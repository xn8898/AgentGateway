# gracefulReload() 端口竞态修复方案

> 日期: 2026-05-19
> 状态: ✅ 已完成 (2026-05-19)

---

## 问题回顾

### 当前行为（fork-and-wait）

```
旧进程 gracefulReload():
  1. stopAnthropicProxy() / stopOpenCode() / IM.stop()
  2. Bun.spawn(['bun', 'run', __filename], ...)  ← 新进程启动
  3. sleep(5000)  ← 等新进程就绪
  4. 检查新进程是否正常
     ✓ → process.exit(0)
     ✗ → 尝试恢复旧服务 → startAnthropicProxy(18899) ← 端口仍被占用 → crash
```

**竞态根因**：新旧进程同时存活期间，新进程绑定了 18899 端口。新进程如果崩溃退出，端口未释放，旧进程恢复时绑定失败，导致 **双挂**。

### 第一次重启日志（实锤）

```
[Reload] 新进程 PID=59254，等待启动验证...
[OpenCodeAdapter] 服务启动成功 (PID=59255, http://127.0.0.1:4096)  ← 新进程起了
[Feishu] WS 已连接                                                  ← 新进程工作了
[Reload] ❌ 新进程启动失败: 新进程已退出，exitCode=null              ← 新进程莫名死了
[uncaught] Failed to start server. Is port 18899 in use?            ← 旧进程恢复也挂了
```

### 第二个问题：信号文件路径不一致

- `buildSystemPromptWithSoul()` 用 `getDataDir()` 生成提示词中的路径
- 开发模式下 `getDataDir()` 返回 cwd 项目目录（`/Users/keyi/Desktop/imtoagent/`）
- 但 agent 实际写的信号文件可能在 `~/.imtoagent/.restart_requested`
- `runtime.ts` 里 `checkRestartSignal(dataDir)` 的 `dataDir` 也可能不一致

---

## 方案：Daemon 模式

### 核心思想

```
┌─────────────┐
│  daemon.sh  │  ← 始终运行，while true 循环
│  (父进程)   │     监控子进程退出 → 自动拉起
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  imtoagent  │  ← 主服务进程（子进程）
│  (bun run)  │     gracefulReload() → 清理 → process.exit(0)
└─────────────┘
```

**优势**：
- 同一时刻只有一个进程，端口零冲突
- 不需要 spawn/回滚逻辑，代码更简单
- daemon.sh 天然提供 crash recovery（即使意外退出也会重启）

---

## 改动清单

### 改动 1：简化 `gracefulReload()` — 只清理 + 自杀

**文件**: `index.ts`  
**位置**: `gracefulReload()` 函数（约 line 779-844）

```
旧逻辑 (~65 行)：
  保存 session 快照 → 备份代码 → 写标记 → 停服务
  → spawn 新进程 → sleep(5000) → 验证 → exit/回滚

新逻辑 (~30 行)：
  保存 session 快照 → 写重启标记 → 停服务 → process.exit(0)
  （daemon.sh 会自动拉起新进程）
```

**删除的部分**：
- `Bun.spawn(...)` 及相关的 `child` 变量
- `sleep(5000)` 启动验证
- `net.createConnection()` 端口探测
- 回滚逻辑（`fs.copyFileSync(backupPath, __filename)` + `startAnthropicProxy()`）
- `backupPath` 备份文件操作

**保留的部分**：
- session 快照（用于重启后通知）
- restore marker（`~/.imtoagent/sessions/.restore`）
- `stopAnthropicProxy()` / `stopOpenCodeServer()` / `bot.im.stop()`

**修改后的代码**：

