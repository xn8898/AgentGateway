# AI Gateway 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 imtoagent Fork 构建 AI Gateway，支持通过微信/Telegram/飞书远程指挥多台机器上的多个 AI 编码 Agent。

**Architecture:** Fork imtoagent 作为基础框架，在其 IM→Agent 统一网关架构上扩展：新增 Hermes Agent 适配、多实例路由、SQLite 存储、分布式 Runner、交互式确认机制、iLink 捎带通知。

**Tech Stack:** TypeScript (ESM), Bun, SQLite (better-sqlite3), iLink SDK (@tencent-weixin/openclaw-weixin), hono (Runner HTTP), pino (logging)

**Spec:** `docs/superpowers/specs/2026-05-26-ai-gateway-design.md`

---

## 文件结构

### 新增文件

| 文件路径 | 职责 |
|---------|------|
| `modules/core/Router.ts` | 指令路由解析（@别名 / @机器:类型 / /command） |
| `modules/core/NotificationQueue.ts` | iLink 捎带通知队列管理 |
| `modules/agent/hermes-adapter.ts` | Hermes Agent 适配器（Gateway HTTP API） |
| `modules/runner/server.ts` | Runner HTTP 服务入口（部署在 Agent 机器） |
| `modules/runner/executor.ts` | CLI 交互式执行器（spawn + stdin/stdout 管理） |
| `modules/runner/approval-detector.ts` | 各 Agent 确认模式正则匹配 |
| `modules/runner/runner-adapter.ts` | Gateway 侧 Runner 客户端适配器 |
| `modules/store/db.ts` | SQLite 连接和 schema 初始化 |
| `modules/store/agent-store.ts` | Agent 实例 CRUD |
| `modules/store/session-store.ts` | 会话 CRUD（替代 JSON 文件） |
| `modules/store/notification-store.ts` | 通知队列 CRUD |
| `modules/store/conversation-store.ts` | 对话历史 CRUD |
| `modules/store/approval-store.ts` | 确认请求队列 CRUD |
| `config.yaml` | 主配置文件 |
| `tests/` | 测试目录 |

### 修改文件（来自 imtoagent）

| 文件路径 | 改动说明 |
|---------|---------|
| `index.ts` | 加入 Router、NotificationQueue 初始化 |
| `modules/core/AgentRuntime.ts` | 消息处理流程加入路由解析、确认检测、捎带通知 |
| `modules/core/AgentAdapter.ts` | 接口增加 approval 相关方法 |
| `modules/core/SessionManager.ts` | 存储层从 JSON 改为 SQLite |
| `modules/core/types.ts` | 新增路由、确认、通知相关类型 |
| `modules/im/wechat.ts` | 增强：捎带通知检查、发送前注入 pending notifications |
| `modules/agent/claude-adapter.ts` | 适配 RunnerAdapter（如目标机器需要 Runner） |
| `modules/agent/opencode-adapter.ts` | 适配 RunnerAdapter |
| `package.json` | 新增 better-sqlite3、hono、js-yaml 依赖 |

---

## Task 1: Fork imtoagent 并验证基线

**Goal:** 克隆 imtoagent，安装依赖，确认能正常构建和运行。

**Files:**
- Create: `.gitignore` (如不存在)

- [ ] **Step 1: Fork 并克隆 imtoagent**

```bash
cd /e/work/2026/ai/ai-gateway
git clone https://github.com/imtoagent/imtoagent.git .
```

- [ ] **Step 2: 安装依赖**

```bash
bun install
```

- [ ] **Step 3: 检查项目结构**

```bash
ls -la modules/core/ modules/im/ modules/agent/
```

确认以下文件存在：
- `modules/core/AgentRuntime.ts`
- `modules/core/AgentAdapter.ts`
- `modules/core/SessionManager.ts`
- `modules/core/types.ts`
- `modules/im/wechat.ts`
- `modules/im/telegram.ts`
- `modules/im/feishu.ts`
- `modules/agent/claude-adapter.ts`
- `modules/agent/codex-adapter.ts`
- `modules/agent/opencode-adapter.ts`

- [ ] **Step 4: 构建验证**

```bash
bun run build  # 或 tsc，取决于 imtoagent 的构建方式
```

- [ ] **Step 5: 初始化 git 并提交**

```bash
git remote rename origin upstream  # 保留上游 remote
git add -A
git commit -m "chore: fork imtoagent as ai-gateway baseline"
```

---

## Task 2: 新增类型定义

**Goal:** 定义路由、确认、通知相关的 TypeScript 类型。

**Files:**
- Modify: `modules/core/types.ts`

- [ ] **Step 1: 读取现有 types.ts**

```bash
cat modules/core/types.ts
```

了解现有的类型定义（AgentConfig、Session、Message 等）。

- [ ] **Step 2: 追加新类型定义**

在 `modules/core/types.ts` 末尾追加：

