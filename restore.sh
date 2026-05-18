#!/bin/bash
# IMtoAgent 一键还原脚本
# 用法: ./restore.sh [时间戳]

GATEWAY_DIR="$HOME/Desktop/imtoagent"
cd "$GATEWAY_DIR"

# 列出可用备份
if [ "$1" = "list" ] || [ -z "$1" ]; then
  echo "📦 可用备份:"
  ls -1ht *.bak.* 2>/dev/null | head -20
  echo ""
  echo "💡 用法: ./restore.sh 20260511_121116"
  exit 0
fi

TS="$1"

# 还原三个核心文件
for f in index.ts codex-proxy.ts anthropic-proxy.ts; do
  bak="${f}.bak.${TS}"
  if [ -f "$bak" ]; then
    cp "$bak" "$f"
    echo "✅ 已还原 $f ← $bak"
  else
    echo "❌ 找不到 $bak"
  fi
done

echo ""
echo "🔄 重启 gateway..."
pkill -f "bun.*index.ts" 2>/dev/null || true
sleep 1
./start.sh &
echo "✅ 还原完成"
