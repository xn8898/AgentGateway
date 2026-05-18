#!/bin/bash
# IMtoAgent — 开发模式（自动重载 + 清缓存）
# 用法:
#   bash dev.sh          # 仅代理（proxy-only）
#   bash dev.sh full     # 完整模式（代理 + 飞书）

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "🧹 清理 bun 编译缓存..."
rm -rf node_modules/.cache/bun
rm -rf /tmp/bun-* 2>/dev/null

if [ "$1" = "full" ]; then
  echo "🔄 完整模式 (代理 :18899 + 飞书) --watch..."
  bun --watch run index.ts
else
  echo "🔄 仅代理模式 :18899 --watch..."
  bun --watch run proxy-only.ts
fi
