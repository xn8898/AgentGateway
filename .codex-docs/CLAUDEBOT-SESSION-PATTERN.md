# ClaudeBot 会话管理模式

> 参考对象：学习 ClaudeBot 如何将会话管理委托给后端，不影响它

## Claude Agent SDK 的会话管理方式

ClaudeBot 路径中，会话生命周期完全由 **Claude Agent SDK** 管理，ccgateway 只扮演极轻量的角色。

### 核心代码 (index.ts `_startClaudeLoop`)

```typescript
const queryOptions: any = {
  persistSession: true,   // SDK 自己持久化会话到磁盘
  // ...
};

if (session.sdkSessionId) {
  queryOptions.resume = session.sdkSessionId;   // 恢复已有会话
} else {
  queryOptions.sessionId = crypto.randomUUID(); // 新建会话
}

const q = query({ prompt, options: queryOptions, env: customEnv });

for await (const msg of q) {
  if (msgAny.session_id && !session.sdkSessionId) {
    session.sdkSessionId = msgAny.session_id;  // 首次响应中捕获 session_id
    this._persistSession(chatId, session);      // 持久化保存
  }
  // ...
}
```

### 模式总结

```
┌─────────────┐     sessionId      ┌──────────────────────┐
│  ccgateway   │ ──────────────────│  Claude Agent SDK     │
│  (Bot 层)    │                    │                       │
│              │                    │  persistSession: true │
│  只存:       │   resume/新建      │  自己管理磁盘持久化    │
│  sdkSessionId│ ◄────────────────│  创建、恢复、状态跟踪  │
│              │  返回 session_id   │                       │
└─────────────┘                    └──────────────────────┘
```

### 关键特征

1. **SDK 原生管理会话** — `persistSession: true` 让 SDK 全权负责
2. **ccgateway 只记住一个 id** — `sdkSessionId`，不管理会话内容、不维护映射逻辑
3. **首次调用自动创建** — `sessionId = crypto.randomUUID()`
4. **后续调用自动恢复** — `resume = sdkSessionId`
5. **session_id 由 SDK 返回** — ccgateway 被动捕获并保存

### 对 CodexBot 的启示

CodexBot 的等价模式应该是：

```
┌─────────────┐    --last/--new    ┌──────────────────────┐
│  ccgateway   │ ──────────────────│  Codex CLI            │
│  (Bot 层)    │                    │                       │
│              │                    │  resume --last        │
│  不存        │   恢复最近/新建    │  自己知道上次 session  │
│  threadId    │ ◄────────────────│  自己管理会话生命周期  │
│              │  返回 thread_id   │                       │
└─────────────┘                    └──────────────────────┘
```

核心差异：
- Claude: SDK 是持续运行的进程，`persistSession` 内置支持
- Codex: CLI 是每次调用的子进程（`Bun.spawn`），需要 `codex exec resume --last` 来让 Codex 自己找到最近会话

### 不变的原则

不管 CodexBot 如何改进，ClaudeBot 的会话管理不受影响：
- Bot 之间完全隔离
- Claude Agent SDK 的 `persistSession` + `resume` 模式继续工作
- ccgateway 的多 Bot 架构保持不变