```typescript
// ============ 路由相关 ============

/** 路由解析结果 */
export interface RouteResult {
  target: string;          // Agent 实例 ID（如 "claw-home"）| "ambiguous" | "default"
  message: string;         // 去掉路由前缀后的消息文本
}

/** Agent 实例配置（扩展自现有 AgentConfig） */
export interface AgentInstanceConfig {
  id: string;              // 实例别名（如 "claw-home"）
  type: string;            // Agent 类型（"openclaw" | "hermes" | "claude-code" | "opencode"）
  host: string;            // 地址（IP:端口 或 域名）
  apiKey?: string;         // API Key（环境变量替换后）
  runner?: boolean;        // 是否需要 Runner
  approval?: ApprovalConfig;
}

/** 审批配置 */
export interface ApprovalConfig {
  mode: "auto_approve" | "prompt" | "hybrid";
  auto_approve_commands?: string[];
  deny_commands?: string[];
}

// ============ 确认相关 ============

/** Agent 确认请求 */
export interface ApprovalRequest {
  id?: number;
  sessionId: string;
  agentId: string;
  channelId: string;
  chatId: string;
  prompt: string;          // "Allow this command?"
  options: string[];       // ["y", "n", "a", "d"]
  detail?: string;         // 具体操作内容
  status: "pending" | "approved" | "denied" | "timeout";
  answer?: string;
  createdAt: string;
  respondedAt?: string;
}

/** 确认模式检测结果 */
export interface ApprovalDetection {
  prompt: string;
  options: string[];
  detail: string;
}

// ============ 通知相关 ============

/** 待推送通知 */
export interface PendingNotification {
  id?: number;
  channelId: string;
  chatId: string;
  message: string;
  createdAt: string;
  delivered: boolean;
}

// ============ Agent 响应 ============

/** Agent 统一响应 */
export interface AgentResponse {
  text: string;
  sessionId: string;
  status: "done" | "working" | "error" | "waiting_approval";
  progress?: string;
}

/** Agent 状态 */
export interface AgentStatus {
  online: boolean;
  busy: boolean;
  currentTask?: string;
  pendingOutput?: string;
}

// ============ Runner 相关 ============

/** Runner 运行请求 */
export interface RunnerRunRequest {
  command: string;         // "claude-code" | "opencode"
  sessionId?: string;
  input: string;
  approvalMode?: string;
}

/** Runner SSE 事件 */
export interface RunnerSSEEvent {
  type: "output" | "approval_required" | "done" | "error";
  text?: string;
  sessionId?: string;
  prompt?: string;
  options?: string[];
  detail?: string;
  code?: number;
}
```

- [ ] **Step 3: 验证类型编译**

```bash
bun run build
```

- [ ] **Step 4: 提交**

```bash
git add modules/core/types.ts
git commit -m "feat: add routing, approval, notification type definitions"
```

---

## Task 3: SQLite 存储层

**Goal:** 实现 SQLite 存储层，替代 JSON 文件存储。

**Files:**
- Create: `modules/store/db.ts`
- Create: `modules/store/agent-store.ts`
- Create: `modules/store/session-store.ts`
- Create: `modules/store/notification-store.ts`
- Create: `modules/store/conversation-store.ts`
- Create: `modules/store/approval-store.ts`
- Modify: `package.json` (添加 better-sqlite3 依赖)

- [ ] **Step 1: 添加依赖**

```bash
bun add better-sqlite3
bun add -d @types/better-sqlite3
```

- [ ] **Step 2: 创建 db.ts — 数据库连接和 schema**

创建 `modules/store/db.ts`：

```typescript
import Database from "better-sqlite3";
import { join } from "path";
import { mkdirSync } from "fs";

let db: Database.Database | null = null;

export function getDb(dbPath: string): Database.Database {
  if (db) return db;

  // 确保目录存在
  const dir = join(dbPath, "..");
  mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);
  return db;
}

function initSchema(db: Database.Database) {
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

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
```

- [ ] **Step 3: 创建 agent-store.ts**

创建 `modules/store/agent-store.ts`：

```typescript
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
```

- [ ] **Step 4: 创建 session-store.ts**

创建 `modules/store/session-store.ts`：

```typescript
import { getDb } from "./db.js";
import { randomUUID } from "crypto";

export function getOrCreateSession(dbPath: string, agentId: string, channelId: string, chatId: string) {
  const db = getDb(dbPath);
  const existing = db.prepare(
    "SELECT * FROM sessions WHERE agent_id = ? AND channel_id = ? AND chat_id = ?"
  ).get(agentId, channelId, chatId) as any;

  if (existing) {
    // 检查是否超时（30 分钟）
    const lastActive = new Date(existing.last_active).getTime();
    if (Date.now() - lastActive > 30 * 60 * 1000) {
      // 超时，创建新会话
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
```

- [ ] **Step 5: 创建 notification-store.ts**

创建 `modules/store/notification-store.ts`：

```typescript
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
```

- [ ] **Step 6: 创建 conversation-store.ts**

创建 `modules/store/conversation-store.ts`：

```typescript
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
```

- [ ] **Step 7: 创建 approval-store.ts**

创建 `modules/store/approval-store.ts`：

```typescript
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
```

- [ ] **Step 8: 验证编译**

```bash
bun run build
```

- [ ] **Step 9: 提交**

```bash
git add modules/store/ package.json bun.lockb
git commit -m "feat: add SQLite storage layer with agent/session/notification/conversation/approval stores"
```

---

## Task 4: 多实例路由 (Router)

**Goal:** 实现指令路由解析，支持 @别名、@机器:类型、@类型、/command 格式。

**Files:**
- Create: `modules/core/Router.ts`

- [ ] **Step 1: 创建 Router.ts**

创建 `modules/core/Router.ts`：

