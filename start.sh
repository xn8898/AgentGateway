#!/bin/bash
# CC Gateway 启动脚本
# 所有配置已统一收敛至 config.json，无需传入环境变量

cd "$(dirname "$0")"

if ! command -v bun &>/dev/null && [ ! -f ~/.bun/bin/bun ]; then
  echo "❌ 需要安装 bun"
  exit 1
fi

# 检查配置文件
CONFIG_FILE="$(dirname "$0")/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ 缺少 config.json 配置文件"
  exit 1
fi

# 1. 强制释放端口
for port in 18899 18900; do
  lsof -ti:$port 2>/dev/null | xargs kill -9 2>/dev/null
done

# 2. 清理锁文件 + 等待端口释放
rm -f /tmp/.cc-gateway.lock
sleep 3

# 3. 启动
nohup ~/.bun/bin/bun index.ts > cc-gateway.log 2>&1 &

echo "🚀 CC Gateway 已启动 (PID: $!)"
sleep 3
tail -15 cc-gateway.log
