# CC Gateway SDK 接口文档

> 版本: v1.1.0  
> 最后更新: 2026-05-16  
> 项目位置: `~/Desktop/cc-gateway/`

---

## 目录

- [1. 架构总览](#1-架构总览)
- [2. 核心概念](#2-核心概念)
- [3. AgentAdapter — Agent 后端适配器](#3-agentadapter--agent-后端适配器)
- [4. IMAdapter — IM 平台适配器（规划中）](#4-imadapter--im-平台适配器规划中)
- [5. 核心类型定义](#5-核心类型定义)
- [6. AgentRuntime — 运行时编排器](#6-agentruntime--运行时编排器)
- [7. SessionManager — 会话管理](#7-sessionmanager--会话管理)
- [8. ErrorHandler — 错误处理](#8-errorhandler--错误处理)
- [9. StatsTracker — 统计追踪](#9-statstracker--统计追踪)
- [10. 统一输出块系统](#10-统一输出块系统)
- [11. 如何实现新的 Adapter](#11-如何实现新的-adapter)

---

## 1. 架构总览

CC Gateway 是一个统一网关，将多个 IM 平台（飞书等）与多个 AI Agent 后端（Claude Code、Codex CLI、OpenCode 等）桥接起来。SDK 定义了标准接口层，使新模块可以独立开发、即插即用。

```
┌─────────────┐    ┌──────────────────────────────────┐    ┌─────────────┐
│  IM 平台 A   │    │         CC Gateway SDK           │    │  Agent 后端 X │
│  (飞书/… )   │◄──►│                                  │◄──►│ (Claude/…)  │
├─────────────┤    │  ┌──────────────────────────┐    │    ├─────────────┤
│  IM 平台 B   │    │  │     AgentRuntime         │    │    │  Agent 后端 Y │
│  (微信/… )   │◄──►│  │                          │    │    │ (Gemini/…)  │
├─────────────┤    │  │  Session │ Error │ Stats  │    │    ├─────────────┤
│  IM 平台 C   │    │  └──────────────────────────┘    │    │  Agent 后端 Z │
│  (Slack/… ) │◄──►│       ▲              ▲            │◄──►│ (DeepSeek/…) │
└─────────────┘    │       │              │            │    └─────────────┘
                   │  IMAdapter      AgentAdapter      │
                   └──────────────────────────────────┘
```

**职责分层：**

| 层级 | 组件 | 职责 |
|------|------|------|
| IM 层 | `IMAdapter` (规划中) | 连接 IM 平台，收发消息，声明输出能力 |
| SDK 核心 | `AgentRuntime` | 会话生命周期、统计、错误处理、编排 |
| Agent 层 | `AgentAdapter` | 对接具体 AI 后端，接收输入、返回输出 |
| 输出层 | `UnifiedBlock` + `parseToBlocks` | 统一富文本格式，IM 能力适配 |

---

## 2. 核心概念

### 2.1 Bot

一个 Bot 是一个独立的 AI 助手实例，绑定一个 IM 应用（如一个飞书自建应用）和一个 Agent 后端。每个 Bot 有独立的：
- 灵魂文件（`soul/<BotName>/*.md`）
- 会话存储（`sessions/<BotName>/*.memory.json`）
- 模型配置

### 2.2 Session

Session 代表一个对话会话的生命周期。SDK 统一了不同 Agent 后端的会话概念：
- **Claude**: SDK session ID（持久化会话）
- **Codex**: thread ID（app-server 或 CLI）
- **OpenCode**: session ID（HTTP API）

所有特定后端的 ID 统一存放在 `Session.metadata` 中。

### 2.3 消息处理流程

```
用户消息 → IMAdapter → Bot.handleMessage()
                        → AgentRuntime.processMessage()
                          → SessionManager.getOrCreate()  ← 获取会话
                          → StatsTracker.resetForCall()   ← 重置统计
                          → ctx.sendProgress()            ← 进度提示
                          → AgentAdapter.handleMessage()  ← 调用后端
                          → StatsTracker.accumulate()     ← 累加统计
                          → ctx.reply() / ctx.sendBlocks()← 发送回复
                          → SessionManager.persist()      ← 持久化
```

---

## 3. AgentAdapter — Agent 后端适配器

### 3.1 接口定义

位置: `modules/core/types.ts`

```typescript
export interface AgentAdapter {
  /** 适配器名称，用于日志和错误信息 */
  readonly name: string;

  /**
   * 处理单条用户消息
   * @param input 标准化输入，包含会话、文本、工作目录等
   * @returns 标准化输出，包含回复文本、统计信息等
   */
  handleMessage(input: AgentInput): Promise<AgentOutput>;

  /** 健康检查（可选） */
  healthCheck?(): Promise<boolean>;

  /** 取消正在进行的会话（可选） */
  cancel?(sessionId: string): Promise<void>;
}
```

### 3.2 AgentInput — 输入结构

```typescript
export interface AgentInput {
  /** 聊天 ID，用于会话隔离 */
  chatId: string;

  /** 用户消息文本 */
  text: string;

  /** 当前会话对象（可读写，持久化由 Runtime 负责） */
  session: Session;

  /** 工作目录（Agent 操作的文件系统根目录） */
  workingDir: string;

  /** 系统提示词（可选，由调用方注入灵魂 + IM 能力） */
  systemPrompt?: string;

  /** 模型规格（如 "deepseek/deepseek-v4-pro"） */
  model: string;
}
```

### 3.3 AgentOutput — 输出结构

```typescript
export interface AgentOutput {
  /** 回复文本（会被 parseToBlocks 解析为统一块） */
  text?: string;

  /** 工具调用记录（日志用途） */
  toolCalls?: Array<{ name: string; summary: string }>;

  /** 用量统计（SDK Runtime 会累加到 Session.stats） */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUSD?: number;
    durationMs?: number;
    numTurns?: number;
  };

  /** 错误信息（设置此项等同于抛出异常） */
  error?: string;
}
```

### 3.4 已有实现

| 适配器 | 文件 | 后端 | 多轮会话机制 | 生命周期 |
|--------|------|------|-------------|---------|
| `ClaudeAdapter` | `modules/agent/claude-adapter.ts` | Claude Agent SDK | SDK session ID resume | — |
| `CodexAdapter` | `modules/agent/codex-adapter.ts` | Codex CLI | app-server thread / CLI thread ID | — |
| `OpenCodeAdapter` | `modules/agent/opencode-adapter.ts` | OpenCode HTTP API | session ID + turn loop | ✅ 自动启停 |

### 3.5 适配器生命周期 — 后端服务管理

某些 Agent 后端运行独立的服务进程（如 OpenCode 的 `opencode serve`），适配器模块应自行管理其生命周期，而不是由 Gateway 主入口硬编码。

**约定：** 需要管理后端的适配器模块导出两个模块级函数：

```typescript
// modules/agent/opencode-adapter.ts

/** 启动后端服务（幂等：已有运行中的服务则复用） */
export async function startOpenCodeServer(): Promise<void>;

/** 停止后端服务 */
export async function stopOpenCodeServer(): Promise<void>;
```

**调用位置：**

```
main() 启动时：
  ├─ 遍历 config.bots，收集唯一的 backend 类型
  ├─ if hasOpenCodeBot → await startOpenCodeServer()
  ├─ if hasOtherBackend → await startOtherServer()    ← 未来扩展
  └─ 初始化 Bot 实例

gracefulReload() 重载时：
  ├─ await stopOpenCodeServer()
  ├─ await stopOtherServer()    ← 未来扩展
  └─ 重启自身
```

**设计原则：**

- **按需启动**：只有配置了对应 backend 的 bot 时才启动服务，未配置则零开销
- **模块自治**：每个适配器模块完全掌管自己后端的启停、健康检查、日志收集
- **幂等**：`start()` 先检查是否已有服务运行，有则复用；`stop()` 可安全重复调用
- **Gateway 只编排**：Gateway 主入口只负责"有哪些 backend 需要启动"，不关心具体如何启动

**完整示例（OpenCode）：**

```typescript
let _ocProcess: ReturnType<typeof Bun.spawn> | null = null;

export async function startOpenCodeServer(): Promise<void> {
  // 先检查是否已有服务在运行
  try {
    const res = await fetch('http://127.0.0.1:4096/global/health', { signal: AbortSignal.timeout(3000) });
    if (res.ok) return; // 复用已有
  } catch {}

  // 启动新进程
  const child = Bun.spawn(['opencode', 'serve', '--port', '4096'], {
    cwd: process.env.HOME + '/Desktop/cc-gateway',
    env: { ...process.env, ANTHROPIC_API_KEY: 'cc-gateway-local' },
    stdout: 'pipe', stderr: 'pipe',
  });

  // 后台收集日志
  (async () => {
    for await (const line of (child.stdout as any)) {
      console.log(`[OpenCode] ${new TextDecoder().decode(line).trim()}`);
    }
  })().catch(() => {});

  // 轮询健康检查（最多 15 秒）
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (child.exitCode != null) throw new Error(`进程退出 exitCode=${child.exitCode}`);
    try {
      const res = await fetch('http://127.0.0.1:4096/global/health', { signal: AbortSignal.timeout(2000) });
      if (res.ok) { _ocProcess = child; return; }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  child.kill('SIGTERM');
  throw new Error('服务启动超时');
}

export async function stopOpenCodeServer(): Promise<void> {
  if (_ocProcess) {
    _ocProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1000));
    _ocProcess = null;
  }
}
```

### 3.6 适配器开发清单

实现一个新的 AgentAdapter 需要：

- [ ] 实现 `handleMessage(input): Promise<AgentOutput>`
- [ ] 管理后端特有的会话 ID（存入 `input.session.metadata`）
- [ ] 处理多轮对话（resume / 新建）
- [ ] 返回用量统计（`usage` 字段）
- [ ] 处理 `startFresh`：读取后**立即清零**，若为 true 则删除旧后端会话、创建新会话（不 resume）
- [ ] 实现 `healthCheck?()`（可选）
- [ ] 实现 `cancel?()`（可选）
- [ ] **如果后端是独立服务进程：** 导出 `start()` / `stop()` 模块级函数（参见 [3.5 适配器生命周期](#35-适配器生命周期--后端服务管理)）

**不需要关心：**
- ❌ Session 创建/持久化（Runtime 负责）
- ❌ 统计累加（StatsTracker 负责）
- ❌ 错误重试/降级（ErrorHandler 负责）
- ❌ 模型别名解析（调用方已解析后传入）

---

## 4. IMAdapter — IM 平台适配器（规划中）

> ⚠️ 当前 IM 层尚未标准化为 `IMAdapter` 接口。飞书模块直接使用 `FeishuIMModule` 类。
> 未来新增 IM 平台（微信、Slack、Telegram 等）时，建议先实现 `IMAdapter` 接口。

### 4.1 建议的接口定义

```typescript
export interface IMAdapter {
  /** 适配器名称 */
  readonly name: string;

  /** 声明此 IM 平台的输出能力 */
  getCapabilities(): IMCapabilities;

  /** 启动消息监听 */
  start(handler: MessageHandler): void;

  /** 停止监听 */
  stop(): void;

  /** 发送文本消息 */
  reply(chatId: string, text: string, maxLen?: number): Promise<void>;

  /** 发送进度/临时消息 */
  sendProgress(chatId: string, text: string): Promise<void>;

  /** 发送富文本块（统一格式） */
  sendBlocks(chatId: string, blocks: UnifiedBlock[]): Promise<void>;

  /** 发送图片 */
  sendImage(chatId: string, imageKey: string, alt?: string): Promise<void>;

  /** 发送文件 */
  sendFile(chatId: string, fileKey: string, fileName: string): Promise<void>;
}

/** 消息处理回调 */
export type MessageHandler = (chatId: string, text: string, userId: string) => Promise<void>;
```

### 4.2 IMCapabilities — 能力声明

```typescript
export interface IMCapabilities {
  text: boolean;           // 纯文本消息
  codeBlock: boolean;      // 代码块渲染
  cardMessage: boolean;    // 富文本卡片/消息
  fileSend: boolean;       // 文件发送
  imageSend: boolean;      // 图片发送
  audioSend: boolean;      // 语音/音频发送
  buttonAction: boolean;   // 按钮交互
  maxTextLength: number;   // 单条消息最大长度
}
```

能力声明决定了两件事：
1. **注入到 Agent 的 system prompt**（告诉 Agent 它能用什么格式输出）
2. **`parseToBlocks` 的解析行为**（只解析有能力渲染的块类型）

### 4.3 飞书能力示例

```typescript
// FeishuIMModule.getCapabilities() 返回：
{
  text: true,
  codeBlock: true,       // 卡片内 markdown 支持 ```
  cardMessage: true,     // 富文本卡片消息
  fileSend: true,        // 飞书文件消息
  imageSend: true,       // 飞书图片消息
  buttonAction: true,    // 卡片按钮
  maxTextLength: 30000,
}
```

---

## 5. 核心类型定义

### 5.1 Session — 统一会话

位置: `modules/core/types.ts`

```typescript
export interface Session {
  chatId: string;              // 聊天 ID
  userId: string;              // 用户 ID
  cwd?: string;                // 工作目录
  startFresh: boolean;         // 下次消息是否清空会话

  backendSessionId?: string;   // 通用后端会话 ID

  metadata: Record<string, any>; // 后端特有元数据
  // 常见字段:
  //   metadata.sdkSessionId   — Claude SDK 会话 ID
  //   metadata.codexThreadId  — Codex thread ID
  //   metadata.ocSessionId    — OpenCode session ID

  stats: CallStats;            // 调用统计
  lastUsed: number;            // 最后使用时间（毫秒时间戳）
  running: boolean;            // 是否正在处理消息
  permissionMode?: string;     // 权限模式 (Claude: bypassPermissions/default/plan)
  codexMode?: string;          // Codex 模式 (auto/plan)
  recentMessages: string[];    // 最近消息历史
}
```

### 5.2 CallStats — 调用统计

```typescript
export interface CallStats {
  calls: number;              // 调用次数
  totalTurns: number;         // 总轮数
  totalInputTokens: number;   // 总输入 token
  totalOutputTokens: number;  // 总输出 token
  totalCostUSD: number;       // 总费用 (USD)
  totalDurationMs: number;    // 总耗时 (毫秒)
}
```

### 5.3 MessageContext — 消息处理上下文

```typescript
export interface MessageContext {
  chatId: string;
  text: string;
  userId: string;
  workingDir: string;
  model: string;
  systemPrompt?: string;

  reply: (text: string) => Promise<void>;            // 发送文本回复
  sendProgress: (text: string) => Promise<void>;     // 发送进度消息
  sendBlocks?: (blocks: UnifiedBlock[]) => Promise<void>;  // 发送富文本
}
```

### 5.4 错误处理类型

```typescript
/** 错误处理动作 */
export type ErrorAction =
  | { type: 'reply'; message: string }      // 回复用户
  | { type: 'retry'; maxAttempts: number }  // 重试
  | { type: 'fallback'; adapter: string };   // 降级到其他适配器

/** 错误上下文 */
export interface ErrorContext {
  chatId: string;
  backend: string;   // 后端名称
  attempt: number;   // 当前重试次数
}
```

---

## 6. AgentRuntime — 运行时编排器

位置: `modules/core/runtime.ts`

### 6.1 构造函数

```typescript
import { AgentRuntime, DefaultErrorHandler, DefaultStatsTracker } from './modules/core';

const runtime = new AgentRuntime({
  sessionManager: mySessionManager,    // Session 管理器
  errorHandler: new DefaultErrorHandler(),  // 错误处理器
  configManager: myConfigManager,      // 配置管理器
  statsTracker: new DefaultStatsTracker(), // 统计追踪器
});
```

### 6.2 注册适配器

```typescript
runtime.registerAdapter('claude', new ClaudeAdapter(ctx));
runtime.registerAdapter('codex', new CodexAdapter(ctx));
runtime.registerAdapter('opencode', new OpenCodeAdapter(ctx));
```

### 6.3 处理消息

```typescript
await runtime.processMessage(
  messageContext,   // MessageContext
  agentAdapter,     // AgentAdapter 实例
  'MyBot'           // Bot 名称（用于 session 隔离）
);
```

### 6.4 处理流程

```
processMessage() 内部流程：
  1. getOrCreate session ← sessionManager
  2. startFresh? → 清除旧 backendSessionId
  3. resetForCall() ← statsTracker
  4. sendProgress("💭 思考中...")
  5. adapter.handleMessage(input)
  6. 成功 → accumulate() + reply()
  7. 失败 → errorHandler.handle() → retry / fallback / reply
  8. persist() ← sessionManager
```

### 6.5 其他方法

```typescript
// 健康检查
await runtime.healthCheck('claude');  // → boolean

// 取消会话
await runtime.cancelSession('claude', sessionId);
```

---

## 7. SessionManager — 会话管理

位置: `modules/core/session.ts`

### 7.1 接口定义

```typescript
export interface SessionManager {
  getOrCreate(botName: string, chatId: string, userId: string): Promise<Session>;
  persist(botName: string, session: Session): void;
  delete(botName: string, chatId: string): void;
  cleanupIdle(botName: string, timeoutMs: number): void;
  listActive(botName: string): Session[];
}
```

### 7.2 FileSessionManager — 文件存储实现

SDK 提供 `FileSessionManager`，将会话持久化到 JSON 文件：

```
sessions/
├── BotAlpha/
│   ├── ou_xxx1.memory.json
│   ├── ou_xxx2.memory.json
│   └── _bot.json           ← Bot 级别配置
└── BotBeta/
    └── ou_yyy1.memory.json
```

**会话文件结构（新格式，向后兼容旧格式）：**

```json
{
  "chatId": "ou_xxx",
  "userId": "ou_xxx",
  "cwd": "/Users/keyi/Projects",
  "startFresh": false,
  "backendSessionId": "session-xxx",
  "stats": {
    "calls": 5,
    "totalTurns": 20,
    "totalInputTokens": 15000,
    "totalOutputTokens": 8000,
    "totalCostUSD": 0.1234,
    "totalDurationMs": 45000
  },
  "lastUsed": 1715846400000,
  "running": false,
  "recentMessages": ["你好", "帮我写个函数"],
  "metadata": {
    "sdkSessionId": "claude-session-xxx",
    "codexThreadId": "thread-xxx",
    "ocSessionId": "oc-session-xxx"
  },
  "permissionMode": "bypassPermissions",
  "codexMode": "auto"
}
```

**旧格式兼容：** 写入时会将 `metadata.sdkSessionId` 同时写入顶层 `sdkSessionId` 字段，确保旧版代码仍可读取。

---

## 8. ErrorHandler — 错误处理

位置: `modules/core/error.ts`

### 8.1 接口定义

```typescript
export interface ErrorHandler {
  handle(chatId: string, error: Error, ctx: ErrorContext): Promise<ErrorAction>;
}
```

### 8.2 DefaultErrorHandler 策略

| 错误类型 | 处理方式 |
|---------|---------|
| 网络超时 / 连接重置 | 自动重试（最多 2 次） |
| 429 限流 | 提取 Retry-After，等待后重试 |
| 5xx 服务端错误 | 自动重试 |
| 401/403 认证失败 | 直接返回用户提示 |
| 其他错误 | 截断到 100 字符返回 |

### 8.3 自定义错误处理器

```typescript
class MyErrorHandler implements ErrorHandler {
  async handle(chatId: string, error: Error, ctx: ErrorContext): Promise<ErrorAction> {
    // 自定义逻辑
    return { type: 'reply', message: '自定义错误消息' };
  }
}
```

---

## 9. StatsTracker — 统计追踪

位置: `modules/core/stats.ts`

### 9.1 接口定义

```typescript
export interface StatsTracker {
  resetForCall(session: Session): void;  // 调用开始时（calls +1）
  accumulate(session: Session, usage: {
    inputTokens: number;
    outputTokens: number;
    costUSD?: number;
    durationMs?: number;
    numTurns?: number;
  }): void;
  formatSummary(session: Session): string;  // 生成摘要字符串
}
```

### 9.2 DefaultStatsTracker

- `resetForCall()`: `session.stats.calls += 1`
- `accumulate()`: 累加 token、费用、耗时
- `formatSummary()`: 返回 `"📊 调用 5 次 | Token 23.0K | 费用 $0.1234 | 耗时 45s"`

---

## 10. 统一输出块系统

位置: `modules/capabilities.ts`

### 10.1 UnifiedBlock 类型

```typescript
export type UnifiedBlock =
  | { type: 'text'; content: string }
  | { type: 'code_block'; code: string; language: string; title?: string }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'card'; title: string; content: string; color?: string; buttons?: { label: string; url?: string }[] }
  | { type: 'table'; headers: string[]; rows: string[][]; caption?: string }
  | { type: 'file'; url: string; filename: string }
  | { type: 'audio'; url: string; filename: string; duration?: number }
  | { type: 'divider' };
```

### 10.2 parseToBlocks — 文本到块的解析

Agent 的输出文本会被 `parseToBlocks()` 解析为 `UnifiedBlock[]`。解析规则由 IM 能力决定：

| 能力 | 触发语法 | 生成的 Block |
|------|---------|-------------|
| `codeBlock` | ````language\ncode\n```` | `code_block` |
| `imageSend` | `![alt](url)` | `image` |
| `fileSend` | `📎 [name](file:///path)` | `file` |
| `audioSend` | `🎙️ [name](file:///path)` | `audio` |
| `cardMessage` | markdown 表格 `| col | col |` | `table` |

### 10.3 buildCapabilityPrompt

根据 `IMCapabilities` 生成注入到 Agent system prompt 的说明，告诉 Agent 它能用什么格式输出。能力与语法一一对应。

---

## 11. 如何实现新的 Adapter

### 11.1 实现新的 AgentAdapter

以接入一个假设的 "Gemini CLI" 为例：

```typescript
// modules/agent/gemini-adapter.ts
import type { AgentAdapter, AgentInput, AgentOutput } from '../core/types';

export interface GeminiAdapterContext {
  botName: string;
  // 其他需要的上下文
}

export class GeminiAdapter implements AgentAdapter {
  readonly name = 'Gemini CLI';
  private ctx: GeminiAdapterContext;

  constructor(ctx: GeminiAdapterContext) {
    this.ctx = ctx;
  }

  async handleMessage(input: AgentInput): Promise<AgentOutput> {
    const { text, session, workingDir, model } = input;

    // 1. 处理 startFresh
    if (session.startFresh) {
      session.metadata.geminiSessionId = undefined;
      session.startFresh = false;
    }

    // 2. 获取或创建后端会话
    const sessionId = session.metadata.geminiSessionId || await this.createNewSession(workingDir);
    session.metadata.geminiSessionId = sessionId;

    // 3. 调用后端 API
    const response = await this.callGemini(text, sessionId, workingDir, model);

    // 4. 返回结果（统计由 Runtime 累加）
    return {
      text: response.text,
      toolCalls: response.toolCalls,
      usage: {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUSD: response.costUSD,
        durationMs: response.durationMs,
        numTurns: response.numTurns,
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      // 检查 gemini CLI 是否可用
      return true;
    } catch {
      return false;
    }
  }

  private async createNewSession(cwd: string): Promise<string> {
    // ...创建后端会话的逻辑
    return 'new-session-id';
  }

  private async callGemini(text: string, sessionId: string, cwd: string, model: string) {
    // ...调用 Gemini 后端的逻辑
    return {
      text: 'response text',
      toolCalls: [],
      inputTokens: 1000,
      outputTokens: 500,
      costUSD: 0.005,
      durationMs: 3000,
      numTurns: 3,
    };
  }
}
```

**注册使用：**

```typescript
// index.ts 中
const geminiAdapter = new GeminiAdapter({ botName: 'MyBot' });
runtime.registerAdapter('gemini', geminiAdapter);
```

### 11.2 实现新的 IMAdapter（未来）

以接入 Telegram 为例：

```typescript
import type { IMAdapter, IMCapabilities, MessageHandler } from '../core/types';
import type { UnifiedBlock } from '../capabilities';

export class TelegramAdapter implements IMAdapter {
  readonly name = 'Telegram';
  private handler: MessageHandler | null = null;

  getCapabilities(): IMCapabilities {
    return {
      text: true,
      codeBlock: true,        // Telegram 支持 markdown
      cardMessage: false,     // Telegram 不支持富文本卡片
      fileSend: true,
      imageSend: true,
      audioSend: true,
      buttonAction: true,     // Telegram 支持 inline keyboard
      maxTextLength: 4096,    // Telegram 消息长度限制
    };
  }

  start(handler: MessageHandler): void {
    this.handler = handler;
    // 启动 Telegram bot 长轮询或 webhook
    // 收到消息时调用: this.handler(chatId, text, userId)
  }

  stop(): void {
    // 停止 bot
  }

  async reply(chatId: string, text: string, maxLen = 4096): Promise<void> {
    // 调用 Telegram API 发送文本消息
  }

  async sendProgress(chatId: string, text: string): Promise<void> {
    // 发送 "typing" 状态或临时消息
  }

  async sendBlocks(chatId: string, blocks: UnifiedBlock[]): Promise<void> {
    // 将 UnifiedBlock[] 翻译为 Telegram 消息
    // 注意：Telegram 不支持卡片，需要降级为纯文本/多消息
  }

  async sendImage(chatId: string, imageKey: string, alt?: string): Promise<void> {
    // 调用 Telegram API 发送图片
  }

  async sendFile(chatId: string, fileKey: string, fileName: string): Promise<void> {
    // 调用 Telegram API 发送文件
  }
}
```

### 11.3 Adapter 开发注意事项

**AgentAdapter 注意事项：**
- `handleMessage` 应该是**幂等的**（同样的输入产生同样的结果）
- 后端会话 ID 必须存储在 `session.metadata` 中
- 不要自己管理统计（`stats`），Runtime 会通过 `usage` 字段自动累加
- 超时/失败时**直接抛出异常**或设置 `output.error`，不要自己处理重试
- `startFresh` 表示用户要求清空会话，Adapter 应在 `handleMessage` 开头**读取后立即清零**：
  ```typescript
  const shouldClear = session.startFresh;
  session.startFresh = false;  // 必须清零，否则后续每条消息都 fresh
  // if (shouldClear) 删除旧后端会话、创建新会话
  ```
  常见错误：只读不清零（导致之后的消息都被当作 fresh），或完全不读（`/clear` 命令失效）
- **如果后端是独立服务进程**（类似 `opencode serve`），导出 `start()` / `stop()` 模块级函数，Gateway 会在 `main()` 和 `gracefulReload()` 中按需调用（参见 3.5 节）

**IMAdapter 注意事项（未来）：**
- `getCapabilities()` 应返回**真实能力**，不要虚报
- `sendBlocks()` 需要处理 IM 平台不支持的块类型（降级为纯文本）
- `maxTextLength` 应设置为 IM 平台的实际限制
- 消息回调中的 `chatId` 和 `userId` 必须与 `reply()` 的参数对应

---

## 附录：文件结构

```
modules/
├── core/                    ← SDK 核心
│   ├── types.ts             # 所有类型定义
│   ├── runtime.ts           # AgentRuntime 编排器
│   ├── session.ts           # FileSessionManager
│   ├── error.ts             # DefaultErrorHandler
│   ├── stats.ts             # DefaultStatsTracker
│   ├── config.ts            # FileConfigManager
│   └── index.ts             # 统一导出
│
├── agent/                   ← Agent 适配器
│   ├── claude-adapter.ts    # Claude Agent SDK
│   ├── codex-adapter.ts     # Codex CLI (app-server + CLI fallback)
│   └── opencode-adapter.ts  # OpenCode HTTP API
│
├── im/                      ← IM 适配器
│   └── feishu.ts            # 飞书 (FeishuIMModule)
│
├── capabilities.ts          # UnifiedBlock + parseToBlocks + 能力注入
├── prompt-builder.ts        # System Prompt 构建
├── bot-context.ts           # 当前 Bot 上下文共享
├── rate-limiter.ts          # 请求限流
├── proxy/                   ← 代理层
│   ├── anthropic-proxy.ts   # Claude Code → OpenAI 格式
│   └── codex-proxy.ts       # Responses API ↔ Chat Completions
└── types.ts                 # 旧接口定义（向后兼容）
```
