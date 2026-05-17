#!/bin/bash
# CC Gateway 看门狗 — 崩溃后自动重启
CC_DIR="$HOME/Desktop/cc-gateway"
LOG="$CC_DIR/watchdog.log"
SAFE_BACKUP="$CC_DIR/index.ts.safe"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# 创建安全备份（只在当前代码能编译时才创建）
if [ ! -f "$SAFE_BACKUP" ]; then
  if bun build "$CC_DIR/index.ts" --no-bundle >/dev/null 2>&1; then
    cp "$CC_DIR/index.ts" "$SAFE_BACKUP"
    log "[INFO] 创建安全备份"
  else
    log "[WARN] 当前代码无法编译，无安全备份"
  fi
fi

while true; do
  # 清理旧进程（精确匹配，不杀自己）
  for p in $(ps aux | grep "[b]un run index.ts" | awk '{print $2}'); do
    kill $p 2>/dev/null
  done
  sleep 1

  log "[START] 启动 CC Gateway..."
  cd "$CC_DIR"
  bun run index.ts >> "$LOG" 2>&1 &
  PID=$!
  log "[INFO] 进程 PID=$PID"

  # 等 5 秒检查端口
  sleep 5
  if lsof -ti:18899 >/dev/null 2>&1; then
    log "[OK] 启动成功，端口正常"
  else
    log "[FAIL] 启动失败，尝试用安全备份恢复..."
    kill $PID 2>/dev/null
    wait $PID 2>/dev/null
    if [ -f "$SAFE_BACKUP" ]; then
      cp "$SAFE_BACKUP" "$CC_DIR/index.ts"
      log "[RESTORE] 已恢复安全备份"
    fi
    sleep 2
    continue
  fi

  # 等待进程退出
  wait $PID 2>/dev/null
  EXIT_CODE=$?
  log "[EXIT] 进程退出，exitCode=$EXIT_CODE"

  # 如果成功启动过，更新安全备份
  if [ $EXIT_CODE -eq 0 ]; then
    if bun build "$CC_DIR/index.ts" --no-bundle >/dev/null 2>&1; then
      cp "$CC_DIR/index.ts" "$SAFE_BACKUP"
      log "[UPDATE] 更新安全备份"
    fi
  fi
  sleep 2
done
