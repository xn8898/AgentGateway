# AI Gateway 设计文档

> 通过微信/Telegram/飞书，远程指挥多台机器上的多个 AI 编码 Agent

## 1. 概述

### 1.1 目标

构建一个个人效率工具——AI Gateway，让用户通过 IM（微信、Telegram、飞书）向分布在多台机器上的多种 AI 编码 Agent（OpenClaw、Hermes、Claude Code、OpenCode）发送指令，接收反馈，进行多轮会话。

### 1.2 核心需求

| 需求 | 说明 |
|------|------|
| 多 Channel | 支持微信（iLink）、Telegram Bot、飞书 Bot |
| 多 Agent | 支持 OpenClaw、Hermes、Claude Code、OpenCode |
| 多机器 | Agent 分布在局域网和公网 VPS 上 |
| 多实例 | 同一类型 Agent 可在多台机器上运行，通过别名路由 |
| 多轮会话 | 每个 Agent 维护独立会话上下文 |
| 指令路由 | `@agent-name 消息` 格式，支持实例别名和机器:类型两种路由 |
| 通知策略 | Telegram/飞书主动推送；iLink 不能推送，用捎带+主动查询 |
| 轻量存储 | SQLite，不引入外部数据库 |

### 1.3 用户场景

用户（一个人）在手机上通过微信/Telegram/飞书，给家里的 PC、NAS、公网 VPS 上的 AI Agent 发指令：

```
@claw-home 帮我在 src/api/ 下新增一个用户注册接口
@hermes-main 分析一下项目的依赖关系
@cc-vps 检查 server.ts 的错误处理逻辑
@opencode 重构 auth 模块，用 JWT 替换 session
```

Agent 在后台执行，关键节点自动通知（Telegram/飞书）或等用户下次发消息时捎带（iLink），用户随时可发 `/status` 查询进度。

---

## 2. 竞品分析

### 2.1 现有项目