```typescript
async function gracefulReload(reason: string) {
  console.log(`[Reload] 🔄 ${reason}`);

  // 1. 保存 session 快照（用于重启后通知）
  const sessionsDir = getSessionsDir();
  const botSnapshots: Record<string, { chats: { chatId: string; lastUsed: number }[] }> = {};
  try {
    if (fs.existsSync(sessionsDir)) {
      for (const botDir of fs.readdirSync(sessionsDir)) {
        const botPath = sessionsDir + '/' + botDir;
        if (!fs.statSync(botPath).isDirectory()) continue;
        const chats: { chatId: string; lastUsed: number }[] = [];
        for (const f of fs.readdirSync(botPath)) {
          if (!f.endsWith('.memory.json')) continue;
          try {
            const m = JSON.parse(fs.readFileSync(botPath + '/' + f, 'utf-8'));
            chats.push({ chatId: m.chatId, lastUsed: m.lastUsed || 0 });
          } catch {}
        }
        chats.sort((a, b) => b.lastUsed - a.lastUsed);
        botSnapshots[botDir] = { chats: chats.slice(0, 3) };
      }
    }
  } catch {}

  // 2. 写 restore marker（新进程启动后读取并通知用户）
  const marker = getRestoreMarkerPath();
  try { fs.writeFileSync(marker, JSON.stringify({ timestamp: Date.now(), reason, bots: botSnapshots })); } catch {}

  // 3. 优雅清理
  await stopAnthropicProxy();
  await stopOpenCodeServer();
  for (const bot of _allBots) bot.im.stop();
  await new Promise(r => setTimeout(r, 500));

  // 4. 退出，daemon.sh 会自动拉起新进程
  console.log('[Reload] 清理完成，退出中...');
  process.exit(0);
}
```

**同时保留 `process.on('SIGHUP')` 监听**：
```typescript
process.on('SIGHUP', () => gracefulReload('SIGHUP'));
```

---

### 改动 2：统一信号文件路径

**文件 2a**: `index.ts` — `buildSystemPromptWithSoul()`（约 line 745-758）  
**文件 2b**: `modules/core/runtime.ts` — `processMessage()` 中 `dataDir` 参数

**问题**：`getDataDir()` 路径解析复杂（IMTOAGENT_HOME → ~/.imtoagent → cwd → pkgDir），导致 agent 写的信号文件和 runtime 读的不是同一个位置。

**解决**：用一个固定的信号文件路径，不依赖 `getDataDir()`。

在 `index.ts` 顶部定义常量：

```typescript
const RESTART_SIGNAL_FILE = path.join(
  process.env.HOME!, '.imtoagent', '.restart_requested'
);
```

在 `buildSystemPromptWithSoul()` 中，system prompt 改为：

```typescript
const restartInstruction = `\n\n## 网关重启能力\n\n如果你判断需要重启 IMtoAgent 网关（如配置变更、检测到异常状态需重置），请执行以下命令：\n\n\`\`\`bash\necho '{"reason": "<简短原因>", "timestamp": '"$(date +%s)"'}' > ${process.env.HOME}/.imtoagent/.restart_requested\n\`\`\`\n\n规则：\n- 该信号文件会被 Runtime 自动检测并消费，用户不会看到\n- 你的回复内容会先正常发送给用户，然后网关执行重启\n- 仅在确实需要时使用，不要随意触发\n- 如果你不需要重启，忽略此指令即可`;
```

在 `runtime.ts` 中，改为使用固定的信号文件路径：

```typescript
const RESTART_SIGNAL_FILE = path.join(
  process.env.HOME!, '.imtoagent', '.restart_requested'
);
```

不再通过 `dataDir` 参数传递，`checkRestartSignal()` 和 `consumeRestartSignal()` 直接读取固定路径。

对应地，`processMessage()` 签名中移除 `dataDir` 参数，调用方 `handleMessage()` 中也移除 `getDataDir()` 传参。

---

### 改动 3：确认 daemon.sh 启动参数

**文件**: `daemon.sh`

**当前问题**：
- 使用 `env -i` 清空所有环境变量，只保留几个关键变量
- 可能遗漏 `IMTOAGENT_HOME` 或 `HOME` 等必要变量

**修改后**：

```bash
#!/bin/bash
# CC 路由守护进程 - 自动重启
# 配置已统一收敛至 config.json，修改环境变量即可

