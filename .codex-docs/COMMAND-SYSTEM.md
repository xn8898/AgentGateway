# IMtoAgent 命令体系设计

> 2026-05-10 · 三层命令架构，已实现 Layer1 网关级 + Layer2 翻译级

## 设计原则

1. **网关不管理后端状态** — 状态归后端，网关只做翻译/透传
2. **按后端类型适配** — 同一命令名，不同后端翻译为不同原生动作
3. **扩展性优先** — 未来接入 Cursor 等新 Agent 时，只需新增翻译映射

## 三层架构

```
飞书消息 "xxx"
  │
  ├─ 以 / 开头 ──→ 命令路由层
  │                 │
  │                 ├─ Layer 1: 网关级
  │                 │     gateway 直接处理，后端完全无感知
  │                 │     所有 Bot 通用
  │                 │
  │                 ├─ Layer 2: 拦截翻译级
  │                 │     gateway 拦截 → 翻译为后端原生动作 → 执行
  │                 │     按后端类型映射不同行为
  │                 │
  │                 └─ Layer 3: 透传级
  │                       不以 / 开头 → 原样给后端
  │
  └─ 非 / 开头 ──→ 透传给后端 Agent
```

## Layer 1: 网关级命令

Gateway 自己处理，后端不感知。所有 Bot 通用。

| 命令 | 功能 | 持久化 |
|------|------|--------|
| `/help` | 动态命令列表（按后端类型生成） | - |
| `/status` | Bot名 + 后端类型 + 当前模型 + 调用次数 | - |
| `/info` | Bot名、模型、目录、会话数 | - |
| `/stats` | Token/费用统计 | - |
| `/model <spec>` | 切换该 Bot 的模型路由 | ✅ Bot 级配置 |
| `/model` | 查看当前模型 | - |
| `/providers` | 列出可用供应商和模型 | - |
| `/reload` | 热重载 | - |

### `/model` 行为详解

- 切换的是**当前 Bot 对应的模型**，不是全局
- 后端无感知：后端仍然调同一个 proxy endpoint，proxy 层根据 Bot 配置选择上游模型
- 持久化到 Bot 级配置文件 `sessions/<BotName>/_config.json`
- 该 Bot 下所有飞书 chat 共享此配置

## Layer 2: 拦截翻译级命令

Gateway 拦截 → 翻译为后端原生动作 → 立即执行。Benefit: gateway 不维护后端状态。

| 命令 | Claude 翻译 | Codex 翻译 | Cursor(未来) |
|------|-----------|-----------|-------------|
| `/clear` | 关闭 SDK session → 下次自动新会话 | Codex 无原生 clear，设 `startFresh` 标记(见注) | 待定 |
| `/dir <path>` | `query({ cwd: newPath })` | `codex exec --cd <path>` | 待定 |
| `/mode <mode>` | `query({ permissionMode })` | ❌ 不支持，返回提示 | 待定 |

> **注**：`/clear` 对 Codex 使用 `startFresh` 标记是因为 Codex CLI 没有原生的"清空会话"指令。
> 这是一个用户意图标记（"下次开新会话"），不是后端状态管理。
> 未来如果 Codex CLI 支持 `codex exec --new` 或类似指令，可升级为原生翻译。

## Layer 3: 透传

不以 `/` 开头的一切消息，原样交给后端 Agent。Gateway 不做任何解析。

## 扩展性示例

接入 Cursor 时只需：
1. 在 `config.json` 新增 Bot: `{ "name": "CursorBot", "backend": "cursor", ... }`
2. 注册翻译映射:
   ```
   /clear → cursor exec --new-session
   /dir   → cursor exec --workspace <path>
   ```
3. Layer 1 命令（/help /status /model 等）自动适配

## 实现状态

| 功能 | 状态 |
|------|------|
| `/model` 网关级 + Bot 级持久化 | ✅ 已实现 (sessions/<Bot>/_bot.json) |
| `/help` 动态生成（按后端类型） | ✅ 已实现 |
| `/clear` Codex 翻译 | ✅ 已实现（startFresh） |
| `/clear` Claude 翻译 | ✅ 已实现 |
| `/mode` Claude only | ✅ 已实现（条件注册） |
| `/providers` 命令 | ✅ 已实现 |
| `/dir` 翻译为后端原生参数 | ⏸ 当前 session.cwd 已满足需求，后续优化 |
| Codex stats 追踪 | 🔜 待实现 |