```typescript
import type { RouteResult, AgentInstanceConfig } from "./types.js";

export class Router {
  private agents: Map<string, AgentInstanceConfig>;
  private defaultAgent: string;

  constructor(agents: AgentInstanceConfig[], defaultAgent: string) {
    this.agents = new Map(agents.map(a => [a.id, a]));
    this.defaultAgent = defaultAgent;
  }

  /**
   * 解析用户消息，返回路由结果
   * 支持格式：
   *   @别名 消息       → 精确匹配实例
   *   @机器:类型 消息   → 按机器+类型匹配
   *   @类型 消息       → 唯一直接路由，多个提示选择
   *   /command ...     → 系统指令
   *   消息（无前缀）   → 默认 Agent
   */
  parse(text: string): RouteResult {
    const trimmed = text.trim();

    // 系统指令
    if (trimmed.startsWith("/")) {
      return { target: "__system__", message: trimmed };
    }

    // @前缀路由
    const atMatch = trimmed.match(/^@(\S+)\s+([\s\S]+)$/);
    if (atMatch) {
      const [, alias, message] = atMatch;
      return this.resolveAlias(alias, message);
    }

    // 无前缀 → 默认 Agent
    return { target: this.defaultAgent, message: trimmed };
  }

  private resolveAlias(alias: string, message: string): RouteResult {
    // 格式1: 直接匹配实例别名
    if (this.agents.has(alias)) {
      return { target: alias, message };
    }

    // 格式2: @machine:agent
    const colonIdx = alias.indexOf(":");
    if (colonIdx > 0) {
      const machine = alias.substring(0, colonIdx);
      const type = alias.substring(colonIdx + 1);
      // 查找匹配 machine + type 的实例
      for (const [id, agent] of this.agents) {
        if (agent.type === type && this.hostMatchesMachine(agent.host, machine)) {
          return { target: id, message };
        }
      }
    }

    // 格式3: @类型（匹配所有该类型的实例）
    const typeMatches = Array.from(this.agents.values()).filter(a => a.type === alias);
    if (typeMatches.length === 1) {
      return { target: typeMatches[0].id, message };
    }
    if (typeMatches.length > 1) {
      const list = typeMatches.map(a => `  @${a.id} (${a.host})`).join("\n");
      return {
        target: "__ambiguous__",
        message: `找到多个 ${alias} 实例：\n${list}\n请用 @别名 指定`
      };
    }

    // 未找到
    return { target: "__not_found__", message: `未找到 @${alias}，用 /list 查看可用 Agent` };
  }

  private hostMatchesMachine(host: string, machine: string): boolean {
    // host 格式: "192.168.1.100:8080" 或 "vps1.example.com:8080"
    const hostname = host.split(":")[0];
    return hostname === machine || hostname.startsWith(machine + ".");
  }

  /** 获取所有已注册的 Agent 实例 */
  getAllAgents(): AgentInstanceConfig[] {
    return Array.from(this.agents.values());
  }

  /** 根据 ID 获取 Agent */
  getAgent(id: string): AgentInstanceConfig | undefined {
    return this.agents.get(id);
  }
}
```

- [ ] **Step 2: 验证编译**

```bash
bun run build
```

- [ ] **Step 3: 提交**

```bash
git add modules/core/Router.ts
git commit -m "feat: add multi-instance Router with @alias, @machine:type, @type routing"
```

---

## Task 5: NotificationQueue（iLink 捎带通知）

**Goal:** 实现 iLink 捎带通知队列——不能主动推送时缓存通知，用户下次发消息时附带。

**Files:**
- Create: `modules/core/NotificationQueue.ts`

- [ ] **Step 1: 创建 NotificationQueue.ts**

创建 `modules/core/NotificationQueue.ts`：

```typescript
import type { Channel } from "../im/types.js";
import * as notificationStore from "../store/notification-store.js";

export class NotificationQueue {
  constructor(private dbPath: string) {}

  /**
   * 发送通知：能推送的 Channel 直接推送，不能的缓存到队列
   */
  async notify(channel: Channel, chatId: string, message: string): Promise<void> {
    if (channel.canPush) {
      await channel.sendMessage(chatId, message);
    } else {
      notificationStore.enqueue(this.dbPath, channel.id, chatId, message);
    }
  }

  /**
   * 捎带检查：用户发消息时调用，返回待推送的通知列表
   */
  flushPending(channelId: string, chatId: string): string[] {
    return notificationStore.dequeuePending(this.dbPath, channelId, chatId);
  }

  /**
   * 定期清理旧通知
   */
  cleanup(days: number = 7) {
    notificationStore.cleanupOld(this.dbPath, days);
  }
}
```

- [ ] **Step 2: 验证编译**

```bash
bun run build
```

- [ ] **Step 3: 提交**

```bash
git add modules/core/NotificationQueue.ts
git commit -m "feat: add NotificationQueue for iLink piggyback notifications"
```

---

## Task 6: Hermes Agent Adapter

**Goal:** 实现 Hermes Agent 适配器，通过 Hermes Gateway HTTP API 通信。

**Files:**
- Create: `modules/agent/hermes-adapter.ts`

- [ ] **Step 1: 读取现有 adapter 了解接口**

```bash
cat modules/agent/claude-adapter.ts
```

了解 imtoagent 现有 adapter 的接口约定和实现模式。

- [ ] **Step 2: 创建 hermes-adapter.ts**

创建 `modules/agent/hermes-adapter.ts`：

