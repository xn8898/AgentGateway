# imtoagent — IM ↔ Agent 统一网关

将飞书、Telegram、个人微信、企业微信对接到 Claude Code、Codex (GPT)、OpenCode 等 AI 编程 Agent。

一个网关，多个 IM，多种 Agent，统一端口代理。

## 架构

```
飞书/Telegram/微信/企微 → IM Registry 工厂 → Bot 实例
                                          → AgentRuntime SDK → Agent Adapter
                                                             → 统一 Proxy (:18899) → 上游模型
```

### 已支持的 IM 适配器

| IM | 连接方式 | 能力 |
|----|----------|------|
| **飞书** | WebSocket 长连接 + 自动重连 | 文本、代码块、卡片、文件、图片、语音、按钮 |
| **Telegram** | 长轮询 + HTTP 代理 | 文本、文件、图片、语音 |
| **个人微信** | iLink HTTP long-poll + QR 扫码 | 文本、图片、文件、语音（AES-128-ECB 加密） |
| **企业微信** | HTTP Webhook 回调 + REST API | 文本、文件、图片 |

### 已支持的 Agent 后端

| 后端 | 对接方式 |
|------|----------|
| **Claude Code** | Claude Agent SDK spawn 子进程 |
| **Codex** | app-server v2 (stdio JSON-RPC) |
| **OpenCode** | HTTP API client |

## 快速开始

### 前置条件

- **Bun** 运行时（≥1.0.0）：`brew install oven-sh/bun/bun`
- **macOS / Linux**
- **至少一个 Agent 后端**（见下表，安装 imtoagent 前或后安装均可）

| 后端 | 安装命令 |
|------|----------|
| Claude Code | `npm install -g @anthropic-ai/claude-agent-sdk` |
| Codex | `npm install -g @openai/codex` |
| OpenCode | `npm install -g opencode` |

### 安装

#### 方式一：npm 全局安装（推荐）

```bash
npm install -g imtoagent
```

安装完成后自动检测是否需要初始配置，交互式终端会自动引导进入配置向导。

#### 方式二：源码安装

```bash
git clone https://github.com/YOUR_USERNAME/imtoagent.git
cd imtoagent
bun install
bun run bin/imtoagent setup
```

### 首次配置

```bash
imtoagent setup
```

交互式配置向导引导你完成：

1. **配置 Bot** — 选择 IM 平台 + Agent 后端
2. **配置模型供应商** — 添加 API 凭证（DeepSeek、Dashscope 等）
3. **生成灵魂文件** — 为每个 Bot 创建 rules.md / identity.md 等
4. **写入配置文件** — 自动生成 `~/.imtoagent/config.json`

#### 飞书 Bot 需要

- 飞书 App ID（`cli_...`）
- 飞书 App Secret
- 飞书应用需开启：机器人、事件订阅、消息收发权限

#### Telegram Bot 需要

- Telegram Bot Token（从 @BotFather 获取）
- 可选：代理地址（如 `http://127.0.0.1:7890`）

#### 个人微信

- 首次运行 `imtoagent start` 后自动弹出 QR 码
- 用手机微信扫码完成绑定

### 启动网关

```bash
imtoagent start     # 后台启动
imtoagent status    # 查看运行状态
imtoagent stop      # 停止网关
```

### 开机自启（macOS launchd）

```bash
# 创建 launchd 配置
cat > ~/Library/LaunchAgents/com.imtoagent.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.imtoagent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/bun</string>
        <string>run</string>
        <string>/usr/local/lib/node_modules/imtoagent/index.ts</string>
        <string>daemon</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/$USER/.imtoagent</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/$USER/.imtoagent/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/$USER/.imtoagent/logs/launchd.err.log</string>
</dict>
</plist>
EOF

# 加载
launchctl load ~/Library/LaunchAgents/com.imtoagent.plist
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `imtoagent setup` | 交互式配置向导 |
| `imtoagent start` | 后台启动网关 |
| `imtoagent stop` | 停止网关 |
| `imtoagent status` | 查看运行状态 |
| `imtoagent restore` | 热重载恢复 |
| `imtoagent daemon` | 前台守护模式（适合 launchd/systemd 托管） |

### 网关内建命令

在 IM 聊天中发送给 Bot：

| 命令 | 说明 |
|------|------|
| `/help` | 帮助信息 |
| `/status` | 网关状态 |
| `/stats` | 使用统计 |
| `/model` | 切换模型 |
| `/providers` | 查看供应商 |
| `/memory` | 查看记忆 |
| `/soul` | 灵魂管理 |
| `/reload` | 重新加载 |
| `/clear` | 清除会话 |
| `/mode` | 切换模式（权限/auto/plan） |
| `/dir` | 切换工作目录 |

## 项目结构

```
imtoagent/
├── index.ts                    # 入口 — IM Registry + Bot 构造 + Proxy 启动
├── bin/imtoagent               # CLI 命令入口
├── modules/
│   ├── core/                   # SDK Core
│   │   ├── AgentRuntime.ts     # 消息处理中枢
│   │   ├── AgentAdapter.ts     # Agent 后端统一抽象
│   │   ├── SessionManager.ts   # 会话持久化
│   │   └── types.ts            # 类型定义
│   ├── im/                     # IM 适配器
│   │   ├── feishu.ts           # 飞书
│   │   ├── telegram.ts         # Telegram
│   │   ├── wechat.ts           # 个人微信
│   │   └── wecom.ts            # 企业微信
│   ├── agent/                  # Agent 后端
│   │   ├── claude-adapter.ts   # Claude Code
│   │   ├── codex-adapter.ts    # Codex
│   │   └── opencode-adapter.ts # OpenCode
│   ├── proxy/                  # 统一代理
│   │   └── anthropic-proxy.ts  # :18899 Anthropic 格式代理
│   ├── cli/                    # CLI
│   │   └── setup.ts            # 交互式配置向导
│   └── utils/
│       └── paths.ts            # 路径解析 + 自动初始化
├── scripts/
│   └── postinstall.ts          # npm 安装后引导
├── templates/                  # 配置模板
│   ├── config.template.json
│   ├── providers.template.json
│   ├── opencode.template.json
│   └── soul.template/
└── README.md
```

## 数据目录

所有运行时数据统一存储在 `~/.imtoagent/`：

```
~/.imtoagent/
├── config.json          # 主配置（Bot + 供应商 + 系统）
├── providers.json       # 模型供应商配置
├── opencode.json        # OpenCode 配置
├── sessions/            # 会话持久化
├── logs/                # 运行日志
└── soul/                # 灵魂文件（每 Bot 一个目录）
    ├── ClaudeBot/
    ├── CodexBot/
    └── ...
```

## 开发

```bash
bun install
bun run index.ts          # 直接运行
bun run bin/imtoagent setup  # 运行配置向导
```

## License

MIT
