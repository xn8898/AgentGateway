import { getDb } from "./db.js";
import type { AgentInstanceConfig } from "../core/types.js";

export function upsertAgent(dbPath: string, agent: AgentInstanceConfig) {
  const db = getDb(dbPath);
  db.prepare(`
    INSERT INTO agents (id, type, host, api_key, is_runner, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      type=excluded.type, host=excluded.host,
      api_key=excluded.api_key, is_runner=excluded.is_runner
  `).run(agent.id, agent.type, agent.host, agent.apiKey || null, agent.runner ? 1 : 0);
}

export function getAgent(dbPath: string, id: string) {
  const db = getDb(dbPath);
  return db.prepare("SELECT * FROM agents WHERE id = ? AND enabled = 1").get(id) as any;
}

export function getAllAgents(dbPath: string) {
  const db = getDb(dbPath);
  return db.prepare("SELECT * FROM agents WHERE enabled = 1").all() as any[];
}

export function getAgentsByType(dbPath: string, type: string) {
  const db = getDb(dbPath);
  return db.prepare("SELECT * FROM agents WHERE type = ? AND enabled = 1").all(type) as any[];
}