```typescript
import type { AgentAdapter } from "../core/AgentAdapter.js";
import type { AgentResponse, AgentStatus } from "../core/types.js";

/**
 * Hermes Agent 适配器
 * 通过 Hermes Gateway HTTP API 通信
 * Hermes 启动方式: hermes gateway start
 * 默认 API: http://host:3000/api
 */
export class HermesAdapter implements AgentAdapter {
  id: string;
  type = "hermes";
  host: string;
  private apiKey?: string;
  private baseUrl: string;

  constructor(id: string, host: string, apiKey?: string) {
    this.id = id;
    this.host = host;
    this.apiKey = apiKey;
    this.baseUrl = `http://${host}`;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async sendMessage(text: string, sessionId?: string): Promise<AgentResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        message: text,
        session_id: sessionId || undefined
      })
    });

    if (!res.ok) {
      throw new Error(`Hermes API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as any;
    return {
      text: data.response || data.text || data.message || "",
      sessionId: data.session_id || sessionId || "",
      status: "done"
    };
  }

  async getStatus(): Promise<AgentStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/api/status`, { headers: this.headers });
      if (!res.ok) return { online: false, busy: false };
      const data = await res.json() as any;
      return {
        online: true,
        busy: data.busy || false,
        currentTask: data.current_task
      };
    } catch {
      return { online: false, busy: false };
    }
  }

  async cancel(_sessionId?: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/stop`, {
      method: "POST",
      headers: this.headers
    });
  }

  async connect(): Promise<void> {
    // 验证 Hermes Gateway 是否可达
    const status = await this.getStatus();
    if (!status.online) {
      console.warn(`[hermes-adapter] Hermes Gateway at ${this.host} is not reachable`);
    }
  }

  async disconnect(): Promise<void> {
    // HTTP 无状态，无需断开
  }

  async healthCheck(): Promise<boolean> {
    const status = await this.getStatus();
    return status.online;
  }
}
```

- [ ] **Step 3: 验证编译**

```bash
bun run build
```

- [ ] **Step 4: 提交**

```bash
git add modules/agent/hermes-adapter.ts
git commit -m "feat: add Hermes Agent adapter via Gateway HTTP API"
```

---

## Task 7: 分布式 Runner

**Goal:** 实现 Runner 进程（部署在 Agent 机器上的 HTTP 服务），封装 CLI 工具。

**Files:**
- Create: `modules/runner/server.ts`
- Create: `modules/runner/executor.ts`
- Create: `modules/runner/approval-detector.ts`

- [ ] **Step 1: 添加 hono 依赖**

```bash
bun add hono
```

- [ ] **Step 2: 创建 approval-detector.ts**

创建 `modules/runner/approval-detector.ts`：

```typescript
import type { ApprovalDetection } from "../core/types.js";

/**
 * 检测 Agent 输出中的确认提示
 * 支持 Claude Code、Hermes、OpenCode 的确认模式
 */
export function detectApprovalPrompt(output: string): ApprovalDetection | null {
  // Claude Code: "Allow this command? [y/n/a/d]"
  const claudeMatch = output.match(
    /(?:Allow|Execute|Run|Use)\s+(?:this\s+)?(?:command|tool|action|file)\s*\?[\s\S]*?\[(\w)\/(\w)(?:\/(\w))?(?:\/(\w))?\]/i
  );
  if (claudeMatch) {
    return {
      prompt: output.split("\n").filter(l => l.trim()).pop() || "Confirm?",
      options: claudeMatch.slice(1).filter(Boolean),
      detail: extractCommandFromOutput(output)
    };
  }

  // Hermes: "Approve this action? (y/n)"
  const hermesMatch = output.match(/(?:Approve|Confirm)\s+(?:this\s+)?(?:action|command)\s*\?\s*\((\w)\/(\w)\)/i);
  if (hermesMatch) {
    return {
      prompt: output.split("\n").filter(l => l.trim()).pop() || "Approve?",
      options: [hermesMatch[1], hermesMatch[2]],
      detail: extractCommandFromOutput(output)
    };
  }

  // 通用: 包含 [y/n] 的提示
  const genericMatch = output.match(/([\s\S]*?\S.*?)\[(\w)\/(\w)\]\s*$/);
  if (genericMatch) {
    return {
      prompt: genericMatch[1].trim().split("\n").pop() || "Confirm?",
      options: [genericMatch[2], genericMatch[3]],
      detail: ""
    };
  }

  return null;
}

function extractCommandFromOutput(output: string): string {
  // 尝试提取 ``` 包裹的命令或 $ 开头的行
  const codeBlock = output.match(/```(?:bash|sh)?\n([\s\S]*?)```/);
  if (codeBlock) return codeBlock[1].trim().split("\n")[0];

  const dollarLine = output.match(/\$\s+(.+)/);
  if (dollarLine) return dollarLine[1];

  return "";
}
```

- [ ] **Step 3: 创建 executor.ts**

创建 `modules/runner/executor.ts`：

```typescript
import { spawn, type ChildProcess } from "child_process";
import { detectApprovalPrompt } from "./approval-detector.js";

export interface ExecutorSession {
  id: string;
  proc: ChildProcess;
  status: "running" | "waiting_approval" | "done" | "error";
  output: string;
  pendingApproval: { resolve: (answer: string) => void } | null;
  onOutput: (chunk: string) => void;
  onApproval: (detection: { prompt: string; options: string[]; detail: string }) => void;
  onDone: (code: number) => void;
}

const activeSessions = new Map<string, ExecutorSession>();

const CLI_MAP: Record<string, { cmd: string; baseArgs: string[] }> = {
  "claude-code": { cmd: "claude", baseArgs: ["--print"] },
  "opencode": { cmd: "opencode", baseArgs: [] }
};

