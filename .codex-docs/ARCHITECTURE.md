# IMtoAgent 架构文档

> 更新于 2026-05-10 · 完整双端可扩展架构

## 愿景

IMtoAgent 的长期目标是成为 **IM ↔ 多品种 Agent 系统的统一网关**。

### 为什么做这个

当前的 AI Agent 生态存在一个断层：
- **编程 Agent**（Claude Code、Codex、Cursor）绑定在终端和 IDE 上
- **通用对话 Agent**（ChatGPT、Claude.ai）绑定在网页和 App 上
- **企业 Agent**（Dify、Coze）绑定在各自控制台上

这些系统各自为战，没有一个统一的 **IM 入口**。IMtoAgent 的使命就是填这个缺口——让你在飞书（以及未来的微信、钉钉）里，像 @ 一个同事一样 @ 各种 Agent。

### 核心价值

> 拆掉 Agent 必须坐在电脑前的墙。Agent 不应只是 IDE 插件或终端命令，它应该是手机上、聊天框里随时能对话的智能伙伴。

### 非目标

- ❌ 不做新的 Agent 系统——只做"连接"，不造轮子
- ❌ 不做 Agent 编排/工作流——那是 Dify/Coze 的事
- ❌ 不做 Web/App 客户端——IM 就是唯一的 UI

---

## 全景架构

```
                       IMtoAgent
    ┌──────────────────────────────────────────────────┐
    │                                                    │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
    │  │ 飞书模块  │  │ 微信模块  │  │ 钉钉模块  │  ...   │  ← IM 端（可扩展）
    │  │ 消息收发  │  │ 消息收发  │  │ 消息收发  │        │    写 IM 模块
    │  │ 命令解析  │  │ 命令解析  │  │ 命令解析  │        │
    │  └────┬─────┘  └────┬─────┘  └────┬─────┘        │
    │       └──────────────┼─────────────┘              │
    │                      ↓                             │
    │              ┌──────────────┐                      │
    │              │  消息路由层   │  ← 不变核心           │
    │              │  会话归属    │    用户识别            │
    │              │  Bot 分发   │    命令体系            │
    │              └──────┬───────┘                      │
    │                     ↓                              │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
    │  │ Claude   │  │  Codex   │  │ ChatGPT  │  ...   │  ← Agent 端（可扩展）
    │  │  模块    │  │  模块    │  │  模块    │        │    写 Agent 模块
    │  │ ┌──────┐ │  │ ┌──────┐ │  │ ┌──────┐ │        │
    │  │ │Proxy │ │  │ │Proxy │ │  │ │直接  │ │        │
    │  │ │:18899│ │  │ │:18900│ │  │ │调API │ │        │
    │  │ └──────┘ │  │ └──────┘ │  │ └──────┘ │        │
    │  │ ┌──────┐ │  │ ┌──────┐ │  │          │        │
    │  │ │对接  │ │  │ │对接  │ │  │          │        │
    │  │ │SDK   │ │  │ │CLI   │ │  │          │        │
    │  │ └──────┘ │  │ └──────┘ │  │          │        │
    │  └────┬─────┘  └────┬─────┘  └────┬─────┘        │
    │       └──────────────┼─────────────┘              │
    │                      ↓                             │
    │              ┌──────────────┐                      │
    │              │  统一模型代理  │  ← 计费/管控/路由    │
    │              └──────────────┘                      │
    └──────────────────────────────────────────────────┘
                           ↓
              DeepSeek / OpenAI / Anthropic ...
```

## 三层结构

| 层 | 职责 | 举例 |
|----|------|------|
| **IM 端**（可扩展） | 收消息、回消息、命令解析、适配不同 IM SDK | 飞书/微信/钉钉模块 |
| **消息路由核心**（不变） | 用户识别、会话归属、Bot 分发、命令体系 | index.ts 内核 |
| **Agent 端**（可扩展） | 对接 Agent 系统 + 定制 Proxy 协议转换 | Claude/Codex/ChatGPT 模块 |

