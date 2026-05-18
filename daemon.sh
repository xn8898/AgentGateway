#!/bin/bash
# CC 路由守护进程 - 自动重启
# 配置已统一收敛至 config.json，修改环境变量即可
IMTOAGENT_HOME="${IMTOAGENT_HOME:-$HOME/.imtoagent}"
LOG="$IMTOAGENT_HOME/logs/imtoagent.log"

mkdir -p "$IMTOAGENT_HOME/logs"

cd "$IMTOAGENT_HOME"

while true; do
  echo "[$(date)] 🚀 启动 CC 路由..." >> "$LOG"
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    TERM="$TERM" \
    IMTOAGENT_HOME="$IMTOAGENT_HOME" \
    FEISHU_APP_ID=YOUR_FEISHU_APP_ID \
    FEISHU_APP_SECRET=YOUR_FEISHU_APP_SECRET \
    bun run "$(dirname "$0")/index.ts" >> "$LOG" 2>&1
  EXIT_CODE=$?
  rm -f /tmp/.imtoagent.lock
  if [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date)] ℹ️ 子进程正常退出，守护进程退出" >> "$LOG"
    exit 0
  fi
  echo "[$(date)] ⚠️ 进程退出，code=$EXIT_CODE，10秒后重启..." >> "$LOG"
  sleep 10
done