export function startExecution(
  sessionId: string,
  command: string,
  input: string,
  callbacks: {
    onOutput: (chunk: string) => void;
    onApproval: (detection: { prompt: string; options: string[]; detail: string }) => void;
    onDone: (code: number) => void;
  }
): ExecutorSession {
  const cli = CLI_MAP[command];
  if (!cli) throw new Error(`Unknown command: ${command}`);

  const args = [...cli.baseArgs];
  if (sessionId) args.push("--session", sessionId);

  const proc = spawn(cli.cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin?.write(input);
  proc.stdin?.end();

  const session: ExecutorSession = {
    id: sessionId,
    proc,
    status: "running",
    output: "",
    pendingApproval: null,
    ...callbacks
  };

  activeSessions.set(sessionId, session);

  let stdoutBuffer = "";

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdoutBuffer += text;
    session.output += text;

    // 检测确认提示
    const detection = detectApprovalPrompt(stdoutBuffer);
    if (detection) {
      session.status = "waiting_approval";
      session.onApproval(detection);
      stdoutBuffer = ""; // 清空缓冲区
      return;
    }

    session.onOutput(text);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    session.output += chunk.toString();
    session.onOutput(chunk.toString());
  });

  proc.on("close", (code) => {
    session.status = code === 0 ? "done" : "error";
    session.onDone(code || 0);
    activeSessions.delete(sessionId);
  });

  return session;
}

export function sendApproval(sessionId: string, answer: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== "waiting_approval") return false;

  session.proc.stdin?.write(answer + "\n");
  session.status = "running";
  return true;
}

export function cancelExecution(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.proc.kill("SIGTERM");
  activeSessions.delete(sessionId);
  return true;
}

export function getSessionStatus(sessionId: string) {
  return activeSessions.get(sessionId);
}
```

- [ ] **Step 4: 创建 server.ts**

创建 `modules/runner/server.ts`：

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { startExecution, sendApproval, cancelExecution, getSessionStatus } from "./executor.js";

const app = new Hono();

// API Key 认证中间件
const API_KEY = process.env.RUNNER_API_KEY || "";

app.use("*", async (c, next) => {
  if (API_KEY) {
    const key = c.req.header("X-API-Key");
    if (key !== API_KEY) return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// 启动执行（SSE 流式返回）
app.post("/run", async (c) => {
  const { command, sessionId, input } = await c.req.json();

  return streamSSE(c, async (stream) => {
    const sid = sessionId || `run-${Date.now()}`;

    startExecution(sid, command, input, {
      onOutput: (text) => {
        stream.writeSSE({ data: JSON.stringify({ type: "output", text }) });
      },
      onApproval: (detection) => {
        stream.writeSSE({
          data: JSON.stringify({
            type: "approval_required",
            sessionId: sid,
            prompt: detection.prompt,
            options: detection.options,
            detail: detection.detail
          })
        });
      },
      onDone: (code) => {
        stream.writeSSE({ data: JSON.stringify({ type: "done", code }) });
        stream.close();
      }
    });
  });
});

// 下发用户确认结果
app.post("/approval", async (c) => {
  const { sessionId, answer } = await c.req.json();
  const ok = sendApproval(sessionId, answer);
  if (ok) return c.json({ ok: true });
  return c.json({ error: "No pending approval" }, 404);
});

// 取消执行
app.post("/cancel", async (c) => {
  const { sessionId } = await c.req.json();
  const ok = cancelExecution(sessionId);
  return c.json({ ok });
});

// 状态查询
app.get("/status", (c) => {
  const sessionId = c.req.query("session");
  if (sessionId) {
    const s = getSessionStatus(sessionId);
    return c.json(s ? { status: s.status, outputLength: s.output.length } : { status: "not_found" });
  }
  return c.json({ status: "ok" });
});

// 健康检查
app.get("/health", (c) => c.json({ status: "ok" }));

const port = parseInt(process.env.RUNNER_PORT || "9090");
console.log(`[runner] listening on port ${port}`);
serve({ fetch: app.fetch, port });
```

- [ ] **Step 5: 验证编译**

```bash
bun run build
```

- [ ] **Step 6: 提交**

```bash
git add modules/runner/ package.json bun.lockb
git commit -m "feat: add distributed Runner with interactive approval support"
```

---

## Task 8: RunnerAdapter（Gateway 侧客户端）

**Goal:** 实现 Gateway 侧的 Runner 客户端适配器，通过 SSE 流式通信。

**Files:**
- Create: `modules/runner/runner-adapter.ts`

- [ ] **Step 1: 创建 runner-adapter.ts**

创建 `modules/runner/runner-adapter.ts`：

