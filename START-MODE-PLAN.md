# imtoagent 三种运行模式改造计划

> ✅ **已完成** (2026-05-23) — 已发布 npm 0.3.6
> - `start` 使用 `execSync` shell 后台命令绕过 Bun 事件循环
> - `run` 使用 Bun.spawn + pipe stdio 实时日志
> - `daemon` 使用 child_process.spawn + fd stdio + 崩溃自动重启
> - CJS wrapper 从 spawnSync 改为 spawn + async exit

## 目标

| 命令 | 模式 | 行为 | 适用场景 |
|------|------|------|---------|
| `imtoagent start` | **后台运行** | 启动后立即返回，关闭终端不影响网关 | 日常使用 |
| `imtoagent run` | **前台运行** | 阻塞终端，实时日志，Ctrl+C 优雅停止 | 开发调试 |
| `imtoagent daemon` | **进程守护** | 阻塞终端，崩溃自动重启，适合托管 | launchd/systemd |

## 改动范围

**只改 `bin/imtoagent-real`**，不改 `index.ts`（网关核心逻辑不变）。

## 核心思路

网关（index.ts）自身已处理 SIGTERM/SIGINT 优雅退出。问题在于 `start` 模式的 log pump 循环阻塞了父进程退出。

**日志方案统一**：
- 所有模式下，子进程（index.ts）日志写入 `~/.imtoagent/logs/imtoagent.log`
- `start`：只写文件，不读不打印
- `run`：写文件 + for-await 泵到终端
- `daemon`：写文件 + for-await 泵到终端 + await child.exited

---

## 改动 1：新增 `imtoagent run`（前台运行）

在 switch 中新增 case `run`，实现函数 `cmdRun()`：

```js
async function cmdRun() {
  // 检查配置
  const dataDir = getDataDir();
  const configPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ No config file found. Please run "imtoagent setup" first');
    process.exit(1);
  }

  // 检查是否已在运行
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
    try {
      process.kill(pid, 0);
      console.error('⚠️  Gateway is already running (PID=' + pid + ')');
      console.error('   Run "imtoagent stop" to stop first, or use "imtoagent start" for background mode');
    } catch {
      fs.unlinkSync(PID_FILE); // stale
    }
  }

  // 写日志文件
  const logsDir = path.join(dataDir, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, 'imtoagent.log');

  const pkgDir = path.resolve(import.meta.dirname, '..');
  const indexFile = path.join(pkgDir, 'index.ts');

  console.log('🚀 Starting imtoagent gateway (foreground mode)...');
  console.log('   Press Ctrl+C to stop');
  console.log('');

  const child = Bun.spawn([process.execPath, 'run', indexFile], {
    cwd: dataDir,
    env: { ...process.env, IMTOAGENT_HOME: dataDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  // 泵 stdout → 终端 + 文件
  const pumpOut = (async () => {
    for await (const chunk of child.stdout as any) {
      const line = new TextDecoder().decode(chunk);
      process.stdout.write(line);
      logStream.write(line);
    }
  })().catch(() => {});

  // 泵 stderr → 终端 + 文件
  const pumpErr = (async () => {
    for await (const chunk of child.stderr as any) {
      const line = new TextDecoder().decode(chunk);
      process.stderr.write(line);
      logStream.write(line);
    }
  })().catch(() => {});

  // Ctrl+C → SIGTERM
  const shutdown = () => {
    console.log('\n🛑 Stopping gateway...');
    process.kill(child.pid, 'SIGTERM');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 等待子进程退出
  const exitCode = await child.exited;
  await Promise.allSettled([pumpOut, pumpErr]);
  logStream.end();

  if (exitCode === 0) {
    console.log('\n✅ Gateway exited cleanly');
  } else {
    console.log('\n⚠️  Gateway exited with code ' + exitCode);
  }
}
```

## 改动 2：修复 `imtoagent start`（后台运行）

核心改动：用 **shell 重定向** 替代 for-await 循环泵日志，让父进程验证启动后立即退出。

