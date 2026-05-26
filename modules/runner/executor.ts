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
  onDone: (code: number) => void;
}

export interface ExecutorSession {
  id: string;
  proc: Subprocess;
  status: "running" | "waiting_approval" | "done" | "error";
  output: string;
  callbacks: ExecutorCallbacks;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null;
}

// ================================================================
// CLI 命令映射
// ================================================================

const CLI_MAP: Record<string, { cmd: string; baseArgs: string[] }> = {
  "claude-code": { cmd: "claude", baseArgs: ["--print"] },
  "opencode": { cmd: "opencode", baseArgs: [] }
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
  callbacks: ExecutorCallbacks
): ExecutorSession {
  const cli = CLI_MAP[command];
  if (!cli) throw new Error(`Unknown command: ${command}`);

  const args = [...cli.baseArgs];
  if (sessionId) args.push("--session", sessionId);

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
    session.callbacks.onDone(code ?? 0);
    closeStdin(session);
    activeSessions.delete(sessionId);
  }).catch((err) => {
    console.error(`[executor] process error for session ${sessionId}:`, err.message);
    session.status = "error";
    session.callbacks.onDone(-1);
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
