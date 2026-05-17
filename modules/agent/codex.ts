// Codex Agent 模块
// 对接 Codex CLI，通过 :18900 Proxy 调用 Provider

import { getProxyUsage, resetProxyUsage } from '../proxy/codex-proxy';
import { calculateCost } from '../proxy/anthropic-proxy';
import type { AgentContext } from '../types';
import { getAppServerManager, type AgentEvent } from './codex-exec-server';
// ================================================================
// 类型
// ================================================================
interface CodexJsonEvent {
  type: string;
  thread_id?: string;
  item?: { type: string; text?: string; name?: string; arguments?: string; output?: string };
  text?: string;
  delta?: string;
  message?: { content?: { type: string; text?: string }[] };
  error?: string;
}

const TOOL_NAMES: Record<string, string> = {
  Bash: '执行命令', Read: '读取文件', Edit: '编辑文件', Write: '写入文件',
  Glob: '搜索文件', Grep: '搜索内容', WebSearch: '搜索网页', WebFetch: '抓取网页',
  NotebookEdit: '编辑 Notebook',
  // Codex 工具名
  command_execution: '执行命令', exec_command: '执行命令', write_stdin: '写入文件', update_plan: '更新计划',
  request_user_input: '请求输入', apply_patch: '应用补丁', view_image: '查看图片',
  spawn_agent: '启动代理', send_input: '发送输入', resume_agent: '恢复代理',
  wait_agent: '等待代理', close_agent: '关闭代理',
};

// ================================================================
// Codex CLI 调用
// ================================================================
function processCodexStream(stdout: string, onTool?: (name: string, args: Record<string, any>) => void): { threadId: string; response: string } {
  let threadId = '', response = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const evt: CodexJsonEvent = JSON.parse(line);
      if (evt.type === 'thread.started' && evt.thread_id) {
        threadId = evt.thread_id;
      } else if (evt.type === 'item.completed') {
        if (evt.item?.type === 'agent_message') {
          response = (response ? response + '\n' : '') + (evt.item.text || '');
        } else if (TOOL_NAMES[evt.item?.type || ''] && onTool) {
          onTool(evt.item.type || 'unknown', { command: (evt.item as any).command || '' });
        }
      } else if (evt.type === 'error' || evt.type === 'thread.error') {
        console.error(`[Codex] event error: ${(evt as any).message || (evt as any).error || JSON.stringify(evt)}`);
      }
    } catch {}
  }
  return { threadId, response };
}

async function spawnCodexExec(
  cwd: string, prompt: string,
  onTool?: (name: string, args: Record<string, any>) => void
): Promise<{ threadId: string; response: string }> {
  console.error(`[Codex] spawnExec cwd=${cwd} prompt_len=${prompt.length}`);
  const child = Bun.spawn(['codex', 'exec', '-p', 'ccgateway', '-s', 'danger-full-access',
    '--skip-git-repo-check', '--json', prompt], {
    cwd, stdout: 'pipe', stderr: 'pipe',
  });

  // 安全读取 stdout/stderr：捕获子进程被 kill 等异常，确保 reject 带 Error 对象
  let stdout = '', stderr = '';
  try {
    [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text().catch((e: any) => { throw new Error(`stdout 读取失败: ${e?.message || e}`); }),
      new Response(child.stderr).text().catch((e: any) => { throw new Error(`stderr 读取失败: ${e?.message || e}`); }),
    ]);
  } catch (ioErr: any) {
    // 子进程可能已被 kill，尝试获取退出码
    try { child.kill('SIGKILL'); } catch {}
    throw new Error(`codex exec I/O 异常: ${ioErr.message}`);
  }

  const code = await child.exited.catch(() => -1);
  console.error(`[Codex] exec exit=${code} stdout_len=${stdout.length} stderr_len=${stderr.length}`);
  const { threadId, response } = processCodexStream(stdout, onTool);
  if (code !== 0 || !threadId) throw new Error(`codex exec exit ${code}: ${stderr.slice(0, 300)}`);
  return { threadId, response };
}

