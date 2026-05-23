# imtoagent — IM ↔ Agent Unified Gateway

Connect Feishu, Telegram, personal WeChat, and WeCom to AI coding agents like Claude Code, Codex (GPT), OpenCode, and more.

One gateway, multiple IMs, multiple agents, unified port proxy.

## Architecture

```
飞书/Telegram/微信/企微 → IM Registry 工厂 → Bot 实例
                                          → AgentRuntime SDK → Agent Adapter
                                                             → 统一 Proxy (:18899) → 上游模型
```

### Supported IM Adapters

| IM | Connection | Capabilities |
|----|----------|------|
| **Feishu** | WebSocket persistent connection + auto-reconnect | Text, code blocks, cards, files, images, voice, buttons |
| **Telegram** | Long polling + HTTP proxy | Text, files, images, voice |
| **Personal WeChat** | iLink HTTP long-poll + QR scan | Text, images, files, voice (AES-128-ECB encrypted) |
| **WeCom** | HTTP Webhook callback + REST API | Text, files, images |

### Supported Agent Backends

| Backend | Integration Method |
|------|----------|
| **Claude Code** | Claude Agent SDK spawn subprocess |
| **Codex** | app-server v2 (stdio JSON-RPC) |
| **OpenCode** | HTTP API client |

## Quick Start

### Prerequisites

- **Bun** runtime (≥1.0.0): `brew install oven-sh/bun/bun`
- **macOS / Linux**
- **At least one Agent backend** (see table below; can be installed before or after imtoagent)

| Backend | Install Command |
|------|----------|
| Claude Code | `npm install -g @anthropic-ai/claude-agent-sdk` |
| Codex | `npm install -g @openai/codex` |
| OpenCode | `npm install -g opencode` |

### Installation

#### Method 1: npm global install (recommended)

```bash
npm install -g imtoagent
```

After installation, it automatically checks whether initial configuration is needed. An interactive terminal will guide you through the setup wizard.

#### Method 2: Source install

```bash
git clone https://github.com/YOUR_USERNAME/imtoagent.git
cd imtoagent
bun install
bun run bin/imtoagent setup
```

### First-Time Configuration

```bash
imtoagent setup
```

The interactive setup wizard guides you through:

1. **Configure Bot** — Select IM platform + Agent backend
2. **Configure Model Providers** — Add API credentials (DeepSeek, Dashscope, etc.)
3. **Generate Soul Files** — Create rules.md / identity.md etc. for each Bot
4. **Write Config Files** — Auto-generate `~/.imtoagent/config.json`

#### Feishu Bot Requirements

- Feishu App ID (`cli_...`)
- Feishu App Secret
- Feishu app must enable: Bot, Event Subscription, Message Send/Receive permissions

#### Telegram Bot Requirements

- Telegram Bot Token (obtain from @BotFather)
- Optional: Proxy address (e.g., `http://127.0.0.1:7890`)

#### Personal WeChat

- QR code automatically pops up on first run of `imtoagent start`
- Scan with your phone's WeChat to complete binding

### Start the Gateway

```bash
imtoagent start     # Start in background
imtoagent status    # Check running status
imtoagent stop      # Stop the gateway
```

### Auto-Start on Boot (macOS launchd)

```bash
# Create launchd configuration
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

# Load
launchctl load ~/Library/LaunchAgents/com.imtoagent.plist
```

### Common Commands

| Command | Description |
|------|------|
| `imtoagent setup` | Interactive setup wizard |
| `imtoagent start` | Start gateway in background |
| `imtoagent stop` | Stop the gateway |
| `imtoagent status` | Check running status |
| `imtoagent restore` | Hot reload recovery |
| `imtoagent daemon` | Foreground daemon mode (suitable for launchd/systemd) |

### Built-In Gateway Commands

Send to the Bot in IM chat:

| Command | Description |
|------|------|
| `/help` | Help information |
| `/status` | Gateway status |
| `/stats` | Usage statistics |
| `/model` | Switch model |
| `/providers` | View providers |
| `/memory` | View memory |
| `/soul` | Soul management |
| `/reload` | Reload |
| `/clear` | Clear session |
| `/mode` | Switch mode (permission/auto/plan) |
| `/dir` | Switch working directory |

## Project Structure

```
imtoagent/
├── index.ts                    # Entry — IM Registry + Bot construction + Proxy startup
├── bin/imtoagent               # CLI command entry point
├── modules/
│   ├── core/                   # SDK Core
│   │   ├── AgentRuntime.ts     # Message processing hub
│   │   ├── AgentAdapter.ts     # Unified Agent backend abstraction
│   │   ├── SessionManager.ts   # Session persistence
│   │   └── types.ts            # Type definitions
│   ├── im/                     # IM adapters
│   │   ├── feishu.ts           # Feishu
│   │   ├── telegram.ts         # Telegram
│   │   ├── wechat.ts           # Personal WeChat
│   │   └── wecom.ts            # WeCom
│   ├── agent/                  # Agent backends
│   │   ├── claude-adapter.ts   # Claude Code
│   │   ├── codex-adapter.ts    # Codex
│   │   └── opencode-adapter.ts # OpenCode
│   ├── proxy/                  # Unified proxy
│   │   └── anthropic-proxy.ts  # :18899 Anthropic format proxy
│   ├── cli/                    # CLI
│   │   └── setup.ts            # Interactive setup wizard
│   └── utils/
│       └── paths.ts            # Path resolution + auto-init
├── scripts/
│   └── postinstall.ts          # Post-npm-install guidance
├── templates/                  # Config templates
│   ├── config.template.json
│   ├── providers.template.json
│   ├── opencode.template.json
│   └── soul.template/
└── README.md
```

## Data Directory

All runtime data is stored centrally in `~/.imtoagent/`:

```
~/.imtoagent/
├── config.json          # Main config (Bot + providers + system)
├── providers.json       # Model provider config
├── opencode.json        # OpenCode config
├── sessions/            # Session persistence
├── logs/                # Runtime logs
└── soul/                # Soul files (one directory per Bot)
    ├── ClaudeBot/
    ├── CodexBot/
    └── ...
```

## Development

```bash
bun install
bun run index.ts          # Run directly
bun run bin/imtoagent setup  # Run setup wizard
```

## License

MIT
