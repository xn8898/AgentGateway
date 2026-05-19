# IMtoAgent 后端 Agent 自主重启能力设计方案

> 版本: v1.0
> 日期: 2025-07-17
> 状态: 待评审

---

## 1. 背景

IMtoAgent 是一个 IM ↔ AI Agent 的网关服务，运行在 Bun 上。当前已支持用户通过 `/reload` 命令手动触发热重载（`gracefulReload()`，基于 SIGHUP 机制）。

现在需要让**后端 Agent 自身**也能主动触发网关重启，且与具体使用哪个 Agent（Claude/Codex/OpenCode）无关。

---

## 2. 核心约束

| 约束 | 说明 |
|------|------|
| **进程内运行** | Agent 运行在 IMtoAgent 进程内部，若直接 kill 进程，Agent 的当前响应就会丢失 |
| **后端无关** | 不能依赖某个 Agent SDK 的特殊机制（如 tool call），必须对所有后端通用 |
| **用户无感** | 不需要用户确认，Agent 自己判断并执行 |
| **消息不丢** | 重启前必须确保当前响应已送达用户 |
| **防滥用** | 不能出现 Agent 循环重启导致服务不可用 |

---

## 3. 方案选型

### 3.1 备选方案对比

| | A. Tool Call | B. 外部文件信号 | C. 响应内嵌指令 **(选中)** |
|---|---|---|---|
| **原理** | Agent 调用重启 tool | Agent 写文件，watchdog 检测 | Agent 在回复中插入特殊标记 |
| **适配器改动** | 三个 Adapter 各改一次 | 无 | 无 |
| **可靠性** | 依赖 SDK tool 机制 | 轮询延迟，可能丢消息 | 标记剥离后触发，消息先送达 |
| **通用性** | 需各 SDK 支持 tool | 通用 | **完全通用** |
| **实现复杂度** | 中 | 中 | **低**（改 2 个文件） |
| **消息保障** | 取决于实现 | **差**（可能丢失） | **好**（先送达再重启） |

### 3.2 结论

**方案 C（响应内嵌指令）**：Agent 在回复中插入 `<!-- GATEWAY_RESTART: 原因 -->`，Runtime 层检测并剥离该指令，先把正常内容发送给用户，确认送达后再触发 `gracefulReload()`。

这是**改动最小、最通用、最可靠**的方案。

---

## 4. 详细设计

### 4.1 整体流程

```
┌──────────┐    回复文本（含指令）    ┌──────────┐
│  Agent   │ ───────────────────────→ │ Runtime  │
│(Claude/  │                          │          │
│ Codex/   │                          │ 1. 检测 <!-- GATEWAY_RESTART: ... -->
│ OpenCode)│                          │ 2. 剥离指令，保留正常内容
└──────────┘                          │ 3. 发送正常内容给 IM 用户
                                       │ 4. 标记 pendingRestart
                                       │ 5. 等待 500ms 确保送达
                                       │ 6. 执行 gracefulReload()
                                       └──────────┘
```

### 4.2 指令格式

```
<!-- GATEWAY_RESTART: 检测到配置变更，需要重载以生效 -->
```

**设计考量：**

- **HTML 注释语法**：即使剥离失败残留在消息中，飞书/Telegram 也不渲染，用户看不到
- **`GATEWAY_RESTART` 前缀**：命名空间隔离，避免与用户正常消息中的 HTML 注释混淆
- **冒号后的文本**：重启原因，会写入日志，方便排查

### 4.3 正则匹配与剥离

```typescript
const RESTART_PATTERN = /<!--\s*GATEWAY_RESTART:\s*(.+?)\s*-->/;

// 在 Runtime 层，消息组装完成后、发送前：
const match = finalText.match(RESTART_PATTERN);
if (match) {
  const reason = match[1].trim();
  finalText = finalText.replace(RESTART_PATTERN, '').trim();

  // 如果剥离后文本为空，替换为兜底消息
  if (!finalText) {
    finalText = '正在重启网关…';
  }

  // 发送正常内容
  await sendToIM(finalText);

  // 标记待重启
  scheduleRestart(reason);
  return; // 不继续后续流程
}

// 无指令，正常发送
await sendToIM(finalText);
```

### 4.4 防风暴机制