| 项目 | GitHub | Channel 支持 | Agent 支持 | 核心特点 | 不足 |
|------|--------|-------------|-----------|---------|------|
| **imtoagent** | [imtoagent/imtoagent](https://github.com/imtoagent/imtoagent) | 飞书/Telegram/微信/企微 | Claude Code/Codex/OpenCode | 架构最接近，IM→Agent 统一网关，Bun/TS | 不支持 Hermes，单机部署，无多实例路由 |
| **Forge Hub** | [LinekForge/forge-hub](https://github.com/LinekForge/forge-hub) | 微信/Telegram/飞书/iMessage | Claude Code | 多 instance 路由，远程审批，定时引擎 | 只支持 Claude Code |
| **CliGate** | dev.to 文章 | Telegram/飞书/钉钉 | Claude Code/Codex/Gemini CLI | 账号池、粘性会话、可视化 Dashboard | 不支持微信 iLink，不支持 Hermes |
| **weixin-agent-gateway** | [cyberg0bl1n/weixin-agent-gateway](https://github.com/cyberg0bl1n/weixin-agent-gateway) | 微信 | OpenClaw/Codex/Claude Code | 分离微信连接层和后端路由层 | 只有微信，Windows 桌面应用 |
| **wechat-ai-bridge** | [AliceLJY/wechat-ai-bridge](https://github.com/AliceLJY/wechat-ai-bridge) | 微信 | AI backends | 自托管，iLink 原生 | 只有微信，基础转发 |
| **CowAgent** | 43k+ stars | 微信/飞书/Telegram 等 | Claude/GPT | 最成熟，长期记忆，Skills 系统 | 偏对话助手，不是编码 Agent 调度器 |

### 2.2 竞品空白

现有项目没有一个同时覆盖以下需求：

| 需求 | imtoagent | Forge Hub | CliGate | 本方案 |
|------|-----------|-----------|---------|--------|
| Hermes Agent | - | - | - | **支持** |
| 多机器分布式部署 | 单机 | 单机 | 单机 | **LAN + VPS 混合** |
| 同 Agent 多实例路由 | - | 有 | - | **有** |
| 微信 + Telegram + 飞书 | 有 | 有 | 缺微信 | **全支持** |
| SQLite 存储 | JSON 文件 | - | - | **SQLite** |
| Runner 远程代理 | - | - | - | **有** |
| iLink 捎带通知 | - | - | - | **有** |

### 2.3 策略：Fork imtoagent 改造

选择 Fork [imtoagent/imtoagent](https://github.com/imtoagent/imtoagent) 进行改造，而非从零构建。

**理由**：
- imtoagent 的架构（IM Registry → AgentRuntime → Agent Adapter）与本设计高度吻合
- 已支持 4 个 IM 平台 + 3 个 Agent 后端，省去大量基础工作
- TypeScript/Bun 生态，iLink SDK 原生支持
- MIT 许可证，允许 Fork 和修改

**需要新增/改动的部分**：

| 改动 | 类型 | 工作量 | 说明 |
|------|------|--------|------|
| Hermes Adapter | 新增文件 | 2 天 | 调用 Hermes Gateway HTTP API |
| 多实例路由 | 修改核心 | 3 天 | `@别名` / `@机器:类型` 路由解析 |
| SQLite 存储 | 替换 | 2 天 | 替换 JSON 文件存储 |
| 分布式 Runner | 新增模块 | 3 天 | 远程 CLI Agent 的 HTTP 代理 |
| iLink 捎带通知 | 增强 | 1 天 | 缓存通知，下次用户发消息时附带 |

---

## 3. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        LAN (局域网)                          │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              AI Gateway (Fork 自 imtoagent)           │   │
│  │                                                      │   │
│  │  ┌───────────────────────────────────┐               │   │
│  │  │         Channel Manager           │               │   │
│  │  │  ┌─────────┐ ┌────────┐ ┌──────┐ │               │   │
│  │  │  │ iLink   │ │Telegram│ │飞书   │ │               │   │
│  │  │  │ Channel │ │Channel │ │Channel│ │               │   │
│  │  │  └────┬────┘ └───┬────┘ └──┬───┘ │               │   │
│  │  └───────┼──────────┼─────────┼─────┘               │   │
│  │          └──────────┼─────────┘                      │   │
│  │                     ▼                                │   │
│  │  ┌──────────────────────────────────────┐           │   │
│  │  │       统一消息格式 (InboundMessage)   │           │   │
│  │  │  { channel, userId, text, reply() }  │           │   │
│  │  └──────────────────┬───────────────────┘           │   │
│  │                     ▼                                │   │
│  │  ┌──────────────┐  ┌──────────────┐                 │   │
│  │  │   Router     │  │   Session    │                 │   │
│  │  │  (指令解析)   │  │   Manager    │                 │   │
│  │  └──────┬───────┘  └──────────────┘                 │   │
│  │         ▼                                            │   │
│  │  ┌──────────────────────────────────────┐           │   │
│  │  │         Agent Manager                │           │   │
│  │  │  ┌────────┐ ┌────────┐ ┌──────────┐ │           │   │
│  │  │  │OpenClaw│ │ Hermes │ │Runner... │ │           │   │
│  │  │  │Adapter │ │Adapter │ │ Adapter  │ │           │   │
│  │  │  └────┬────┘ └───┬────┘ └────┬─────┘ │           │   │
│  │  └───────┼──────────┼──────────┼────────┘           │   │
│  └──────────┼──────────┼──────────┼────────────────────┘   │
│             │          │          │                         │
│      ┌──────┴──┐ ┌─────┴──┐ ┌────┴─────┐                  │
│      │OpenClaw │ │ Hermes │ │  Runner  │ ← LAN 机器        │
│      │Gateway  │ │Gateway │ │(Claude/  │                   │
│      └─────────┘ └────────┘ │OpenCode) │                   │
│                             └──────────┘                   │
└─────────────────────────────┬───────────────────────────────┘
                              │ (出站 HTTP)
                    ┌─────────┴─────────┐
                    │ ilinkai.weixin.qq.com │
                    │ api.telegram.org    │
                    │ open.feishu.cn      │
                    └─────────┬─────────┘
                              │
                    ┌─────────┴─────────┐
                    │  微信 / TG / 飞书   │
                    └───────────────────┘

┌──────────────────────────────────────────────────────┐
│                Public VPS (公网服务器)                  │
│                                                      │
│  ┌──────────┐  ┌──────────┐                          │
│  │ Runner   │  │ Runner   │  ← 暴露 HTTP API         │
│  │ Claude   │  │ OpenCode │    Gateway 主动连过来       │
│  └──────────┘  └──────────┘                          │
└──────────────────────────────────────────────────────┘
```

### 3.1 核心组件

| 组件 | 职责 |
|------|------|
| **Channel Manager** | 管理多个 IM Channel 的生命周期，统一消息格式 |
| **Channel (iLink/Telegram/飞书)** | 各 IM 平台的协议适配，收发消息 |
| **Router** | 解析 `@agent` / `@machine:agent` / `/command` 指令，路由到目标 Agent |
| **Session Manager** | 维护每个 Agent 实例的会话状态、上下文、conversation ID |
| **Agent Manager** | 管理所有 Agent Adapter 的注册、健康检查、生命周期 |
| **Agent Adapter** | 统一接口，适配不同 Agent 的通信方式 |
| **Runner** | 部署在 Agent 机器上的轻量 HTTP 进程，封装 CLI 工具，支持交互式确认 |
| **Notification Queue** | iLink 捎带通知队列，Telegram/飞书直接推送 |
| **Approval Handler** | Agent 确认请求的检测、转发、回调处理 |

### 3.2 网络拓扑

- Gateway 在局域网内运行，**主动出站**连接各 IM 平台服务器和公网 VPS（不需要公网 IP）
- iLink：长轮询出站到 `ilinkai.weixin.qq.com`
- Telegram：长轮询出站到 `api.telegram.org`（或 Webhook，需公网 IP）
- 飞书：WebSocket 长连接到 `open.feishu.cn`
- LAN 内 Agent：直连 HTTP
- 公网 VPS Agent：Gateway 主动 HTTPS 连接，Runner 暴露 API + API Key 认证

---

## 4. Channel 通信层

### 4.1 Channel 统一接口

```typescript
interface Channel {
  id: string;                    // "wechat" | "telegram" | "feishu"
  name: string;                  // 显示名
  canPush: boolean;              // true=可主动推送，false=仅捎带

  start(): Promise<void>;        // 启动监听
  stop(): Promise<void>;

  // 回复到发起消息的对话
  sendMessage(chatId: string, text: string): Promise<void>;

  // 发送"正在输入"状态（不支持的 Channel 忽略）
  sendTyping?(chatId: string): Promise<void>;
}
```

### 4.2 各 Channel 实现

#### iLink (微信)

| 特性 | 说明 |
|------|------|
| 协议 | HTTP/JSON，长轮询（35s hold + 游标推进） |
| 接入域名 | `ilinkai.weixin.qq.com` |
| 主动推送 | **不支持**，必须用户先发消息，用 `context_token` 回复 |
| 鉴权 | 扫码登录获取 `bot_token`，Bearer Token |
| SDK | `@tencent-weixin/openclaw-weixin`（官方 npm 包） |

**消息接收流程**：
```
扫码登录 → 获取 bot_token → 长轮询 getupdates
→ 收到消息 → 解析 item_list[].text_item.text → 转为 InboundMessage
```

**消息发送流程**：
```
回复 → 提取 context_token → sendtyping（可选）→ sendmessage
```

**iLink 特有处理**：
- `bot_token` 持久化到 SQLite，重启免扫码
- Session Guard：错误码 `-14`（会话过期）时暂停 60 分钟，防风控
- `X-WECHAT-UIN`：每次请求随机生成 uint32 → base64，防重放
- Markdown → 纯文本：AI 返回的 markdown 自动转为微信友好格式
- 长消息拆分：超过 2000 字自动按段落边界拆分

#### Telegram Bot

| 特性 | 说明 |
|------|------|
| 协议 | HTTP，长轮询或 Webhook |
| API | `api.telegram.org/bot<token>/` |
| 主动推送 | **支持**，`sendMessage` 可随时推送 |
| 鉴权 | Bot Token（从 @BotFather 获取） |
| 限制 | 需要网络可达 `api.telegram.org`（可能需要代理） |

**消息接收**：长轮询 `getUpdates` 或 Webhook 回调
**消息发送**：直接 `sendMessage`，支持 Markdown/HTML 格式

#### 飞书 Bot

| 特性 | 说明 |
|------|------|
| 协议 | WebSocket 长连接 + REST API |
| API | `open.feishu.cn` |
| 主动推送 | **支持**，通过 API 发送消息 |
| 鉴权 | App ID + App Secret |
| 能力 | 文本、富文本、消息卡片、文件、图片、语音 |

**消息接收**：WebSocket 事件订阅
**消息发送**：REST API `POST /im/v1/messages`

### 4.3 通知策略

```typescript
async function notify(channel: Channel, chatId: string, message: string) {
  if (channel.canPush) {
    // Telegram/飞书：立即主动推送
    await channel.sendMessage(chatId, message);
  } else {
    // iLink：缓存到通知队列，等用户下次发消息时捎带
    await notificationStore.enqueue(channel.id, chatId, message);
  }
}
```

**捎带机制**（iLink 专用）：
```
用户发任意消息
  → 检查该 channel + chatId 的 pendingNotifications
  → 有待通知内容 → 先回复进度通知 → 再处理当前消息
  → 无待通知内容 → 直接处理当前消息
```

---

## 5. 指令路由与会话管理

### 5.1 指令格式

#### Agent 路由指令

| 格式 | 示例 | 行为 |
|------|------|------|
| `@实例别名 <消息>` | `@claw-home 写个函数` | 精确匹配实例 |
| `@机器:类型 <消息>` | `@home:openclaw 写个函数` | 按机器+类型匹配 |
| `@类型 <消息>` | `@openclaw 写个函数` | 唯一则直接路由，多个则提示选择 |
| `<消息>`（无前缀） | `写个函数` | 发给默认 Agent（`/switch` 设置的） |

#### 实例别名映射

```yaml
agents:
  claw-home:        # 别名
    type: openclaw
    host: 192.168.1.100:8080

  claw-vps:
    type: openclaw
    host: vps1.example.com:8080
    apiKey: ${OPENCLAW_VPS_KEY}

  hermes-main:
    type: hermes
    host: 192.168.1.101:3000

  cc-home:
    type: claude-code
    host: 192.168.1.100:9090
    runner: true

  cc-vps:
    type: claude-code
    host: vps2.example.com:9090
    runner: true
    apiKey: ${CC_VPS_KEY}

  oc-home:
    type: opencode
    host: 192.168.1.100:9091
    runner: true
```

#### 系统指令

| 指令 | 功能 |
|------|------|
| `/status` | 查看所有 Agent 状态和待通知进度 |
| `/status @agent` | 查看指定 Agent 状态 |
| `/list` | 列出已注册的 Agent 及其在线状态 |
| `/switch @agent` | 切换默认 Agent |
| `/cancel @agent` | 取消指定 Agent 正在执行的任务 |
| `/help` | 帮助信息 |

### 5.2 路由解析逻辑

```typescript
function parseRoute(text: string): { target: string; message: string } | null {
  // 格式1: @别名 消息
  const aliasMatch = text.match(/^@(\S+)\s+([\s\S]+)$/);
  if (aliasMatch) {
    const [, alias, message] = aliasMatch;
    // 尝试直接匹配实例别名
    if (agents.has(alias)) return { target: alias, message };
    // 尝试 @machine:agent 格式
    const [machine, type] = alias.split(":");
    if (machine && type) return { target: `${machine}:${type}`, message };
    // 尝试匹配 agent 类型
    const matches = agents.filter(a => a.type === alias);
    if (matches.length === 1) return { target: matches[0].id, message };
    if (matches.length > 1) {
      // 返回提示信息，让用户选择
      return { target: "ambiguous", message: formatAmbiguous(matches) };
    }
  }
  // 无前缀 → 默认 Agent
  return { target: config.defaultAgent, message: text };
}
```

### 5.3 会话模型

```typescript
interface Session {
  id: string;                    // 会话唯一 ID
  agentId: string;               // Agent 实例 ID（如 "claw-home"）
  channelId: string;             // 来源 Channel（"wechat" | "telegram" | "feishu"）
  chatId: string;                // Channel 内的对话标识
  agentSessionId: string;        // Agent 侧的会话标识（conversationId / session token）
  lastActive: number;            // 最后活跃时间戳
  status: "idle" | "busy";       // 当前状态
  currentTask?: string;          // 正在执行的任务描述
  pendingNotifications: string[];// 待推送的通知（iLink 用）
}
```

**会话隔离**：同一个 Agent 实例，通过不同 Channel 对话是独立会话。
**会话超时**：默认 30 分钟无活动后自动新建会话。
**多轮对话**：每次 `@agent` 消息自动延续该 Agent 在当前 Channel 的会话上下文。

---

## 6. Agent Adapter 层

### 6.1 统一接口

```typescript
interface AgentAdapter {
  id: string;                    // 实例唯一 ID（如 "claw-home"）
  type: string;                  // Agent 类型
  host: string;                  // 地址

  sendMessage(text: string, sessionId?: string): Promise<AgentResponse>;
  getStatus(): Promise<AgentStatus>;
  cancel(sessionId?: string): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;
}

interface AgentResponse {
  text: string;                  // 回复文本
  sessionId: string;             // 会话标识
  status: "done" | "working" | "error";
  progress?: string;             // 中间进度消息
}

interface AgentStatus {
  online: boolean;
  busy: boolean;
  currentTask?: string;
  pendingOutput?: string;
}
```

### 6.2 Agent 适配方式

| Agent | 适配方式 | 说明 |
|-------|---------|------|
| **OpenClaw** | RemoteAPIAdapter | 调用 OpenClaw Gateway HTTP API |
| **Hermes** | RemoteAPIAdapter | 调用 Hermes Gateway HTTP API（`hermes gateway` 启动后暴露） |
| **Claude Code** | RunnerAdapter | 调用远程 Runner，Runner 封装 `claude --print` |
| **OpenCode** | RunnerAdapter | 调用远程 Runner，Runner 封装 opencode CLI |

### 6.3 RemoteAPIAdapter（OpenClaw / Hermes）

```typescript
class RemoteAPIAdapter implements AgentAdapter {
  async sendMessage(text: string, sessionId?: string): Promise<AgentResponse> {
    const res = await fetch(`http://${this.host}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey && { "Authorization": `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify({ message: text, session_id: sessionId })
    });
    return res.json();
  }

  async getStatus(): Promise<AgentStatus> {
    const res = await fetch(`http://${this.host}/api/status`);
    return res.json();
  }
}
```

### 6.4 RunnerAdapter（Claude Code / OpenCode）

```typescript
class RunnerAdapter implements AgentAdapter {
  async sendMessage(text: string, sessionId?: string): Promise<AgentResponse> {
    const res = await fetch(`http://${this.host}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey
      },
      body: JSON.stringify({
        command: this.type,
        sessionId,
        input: text
      })
    });
    return res.json();
  }
}
```

### 6.5 Runner 进程

部署在 Agent 所在机器上的轻量 HTTP 服务（~100 行代码），封装 CLI 工具。

**API 端点**：

| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /run` | POST | 启动 Agent CLI，返回 SSE 流式输出（支持确认回调） |
| `GET /status` | GET | 当前执行状态 |
| `POST /cancel` | POST | 终止当前任务 |
| `GET /health` | GET | 健康检查 |
| `POST /approval` | POST | Gateway 下发用户确认结果（`6.6 节`） |

**核心逻辑**：

```typescript
app.post("/run", async (req, res) => {
  const { command, sessionId, input } = req.body;

  // 根据 command 类型选择 CLI
  const cliMap = {
    "claude-code": { cmd: "claude", args: ["--print", "--session", sessionId] },
    "opencode":    { cmd: "opencode", args: ["--session", sessionId] }
  };
  const { cmd, args } = cliMap[command];

  const proc = spawn(cmd, args);
  proc.stdin.write(input);
  proc.stdin.end();

  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });

  proc.on("close", (code) => {
    res.json({ text: output, sessionId, status: code === 0 ? "done" : "error" });
  });
});
```

**认证**：
- LAN 内 Runner：可选 API Key
- 公网 VPS Runner：必须 API Key + HTTPS

### 6.6 Agent 交互式确认（Approval）

AI 编码 Agent 在执行危险操作前通常需要用户确认：

| Agent | 确认方式 | 示例 |
|-------|---------|------|
| Claude Code | stdout 输出确认提示，等待 stdin 输入 | `Allow this command? [y/n/a/d]` |
| Hermes | 命令审批系统，可配置 allowlist | 非 allowlist 中的命令需确认 |
| OpenClaw | 权限管理，可配置自动/手动模式 | 高风险操作需确认 |
| OpenCode | 类似 Claude Code | 权限提示 |

#### 问题

Runner 使用 `spawn` 启动 Agent CLI 后，Agent 可能在执行过程中暂停等待确认。如果 Runner 只是简单地等待进程退出（`proc.on("close")`），会卡住——进程既没退出，也没输出最终结果。

#### 解决方案：Runner 内置 Approval 回调

Runner 不再是"启动 → 等输出 → 返回"的简单模式，而是变成**交互式会话管理器**：

```
Gateway                    Runner                     Agent CLI
  │                          │                            │
  │── POST /run ────────────→│                            │
  │                          │── spawn("claude") ────────→│
  │                          │                            │
  │                          │←── stdout: "分析中..." ────│
  │                          │                            │
  │                          │←── stdout: "Allow this     │
  │                          │    command? [y/n]" ────────│  Agent 暂停等待
  │                          │                            │
  │                          │── POST /callback/approval  │
  │                          │   到 Gateway ─────────────→│
  │←── IM: "确认执行？" ─────│                            │
  │                          │                            │
  │── 用户回复 "y" ─────────→│                            │
  │                          │                            │
  │                          │── POST /approval/response →│
  │                          │   到 Runner ──────────────→│
  │                          │                            │
  │                          │── stdin: "y" ─────────────→│
  │                          │                            │
  │                          │←── stdout: "执行完成" ─────│
  │                          │                            │
  │←── 最终结果 ─────────────│                            │
```

#### Runner 新增 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /run` | POST | 启动 Agent CLI，返回 SSE 流式输出 |
| `GET /status` | GET | 当前执行状态 |
| `POST /cancel` | POST | 终止当前任务 |
| `GET /health` | GET | 健康检查 |
| `POST /approval` | POST | **新增**：Gateway 下发用户确认结果 |

#### Runner 交互式执行逻辑

```typescript
// Runner 维护活跃会话
const activeSessions = new Map<string, {
  proc: ChildProcess;
  pendingApproval: { resolve: (answer: string) => void } | null;
}>();

app.post("/run", async (req, res) => {
  const { command, sessionId, input } = req.body;

  const proc = spawn(cliMap[command].cmd, cliMap[command].args);
  proc.stdin.write(input);
  proc.stdin.end();

  // SSE 流式返回
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  const session = { proc, pendingApproval: null };
  activeSessions.set(sessionId, session);

  let buffer = "";

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();

    // 检测确认提示（正则匹配 Agent 的确认模式）
    const approvalMatch = detectApprovalPrompt(buffer);
    if (approvalMatch) {
      // 向 Gateway 发送确认请求回调
      notifyGateway({
        type: "approval_required",
        sessionId,
        prompt: approvalMatch.prompt,    // "Allow this command?"
        options: approvalMatch.options,  // ["y", "n", "a", "d"]
        detail: approvalMatch.detail     // "rm -rf /tmp/old-build"
      });

      // 暂停输出收集，等待 Gateway 回调
      session.pendingApproval = {
        resolve: (answer: string) => {
          proc.stdin.write(answer + "\n");
          buffer = ""; // 清空缓冲区
        }
      };
      return;
    }

    // 普通输出，通过 SSE 推送给 Gateway
    res.write(`data: ${JSON.stringify({ type: "output", text: chunk.toString() })}\n\n`);
  });

  proc.on("close", (code) => {
    res.write(`data: ${JSON.stringify({ type: "done", code })}\n\n`);
    res.end();
    activeSessions.delete(sessionId);
  });
});

// Gateway 回调：下发用户确认结果
app.post("/approval", (req, res) => {
  const { sessionId, answer } = req.body; // answer: "y" | "n" | "a" | "d"
  const session = activeSessions.get(sessionId);
  if (session?.pendingApproval) {
    session.pendingApproval.resolve(answer);
    session.pendingApproval = null;
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "No pending approval" });
  }
});
```

#### Gateway 侧确认流程

```typescript
// Runner 回调 Gateway 请求确认
async function handleApprovalRequest(req: ApprovalRequest) {
  const { sessionId, prompt, options, detail } = req;

  // 构造确认消息
  const approvalMessage = [
    `⚠️ Agent 请求确认：`,
    `${prompt}`,
    detail ? `操作：${detail}` : "",
    `回复：${options.join(" / ")} 或 直接回复 y/n`
  ].filter(Boolean).join("\n");

  // 通过发起会话的 Channel 发送给用户
  const session = await sessionStore.get(sessionId);
  await channelManager.sendMessage(session.channelId, session.chatId, approvalMessage);

  // 标记会话等待确认
  await sessionStore.updateStatus(sessionId, "waiting_approval");
}

// 用户在 IM 中回复确认结果
async function handleApprovalResponse(userId: string, text: string, session: Session) {
  if (session.status !== "waiting_approval") return false;

  // 解析用户回复
  const answer = parseApprovalAnswer(text); // "y" → "y", "是" → "y", "拒绝" → "n"
  if (!answer) return false;

  // 转发给 Runner
  await fetch(`http://${session.agentHost}/approval`, {
    method: "POST",
    body: JSON.stringify({ sessionId: session.agentSessionId, answer })
  });

  await sessionStore.updateStatus(sessionId, "busy");
  return true; // 已处理，不再走正常消息流程
}
```

#### 各 Agent 确认模式匹配

```typescript
function detectApprovalPrompt(output: string): ApprovalPrompt | null {
  // Claude Code 确认模式
  const claudeMatch = output.match(
    /(?:Allow|Execute|Run)\s+(?:this\s+)?(?:command|tool|action)\?\s*\[(\w)\/(\w)(?:\/(\w))?(?:\/(\w))?\]/
  );
  if (claudeMatch) {
    return {
      prompt: output.split("\n").pop()!,
      options: claudeMatch.slice(1).filter(Boolean),
      detail: extractCommandDetail(output)
    };
  }

  // Hermes 确认模式
  const hermesMatch = output.match(/Approve\s+this\s+action\?\s*\(y\/n\)/i);
  if (hermesMatch) {
    return { prompt: "Approve this action?", options: ["y", "n"], detail: "" };
  }

  // 通用模式：包含 [y/n] 的提示
  const genericMatch = output.match(/([\s\S]*?)\[(\w)\/(\w)\]\s*$/);
  if (genericMatch) {
    return { prompt: genericMatch[1].trim(), options: [genericMatch[2], genericMatch[3]], detail: "" };
  }

  return null;
}
```

#### 简化模式：预配置权限（跳过确认）

对于个人工具，可以配置 Agent 预先授权，跳过确认：

```yaml
# config.yaml
agents:
  cc-home:
    type: claude-code
    host: 192.168.1.100:9090
    runner: true
    approval:
      mode: "auto_approve"    # auto_approve | prompt | hybrid
      auto_approve_commands:  # 仅 mode=prompt 时生效
        - "ls"
        - "cat"
        - "git status"
      deny_commands:
        - "rm -rf /"
        - "git push --force"
```

| 模式 | 说明 |
|------|------|
| `auto_approve` | Agent 启动时传入 `--dangerously-skip-permissions`，所有操作自动批准 |
| `prompt` | 每次确认都通过 IM 转发给用户（默认） |
| `hybrid` | 匹配 allowlist 的自动批准，其余转给用户 |

---

## 7. 数据存储

### 7.1 SQLite

使用 SQLite 替代 JSON 文件存储，单文件、零配置、结构化查询。

**数据库文件**：`~/.ai-gateway/data/gateway.db`

### 7.2 表结构

```sql
-- Agent 实例注册
CREATE TABLE agents (
  id TEXT PRIMARY KEY,           -- "claw-home"
  type TEXT NOT NULL,            -- "openclaw" | "hermes" | "claude-code" | "opencode"
  host TEXT NOT NULL,            -- "192.168.1.100:8080"
  api_key TEXT,                  -- 加密存储
  is_runner INTEGER DEFAULT 0,  -- 是否需要 Runner
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 会话管理
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,      -- "wechat" | "telegram" | "feishu"
  chat_id TEXT NOT NULL,         -- Channel 内对话标识
  agent_session_id TEXT,         -- Agent 侧会话 ID
  last_active TEXT,
  status TEXT DEFAULT 'idle',    -- "idle" | "busy"
  current_task TEXT,
  UNIQUE(agent_id, channel_id, chat_id)
);

-- 待推送通知（iLink 捎带用）
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  delivered INTEGER DEFAULT 0
);
CREATE INDEX idx_notifications_pending ON notifications(channel_id, chat_id, delivered);

-- 对话历史
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,            -- "user" | "agent"
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_conversations_lookup ON conversations(agent_id, channel_id, chat_id, created_at);

-- 等待确认的 Approval 请求
CREATE TABLE approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,      -- 关联的会话
  agent_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  prompt TEXT NOT NULL,          -- "Allow this command?"
  options TEXT NOT NULL,         -- JSON: ["y", "n", "a", "d"]
  detail TEXT,                   -- 具体操作内容
  status TEXT DEFAULT 'pending', -- "pending" | "approved" | "denied" | "timeout"
  answer TEXT,                   -- 用户回复
  created_at TEXT DEFAULT (datetime('now')),
  responded_at TEXT
);
CREATE INDEX idx_approval_pending ON approval_requests(session_id, status);