async function spawnCodexResume(
  cwd: string, threadId: string, prompt: string,
  onTool?: (name: string, args: Record<string, any>) => void
): Promise<{ response: string }> {
  console.error(`[Codex] spawnResume cwd=${cwd} threadId=${threadId.slice(-8)} prompt_len=${prompt.length}`);
  const child = Bun.spawn(['codex', 'exec', 'resume', threadId,
    '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_provider=ccgateway', '-c', 'model=gpt-5.5', '--json', '--skip-git-repo-check', prompt], {
    cwd, stdout: 'pipe', stderr: 'pipe',
  });

  let stdout = '', stderr = '';
  try {
    [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text().catch((e: any) => { throw new Error(`stdout 读取失败: ${e?.message || e}`); }),
      new Response(child.stderr).text().catch((e: any) => { throw new Error(`stderr 读取失败: ${e?.message || e}`); }),
    ]);
  } catch (ioErr: any) {
    try { child.kill('SIGKILL'); } catch {}
    throw new Error(`codex exec resume I/O 异常: ${ioErr.message}`);
  }

  const code = await child.exited.catch(() => -1);
  console.error(`[Codex] resume exit=${code} stdout_len=${stdout.length} stderr_len=${stderr.length}`);
  if (code !== 0) throw new Error(`codex exec resume exit ${code}: ${stderr.slice(0, 300)}`);
  return { response: processCodexStream(stdout, onTool).response };
}

// ================================================================
// App-Server 路径（优先使用——流式输出 + 长记忆 + 崩溃不丢上下文）
// ================================================================
async function runViaAppServer(
  cwd: string, prompt: string, chatId: string, session: any,
  onTool: (name: string, args: Record<string, any>) => void,
  isFresh: boolean
): Promise<{ threadId: string; response: string; usage: { inputTokens: number; outputTokens: number } }> {
  const manager = getAppServerManager();
  const client = await manager.getClient(chatId);

  // app-server 同进程内线程存活
  // 但进程重启后旧 thread 过期，需要判断代际
  const currentGen = manager.generation;
  const threadExpired = session._appServerGen !== currentGen;
  if (isFresh || !session.codexThreadId || threadExpired) {
    session.codexThreadId = await client.startThread(cwd);
    session._appServerGen = currentGen;
    console.log(`[Codex] app-server 全新线程 thread=${session.codexThreadId.slice(-8)}${threadExpired ? ' (进程重启)' : ''}`);
  }
  // 后续消息直接 turn/start（同线程延续上下文）

  await client.sendPrompt(session.codexThreadId, prompt, cwd);

  let response = '';
  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  const startTime = Date.now();
  const MAX_DURATION = 600_000; // 10 分钟总超时

  for await (const event of client.receiveEvents()) {
    // 超时保护
    if (Date.now() - startTime > MAX_DURATION) {
      console.error('[Codex] app-server 任务超时 (10min)');
      break;
    }

    switch (event.type) {
      case 'text_delta':
        response += event.textDelta || '';
        break;
      case 'tool_call':
        onTool(event.toolName || 'unknown', event.toolInput || {});
        break;
      case 'turn_result':
        // 累加多轮 token（非终端 turn_result 来自每轮的 turn/completed）
        totalUsage.inputTokens += event.usage?.inputTokens || 0;
        totalUsage.outputTokens += event.usage?.outputTokens || 0;
        break;
      case 'error':
        throw new Error(`app-server 错误: ${event.error}`);
    }
  }

  return { threadId: session.codexThreadId, response, usage: totalUsage };
}

