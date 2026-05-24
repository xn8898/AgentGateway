# Architecture

## Overview

```
IM Platform → IM Registry → Bot → AgentRuntime → AgentAdapter → Proxy :18899 → Upstream
```

## Core Components

### IM Registry Factory

Registers IM adapters by type. New IMs need only one registration line:

```typescript
registerIM("feishu", feishuFactory);
```

### AgentRuntime (`modules/core/`)

Message processing hub:
- Session management
- Agent adapter routing
- Stats tracking
- Error handling
- Session persistence

### AgentAdapter Interface

Unified abstraction for all agent backends:
- Claude Code → spawn subprocess
- Codex → app-server v2
- OpenCode → HTTP API

### Unified Proxy (`:18899`)

Single port for all agent requests. Anthropic-compatible format. No separate ports needed.

### Bot Configuration

Multiple bots can run simultaneously with different IM + agent combinations. Each bot has:
- Independent session persistence
- Per-bot soul files
- Model configuration (`activeModel`, `modelAliases`, `modelPresets`)

### Soul System

```
soul/<BotName>/
├── rules.md      → Behavioral rules
├── identity.md   → Bot identity
├── profile.md    → Skills
├── workspace.md  → Working directory
└── skills.md     → Available skills
```

Injected into Agent system prompt alongside IM capabilities.

### Graceful Shutdown

SIGINT/SIGTERM → Stop IM → Stop Proxy → Persist sessions → Wait for active requests (10s timeout).
