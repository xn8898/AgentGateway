import { getDb } from "./db.js";
import type { ApprovalRequest } from "../core/types.js";

export function createRequest(dbPath: string, req: Omit<ApprovalRequest, "id" | "createdAt">): number {
  const db = getDb(dbPath);
  const result = db.prepare(
    "INSERT INTO approval_requests (session_id, agent_id, channel_id, chat_id, prompt, options, detail, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')"
  ).run(req.sessionId, req.agentId, req.channelId, req.chatId, req.prompt, JSON.stringify(req.options), req.detail || null);
  return result.lastInsertRowid as number;
}

export function getPendingBySession(dbPath: string, sessionId: string) {
  const db = getDb(dbPath);
  const row = db.prepare(
    "SELECT * FROM approval_requests WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
  ).get(sessionId) as any;
  if (row) row.options = JSON.parse(row.options);
  return row;
}

export function respondToRequest(dbPath: string, requestId: number, answer: string, status: "approved" | "denied") {
  const db = getDb(dbPath);
  db.prepare(
    "UPDATE approval_requests SET status = ?, answer = ?, responded_at = datetime('now') WHERE id = ?"
  ).run(status, answer, requestId);
}

export function cleanupOld(dbPath: string, days: number = 7) {
  const db = getDb(dbPath);
  db.prepare(
    "DELETE FROM approval_requests WHERE status != 'pending' AND created_at < datetime('now', ?)"
  ).run(`-${days} days`);
}