IMTOAGENT_HOME="${IMTOAGENT_HOME:-$HOME/.imtoagent}"
IMTOAGENT_PROJECT="${IMTOAGENT_PROJECT:-$HOME/Desktop/imtoagent}"
LOG="$IMTOAGENT_HOME/logs/imtoagent.log"

mkdir -p "$IMTOAGENT_HOME/logs"

cd "$IMTOAGENT_PROJECT"

while true; do
  echo "[$(date)] 🚀 启动 CC 路由..." >> "$LOG"
  IMTOAGENT_HOME="$IMTOAGENT_HOME" bun run index.ts >> "$LOG" 2>&1
  EXIT_CODE=$?
  echo "[$(date)] ⚠️ 进程退出，code=$EXIT_CODE，3秒后重启..." >> "$LOG"
  sleep 3
done
```

**关键变化**：
- 去掉 `env -i`，保留继承的环境（`HOME`、`PATH` 等）
- 显式传递 `IMTOAGENT_HOME`
- 添加 `IMTOAGENT_PROJECT` 环境变量（默认指向 `~/Desktop/imtoagent`）
- 缩短等待时间：10s → 3s
- 去掉 `rm -f /tmp/.imtoagent.lock`（这个锁文件没有实际用途）

---

### 改动 4：清理残留的信号文件

当前 `/Users/keyi/.imtoagent/.restart_requested` 仍然存在（上次未消费）。

在启动时（`main()` 函数的开头）添加消费逻辑，防止旧信号触发误重启：

```typescript
// 启动时清理残留的重启信号（可能是上次崩溃遗留的）
try {
  const signalPath = path.join(process.env.HOME!, '.imtoagent', '.restart_requested');
  if (fs.existsSync(signalPath)) {
    const old = JSON.parse(fs.readFileSync(signalPath, 'utf-8'));
    const age = Date.now() - (old.timestamp || 0);
    if (age > 60000) { // 超过 1 分钟的信号视为残留
      console.log(`[Startup] 清理残留重启信号: ${old.reason}（${Math.floor(age/1000)}s 前）`);
      fs.unlinkSync(signalPath);
    }
  }
} catch {}
```

---

## 影响分析

| 改动 | 影响范围 | 风险 |
|------|----------|------|
| 1. 简化 gracefulReload() | 重启流程 | 低（逻辑更简单） |
| 2. 统一信号文件路径 | Agent 重启能力 | 低（路径更明确） |
| 3. 修复 daemon.sh | 启动方式 | 低（需确认用户确实通过 daemon.sh 启动） |
| 4. 清理残留信号 | 启动流程 | 无风险（防御性措施） |

## 验证方案

1. 发送消息让 agent 写入 `.restart_requested` 信号文件
2. 观察日志确认：
   - `[Runtime] 🔄 Agent 请求重启: ...`
   - `[Reload] 🔄 Agent 请求重启: ...`
   - `[Reload] 清理完成，退出中...`
   - daemon.sh 日志：`🚀 启动 CC 路由...`
   - 新进程正常启动，飞书 WS 连接
   - `[Restore]` 通知消息已发送
3. 确认端口 18899 只有一个进程监听

---

## 风险与备选

**风险**：如果用户不是通过 `daemon.sh` 启动的（比如直接 `bun run index.ts`），那么 `process.exit(0)` 后服务不会自动恢复。

**缓解**：
- gracefulReload() 退出前打印提示：`[Reload] 请通过守护进程或手动命令重新启动`
- 在 MEMORY.md 或文档中记录重启逻辑依赖 daemon.sh

**备选方案**（如果不想用 daemon.sh）：
- 保持 spawn 模式，但改为：新进程绑定**不同端口**（如 18898），就绪后再通知旧进程退出并切换到 18899
- 复杂度更高，不推荐
