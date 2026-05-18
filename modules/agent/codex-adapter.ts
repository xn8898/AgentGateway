// ================================================================
// Codex Agent Adapter — 实现 SDK AgentAdapter 接口
// ================================================================
// 职责：对接 Codex CLI，将 AgentInput 转换为 AgentOutput
// 支持两条路径：
//   1. App-Server（优先）：进程内 HTTP 流式，长记忆，崩溃不丢上下文
//   2. CLI 子进程（fallback）：codex exec/resume
// ================================================================

import type { AgentAdapter, AgentInput, AgentOutput, Session, buildAttachmentHint } from '../core/types';
import { buildSystemPrompt } from '../prompt-builder';
import { getAppServerManager, type AgentEvent } from './codex-exec-server';

// ================================================================
// CodexAdapter 上下文
// ================================================================

export interface CodexAdapterContext {
  imModule?: { getCapabilities(): any } | null;
  botName: string;
}

// ================================================================
// Codex CLI 调用
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

function processCodexStream(stdout: string): { threadId: string; response: string } {
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
        }
      } else if (evt.type === 'error' || evt.type === 'thread.error') {
        console.error(`[CodexAdapter] event error: ${(evt as any).message || (evt as any).error || JSON.stringify(evt)}`);
      }
    } catch {}
  }
  return { threadId, response };
}

async function spawnCodexExec(cwd: string, prompt: string): Promise<{ threadId: string; response: string }> {
  const child = Bun.spawn(['codex', 'exec', '-p', 'imtoagent', '-s', 'danger-full-access',
    '--skip-git-repo-check', '--json', prompt], {
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
    throw new Error(`codex exec I/O 异常: ${ioErr.message}`);
  }

  const code = await child.exited.catch(() => -1);
  const { threadId, response } = processCodexStream(stdout);
  if (code !== 0 || !threadId) throw new Error(`codex exec exit ${code}: ${stderr.slice(0, 300)}`);
  return { threadId, response };
}

async function spawnCodexResume(cwd: string, threadId: string, prompt: string): Promise<{ response: string }> {
  const child = Bun.spawn(['codex', 'exec', 'resume', threadId,
    '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_provider=imtoagent', '-c', 'model=gpt-5.5', '--json', '--skip-git-repo-check', prompt], {
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
  if (code !== 0) throw new Error(`codex exec resume exit ${code}: ${stderr.slice(0, 300)}`);
  return { response: processCodexStream(stdout).response };
}

// ================================================================
// App-Server 路径（优先）
// ================================================================

async function runViaAppServer(
  cwd: string, prompt: string, chatId: string, session: Session,
  isFresh: boolean
): Promise<{ threadId: string; response: string; usage: { inputTokens: number; outputTokens: number } }> {
  const manager = getAppServerManager();
  const client = await manager.getClient(chatId);

  const currentGen = manager.generation;
  const sessionAny = session as any;
  const threadExpired = sessionAny._appServerGen !== currentGen;
  if (isFresh || !sessionAny.codexThreadId || threadExpired) {
    sessionAny.codexThreadId = await client.startThread(cwd);
    sessionAny._appServerGen = currentGen;
    session.metadata.codexThreadId = sessionAny.codexThreadId;
    console.log(`[CodexAdapter] app-server 全新 thread=${sessionAny.codexThreadId.slice(-8)}${threadExpired ? ' (进程重启)' : ''}`);
  }

  await client.sendPrompt(sessionAny.codexThreadId, prompt, cwd);

  let response = '';
  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  const startTime = Date.now();
  const MAX_DURATION = 600_000; // 10 分钟

  for await (const event of client.receiveEvents()) {
    if (Date.now() - startTime > MAX_DURATION) {
      console.error('[CodexAdapter] app-server 任务超时 (10min)');
      break;
    }

    switch (event.type) {
      case 'text_delta':
        response += event.textDelta || '';
        break;
      case 'tool_call':
        break; // tool 日志由 Runtime 层处理
      case 'turn_result':
        totalUsage.inputTokens += event.usage?.inputTokens || 0;
        totalUsage.outputTokens += event.usage?.outputTokens || 0;
        break;
      case 'error':
        throw new Error(`app-server 错误: ${event.error}`);
    }
  }

  return { threadId: sessionAny.codexThreadId, response, usage: totalUsage };
}

// ================================================================
// CodexAdapter — 实现 AgentAdapter
// ================================================================

export class CodexAdapter implements AgentAdapter {
  readonly name = 'Codex CLI';
  private ctx: CodexAdapterContext;

  constructor(ctx: CodexAdapterContext) {
    this.ctx = ctx;
  }

  async handleMessage(input: AgentInput): Promise<AgentOutput> {
    const { text, session, workingDir, systemPrompt: overrideSystemPrompt } = input;
    const sessionAny = session as any;
    const cwd = workingDir;

    let effectiveText = text;

    // 附件信息注入：让 Agent 知道用户发送了附件（图片/文件/语音）及本地路径
    if (input.attachments && input.attachments.length > 0) {
      effectiveText = buildAttachmentHint(input.attachments) + '\n\n---\n\n' + effectiveText;
    }

    if (session.codexMode === 'plan') {
      effectiveText = `[模式: 先计划后执行] 请先制定一个清晰的计划，等我确认后再执行。用户请求: ${effectiveText}`;
    }

    const isFresh = session.startFresh || !sessionAny.codexThreadId;
    session.startFresh = false;

    // 优先尝试 app-server
    let useExecFallback = false;
    let response: string;
    let execServerUsage: { inputTokens: number; outputTokens: number } | null = null;

    try {
      const r = await runViaAppServer(cwd, effectiveText, input.chatId, session, isFresh);
      response = r.response;
      execServerUsage = r.usage;
    } catch (appErr: any) {
      const errMsg = appErr.message || '';
      console.error(`[CodexAdapter] app-server 失败: ${errMsg}`);

      if (errMsg.includes('thread not found') || errMsg.includes('Thread not found')) {
        try {
          sessionAny.codexThreadId = undefined;
          const r2 = await runViaAppServer(cwd, effectiveText, input.chatId, session, true);
          response = r2.response;
          execServerUsage = r2.usage;
          console.error(`[CodexAdapter] app-server thread 重建成功`);
        } catch {
          useExecFallback = true;
        }
      } else {
        useExecFallback = true;
      }
    }

    if (useExecFallback) {
      getAppServerManager().removeClient(input.chatId);
      if (isFresh || !sessionAny.codexThreadId) {
        const r = await spawnCodexExec(cwd, effectiveText);
        sessionAny.codexThreadId = r.threadId;
        session.metadata.codexThreadId = r.threadId;
        response = r.response;
      } else {
        const r = await spawnCodexResume(cwd, sessionAny.codexThreadId, effectiveText);
        response = r.response;
      }
    }

    return {
      text: response || '✅ 已完成',
      usage: execServerUsage || undefined,
    };
  }
}
