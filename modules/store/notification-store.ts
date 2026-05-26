import { getDb } from "./db.js";

export function enqueue(dbPath: string, channelId: string, chatId: string, message: string) {
  const db = getDb(dbPath);
  db.prepare(
    "INSERT INTO notifications (channel_id, chat_id, message) VALUES (?, ?, ?)"
  ).run(channelId, chatId, message);
}

export function dequeuePending(dbPath: string, channelId: string, chatId: string): string[] {
  const db = getDb(dbPath);
  const rows = db.prepare(
    "SELECT id, message FROM notifications WHERE channel_id = ? AND chat_id = ? AND delivered = 0 ORDER BY created_at"
  ).all(channelId, chatId) as any[];

  if (rows.length === 0) return [];

  const ids = rows.map((r: any) => r.id);
  db.prepare(
    `UPDATE notifications SET delivered = 1 WHERE id IN (${ids.map(() => "?").join(",")})`
  ).run(...ids);

  return rows.map((r: any) => r.message);
}

export function cleanupOld(dbPath: string, days: number = 7) {
  const db = getDb(dbPath);
  db.prepare(
    "DELETE FROM notifications WHERE delivered = 1 AND created_at < datetime('now', ?)"
  ).run(`-${days} days`);
}
