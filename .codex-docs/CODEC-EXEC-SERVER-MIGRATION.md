# Codex Exec-Server 迁移方案

> 2026-05-14 · 由 CX 基于 openai/codex app-server-protocol v2 源码分析产出
> 目标：将 IMtoAgent 对接 Codex 的方式从 `codex exec` 子进程升级为 app-server v2 WebSocket 长连接

---

## 一、背景与动机

### 当前状态
- IMtoAgent 通过 `Bun.spawn('codex exec ...')` 调用 Codex CLI
- 新会话用 `spawnCodexExec`，续接用 `spawnCodexResume(threadId)`
- 线程内上下文保持**已正常工作**（通过 Codex CLI 的 `state_5.sqlite`）

### 真正痛点
- `codex exec` 是一次性子进程，大任务容易超时/OOM 崩溃
- 崩溃后 `codex.ts` 的 catch 块会清掉 `codexThreadId`，回退到全新会话 → 上下文全丢
- 输出是一次性全量返回，无法流式展示进度
- 不触发 Codex 的长期记忆流水线（`raw_memories.md`，次要问题）

### 目标
- 切换到 app-server v2 WebSocket 持久连接
- 单轮失败不影响线程上下文
- 流式输出、实时看到进度（Plan/Diff/Tool calls）
- 自动触发长期记忆

---

## 二、架构概览

```
IMtoAgent (Bun)
  │
  ├─ codex.ts (编排层)          ← 需要修改
  │   ├─ 优先: exec-server WS   ← 新增
  │   └─ 回退: codex exec       ← 保留
  │
  ├─ codex-exec-server.ts       ← 新建
  │   ├─ 进程管理 (Bun.spawn)
  │   ├─ WS JSON-RPC 客户端
  │   └─ 通知分发
  │
  └─ config.json                ← 需要新增字段
      └─ execServer: { enabled, port, timeout, fallbackToExec }
```

## 三、协议说明（app-server v2）

协议源码：`openai/codex` → `codex-rs/app-server-protocol/src/protocol/v2/`

### 3.1 请求（Client → Server）

#### initialize
```json
{ "method": "initialize", "params": { "clientName": "imtoagent", "resumeSessionId": "optional-session-id" } }
```
返回：`{ "session_id": "..." }`

#### thread/start
```json
{
  "method": "thread/start",
  "params": {
    "cwd": "/path/to/workdir",
    "model": "gpt-5.5",
    "modelProvider": "imtoagent",
    "sandbox": "danger-full-access",
    "approvalPolicy": "never"
  }
}
```
响应为 `ThreadStartedNotification { thread }`

#### thread/resume
```json
{
  "method": "thread/resume",
  "params": { "thread_id": "thread-xxx" }
}
```
响应为 `ThreadResumeResponse { thread, model, cwd, sandbox, ... }`

#### turn/start
```json
{
  "method": "turn/start",
  "params": {
    "thread_id": "thread-xxx",
    "input": [{ "text": "用户消息内容" }],
    "cwd": "/path/to/workdir",
    "model": "gpt-5.5",
    "effort": "medium"
  }
}
```
响应为 `TurnStartResponse { turn }`

#### turn/interrupt
```json
{
  "method": "turn/interrupt",
  "params": { "thread_id": "thread-xxx", "turn_id": "turn-xxx" }
}
```

### 3.2 通知（Server → Client，流式推送）

| 通知类型 | 关键字段 | 用途 |
|---------|---------|------|
| `ThreadStartedNotification` | `thread` | 新线程创建 |
| `ThreadClosedNotification` | `thread_id` | 线程关闭 |
| `TurnStartedNotification` | `thread_id, turn` | 新一轮开始 |
| `TurnCompletedNotification` | `thread_id, turn` | 轮次完成 → **触发记忆** |
| `AgentMessageDeltaNotification` | `thread_id, turn_id, delta` | **流式文本** |
| `ItemStartedNotification` | `thread_id, turn_id, item` | 工具调用开始 |
| `ItemCompletedNotification` | `thread_id, turn_id, item` | 工具调用完成 |
| `ReasoningTextDeltaNotification` | `thread_id, turn_id, delta` | 推理过程 |
| `TurnPlanUpdatedNotification` | `thread_id, turn_id, plan, explanation` | 计划更新 |
| `TurnDiffUpdatedNotification` | `thread_id, turn_id, diff` | Diff 更新 |
| `ContextCompactedNotification` | `thread_id, turn_id` | 上下文压缩 |

### 3.3 重要：需要验证

**以下内容基于源码分析，尚未通过实际连接验证：**

1. `codex exec-server --listen` 暴露的是哪层协议？需要实际测试
2. 如果只暴露 exec-server 协议（`process/start`），则 app-server v2 可能在另一个入口
3. 建议先用 WebSocket 客户端连上去发 `initialize` 看返回

---

## 四、Step 0：协议验证（必做，阻塞后续）

**目的**：确认 `codex exec-server` 实际暴露的协议版本。

**操作**：
```bash
# 启动 exec-server
codex exec-server --listen ws://127.0.0.1:18901

# 用 wscat 或其他 WS 客户端连接
wscat -c ws://127.0.0.1:18901

# 发 initialize
> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientName":"imtoagent-test"}}

# 观察返回，判断：
# - 如果返回 session_id + 后续有 thread/start 等方法 → app-server v2 ✅
# - 如果返回 initialized 通知 + 后续只有 process/start → exec-server 协议 ❌ 需要另找入口
```

**验证通过标准**：能成功调用 `thread/start` + `turn/start`，收到 `AgentMessageDeltaNotification`。

