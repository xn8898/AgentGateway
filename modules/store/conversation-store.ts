import { getDb } from "./db.js";

export function saveMessage(dbPath: string, agentId: string, channelId: string, chatId: string, role: string, content: string) {
  const db = getDb(dbPath);
  db.prepare(
    "INSERT INTO conversations (agent_id, channel_id, chat_id, role, content) VALUES (?, ?, ?, ?, ?)"
  ).run(agentId, channelId, chatId, role, content);
}

export function getHistory(dbPath: string, agentId: string, channelId: string, chatId: string, limit: number = 20) {
  const db = getDb(dbPath);
  return db.prepare(
    "SELECT * FROM conversations WHERE agent_id = ? AND channel_id = ? AND chat_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(agentId, channelId, chatId, limit).reverse();
}

export function cleanupOld(dbPath: string, days: number = 30) {
  const db = getDb(dbPath);
  db.prepare(
    "DELETE FROM conversations WHERE created_at < datetime('now', ?)"
  ).run(`-${days} days`);
}