```typescript
import type { AgentAdapter } from "../core/AgentAdapter.js";
import type { AgentResponse, AgentStatus, RunnerSSEEvent } from "../core/types.js";

export interface RunnerAdapterCallbacks {
  onProgress?: (text: string) => void;
  onApproval?: (req: { sessionId: string; prompt: string; options: string[]; detail: string }) => void;
}

/**
 * Runner 客户端适配器
 * 部署在 Gateway 侧，通过 HTTP/SSE 与远程 Runner 通信
 */
export class RunnerAdapter implements AgentAdapter {
  id: string;
  type: string;
  host: string;
  private apiKey?: string;
  private callbacks?: RunnerAdapterCallbacks;

  constructor(id: string, type: string, host: string, apiKey?: string, callbacks?: RunnerAdapterCallbacks) {
    this.id = id;
    this.type = type;
    this.host = host;
    this.apiKey = apiKey;
    this.callbacks = callbacks;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    return h;
  }

  async sendMessage(text: string, sessionId?: string): Promise<AgentResponse> {
    const res = await fetch(`http://${this.host}/run`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ command: this.type, sessionId, input: text })
    });

    if (!res.ok) {
      throw new Error(`Runner error: ${res.status}`);
    }

    // 解析 SSE 流
    return this.processSSEStream(res, sessionId || "");
  }

  private async processSSEStream(res: Response, fallbackSessionId: string): Promise<AgentResponse> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let sessionId = fallbackSessionId;
    let status: AgentResponse["status"] = "working";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        try {
          const event: RunnerSSEEvent = JSON.parse(data);

          switch (event.type) {
            case "output":
              fullText += event.text || "";
              this.callbacks?.onProgress?.(event.text || "");
              break;

            case "approval_required":
              sessionId = event.sessionId || sessionId;
              status = "waiting_approval";
              this.callbacks?.onApproval?.({
                sessionId,
                prompt: event.prompt || "",
                options: event.options || [],
                detail: event.detail || ""
              });
              break;

            case "done":
              status = "done";
              break;

            case "error":
              status = "error";
              fullText += event.text || "";
              break;
          }
        } catch {
          // 忽略解析错误
        }
      }
    }

    return { text: fullText, sessionId, status };
  }

  async getStatus(): Promise<AgentStatus> {
    try {
      const res = await fetch(`http://${this.host}/status`, { headers: this.headers });
      if (!res.ok) return { online: false, busy: false };
      const data = await res.json() as any;
      return {
        online: true,
        busy: data.status === "running" || data.status === "waiting_approval"
      };
    } catch {
      return { online: false, busy: false };
    }
  }

  async cancel(_sessionId?: string): Promise<void> {
    await fetch(`http://${this.host}/cancel`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ sessionId: _sessionId })
    });
  }

  async connect(): Promise<void> {
    const status = await this.getStatus();
    if (!status.online) {
      console.warn(`[runner-adapter] Runner at ${this.host} is not reachable`);
    }
  }

  async disconnect(): Promise<void> {}

  async healthCheck(): Promise<boolean> {
    const status = await this.getStatus();
    return status.online;
  }

  /** 转发用户确认结果到 Runner */
  async sendApprovalResponse(sessionId: string, answer: string): Promise<void> {
    await fetch(`http://${this.host}/approval`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ sessionId, answer })
    });
  }
}
```

- [ ] **Step 2: 验证编译**

```bash
bun run build
```

- [ ] **Step 3: 提交**

```bash
git add modules/runner/runner-adapter.ts
git commit -m "feat: add RunnerAdapter for Gateway-side SSE client with approval forwarding"
```

---

## Task 9: 配置加载和 Agent 注册

**Goal:** 实现 YAML 配置加载，支持环境变量替换，启动时注册所有 Agent 实例。

**Files:**
- Create: `config.yaml`
- Modify: `index.ts` (启动时加载配置并注册 Agent)

- [ ] **Step 1: 添加 js-yaml 依赖**

```bash
bun add js-yaml
bun add -d @types/js-yaml
```

- [ ] **Step 2: 创建 config.yaml**

创建 `config.yaml`：

```yaml
# AI Gateway 配置
channels:
  wechat:
    enabled: false
    type: ilink
  telegram:
    enabled: false
    type: telegram
    bot_token: ${TELEGRAM_BOT_TOKEN}
    allowed_users: []
  feishu:
    enabled: false
    type: feishu
    app_id: ${FEISHU_APP_ID}
    app_secret: ${FEISHU_APP_SECRET}

agents:
  # 示例配置（按实际环境修改）
  # claw-home:
  #   type: openclaw
  #   host: 192.168.1.100:8080
  # hermes-main:
  #   type: hermes
  #   host: 192.168.1.101:3000
  # cc-home:
  #   type: claude-code
  #   host: 192.168.1.100:9090
  #   runner: true

routing:
  default_agent: ""
  session_timeout: 1800000
  message_max_length: 2000

notifications:
  on_complete: true
  on_error: true
  on_milestone: true
  piggyback: true

storage:
  db_path: ./data/gateway.db
  retention_days: 30
```

- [ ] **Step 3: 读取 index.ts 了解启动流程**

```bash
cat index.ts
```

了解 imtoagent 的启动入口和初始化流程。

- [ ] **Step 4: 在 index.ts 中集成配置加载和 Agent 注册**

在 `index.ts` 的启动流程中加入：

```typescript
import { readFileSync } from "fs";
import { parse as parseYaml } from "js-yaml";
import { Router } from "./modules/core/Router.js";
import { NotificationQueue } from "./modules/core/NotificationQueue.js";
import { HermesAdapter } from "./modules/agent/hermes-adapter.js";
import { RunnerAdapter } from "./modules/runner/runner-adapter.js";
import * as agentStore from "./modules/store/agent-store.js";
import { getDb } from "./modules/store/db.js";

// 加载配置（支持环境变量替换）
function loadConfig(path: string) {
  let content = readFileSync(path, "utf-8");
  content = content.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || "");
  return parseYaml(content) as any;
}

// 根据配置创建 Agent Adapter
function createAdapter(agentId: string, config: any, callbacks?: any) {
  if (config.runner) {
    return new RunnerAdapter(agentId, config.type, config.host, config.apiKey, callbacks);
  }
  switch (config.type) {
    case "hermes":
      return new HermesAdapter(agentId, config.host, config.apiKey);
    case "openclaw":
    case "claude-code":
    case "opencode":
      // 如果没有 runner 标记但类型是 CLI 工具，也用 RemoteAPIAdapter
      // （imtoagent 已有的适配器，此处简化处理）
      return new RunnerAdapter(agentId, config.type, config.host, config.apiKey, callbacks);
    default:
      throw new Error(`Unknown agent type: ${config.type}`);
  }
}