---

## 五、实现步骤

### Step 1: 新建 `modules/agent/codex-exec-server.ts`

职责：
- 管理 `codex exec-server` 子进程生命周期（启动/重启/关闭）
- WebSocket JSON-RPC 客户端
- 支持 `initialize` → `thread/start|resume` → `turn/start` 调用链
- 将 Server Notification 分发给上层回调

核心接口设计：
```typescript
interface ExecServerClient {
  // 生命周期
  connect(): Promise<void>
  close(): void
  
  // 业务方法
  initialize(clientName: string, resumeSessionId?: string): Promise<string> // 返回 sessionId
  threadStart(params: ThreadStartParams): Promise<ThreadStartedNotification>
  threadResume(threadId: string): Promise<ThreadResumeResponse>
  turnStart(params: TurnStartParams): AsyncIterable<TurnNotification>
  turnInterrupt(threadId: string, turnId: string): Promise<void>
}

interface ThreadStartParams {
  cwd: string
  model?: string
  modelProvider?: string
  sandbox?: string
  approvalPolicy?: string
}

interface TurnStartParams {
  threadId: string
  input: string  // 用户消息
  cwd?: string
  model?: string
  effort?: string
}

type TurnNotification = 
  | { type: 'started', turn: Turn }
  | { type: 'delta', delta: string }
  | { type: 'item_started', item: ThreadItem }
  | { type: 'item_completed', item: ThreadItem }
  | { type: 'plan_updated', plan: PlanStep[], explanation?: string }
  | { type: 'diff_updated', diff: string }
  | { type: 'completed', turn: Turn }
  | { type: 'error', message: string }
```

### Step 2: 修改 `modules/agent/codex.ts`

职责：
- 优先走 exec-server（如果 `config.json.execServer.enabled: true`）
- exec-server 失败时回退到现有的 `codex exec` 路径
- 保留现有的 `spawnCodexExec`/`spawnCodexResume` 作为 fallback

关键修改点：
1. `handleMessage()` 中增加 exec-server 优先分支
2. 失败回退时**不再清 `codexThreadId`**（exec-server 模式下线程不会因单轮失败而失效）
3. 增加 `AgentMessageDeltaNotification` 的流式处理，逐段发送到飞书

伪代码：
```typescript
async handleMessage(chatId, text, session) {
  const useExecServer = config.execServer?.enabled !== false
  
  if (useExecServer) {
    try {
      const client = getExecServerManager().getClient(chatId)
      // 首次或 startFresh 时创建/恢复线程
      if (session.startFresh || !session.codexThreadId) {
        await client.threadStart({ cwd, model, ... })
        // 从 ThreadStartedNotification 获取 thread_id
        session.codexThreadId = threadId
      }
      // 启动 turn
      for await (const notif of client.turnStart({ threadId, input: text })) {
        switch (notif.type) {
          case 'delta': await ctx.reply(chatId, notif.delta) // 流式输出
          case 'item_started': ctx.addToolLog(chatId, ...)
          case 'completed': /* 触发统计 & 持久化 */
        }
      }
    } catch (e) {
      console.error('exec-server failed, falling back to exec')
      // 回退到现有逻辑，不丢 threadId
    }
  } else {
    // 现有 exec 逻辑保持不变
  }
}
```

### Step 3: 修改 `config.json`

新增字段：
```json
{
  "execServer": {
    "enabled": true,
    "port": 18901,
    "timeout": 300000,
    "fallbackToExec": true
  }
}
```

### Step 4: 其他改动

| 文件 | 改动 |
|------|------|
| `modules/agent/codex.ts` | 增加 exec-server 优先分支，保留 fallback |
| `modules/agent/codex-exec-server.ts` | **新建**，核心实现 |
| `config.json` | 新增 `execServer` 配置块 |
| `sessions/*.memory.json` | 新增 `codexSessionId` 字段（可选，用于断线重连） |

---

## 六、不变的部分（明确不碰）

| 保留项 | 说明 |
|--------|------|
| `spawnCodexExec` / `spawnCodexResume` | 作为 fallback 路径完整保留 |
| `codex-proxy.ts` (:18899 统一端口) | 不修改，协议转换层不变 |
| `anthropic-proxy.ts` (:18899) | 不相关 |
| `sessions/` 持久化格式 | 只增字段，不改结构 |
| 现有的错误处理 catch 块 | 保留 exec 回退逻辑 |

---

## 七、风险与注意事项

| 风险 | 缓解 |
|------|------|
| exec-server 协议版本不确定 | Step 0 必须验证 |
| exec-server 子进程崩溃 | 自动重启 + 通过 `thread/resume` 恢复线程 |
| WS 连接断开 | 重连机制 + `resumeSessionId` 恢复会话 |
| 流式输出与飞书消息格式冲突 | 参考现有飞书卡片消息机制，逐段更新或累积到一定长度再发 |
| 与现有 exec 回退路径冲突 | exec-server 失败时 threadId 不清空，留给下次 retry |

---

## 八、可后续迭代（不在此次范围）

- [ ] 飞书实时展示 Tool Call 进度卡片
- [ ] 飞书实时展示 Plan 步骤状态
- [ ] Gateway 层跨会话长期记忆（自建，不依赖 Codex memories）
- [ ] exec-server 健康检查 & 自动恢复
- [ ] 多 Codex 实例负载均衡

---

## 参考文件

- `openai/codex` → `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- `openai/codex` → `codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
- `openai/codex` → `codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `openai/codex` → `codex-rs/exec-server/src/protocol.rs`