---

## 模块是什么

一个模块是**独立完整的功能单元**，包含该渠道/系统所需的全部定制逻辑。

### IM 模块

```
接收该 IM 的消息事件
  → 转成统一内部消息格式
  → 交给路由层
  → 收到 Agent 回复
  → 转回该 IM 的消息格式发回去
```

| 模块 | 状态 | 接入方式 |
|------|------|----------|
| 飞书 | ✅ 已实现 | WebSocket 长连接、卡片消息 |
| 企业微信 | 📅 规划 | 回调 URL 模式 |
| 微信公众号 | 📅 规划 | 被动回复模式 |
| 钉钉 | 📅 规划 | 机器人回调 |

### Agent 模块

```
收到统一消息
  → 调用 Agent 系统（SDK / CLI / API）
  → Proxy 截获模型请求（如果需要，协议转换）
  → 流式返回回复
  → 管理会话状态
```

| 模块 | Proxy | 对接方式 | 状态 |
|------|-------|----------|------|
| Claude Code | ✅ :18899 Anthropic ↔ Provider | spawn SDK | ✅ |
| Codex | ✅ :18900 Responses ↔ Chat Completions | exec-server WebSocket（优先）+ exec CLI 回退 | ✅ |
| ChatGPT | ❌ 无需 | 直接调 OpenAI API | 🔜 |
| Claude.ai | ❌ 无需 | 直接调 Anthropic API | 🔜 |
| Dify | ❌ 无需 | REST API | 🔜 |
| Coze | ❌ 无需 | REST API | 🔜 |
| Gemini | ❌ 无需 | 直接调 API | 📅 |

### 统一消息格式

IM 和 Agent 系统之间的消息格式各不相同。网关采用统一内部格式 + 能力降级机制处理差异。详见 [MESSAGE-FORMAT.md](./MESSAGE-FORMAT.md)。

### 为什么有些需要 Proxy、有些不需要？

```
Claude Code/Codex 是 SDK/CLI 形态：
  它们发模型请求时用的是自己特定的 API 协议
  但我们的 Provider（DeepSeek）只认标准格式
  → 需要 Proxy 在中间做"方言翻译"

ChatGPT/Dify/Gemini 是 REST API 形态：
  我们直接以标准格式调它们的 API
  → 不需要 Proxy
```

**Proxy 是定制的**——每个 Agent 系统的"方言"不同，所以每个需要 Proxy 的模块里的 Proxy 都是单独写的。

---

## 演化路线

```
Phase 1 ✅           Phase 2 📋            Phase 3-4 🔜          Phase 5 📅
┌──────────┐       ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│ 硬编码    │  →    │ 模块化重构    │  →   │ 通用/企业     │  →   │ 多 IM 渠道   │
│ 双 Bot    │       │ 标准化模块接口 │      │ Agent 接入    │      │ 微信/钉钉    │
│ Claude    │       │ Proxy独立    │      │ ChatGPT/Dify   │      │              │
│ + Codex   │       │              │      │ Coze 等       │      │              │
└──────────┘       └──────────────┘      └──────────────┘      └──────────────┘
```

| 阶段 | 目标 | 关键产出 |
|------|------|----------|
| Phase 1 | 飞书 ↔ Claude Code / Codex（编程双 Bot + 完整统计） | ✅ 已完成 |
| Phase 2 | 模块化重构：标准化模块接口，Proxy 独立 | IM 模块接口 + Agent 模块接口 |
| Phase 3 | 通用对话 Agent（ChatGPT、Claude.ai） | 非程序员也能用 |
| Phase 4 | 低代码 Agent 平台（Dify、Coze） | 企业可定制 Agent |
| Phase 5 | 多 IM 渠道 | 微信、钉钉适配器 |

---

## 模块接口设计（Phase 2 规划）

### Agent 模块接口

