# 会话连续性 — App-Server v2 协议对接

> 2026-05-14 · 基于 openai/codex app-server-protocol v2 schema 校准
> 2026-05-13 · 从 `codex exec` 迁移到 `codex exec-server` WebSocket 持久连接

## 为什么迁移

`codex exec`（一次性子进程）不会触发 Codex CLI 的 **跨线程长记忆**（`memories` 特性）。
`memories` 特性负责将 rollout 摘要整合到 `raw_memories.md`，并在后续会话中注入 system prompt。
该特性只在 TUI 交互模式下触发，`exec` 一锤子模式不触发。

`codex exec-server` 使用 JSON-RPC over WebSocket 协议（app-server v2），与 TUI 模式共享底层协议，
`TurnCompletedNotification` 事件会自动触发记忆流水线。

## 当前架构

```
CodexAgentModule.handleMessage()
  │
  ├─ 优先: exec-server WebSocket (JSON-RPC, app-server v2)
  │   getExecServerManager().getClient(chatId)
  │     → ws.send('initialize', { clientName: 'imtoagent', resumeSessionId?: string })
  │     → ws.send('thread/start', { cwd, model, ... })  或  ws.send('thread/resume', { thread_id })
  │     → ws.send('turn/start', { thread_id, input: [{text: prompt}] })
  │     ← 通知流: TurnStartedNotification
  │     ← 通知流: AgentMessageDeltaNotification (文本增量)
  │     ← 通知流: ItemStartedNotification / ItemCompletedNotification (工具调用)
  │     ← 通知流: TurnPlanUpdatedNotification (计划更新)
  │     ← 通知流: TurnDiffUpdatedNotification (diff 更新)
  │     ← 通知流: TurnCompletedNotification { thread_id, turn }
  │
  └─ 回退: codex exec (Bun.spawn 一次性子进程)
      spawnCodexExec / spawnCodexResume
        → codex exec -p imtoagent ...
```

## 线程管理

| 场景 | exec-server 路径 | exec 回退路径 |
|------|-----------------|-------------|
| 新会话（startFresh=true 或 无 codexThreadId） | `thread/start` → ThreadStartedNotification → 存 thread_id | `codex exec` 新建线程 |
| 续接会话（有 codexThreadId） | `thread/resume { thread_id }` → ThreadResumeResponse | `codex exec resume <threadId>` |
| exec-server 失败 | 自动回退 exec，清除断开的 WS 客户端 | — |

## 实际 app-server v2 协议（基于 openai/codex 源码）

### 请求（Client → Server）

| 方法 | 参数要点 | 响应 |
|------|---------|------|
| `initialize` | `clientName`, `resumeSessionId?` | `{ session_id }` |
| `thread/start` | `cwd?`, `model?`, `sandbox?`, `personality?`, `base_instructions?`, `approval_policy?`, `permissions?` | ThreadStartedNotification |
| `thread/resume` | **`thread_id`** (必填), `cwd?`, `model?`, `exclude_turns?` | ThreadResumeResponse `{ thread, model, cwd, sandbox, ... }` |
| `turn/start` | **`thread_id`** (必填), **`input`** (Vec\<UserInput\>), `cwd?`, `model?`, `effort?`, `output_schema?` | TurnStartResponse `{ turn }` |
| `turn/interrupt` | `thread_id`, `turn_id` | TurnInterruptResponse |

### 通知（Server → Client）

