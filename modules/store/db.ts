import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

const dbCache = new Map<string, Database>();

export function getDb(dbPath: string): Database {
  const cached = dbCache.get(dbPath);
  if (cached) return cached;
  const dir = join(dbPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  dbCache.set(dbPath, db);
  return db;
}

function initSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      host TEXT NOT NULL,
      api_key TEXT,
      is_runner INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      agent_session_id TEXT,
      last_active TEXT,
      status TEXT DEFAULT 'idle',
      current_task TEXT,
      UNIQUE(agent_id, channel_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      delivered INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_pending
      ON notifications(channel_id, chat_id, delivered);

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_lookup
      ON conversations(agent_id, channel_id, chat_id, created_at);

    CREATE TABLE IF NOT EXISTS approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      options TEXT NOT NULL,
      detail TEXT,
      status TEXT DEFAULT 'pending',
      answer TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      responded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approval_pending
      ON approval_requests(session_id, status);

    CREATE TABLE IF NOT EXISTS channel_state (
      channel_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function closeDb(dbPath?: string) {
  if (dbPath) {
    const db = dbCache.get(dbPath);
    if (db) {
      db.close();
      dbCache.delete(dbPath);
    }
  } else {
    for (const [key, db] of dbCache) {
      db.close();
    }
    dbCache.clear();
  }
}