```typescript
interface AgentModule {
  // 元信息
  readonly name: string
  readonly capabilities: AgentCapabilities

  // 核心方法
  send(message: string, context: SendContext): AsyncIterable<ResponseChunk>
  resume(sessionId: string): SessionState | null
  clear(sessionId: string): void
  
  // 生命周期
  start(): Promise<void>    // 启动（含 Proxy 端口监听）
  stop(): Promise<void>     // 停止（含 Proxy 端口释放）
}

interface AgentCapabilities {
  streaming: boolean
  imageInput: boolean
  fileUpload: boolean
  maxContextTokens: number
  availableModels: string[]
  commands: CommandDef[]         // 该 Agent 专有命令
}

interface SendContext {
  sessionId: string
  userId: string
  workingDir?: string
  model?: string
}
```

### IM 模块接口

```typescript
interface IMModule {
  readonly name: string

  // 生命周期
  start(router: MessageRouter): Promise<void>
  stop(): Promise<void>

  // 能力
  readonly features: {
    cardMessage: boolean
    imageMessage: boolean
    fileMessage: boolean
    reactions: boolean
  }
}

interface MessageRouter {
  // IM 模块把消息交给路由层
  route(message: UnifiedMessage): Promise<void>
  
  // 路由层把回复交给 IM 模块
  onReply(handler: (reply: UnifiedReply) => Promise<void>): void
}
```

---

## 当前架构（Phase 1 实现）

```
飞书消息 → IMtoAgent (Bun)
              │
              ├─ HTTP Proxy :18899 (Anthropic API ↔ Provider)
              ├─ HTTP Proxy :18900 (Responses API ↔ Chat Completions)
              │
              ├─ Bot "ClaudeBot"  → Claude Agent SDK  → Provider API
              └─ Bot "CodexBot"   → codex exec/resume  → :18900 → DeepSeek API
```

---

## 核心设计原则

1. **两端可扩展** — IM 端加渠道 = 写 IM 模块，Agent 端加系统 = 写 Agent 模块
2. **中间不变** — 消息路由、会话归属、命令体系是网关内核，加模块不改它
3. **模块自包含** — 每个模块独立负责自己的 Proxy + Agent 对接，模块间零耦合
4. **Bot 与 Agent 模块 1:1** — 配置驱动，config.json 决定哪些模块生效
5. **HTTP Proxy 无状态** — 纯协议转换，不存会话数据
6. **热重载支持** — 文件变化或 SIGHUP 触发

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `index.ts` | 主入口：多 Bot 管理、飞书 WS 长连接、消息路由、会话生命周期 |
| `codex-proxy.ts` | Codex 代理：OpenAI Responses API ↔ Chat Completions 双向转换（端口 18900） |
| `anthropic-proxy.ts` | Claude 代理：Anthropic API ↔ Provider API 转换 + 会话持久化工具函数（端口 18899） |
| `config.json` | Bot 凭证、供应商配置、模型映射 |
| `providers.json` | 供应商详细配置 |
| `sessions/` | 会话持久化目录，按 Bot 分子目录 |
| `.codex-docs/` | 项目文档，供 Codex 新会话快速恢复上下文 |

### 文件结构（Phase 2 已完成）

```
imtoagent/
├── index.ts                  # 消息路由核心（不变）
├── config.json
├── providers.json
├── modules/
│   ├── im/
│   │   ├── feishu.ts         # 飞书 IM 模块（待提取）
│   │   ├── wechat.ts         # 微信 IM 模块（未来）
│   │   └── dingtalk.ts       # 钉钉 IM 模块（未来）
│   ├── agent/
│   │   ├── claude.ts         # ✅ Claude 模块
│   │   ├── codex.ts          # ✅ Codex 模块
│   │   ├── chatgpt.ts        # ChatGPT 模块（未来）
│   │   └── dify.ts           # Dify 模块（未来）
│   └── proxy/
│       ├── anthropic-proxy.ts  # Claude Proxy（待移入）
│       └── codex-proxy.ts      # Codex Proxy（待移入）
└── sessions/
```