| 通知 | 关键字段 | 说明 |
|------|---------|------|
| `ThreadStartedNotification` | `thread: Thread` | 新线程已创建 |
| `ThreadStatusChangedNotification` | `thread_id`, `status` | 线程状态变化 |
| `ThreadClosedNotification` | `thread_id` | 线程关闭 |
| `TurnStartedNotification` | `thread_id`, `turn: Turn` | 新一轮开始 |
| **`TurnCompletedNotification`** | `thread_id`, `turn: Turn` | **轮次结束，触发记忆流水线** |
| `AgentMessageDeltaNotification` | `thread_id`, `turn_id`, `delta: string` | **流式文本输出** |
| `ItemStartedNotification` | `thread_id`, `turn_id`, `item` | 工具调用开始 |
| `ItemCompletedNotification` | `thread_id`, `turn_id`, `item` | 工具调用完成 |
| `ReasoningTextDeltaNotification` | `thread_id`, `turn_id`, `delta` | 推理过程增量 |
| `TurnPlanUpdatedNotification` | `thread_id`, `turn_id`, `plan[]`, `explanation?` | 计划更新 |
| `TurnDiffUpdatedNotification` | `thread_id`, `turn_id`, `diff` | Diff 更新 |
| `ProcessOutputDeltaNotification` | — | 子进程输出增量 |
| `ProcessExitedNotification` | — | 子进程退出 |
| `ContextCompactedNotification` | `thread_id`, `turn_id` | 上下文压缩 |

## IMtoAgent 需要做的适配

| 事项 | 说明 |
|------|------|
| **每个请求带 thread_id** | `turn/start`、`turn/interrupt` 都需要携带 `thread_id`，不像之前假设的是无状态的 turn |
| **text 输入用 UserInput 结构** | `turn/start` 的 input 字段是 `Vec<UserInput>`，不是裸字符串 |
| **文本输出走 Delta** | 不是 `agent_message` item 一次性返回，而是 `AgentMessageDeltaNotification` 流式推送 |
| **记忆触发点** | `TurnCompletedNotification` 触发记忆流水线（和文档假设一致） |

### 与旧文档的关键差异

1. **之前的文档假设 turn 无状态**，实际每个请求都绑定 `thread_id`
2. **之前假设 agent_message 一次性返回**，实际是 delta 流式推送
3. **之前忽略了 ItemStarted/ItemCompleted**，这些是追踪工具调用的关键通知
4. **之前不知道 TurnPlanUpdated 和 TurnDiffUpdated**，这些对实时展示进度很有用

## 记忆整合流程

```
codex app-server (持久进程)
  │
  ├─ thread/start 或 thread/resume → 线程就绪
  ├─ turn/start { thread_id, input } → TurnStartedNotification
  ├─ ... 通知流 → AgentMessageDelta, ItemStarted/Completed, TurnPlanUpdated, TurnDiffUpdated
  ├─ TurnCompletedNotification → 轮次结束
  │
  └─ 自动触发记忆整合:
      rollout → summary → raw_memories.md
      → .codex/memories/ 更新
      → 下次会话 system prompt 注入
```

## 进程生命周期

```
Gateway 启动
  → exec-server 不启动（懒加载）

第一条 CodexBot 消息
  → getExecServerManager().ensureRunning()
  → Bun.spawn('codex exec-server --listen ws://127.0.0.1:PORT ...')
  → 等待端口就绪
  → WebSocket 连接

Gateway 关闭 (SIGTERM/SIGINT/reload)
  → shutdownExecServer()
  → 关闭所有 WS 客户端
  → SIGTERM → 等 3s → SIGKILL
```

## 数据结构

- `ChatSession.codexThreadId?: string` — app-server 线程 ID，持久化到 `{chatId}.memory.json`
- `ChatSession.codexSessionId?: string` — app-server session ID（initialize 返回），用于断线重连
- `ChatSession.startFresh?: boolean` — `/clear` 后置 true，下条消息开新线程后置 false
- `config.json.execServer` — exec-server 配置（enabled/port/timeout/fallbackToExec）

## 文件分工

| 文件 | 职责 |
|------|------|
| `modules/agent/codex-exec-server.ts` | exec-server 进程管理 + WebSocket JSON-RPC 客户端（app-server v2） |
| `modules/agent/codex.ts` | 编排层：exec-server 优先 → exec 回退 |

## 参考

- 源码: `openai/codex` → `codex-rs/app-server-protocol/src/protocol/v2/`
- Schema: `codex-rs/app-server-protocol/schema/json/v2/`
