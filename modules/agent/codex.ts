// Codex Agent 模块
// 对接 Codex CLI，通过 :18899 Proxy 调用 Provider

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
  Bash: 'Execute command', Read: 'Read file', Edit: 'Edit file', Write: 'Write file',
  Glob: 'Search files', Grep: 'Search content', WebSearch: 'Web search', WebFetch: 'Fetch webpage',
  NotebookEdit: 'Edit Notebook',
  // Codex tool names
  command_execution: 'Execute command', exec_command: 'Execute command', write_stdin: 'Write to stdin', update_plan: 'Update plan',
  request_user_input: 'Request input', apply_patch: 'Apply patch', view_image: 'View image',
  spawn_agent: 'Spawn agent', send_input: 'Send input', resume_agent: 'Resume agent',
  wait_agent: 'Wait agent', close_agent: 'Close agent',
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
  const child = Bun.spawn(['codex', 'exec', '-p', 'imtoagent', '-s', 'danger-full-access',
    '--skip-git-repo-check', '--json', prompt], {
    cwd, stdout: 'pipe', stderr: 'pipe',
  });

  // Safe read stdout/stderr: catch subprocess kill exceptions, ensure reject carries Error object
  let stdout = '', stderr = '';
  try {
    [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text().catch((e: any) => { throw new Error(`stdout read failed: ${e?.message || e}`); }),
      new Response(child.stderr).text().catch((e: any) => { throw new Error(`stderr read failed: ${e?.message || e}`); }),
    ]);
  } catch (ioErr: any) {
    // Subprocess may have been killed, try to get exit code
    try { child.kill('SIGKILL'); } catch {}
    throw new Error(`codex exec I/O error: ${ioErr.message}`);
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
    '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_provider=imtoagent', '-c', 'model=gpt-5.5', '--json', '--skip-git-repo-check', prompt], {
    cwd, stdout: 'pipe', stderr: 'pipe',
  });

  let stdout = '', stderr = '';
  try {
    [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text().catch((e: any) => { throw new Error(`stdout read failed: ${e?.message || e}`); }),
      new Response(child.stderr).text().catch((e: any) => { throw new Error(`stderr read failed: ${e?.message || e}`); }),
    ]);
  } catch (ioErr: any) {
    try { child.kill('SIGKILL'); } catch {}
    throw new Error(`codex exec resume I/O error: ${ioErr.message}`);
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
    console.log(`[Codex] app-server new thread=${session.codexThreadId.slice(-8)}${threadExpired ? ' (process restarted)' : ''}`);
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
      console.error('[Codex] app-server task timed out (10min)');
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
        throw new Error(`app-server error: ${event.error}`);
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
        effectiveText = `[Mode: Plan then execute] Please create a clear plan first, wait for my confirmation before executing. User request: ${text}`;
      }

      const isFresh = session.startFresh || !session.codexThreadId;
      let response: string;
      let execServerUsage: { inputTokens: number; outputTokens: number } | null = null;

      session.startFresh = false;
      await ctx.sendProgress(chatId, '💭 Thinking...');

      // 优先尝试 app-server
      console.error(`[${ctx.name}] DEBUG entering app-server branch, isFresh=${isFresh}, threadId=${session.codexThreadId?.slice(-8)}`);
      let useExecFallback = false;
      try {
        const r = await runViaAppServer(cwd, effectiveText, chatId, session, onTool, isFresh);
        response = r.response;
        execServerUsage = r.usage;
      } catch (appErr: any) {
        const errMsg = appErr.message || '';
        console.error(`[${ctx.name}] app-server failed: ${errMsg}`);

        // thread not found → app-server 进程内线程丢了，尝试重新创建
        if (errMsg.includes('thread not found') || errMsg.includes('Thread not found')) {
          try {
            session.codexThreadId = undefined;
            const r2 = await runViaAppServer(cwd, effectiveText, chatId, session, onTool, true);
            response = r2.response;
            execServerUsage = r2.usage;
            console.error(`[${ctx.name}] app-server thread rebuilt successfully`);
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
          console.log(`[${ctx.name}] Fresh session thread=${r.threadId.slice(-8)}`);
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
          `Input ${usage.inputTokens.toLocaleString()} Token\nOutput ${usage.outputTokens.toLocaleString()} Token\nCost $${cost.toFixed(4)}`);
      }

      if (response) {
        await ctx.sendFormattedReply(chatId, response);
      }
      else await ctx.reply(chatId, '✅ Completed');
      ctx.persistSession(chatId, session);
    } catch (e: any) {
      console.error(`[${ctx.name}] Codex error: ${e.message}`);
      session.codexThreadId = undefined;
      try {
        const r = await spawnCodexExec(cwd, text, onTool);
        session.codexThreadId = r.threadId;
        if (r.response) {
          await ctx.sendFormattedReply(chatId, r.response);
        }
      } catch (e2: any) {
        await ctx.reply(chatId, `❌ Processing failed: ${e2.message}`);
      }
    }
  }
}
