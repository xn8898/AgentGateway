#!/bin/bash
# CC 路由守护进程 - 自动重启
# 配置已统一收敛至 config.json，修改环境变量即可
LOG="$HOME/Desktop/cc-gateway/cc-gateway.log"

cd "$HOME/Desktop/cc-gateway"

while true; do
  echo "[$(date)] 🚀 启动 CC 路由..." >> "$LOG"
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    TERM="$TERM" \
    FEISHU_APP_ID=YOUR_FEISHU_APP_ID \
    FEISHU_APP_SECRET=YOUR_FEISHU_APP_SECRET \
    bun index.ts >> "$LOG" 2>&1
  EXIT_CODE=$?
  rm -f /tmp/.cc-gateway.lock
  if [ $EXIT_CODE -eq 0 ]; then
    # 正常退出（子进程），不重启
    echo "[$(date)] ℹ️ 子进程正常退出，守护进程退出" >> "$LOG"
    exit 0
  fi
  echo "[$(date)] ⚠️ 进程退出，code=$EXIT_CODE，10秒后重启..." >> "$LOG"
  sleep 10
done