// 主启动流程（集成到 imtoagent 现有启动中）
async function main() {
  const config = loadConfig("./config.yaml");
  const dbPath = config.storage.db_path;

  // 初始化数据库
  getDb(dbPath);

  // 注册 Agent 实例
  const agentConfigs = Object.entries(config.agents).map(([id, cfg]: [string, any]) => ({
    id, ...cfg
  }));

  for (const agent of agentConfigs) {
    agentStore.upsertAgent(dbPath, agent);
  }

  // 创建 Router
  const router = new Router(agentConfigs, config.routing.default_agent);

  // 创建 NotificationQueue
  const notificationQueue = new NotificationQueue(dbPath);

  // ... 继续 imtoagent 原有的启动流程
  // 将 router 和 notificationQueue 注入到 AgentRuntime 中
}

main().catch(console.error);
```

- [ ] **Step 5: 验证编译**

```bash
bun run build
```

- [ ] **Step 6: 提交**

```bash
git add config.yaml index.ts package.json bun.lockb
git commit -m "feat: add YAML config loading with env var substitution and agent registration"
```

---

## Task 10: AgentRuntime 集成路由和通知

**Goal:** 修改 AgentRuntime，将消息路由、确认检测、捎带通知集成到消息处理流程中。

**Files:**
- Modify: `modules/core/AgentRuntime.ts`

- [ ] **Step 1: 读取 AgentRuntime.ts**

```bash
cat modules/core/AgentRuntime.ts
```

了解现有消息处理流程：收到消息 → 找到 Agent → 调用 sendMessage → 返回结果。

- [ ] **Step 2: 修改消息处理流程**

在 `AgentRuntime.ts` 中集成 Router 和 NotificationQueue：

```typescript
// 伪代码，展示需要改动的核心逻辑

import { Router } from "./Router.js";
import { NotificationQueue } from "./NotificationQueue.js";
import * as approvalStore from "../store/approval-store.js";
import * as sessionStore from "../store/session-store.js";

class AgentRuntime {
  private router: Router;
  private notificationQueue: NotificationQueue;
  private dbPath: string;

  // ... 现有属性

  constructor(config: any) {
    // ... 现有初始化
    this.router = new Router(config.agents, config.routing.default_agent);
    this.notificationQueue = new NotificationQueue(config.storage.db_path);
    this.dbPath = config.storage.db_path;
  }

  /**
   * 处理收到的消息（改造核心）
   */
  async handleMessage(channelId: string, chatId: string, userId: string, text: string) {
    // 1. 捎带通知检查（iLink）
    const pending = this.notificationQueue.flushPending(channelId, chatId);
    if (pending.length > 0) {
      for (const msg of pending) {
        await this.sendToChannel(channelId, chatId, msg);
      }
    }

    // 2. 检查是否有等待中的确认请求需要处理
    const activeSession = sessionStore.getActiveSession(this.dbPath, channelId, chatId);
    if (activeSession?.status === "waiting_approval") {
      const approvalReq = approvalStore.getPendingBySession(this.dbPath, activeSession.id);
      if (approvalReq) {
        const answer = this.parseApprovalAnswer(text);
        if (answer) {
          approvalStore.respondToRequest(this.dbPath, approvalReq.id, answer, answer === "n" ? "denied" : "approved");
          // 转发给 Runner
          const adapter = this.getAdapter(activeSession.agent_id);
          if (adapter instanceof RunnerAdapter) {
            await adapter.sendApprovalResponse(activeSession.agent_session_id, answer);
          }
          sessionStore.updateSessionStatus(this.dbPath, activeSession.id, "busy");
          await this.sendToChannel(channelId, chatId, `✅ 已发送确认：${answer}`);
          return;
        }
      }
    }

    // 3. 路由解析
    const route = this.router.parse(text);

    // 系统指令
    if (route.target === "__system__") {
      return this.handleSystemCommand(channelId, chatId, route.message);
    }

    // 错误处理（未找到、歧义）
    if (route.target === "__not_found__" || route.target === "__ambiguous__") {
      await this.sendToChannel(channelId, chatId, route.message);
      return;
    }

    // 4. 获取或创建会话
    const session = sessionStore.getOrCreateSession(this.dbPath, route.target, channelId, chatId);

    // 5. 发送 typing 状态
    await this.sendTyping(channelId, chatId);

    // 6. 记录用户消息
    conversationStore.saveMessage(this.dbPath, route.target, channelId, chatId, "user", route.message);

    // 7. 调用 Agent
    sessionStore.updateSessionStatus(this.dbPath, session.id, "busy", route.message.substring(0, 50));
    const adapter = this.getAdapter(route.target);

    try {
      const response = await adapter.sendMessage(route.message, session.agent_session_id);

      // 更新 Agent 侧会话 ID
      if (response.sessionId) {
        sessionStore.updateAgentSessionId(this.dbPath, session.id, response.sessionId);
      }

      // 记录 Agent 回复
      conversationStore.saveMessage(this.dbPath, route.target, channelId, chatId, "agent", response.text);

      // 回复用户
      await this.sendToChannel(channelId, chatId, response.text);

      // 更新状态
      sessionStore.updateSessionStatus(this.dbPath, session.id, "idle");
    } catch (err: any) {
      await this.sendToChannel(channelId, chatId, `❌ Agent 错误：${err.message}`);
      sessionStore.updateSessionStatus(this.dbPath, session.id, "idle");
    }
  }

