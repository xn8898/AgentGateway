# Agent Gateway

> 通过微信/Telegram/飞书/企业微信，远程指挥多台机器上的多个 AI 编码 Agent
>
> Control multiple AI coding agents across multiple machines via WeChat/Telegram/Feishu/WeCom

---

## 中文版

### 简介

Agent Gateway 是一个个人效率工具，让你通过手机上的 IM 应用（微信、Telegram、飞书、企业微信），向分布在多台机器上的多种 AI 编码 Agent 发送指令，接收反馈，进行多轮会话。

基于 [imtoagent](https://github.com/imtoagent/imtoagent) 改造，扩展了多实例路由、分布式 Runner、SQLite 存储、交互式确认等能力。

### 核心特性

| 特性 | 说明 |
|------|------|
| **多 Channel** | 微信（iLink）、Telegram、飞书、企业微信 |
| **多 Agent** | Claude Code、Codex、Hermes、OpenCode、OpenClaw |
| **多机器** | Agent 分布在局域网和公网 VPS 上 |
| **多实例** | 同类型 Agent 可在多台机器运行，通过别名路由 |
| **指令路由** | `@别名`、`@机器:类型`、`@类型` 三种路由格式 |
| **分布式 Runner** | 远程机器上的轻量 HTTP 服务，封装 CLI Agent |
| **交互式确认** | Agent 请求确认时自动转发到 IM，用户回复后回调 |
| **捎带通知** | iLink 不能主动推送时缓存通知，下次发消息时附带 |
| **SQLite 存储** | 会话、通知、对话历史全部持久化 |
| **Codex 支持** | App-Server（JSON-RPC）+ CLI fallback，多轮 thread |

### 快速开始

#### 前置条件

- **Bun** 运行时 (≥1.0.0)
- 至少一个 Agent 后端

#### 安装

```bash
# 从源码安装
git clone <repo-url>
cd agent-gateway
bun install
```

#### 配置

编辑 `config.yaml`：

```yaml
channels:
  telegram:
    enabled: true
    type: telegram
    bot_token: ${TELEGRAM_BOT_TOKEN}

agents:
  cc-home:
    type: claude-code
    host: 192.168.1.100:9090
    runner: true

  hermes-main:
    type: hermes
    host: 192.168.1.101:3000

  codex-local:
    type: codex
    backend: codex

routing:
  default_agent: cc-home
```

#### 启动

```bash
bun run index.ts
```

### 指令格式

在 IM 中发送消息：

| 格式 | 示例 | 行为 |
|------|------|------|
| `@别名 消息` | `@cc-home 写个函数` | 精确匹配实例 |
| `@机器:类型 消息` | `@home:claude-code 检查代码` | 按机器+类型匹配 |
| `@类型 消息` | `@hermes 分析依赖` | 唯一直接路由，多个提示选择 |
| `消息`（无前缀） | `帮我重构` | 发给默认 Agent |

#### 系统指令

| 指令 | 功能 |
|------|------|
| `/list` | 列出已注册的 Agent |
| `/status` | 查看所有 Agent 状态 |
| `/status @agent` | 查看指定 Agent 状态 |
| `/switch @agent` | 切换默认 Agent |
| `/cancel @agent` | 取消正在执行的任务 |
| `/help` | 帮助信息 |

### 架构

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Gateway                         │
│                                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │
│  │  iLink  │  │Telegram │  │  飞书    │  │ 企微     │   │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘   │
│       └────────────┼──────────┼──────────────┘         │
│                    ▼                                     │
│              ┌──────────┐                               │
│              │  Router   │  @别名 / @机器:类型 / @类型    │
│              └─────┬────┘                               │
│                    ▼                                     │
│  ┌──────────────────────────────────────────────┐      │
│  │           Agent Adapters                      │      │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐│      │
│  │  │Claude  │ │ Codex  │ │ Hermes │ │ Runner ││      │
│  │  │Adapter │ │Adapter │ │Adapter │ │Adapter ││      │
│  │  └────────┘ └────────┘ └────────┘ └────────┘│      │
│  └──────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
         │                    │
    ┌────┴────┐          ┌────┴────┐
    │ 本地 Agent │          │ Runner  │ ← 远程机器
    └─────────┘          └─────────┘
```

### 项目结构

```
agent-gateway/
├── index.ts                        # 入口
├── config.yaml                     # 主配置文件
├── modules/
│   ├── core/
│   │   ├── runtime.ts              # AgentRuntime — 消息处理中枢
│   │   ├── Router.ts               # 指令路由
│   │   ├── NotificationQueue.ts    # 捎带通知队列
│   │   └── types.ts                # 类型定义
│   ├── im/
│   │   ├── feishu.ts               # 飞书
│   │   ├── telegram.ts             # Telegram
│   │   ├── wechat.ts               # 微信 (iLink)
│   │   └── wecom.ts                # 企业微信
│   ├── agent/
│   │   ├── claude-adapter.ts       # Claude Code
│   │   ├── codex-adapter.ts        # Codex (App-Server + CLI)
│   │   ├── codex-exec-server.ts    # Codex App-Server 管理
│   │   ├── hermes-adapter.ts       # Hermes
│   │   └── opencode-adapter.ts     # OpenCode
│   ├── runner/
│   │   ├── server.ts               # Runner HTTP 服务
│   │   ├── executor.ts             # CLI 交互式执行器
│   │   ├── approval-detector.ts    # 确认模式检测
│   │   └── runner-adapter.ts       # Gateway 侧 Runner 客户端
│   ├── store/
│   │   ├── db.ts                   # SQLite (bun:sqlite)
│   │   ├── agent-store.ts
│   │   ├── session-store.ts
│   │   ├── notification-store.ts
│   │   ├── conversation-store.ts
│   │   └── approval-store.ts
│   ├── media/
│   │   ├── media-store.ts          # 媒体存储
│   │   └── types.ts
│   ├── capabilities.ts             # IM 能力抽象
│   ├── prompt-builder.ts           # System prompt 构建
│   └── utils/
│       └── paths.ts                # 路径解析
├── docs/
│   └── superpowers/
│       ├── specs/                  # 设计文档
│       └── plans/                  # 实施计划
└── data/                           # 运行时数据 (gitignore)
```

### 数据目录

运行时数据存储在 `~/.agent-gateway/`：

```
~/.agent-gateway/
├── data/
│   └── gateway.db              # SQLite 数据库
├── media/
│   └── inbound/                # 接收的媒体文件
├── logs/
│   └── imtoagent.log           # 运行日志
├── soul/                       # Bot 人格文件
│   └── {botName}/
│       ├── rules.md
│       ├── identity.md
│       └── profile.md
├── wecom-creds.json            # 企微凭证
└── .restart_requested          # Agent 重启信号
```

### Agent 适配方式

| Agent | 本地模式 | 远程模式 (Runner) | 说明 |
|-------|---------|------------------|------|
| Claude Code | ClaudeAdapter | RunnerAdapter | `claude --print` |
| Codex | CodexAdapter | RunnerAdapter | App-Server JSON-RPC 优先，CLI fallback |
| Hermes | HermesAdapter | — | HTTP API 直连 |
| OpenCode | — | RunnerAdapter | CLI 工具 |
| OpenClaw | RemoteAPIAdapter | — | HTTP API 直连 |

### 分布式 Runner

Runner 是部署在远程 Agent 机器上的轻量 HTTP 服务，封装 CLI 工具：

```bash
# 在远程机器上启动 Runner
RUNNER_API_KEY=your-key RUNNER_PORT=9800 bun run modules/runner/server.ts
```

**API 端点：**

| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /run` | POST | 启动执行，返回 SSE 流式输出 |
| `POST /approval` | POST | 下发用户确认结果 |
| `POST /cancel` | POST | 取消执行 |
| `GET /status` | GET | 查询会话状态 |
| `GET /health` | GET | 健康检查 |

### 许可证

MIT

---

## English Version

### Introduction

Agent Gateway is a personal productivity tool that lets you send commands to multiple AI coding agents distributed across multiple machines via IM apps on your phone (WeChat, Telegram, Feishu, WeCom).

Based on [imtoagent](https://github.com/imtoagent/imtoagent), extended with multi-instance routing, distributed Runner, SQLite storage, interactive approval, and more.

### Key Features

| Feature | Description |
|---------|-------------|
| **Multi-Channel** | WeChat (iLink), Telegram, Feishu, WeCom |
| **Multi-Agent** | Claude Code, Codex, Hermes, OpenCode, OpenClaw |
| **Multi-Machine** | Agents distributed across LAN and public VPS |
| **Multi-Instance** | Same agent type on multiple machines, routed by alias |
| **Command Routing** | `@alias`, `@machine:type`, `@type` routing formats |
| **Distributed Runner** | Lightweight HTTP service on remote machines wrapping CLI agents |
| **Interactive Approval** | Agent approval prompts forwarded to IM, user replies forwarded back |
| **Piggyback Notifications** | iLink notifications cached and delivered with next user message |
| **SQLite Storage** | Sessions, notifications, conversation history all persisted |
| **Codex Support** | App-Server (JSON-RPC) + CLI fallback, multi-turn threads |

### Quick Start

#### Prerequisites

- **Bun** runtime (≥1.0.0)
- At least one agent backend

#### Install

```bash
git clone <repo-url>
cd agent-gateway
bun install
```

#### Configure

Edit `config.yaml`:

```yaml
channels:
  telegram:
    enabled: true
    type: telegram
    bot_token: ${TELEGRAM_BOT_TOKEN}

agents:
  cc-home:
    type: claude-code
    host: 192.168.1.100:9090
    runner: true

  hermes-main:
    type: hermes
    host: 192.168.1.101:3000

  codex-local:
    type: codex
    backend: codex

routing:
  default_agent: cc-home
```

#### Start

```bash
bun run index.ts
```

### Command Format

Send messages in IM:

| Format | Example | Behavior |
|--------|---------|----------|
| `@alias message` | `@cc-home write a function` | Exact instance match |
| `@machine:type message` | `@home:claude-code check code` | Machine + type match |
| `@type message` | `@hermes analyze deps` | Unique match routes directly, multiple prompts selection |
| `message` (no prefix) | `help me refactor` | Routes to default agent |

#### System Commands

| Command | Function |
|---------|----------|
| `/list` | List registered agents |
| `/status` | View all agent status |
| `/status @agent` | View specific agent status |
| `/switch @agent` | Switch default agent |
| `/cancel @agent` | Cancel running task |
| `/help` | Help info |

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Gateway                         │
│                                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │
│  │  iLink  │  │Telegram │  │ Feishu  │  │  WeCom  │   │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘   │
│       └────────────┼──────────┼──────────────┘         │
│                    ▼                                     │
│              ┌──────────┐                               │
│              │  Router   │  @alias / @machine:type / @type│
│              └─────┬────┘                               │
│                    ▼                                     │
│  ┌──────────────────────────────────────────────┐      │
│  │           Agent Adapters                      │      │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐│      │
│  │  │Claude  │ │ Codex  │ │ Hermes │ │ Runner ││      │
│  │  │Adapter │ │Adapter │ │Adapter │ │Adapter ││      │
│  │  └────────┘ └────────┘ └────────┘ └────────┘│      │
│  └──────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
         │                    │
    ┌────┴────┐          ┌────┴────┐
    │  Local   │          │ Runner  │ ← Remote machine
    │  Agent   │          └─────────┘
    └─────────┘
```

### Agent Integration

| Agent | Local Mode | Remote Mode (Runner) | Notes |
|-------|-----------|---------------------|-------|
| Claude Code | ClaudeAdapter | RunnerAdapter | `claude --print` |
| Codex | CodexAdapter | RunnerAdapter | App-Server JSON-RPC preferred, CLI fallback |
| Hermes | HermesAdapter | — | HTTP API direct |
| OpenCode | — | RunnerAdapter | CLI tool |
| OpenClaw | RemoteAPIAdapter | — | HTTP API direct |

### Distributed Runner

Runner is a lightweight HTTP service deployed on remote agent machines, wrapping CLI tools:

```bash
# Start Runner on remote machine
RUNNER_API_KEY=your-key RUNNER_PORT=9800 bun run modules/runner/server.ts
```

**API Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /run` | POST | Start execution, returns SSE stream |
| `POST /approval` | POST | Send user approval response |
| `POST /cancel` | POST | Cancel execution |
| `GET /status` | GET | Query session status |
| `GET /health` | GET | Health check |

### Data Directory

Runtime data is stored in `~/.agent-gateway/`:

```
~/.agent-gateway/
├── data/
│   └── gateway.db              # SQLite database
├── media/
│   └── inbound/                # Received media files
├── logs/
│   └── imtoagent.log           # Runtime logs
├── soul/                       # Bot personality files
│   └── {botName}/
│       ├── rules.md
│       ├── identity.md
│       └── profile.md
├── wecom-creds.json            # WeCom credentials
└── .restart_requested          # Agent restart signal
```

### License

MIT