```typescript
const RESTART_COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟冷却
let lastRestartTime = 0;

function scheduleRestart(reason: string) {
  const now = Date.now();
  if (now - lastRestartTime < RESTART_COOLDOWN_MS) {
    logger.warn(
      `GATEWAY_RESTART ignored: cooldown active, ` +
      `${Math.ceil((RESTART_COOLDOWN_MS - (now - lastRestartTime)) / 1000)}s remaining`
    );
    return;
  }

  lastRestartTime = now;
  logger.info(`GATEWAY_RESTART scheduled: ${reason}`);

  setTimeout(async () => {
    await gracefulReload(`GATEWAY_RESTART: ${reason}`);
  }, 500); // 500ms 确保 IM 消息已送达
}
```

### 4.5 System Prompt 注入

在 `prompt-builder.ts` 中为所有 Agent 注入以下能力说明：

```markdown
## 网关控制指令

如果你判断需要重启 IMtoAgent 网关（如配置变更、检测到异常状态需重置），
可以在回复中插入以下指令：

\`\`\`
<!-- GATEWAY_RESTART: <简短原因> -->
\`\`\`

规则：
- 该指令会被自动剥离，用户不会看到
- 你的其余回复内容会先正常发送给用户，然后网关执行重启
- 仅在确实需要时使用，不要随意触发重启
- 如果你不需要重启，忽略此指令即可
```

---

## 5. 安全性

| 风险 | 对策 |
|------|------|
| **Agent 循环重启** | 5 分钟冷却期，短时间频繁触发会被拒绝并记录日志 |
| **新进程启动失败** | 复用现有 `gracefulReload()` 的回滚机制：10 秒未就绪则恢复旧进程 |
| **指令残留暴露给用户** | HTML 注释语法 + 双重剥离保障；即使残留，飞书/Telegram 也不渲染 |
| **Agent 忽略指令格式** | System prompt 中提供明确示例；正则做了宽松匹配（`\s*`） |
| **误匹配正常内容** | `GATEWAY_RESTART:` 是具体的前缀，正常对话几乎不可能出现 |

---

## 6. 改动清单

| 文件 | 改动内容 | 影响范围 |
|------|----------|----------|
| `prompt-builder.ts` | 在 system prompt 中注入"网关控制指令"段落 | ~10 行新增 |
| `modules/core/runtime.ts`（或 `index.ts` 的消息发送处） | 检测 `GATEWAY_RESTART` 指令、剥离、延时重启 | ~30 行新增 |

**总计：2 个文件，约 40 行代码。不修改任何 Adapter。**

---

## 7. 与现有 `/reload` 命令的关系

| | 用户 `/reload` | Agent `GATEWAY_RESTART` |
|---|---|---|
| **触发者** | 用户（IM 消息） | Agent（回复指令） |
| **触发位置** | `index.ts` 命令分发 | Runtime 层响应处理 |
| **最终执行** | `gracefulReload()` | `gracefulReload()` |
| **冷却期** | 无（用户手动控制） | 5 分钟 |
| **日志标记** | `source: user_command` | `source: agent_request` |

两者共享同一个 `gracefulReload()` 实现，只是触发路径不同。

---

## 8. 测试场景

| 场景 | 预期结果 |
|------|----------|
| Agent 回复中无指令 | 正常发送，无重启 |
| Agent 回复中包含 `<!-- GATEWAY_RESTART: 测试 -->` | 指令被剥离，剩余内容发送用户，500ms 后重启 |
| Agent 回复只有指令，无其他内容 | 发送兜底消息"正在重启网关…"，500ms 后重启 |
| 5 分钟内第二次触发 | 拒绝执行，记录 warn 日志 |
| Agent 指令格式有空格偏差 | 正则可容错（`\s*`），正常识别 |
| 新进程 10 秒内未就绪 | 回滚到旧进程，service 不中断 |

---

## 9. 未解决问题（待讨论）

1. **是否需要允许 Agent 取消重启？** 比如再发一个 `<!-- GATEWAY_RESTART_CANCEL -->`。目前评估优先级不高，可后续再议。

2. **重启原因是否需要反馈给用户？** 当前设计是剥离指令后直接发剩余内容。可选增强：在兜底消息中带上原因（如"正在重启网关：配置变更"）。

3. **是否需要限制哪个 Agent 可以重启？** 比如只允许 ClaudeBot 触发。当前设计是任何 Agent 都可以。如果后续需要，可以在 bot 配置中加入 `allowRestart: true/false` 字段。
