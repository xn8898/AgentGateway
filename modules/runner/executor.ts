// ================================================================
// Executor — Interactive CLI Session Manager
// ================================================================
// 管理 CLI 子进程的生命周期，支持交互式确认转发
// 使用 Bun.spawn 替代 child_process，适配 Bun 运行时
// ================================================================

import type { Subprocess } from 'bun';
import { detectApprovalPrompt } from './approval-detector';

// ================================================================
// 类型
// ================================================================

export interface ExecutorCallbacks {
  onOutput: (chunk: string) => void;
  onApproval: (detection: { prompt: string; options: string[]; detail: string }) => void;
  onDone: (code: number, threadId?: string) => void;
}

export interface ExecutorSession {
  id: string;
  proc: Subprocess;
  status: "running" | "waiting_approval" | "done" | "error";
  output: string;
  callbacks: ExecutorCallbacks;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  threadId?: string;  // Codex thread ID（从 JSON 输出解析）
}

// ================================================================
// CLI 命令映射
// ================================================================

const CLI_MAP: Record<string, { cmd: string; baseArgs: string[] }> = {
  "claude-code": { cmd: "claude", baseArgs: ["--print"] },
  "opencode": { cmd: "opencode", baseArgs: [] },
  "codex": { cmd: "codex", baseArgs: ["exec", "--json", "--skip-git-repo-check"] },
};

// ================================================================
// 活跃会话管理
// ================================================================

const activeSessions = new Map<string, ExecutorSession>();

/**
 * 启动一个新的 CLI 执行会话
 */
export function startExecution(
  sessionId: string,
  command: string,
  input: string,
  callbacks: ExecutorCallbacks,
  options?: { threadId?: string }
): ExecutorSession {
  const cli = CLI_MAP[command];
  if (!cli) throw new Error(`Unknown command: ${command}`);

  let args: string[];

  // Codex 多轮：有 threadId 时用 resume
  if (command === "codex" && options?.threadId) {
    args = ["exec", "resume", options.threadId, "--json", "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox"];
  } else {
    args = [...cli.baseArgs];
    if (sessionId && command !== "codex") args.push("--session", sessionId);
  }

  const proc = Bun.spawn([cli.cmd, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // 写入输入，保持 stdin 开启以便后续发送 approval 回答
  const writer = proc.stdin.getWriter();
  writer.write(new TextEncoder().encode(input));

  const session: ExecutorSession = {
    id: sessionId,
    proc,
    status: "running",
    output: "",
    callbacks,
    stdinWriter: writer,
  };

  activeSessions.set(sessionId, session);

  // 异步读取 stdout
  readStdout(session, proc);

  // 异步读取 stderr
  readStderr(session, proc);

  // 等待进程退出
  proc.exited.then((code) => {
    session.status = code === 0 ? "done" : "error";
    session.callbacks.onDone(code ?? 0, session.threadId);
    closeStdin(session);
    activeSessions.delete(sessionId);
  }).catch((err) => {
    console.error(`[executor] process error for session ${sessionId}:`, err.message);
    session.status = "error";
    session.callbacks.onDone(-1, session.threadId);
    closeStdin(session);
    activeSessions.delete(sessionId);
  });

  return session;
}

/**
 * 向等待确认的会话发送回答
 */
export function sendApproval(sessionId: string, answer: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== "waiting_approval") return false;

  try {
    if (session.stdinWriter) {
      session.stdinWriter.write(new TextEncoder().encode(answer + "\n"));
    }
  } catch {
    return false;
  }

  session.status = "running";
  return true;
}

/**
 * 取消正在运行的会话
 */
export function cancelExecution(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  try {
    session.proc.kill("SIGTERM");
  } catch {}

  closeStdin(session);
  activeSessions.delete(sessionId);
  return true;
}

/**
 * 获取会话状态
 */
export function getSessionStatus(sessionId: string): ExecutorSession | undefined {
  return activeSessions.get(sessionId);
}

// ================================================================
// 内部: 工具函数
// ================================================================

function closeStdin(session: ExecutorSession) {
  try {
    session.stdinWriter?.releaseLock();
    session.proc.stdin?.cancel();
  } catch {}
  session.stdinWriter = null;
}

// ================================================================
// 内部: Codex threadId 解析
// ================================================================

/**
 * 从 Codex JSON 输出行中解析 threadId
 * Codex 输出格式: {"type":"thread.started","thread_id":"..."}
 */
function parseCodexThreadId(session: ExecutorSession, text: string): void {
  if (session.threadId) return; // 已有 threadId，不再解析
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt.type === 'thread.started' && evt.thread_id) {
        session.threadId = evt.thread_id;
        return;
      }
    } catch {}
  }
}

// ================================================================
// 内部: 流读取
// ================================================================

async function readStdout(session: ExecutorSession, proc: Subprocess): Promise<void> {
  if (!proc.stdout) return;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      buffer += text;
      session.output += text;

      // 检测确认提示
      const detection = detectApprovalPrompt(buffer);
      if (detection) {
        session.status = "waiting_approval";
        session.callbacks.onApproval(detection);
        buffer = "";
        continue;
      }

      // 解析 Codex JSON 输出中的 threadId
      parseCodexThreadId(session, text);

      session.callbacks.onOutput(text);
    }
  } catch (err: any) {
    if (!session.proc.killed) {
      console.error(`[executor] stdout read error for session ${session.id}:`, err.message);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function readStderr(session: ExecutorSession, proc: Subprocess): Promise<void> {
  if (!proc.stderr) return;
  try {
    const stderr = await new Response(proc.stderr).text();
    if (stderr.trim()) {
      session.output += stderr;
      session.callbacks.onOutput(stderr);
    }
  } catch {}
}