```js
async function cmdStart() {
  // 1. 检查是否已在运行（不变）
  // 2. 检查配置（不变）
  // 3. 检查后端（不变）

  // 4. 写日志文件
  // ...

  // 5. 启动子进程 — 关键改动：
  //    用 Bun.spawn + detached + unref，或者用 shell 重定向
  //    方案：Bun.spawn + stdout/stderr 直接写到文件
  //    （Bun.spawn 不支持直接指定 fd，用 child_process.execFile 或 shell）

  // 实际方案：用 node:child_process 的 spawn，支持 stdio 文件重定向
  const { spawn } = await import('child_process');
  const child = spawn(process.execPath, ['run', indexFile], {
    cwd: dataDir,
    env: { ...process.env, IMTOAGENT_HOME: dataDir },
    detached: true,
    stdio: ['ignore', logFd, logFd],  // stdin 关闭，stdout+stderr → 日志文件
    shell: false,
  });

  child.unref();  // 父进程不等待子进程
  fs.writeFileSync(PID_FILE, String(child.pid));

  // 6. 等待启动验证（不变：等 3 秒检查进程存活）
  // 7. 打印成功 → 父进程退出
}
```

**注意**：需要打开日志文件获取 fd，在 start 验证阶段也需要写入日志。

## 改动 3：简化 `imtoagent daemon`（进程守护）

保持现有逻辑基本不变，只调整日志写入方式使其与 start 一致：

- 子进程 stdout/stderr → 写文件（用 `child_process.spawn` + fd 重定向）
- 文件写入同时泵到终端（用 `fs.watch` 或 tail 方式，或简化为只写文件、不泵终端）
- await child.exited → 决定是否需要重启

**可选简化**：daemon 模式不实时泵日志到终端，只写文件。用户想看日志可以用 `tail -f ~/.imtoagent/logs/imtoagent.log`。这样 daemon 代码大幅简化：

```js
async function cmdDaemon() {
  // ...setup...
  while (!shuttingDown) {
    // 延迟（指数退避）
    // spawn + detached + stdio fd redirect
    // await child.exited
    // 根据 exitCode 决定是否重启
  }
}
```

## 改动 4：更新 CLI help 文本

```
  imtoagent setup     Interactive setup wizard
  imtoagent start     Start gateway in background (returns immediately)
  imtoagent run       Start gateway in foreground (Ctrl+C to stop)
  imtoagent stop      Stop gateway
  imtoagent status    Check running status
  imtoagent restore   Hot reload
  imtoagent daemon    Foreground daemon with auto-restart (for launchd/systemd)
```

## 改动 5：更新 `imtoagent stop`

保持现有逻辑不变，PID 文件由 start/run/daemon 统一写入 `/tmp/imtoagent.pid`。

**注意**：`run` 模式不写 PID 文件（终端关闭进程自然退出），如果用户在 run 模式下另开终端执行 stop，需要通过其他方式找到进程。考虑：run 模式也写 PID 文件，退出时清理。

### 最终决策：PID 文件策略

| 模式 | 写 PID | 清理 PID |
|------|--------|---------|
| `start` | ✅ 启动时 | ❌（由 stop 清理） |
| `run` | ✅ 启动时 | ✅ 退出时（子进程自己清理或用 trap） |
| `daemon` | ✅ 每次启动子进程时 | ✅ 子进程退出时 |

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `bin/imtoagent-real` | 新增 `cmdRun()`、重写 `cmdStart()`、简化 `cmdDaemon()`、更新 help、更新 switch |
| `README.md` | 更新命令文档 |

## 风险评估

- **低风险**：`run` 是全新命令，不影响现有功能
- **中风险**：`start` 重写，需要验证后台进程确实不随终端关闭而退出
- **低风险**：`daemon` 简化，行为保持一致（自动重启 + 优雅停止）

## 测试步骤

1. `imtoagent run` — Ctrl+C 正常退出
2. `imtoagent start` — 启动后关闭终端，网关仍在运行
3. `imtoagent status` — 能检测到 start 启动的进程
4. `imtoagent stop` — 能停止 start 启动的进程
5. `imtoagent daemon` — 模拟崩溃（kill -9），验证自动重启
6. 各模式日志写入正常
