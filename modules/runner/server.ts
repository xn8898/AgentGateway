// ================================================================
// Runner HTTP Server — Hono + Bun.serve
// ================================================================
// 部署在 Agent 机器上的轻量 HTTP 服务
// 提供 SSE 流式输出、交互确认转发、会话管理
// ================================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  startExecution,
  sendApproval,
  cancelExecution,
  getSessionStatus,
  type ExecutorCallbacks,
} from './executor';
import type { RunnerRunRequest, RunnerSSEEvent } from '../core/types';

// ================================================================
// 配置
// ================================================================

const DEFAULT_PORT = 9800;

// ================================================================
// Hono 应用
// ================================================================

const app = new Hono();

// CORS
app.use("*", cors());

// ================================================================
// API Key 认证中间件
// ================================================================

app.use("*", async (c, next) => {
  // health 接口不需要认证
  if (c.req.path === "/health") return next();

  const apiKey = process.env.RUNNER_API_KEY;
  if (!apiKey) return next(); // 未配置则跳过认证

  const provided = c.req.header("X-API-Key");
  if (provided !== apiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
});

// ================================================================
// Health Check
// ================================================================

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ================================================================
// POST /run — 启动执行，返回 SSE 流
// ================================================================

app.post("/run", async (c) => {
  let body: RunnerRunRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { command, sessionId, input, approvalMode, threadId } = body;

  if (!command || !input) {
    return c.json({ error: "Missing required fields: command, input" }, 400);
  }

  // 生成 sessionId 如果未提供
  const sid = sessionId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // SSE 响应
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: RunnerSSEEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      const callbacks: ExecutorCallbacks = {
        onOutput(text) {
          send({ type: "output", text });
        },
        onApproval(detection) {
          send({
            type: "approval_required",
            sessionId: sid,
            prompt: detection.prompt,
            options: detection.options,
            detail: detection.detail,
          });
        },
        onDone(code, doneThreadId) {
          send({ type: "done", code, threadId: doneThreadId });
          controller.close();
        },
      };

      try {
        startExecution(sid, command, input, callbacks, { threadId });
      } catch (err: any) {
        send({ type: "error", text: err.message || "Failed to start execution" });
        controller.close();
      }
    },
    cancel() {
      // 客户端断开时取消执行
      cancelExecution(sid);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

// ================================================================
// POST /approval — 发送确认回答
// ================================================================

app.post("/approval", async (c) => {
  let body: { sessionId: string; answer: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.sessionId || !body.answer) {
    return c.json({ error: "Missing required fields: sessionId, answer" }, 400);
  }

  const ok = sendApproval(body.sessionId, body.answer);
  if (!ok) {
    return c.json({ error: "Session not found or not waiting for approval" }, 404);
  }

  return c.json({ status: "ok" });
});

// ================================================================
// POST /cancel — 取消执行
// ================================================================

app.post("/cancel", async (c) => {
  let body: { sessionId: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.sessionId) {
    return c.json({ error: "Missing required field: sessionId" }, 400);
  }

  const ok = cancelExecution(body.sessionId);
  if (!ok) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({ status: "ok" });
});

// ================================================================
// GET /status — 查询会话状态
// ================================================================

app.get("/status", (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) {
    return c.json({ error: "Missing query parameter: sessionId" }, 400);
  }

  const session = getSessionStatus(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({
    id: session.id,
    status: session.status,
    outputLength: session.output.length,
  });
});

// ================================================================
// 启动服务器
// ================================================================

export function startRunnerServer(port?: number): void {
  const serverPort = port || Number(process.env.RUNNER_PORT) || DEFAULT_PORT;

  Bun.serve({
    port: serverPort,
    fetch: app.fetch,
  });

  console.log(`[runner] server listening on port ${serverPort}`);
}

// 直接运行时启动
if (import.meta.main) {
  startRunnerServer();
}
