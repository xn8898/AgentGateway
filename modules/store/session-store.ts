import { getDb } from "./db.js";
import { randomUUID } from "crypto";

export function getOrCreateSession(dbPath: string, agentId: string, channelId: string, chatId: string) {
  const db = getDb(dbPath);
  const existing = db.prepare(
    "SELECT * FROM sessions WHERE agent_id = ? AND channel_id = ? AND chat_id = ?"
  ).get(agentId, channelId, chatId) as any;

  if (existing) {
    const lastActive = new Date(existing.last_active).getTime();
    if (Date.now() - lastActive > 30 * 60 * 1000) {
      const newId = randomUUID();
      db.prepare(
        "UPDATE sessions SET id = ?, agent_session_id = NULL, last_active = datetime('now'), status = 'idle', current_task = NULL WHERE id = ?"
      ).run(newId, existing.id);
      return { ...existing, id: newId, agent_session_id: null, status: "idle" };
    }
    return existing;
  }

  const id = randomUUID();
  db.prepare(
    "INSERT INTO sessions (id, agent_id, channel_id, chat_id, last_active) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(id, agentId, channelId, chatId);
  return { id, agent_id: agentId, channel_id: channelId, chat_id: chatId, status: "idle" };
}

export function updateSessionStatus(dbPath: string, sessionId: string, status: string, task?: string) {
  const db = getDb(dbPath);
  db.prepare(
    "UPDATE sessions SET status = ?, current_task = ?, last_active = datetime('now') WHERE id = ?"
  ).run(status, task || null, sessionId);
}

export function updateAgentSessionId(dbPath: string, sessionId: string, agentSessionId: string) {
  const db = getDb(dbPath);
  db.prepare("UPDATE sessions SET agent_session_id = ?, last_active = datetime('now') WHERE id = ?")
    .run(agentSessionId, sessionId);
}

export function getActiveSession(dbPath: string, channelId: string, chatId: string) {
  const db = getDb(dbPath);
  return db.prepare(
    "SELECT * FROM sessions WHERE channel_id = ? AND chat_id = ? AND status != 'idle' ORDER BY last_active DESC LIMIT 1"
  ).get(channelId, chatId) as any;
}