  /** 系统指令处理 */
  private async handleSystemCommand(channelId: string, chatId: string, command: string) {
    const parts = command.split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case "/list": {
        const agents = this.router.getAllAgents();
        const list = agents.map(a => `  @${a.id} (${a.type} @ ${a.host})`).join("\n");
        await this.sendToChannel(channelId, chatId, `已注册的 Agent：\n${list}`);
        break;
      }
      case "/status": {
        const target = parts[1]?.replace("@", "");
        if (target) {
          const adapter = this.router.getAgent(target);
          if (!adapter) { await this.sendToChannel(channelId, chatId, `未找到 @${target}`); return; }
          const status = await this.getAdapter(target).getStatus();
          await this.sendToChannel(channelId, chatId,
            `@${target}: ${status.online ? "🟢 在线" : "🔴 离线"}${status.busy ? " (忙碌)" : ""}${status.currentTask ? `\n当前任务: ${status.currentTask}` : ""}`
          );
        } else {
          const agents = this.router.getAllAgents();
          const lines = [];
          for (const a of agents) {
            const status = await this.getAdapter(a.id).getStatus();
            lines.push(`@${a.id}: ${status.online ? "🟢" : "🔴"}${status.busy ? " ⏳" : ""}`);
          }
          await this.sendToChannel(channelId, chatId, lines.join("\n"));
        }
        break;
      }
      case "/help":
        await this.sendToChannel(channelId, chatId, [
          "可用指令：",
          "@别名 消息 — 发消息给指定 Agent",
          "@机器:类型 消息 — 按机器+类型路由",
          "/list — 列出所有 Agent",
          "/status [@agent] — 查看状态",
          "/switch @agent — 切换默认 Agent",
          "/cancel @agent — 取消任务",
          "/help — 帮助"
        ].join("\n"));
        break;
      // ... 其他指令
    }
  }

  /** 解析确认回复 */
  private parseApprovalAnswer(text: string): string | null {
    const t = text.trim().toLowerCase();
    if (["y", "yes", "是", "同意", "批准"].includes(t)) return "y";
    if (["n", "no", "否", "拒绝", "deny"].includes(t)) return "n";
    if (["a", "always", "总是"].includes(t)) return "a";
    if (["d", "done", "完成"].includes(t)) return "d";
    return null;
  }
}
```

- [ ] **Step 3: 验证编译**

```bash
bun run build
```

- [ ] **Step 4: 提交**

```bash
git add modules/core/AgentRuntime.ts
git commit -m "feat: integrate Router, NotificationQueue, and approval handling into AgentRuntime"
```

---

## Task 11: iLink Channel 捎带通知增强

**Goal:** 增强 iLink Channel，在用户发消息时自动检查并推送 pending notifications。

**Files:**
- Modify: `modules/im/wechat.ts`

- [ ] **Step 1: 读取 wechat.ts**

```bash
cat modules/im/wechat.ts
```

了解 iLink Channel 的消息接收和发送流程。

- [ ] **Step 2: 在消息接收处加入捎带检查**

在 `wechat.ts` 的消息处理回调中，收到用户消息后：

```typescript
// 在收到用户消息的回调处加入：
async function onUserMessage(msg: any, text: string) {
  const chatId = msg.from_user_id;
  const contextToken = msg.context_token;

  // 捎带通知检查
  const pending = notificationQueue.flushPending("wechat", chatId);
  if (pending.length > 0) {
    for (const notification of pending) {
      await sendText(baseUrl, botToken, chatId, contextToken, notification);
    }
  }

  // 继续正常消息处理...
  await agentRuntime.handleMessage("wechat", chatId, userId, text);
}
```

- [ ] **Step 3: 验证编译**

```bash
bun run build
```

- [ ] **Step 4: 提交**

```bash
git add modules/im/wechat.ts
git commit -m "feat: enhance iLink channel with piggyback notification on message receive"
```

---

## Task 12: 集成验证和端到端测试

**Goal:** 验证完整流程：配置加载 → Agent 注册 → 消息路由 → 回复用户。

**Files:**
- Create: `tests/integration.test.ts` (或 imtoagent 的测试目录)

- [ ] **Step 1: 启动 Gateway 并验证配置加载**

```bash
bun run index.ts
```

确认：
- 配置文件加载成功
- SQLite 数据库创建成功
- Agent 注册成功（查日志）

- [ ] **Step 2: 验证 /list 指令**

在微信/Telegram 中发送 `/list`，确认返回已注册的 Agent 列表。

- [ ] **Step 3: 验证 @路由指令**

发送 `@claw-home hello`，确认消息被正确路由到 claw-home Agent。

- [ ] **Step 4: 验证 /status 指令**

发送 `/status`，确认返回所有 Agent 的在线状态。

- [ ] **Step 5: 验证 iLink 捎带通知**

1. 让一个 Agent 执行长任务
2. 任务完成时触发通知（存入 notification queue）
3. 发送新消息，确认捎带通知先于回复出现

- [ ] **Step 6: 验证确认流程（如 Agent 触发）**

1. 发送需要确认的指令
2. 确认 Runner 检测到 approval prompt
3. 确认 Gateway 转发确认消息到 IM
4. 回复 "y"，确认 Agent 继续执行

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "chore: integration verification complete"
```

---

## 自检清单

- [ ] 所有新增文件都有明确职责，无重复
- [ ] 类型定义在 Task 2 中统一定义，后续 task 引用一致
- [ ] SQLite schema 在 Task 3 中定义，包含所有必要的表和索引
- [ ] Router 支持所有约定的格式（@别名、@机器:类型、@类型、/command）
- [ ] NotificationQueue 正确区分 canPush/不能 push 的 Channel
- [ ] Runner 支持交互式确认（SSE 流式 + /approval 回调）
- [ ] 配置支持环境变量替换
- [ ] 对话历史保留 30 天
- [ ] 实施计划与 spec 设计文档一致