-- iLink token 持久化
CREATE TABLE channel_state (
  channel_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,      -- { bot_token, baseurl, cursor, ... }
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### 7.3 数据清理

- 对话历史保留 **30 天**，自动清理更早的记录
- 已送达的通知记录保留 7 天
- 可通过配置调整保留策略

```sql
-- 定时清理（每天执行一次）
DELETE FROM conversations WHERE created_at < datetime('now', '-30 days');
DELETE FROM notifications WHERE delivered = 1 AND created_at < datetime('now', '-7 days');
```

---

## 8. 配置

### 8.1 配置文件 (config.yaml)

```yaml
# Channel 配置
channels:
  wechat:
    enabled: true
    type: ilink
    # token 自动存入 SQLite

  telegram:
    enabled: true
    type: telegram
    bot_token: ${TELEGRAM_BOT_TOKEN}
    allowed_users: [12345678]     # 只允许你的 Telegram user ID
    proxy:                        # 可选，用于网络受限环境
      host: "http://127.0.0.1:7890"

  feishu:
    enabled: true
    type: feishu
    app_id: ${FEISHU_APP_ID}
    app_secret: ${FEISHU_APP_SECRET}

# Agent 实例注册
agents:
  claw-home:
    type: openclaw
    host: 192.168.1.100:8080

  claw-vps:
    type: openclaw
    host: vps1.example.com:8080
    apiKey: ${OPENCLAW_VPS_KEY}

  hermes-main:
    type: hermes
    host: 192.168.1.101:3000

  cc-home:
    type: claude-code
    host: 192.168.1.100:9090
    runner: true

  cc-vps:
    type: claude-code
    host: vps2.example.com:9090
    runner: true
    apiKey: ${CC_VPS_KEY}

  oc-home:
    type: opencode
    host: 192.168.1.100:9091
    runner: true

# 路由配置
routing:
  default_agent: claw-home       # 不带前缀时的默认目标
  session_timeout: 1800000       # 会话超时 30 分钟
  message_max_length: 2000       # 单条消息最大长度

# 通知策略
notifications:
  on_complete: true              # 任务完成时通知
  on_error: true                 # 出错时通知
  on_milestone: true             # 关键节点通知
  piggyback: true                # iLink 捎带回复

# 存储配置
storage:
  db_path: ./data/gateway.db     # SQLite 数据库路径
  retention_days: 30             # 对话历史保留天数
```

### 8.2 环境变量

配置中的 `${VAR}` 语法会自动从环境变量替换。

---

## 9. 错误处理与容错

### 9.1 iLink 层

| 场景 | 处理策略 |
|------|---------|
| 长轮询超时 | 正常，重新发起轮询 |
| 网络断开 | 指数退避重连（2s → 4s → 8s → ... → 最大 5min） |
| `bot_token` 过期 | 重新扫码登录，通知用户 |
| 错误码 `-14`（会话过期） | 暂停该会话 60 分钟，防风控 |
| 发送消息失败 | 重试 2 次，仍失败则缓存到待发队列 |

### 9.2 Agent 通信层

| 场景 | 处理策略 |
|------|---------|
| Agent 无响应（超时 5min） | 回复用户"Agent 超时，用 /status 查看" |
| Agent 返回错误 | 错误信息原样转发给用户 |
| Runner 进程崩溃 | 健康检查发现后标记 offline，通知用户，自动尝试重启 |
| 公网 VPS 不可达 | 标记 offline，回复用户"该 Agent 当前离线" |

### 9.3 消息拆分

超过 2000 字的消息自动拆分，按段落边界截断：

```
[1/3] 分析结果如下：
（第一段内容）

[2/3]
（第二段内容）

[3/3]
（第三段内容）
```

### 9.4 用户可见状态反馈

```
正常：  用户发消息 → typing → 进度通知 → 最终回复
离线：  "⚠️ cc-vps 当前离线，最后在线: 10分钟前"
超时：  "⏳ Agent 正在处理中，已等待 5 分钟，可发 /status 查看"
错误：  "❓ 未找到 @xxx，用 /list 查看可用 Agent"
```

---

## 10. 项目结构

基于 imtoagent Fork 后的目录结构：

```
ai-gateway/
├── config.yaml                     # 主配置文件
├── package.json
├── tsconfig.json
│
├── index.ts                        # 入口（来自 imtoagent，改造）
├── bin/                            # CLI 命令
│
├── modules/
│   ├── core/                       # 核心模块（来自 imtoagent，改造）
│   │   ├── AgentRuntime.ts         # 消息处理中枢
│   │   ├── AgentAdapter.ts         # 统一 Agent 接口
│   │   ├── SessionManager.ts       # 会话管理（改造：SQLite）
│   │   ├── Router.ts               # 【新增】指令路由解析
│   │   ├── NotificationQueue.ts    # 【新增】iLink 捎带通知队列
│   │   └── types.ts
│   │
│   ├── im/                         # IM Channel 适配（来自 imtoagent）
│   │   ├── feishu.ts
│   │   ├── telegram.ts
│   │   ├── wechat.ts              # iLink 适配（增强：捎带通知）
│   │   └── wecom.ts
│   │
│   ├── agent/                      # Agent 后端适配
│   │   ├── claude-adapter.ts       # 来自 imtoagent
│   │   ├── codex-adapter.ts        # 来自 imtoagent
│   │   ├── opencode-adapter.ts     # 来自 imtoagent
│   │   └── hermes-adapter.ts       # 【新增】Hermes Agent 适配
│   │
│   ├── runner/                     # 【新增】分布式 Runner
│   │   ├── server.ts               # Runner HTTP 服务（部署在 Agent 机器上）
│   │   ├── executor.ts             # CLI 交互式执行器（支持确认回调）
│   │   ├── approval-detector.ts    # 各 Agent 确认模式匹配
│   │   └── runner-adapter.ts       # Gateway 侧的 Runner 客户端
│   │
│   ├── store/                      # 【新增】SQLite 存储层
│   │   ├── db.ts                   # 数据库连接和初始化
│   │   ├── agent-store.ts          # Agent 实例 CRUD
│   │   ├── session-store.ts        # 会话 CRUD
│   │   ├── notification-store.ts   # 通知队列
│   │   ├── conversation-store.ts   # 对话历史
│   │   └── approval-store.ts       # 确认请求队列
│   │
│   ├── proxy/                      # 来自 imtoagent
│   │   └── anthropic-proxy.ts
│   │
│   └── cli/                        # 来自 imtoagent
│       └── setup.ts
│
├── data/                           # 运行时数据（gitignore）
│   └── gateway.db                  # SQLite 数据库
│
└── docs/
    └── superpowers/specs/
        └── 2026-05-26-ai-gateway-design.md  # 本文档
```

---

## 11. 技术选型

| 层面 | 选择 | 理由 |
|------|------|------|
| 基础框架 | imtoagent (Fork) | 架构最接近，已支持 4 个 IM + 3 个 Agent |
| 语言 | TypeScript (ESM) | imtoagent 原生，iLink SDK 支持 |
| 运行时 | Bun | imtoagent 使用 Bun，性能好 |
| iLink SDK | `@tencent-weixin/openclaw-weixin` | 官方 SDK |
| 数据库 | SQLite (`better-sqlite3`) | 单文件、零配置、性能好 |
| 配置 | YAML (`js-yaml`) | 比 JSON 易读，支持注释 |
| 日志 | `pino` | 轻量高性能 |
| HTTP 框架（Runner） | `hono` | 超轻量，适合小服务 |

---

## 12. 部署拓扑示例

```
机器1 (家里 PC - 192.168.1.100):
  ├── AI Gateway (主进程)
  ├── OpenClaw (claw-home, :8080)
  ├── Runner for Claude Code (cc-home, :9090)
  └── Runner for OpenCode (oc-home, :9091)

机器2 (家里 NAS - 192.168.1.101):
  └── Hermes (hermes-main, :3000)

机器3 (公网 VPS - vps1.example.com):
  └── Runner for Claude Code (cc-vps, :9090, HTTPS + API Key)

机器4 (公网 VPS - vps2.example.com):
  └── OpenClaw (claw-vps, :8080, HTTPS + API Key)
```

---

## 13. 实施计划

基于 imtoagent Fork 改造，按优先级排序：

| 阶段 | 任务 | 工作量 | 产出 |
|------|------|--------|------|
| P0 | Fork imtoagent，本地跑通 | 1 天 | 可运行的 baseline |
| P1 | 新增 Hermes Adapter | 2 天 | 4 个 Agent 全支持 |
| P1 | 实现多实例路由（@别名 / @机器:类型） | 3 天 | 核心路由功能 |
| P2 | 替换为 SQLite 存储 | 2 天 | 结构化存储 |
| P2 | 实现分布式 Runner | 3 天 | 远程 CLI Agent 支持 |
| P2 | Agent 交互式确认（Approval） | 2 天 | Runner 交互式会话 + IM 确认转发 |
| P3 | iLink 捎带通知机制 | 1 天 | iLink 通知体验 |
| P3 | 对话历史记录（30 天保留） | 1 天 | 可回溯 |
| **总计** | | **~15 天** | |

---

## 附录 A: 各 Agent 远程能力参考

| Agent | 远程 API | 连接方式 | 备注 |
|-------|---------|---------|------|
| OpenClaw | 有（Gateway HTTP API） | HTTP 直连 | 自带 Gateway 架构 |
| Hermes | 有（Gateway HTTP API） | HTTP 直连 | `hermes gateway start` 后暴露 |
| Claude Code | 无 | 需要 Runner 封装 | `claude --print` 非交互模式 |
| OpenCode | 无 | 需要 Runner 封装 | CLI 工具 |

## 附录 B: iLink 协议要点

| 端点 | 方法 | 用途 |
|------|------|------|
| `ilink/bot/get_bot_qrcode` | GET | 获取登录二维码 |
| `ilink/bot/get_qrcode_status` | GET | 轮询扫码状态 |
| `ilink/bot/getupdates` | POST | 长轮询收消息（35s hold） |
| `ilink/bot/sendmessage` | POST | 发送消息 |
| `ilink/bot/getconfig` | POST | 获取配置（含 typing_ticket） |
| `ilink/bot/sendtyping` | POST | 发送"正在输入"状态 |

关键约束：
- 每个请求携带 `base_info: { channel_version: "1.0.2" }`
- 回复必须带 `context_token`（从收到的消息中提取）
- 不能主动推送，必须用户先发消息