// ================================================================
// Codex 模块类
// ================================================================
export class CodexAgentModule {
  private ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  async handleMessage(chatId: string, text: string, session: any) {
    const ctx = this.ctx;
    const cwd = session.cwd || ctx.defaultCwd;
    console.log(`[${ctx.name}] Codex chat=${chatId.slice(-8)} startFresh=${session.startFresh || false}`);

    const onTool = (name: string, args: Record<string, any>) => {
      const cmd = args.cmd || args.command || '';
      const justification = args.justification || args.description || '';
      const summary = cmd ? cmd.slice(0, 80) : justification.slice(0, 80);
      ctx.addToolLog(chatId, { name, summary });
    };

    resetProxyUsage();
    try {
      let effectiveText = text;
      if (session.codexMode === 'plan') {
        effectiveText = `[模式: 先计划后执行] 请先制定一个清晰的计划，等我确认后再执行。用户请求: ${text}`;
      }

      const isFresh = session.startFresh || !session.codexThreadId;
      let response: string;
      let execServerUsage: { inputTokens: number; outputTokens: number } | null = null;

      session.startFresh = false;
      await ctx.sendProgress(chatId, '💭 思考中...');

      // 优先尝试 app-server
      console.error(`[${ctx.name}] DEBUG 进入 app-server 分支, isFresh=${isFresh}, threadId=${session.codexThreadId?.slice(-8)}`);
      let useExecFallback = false;
      try {
        const r = await runViaAppServer(cwd, effectiveText, chatId, session, onTool, isFresh);
        response = r.response;
        execServerUsage = r.usage;
      } catch (appErr: any) {
        const errMsg = appErr.message || '';
        console.error(`[${ctx.name}] app-server 失败: ${errMsg}`);

        // thread not found → app-server 进程内线程丢了，尝试重新创建
        if (errMsg.includes('thread not found') || errMsg.includes('Thread not found')) {
          try {
            session.codexThreadId = undefined;
            const r2 = await runViaAppServer(cwd, effectiveText, chatId, session, onTool, true);
            response = r2.response;
            execServerUsage = r2.usage;
            console.error(`[${ctx.name}] app-server thread 重建成功`);
          } catch {
            useExecFallback = true;
          }
        } else {
          useExecFallback = true;
        }
      }

      if (useExecFallback) {
        getAppServerManager().removeClient(chatId);
        if (isFresh || !session.codexThreadId) {
          const r = await spawnCodexExec(cwd, effectiveText, onTool);
          session.codexThreadId = r.threadId;
          response = r.response;
          console.log(`[${ctx.name}] 全新会话 thread=${r.threadId.slice(-8)}`);
        } else {
          const r = await spawnCodexResume(cwd, session.codexThreadId, effectiveText, onTool);
          response = r.response;
        }
      }
      ctx.flushToolLog(chatId);

      // 优先使用 app-server 返回的 usage，否则从 proxy 获取
      const usage = execServerUsage || getProxyUsage();
      if (usage.inputTokens > 0 || usage.outputTokens > 0) {
        const cost = calculateCost(ctx.activeModel, usage.inputTokens, usage.outputTokens);
        ctx.accumulateStats(session, { ...usage, costUSD: cost });
        await ctx.sendProgress(chatId,
          `输入 ${usage.inputTokens.toLocaleString()} Token\n输出 ${usage.outputTokens.toLocaleString()} Token\n费用 $${cost.toFixed(4)}`);
      }

      if (response) {
        await ctx.sendFormattedReply(chatId, response);
      }
      else await ctx.reply(chatId, '✅ 已完成');
      ctx.persistSession(chatId, session);
    } catch (e: any) {
      console.error(`[${ctx.name}] Codex 错误: ${e.message}`);
      session.codexThreadId = undefined;
      try {
        const r = await spawnCodexExec(cwd, text, onTool);
        session.codexThreadId = r.threadId;
        if (r.response) {
          await ctx.sendFormattedReply(chatId, r.response);
        }
      } catch (e2: any) {
        await ctx.reply(chatId, `❌ 处理失败: ${e2.message}`);
      }
    }
  }
}
