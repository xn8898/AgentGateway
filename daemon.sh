#!/bin/bash
# CC 路由守护进程 - 自动重启
# 配置已统一收敛至 config.json，无需传入环境变量
# 首次运行会自动初始化 ~/.imtoagent/ 数据目录

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
