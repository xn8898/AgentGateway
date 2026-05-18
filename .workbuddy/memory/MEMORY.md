# MEMORY.md — IMtoAgent 项目长期记忆

## 项目概况
- **路径**: `/Users/keyi/Desktop/imtoagent`
- **定位**: IM ↔ Agent 统一网关，飞书/Telegram 消息路由到 Claude/Codex/OpenCode 后端
- **运行时**: Bun (`~/.bun/bin/bun`)
- **架构**: 4 层解耦 — IM Module → Prompt Builder → Agent Adapter → Proxy Layer (`:18899`)
- **启动**: `./start.sh` 或 `~/.bun/bin/bun index.ts`

## 关键技术决策
- 端口合并：Codex Proxy (`:18900`) 已合并到 Anthropic Proxy (`:18899`)，`/v1/responses` 路由到 `handleCodexDispatch()`
- 两套 Agent 体系并存：新 SDK (`*-adapter.ts`) + 旧 legacy (`claude.ts`/`codex.ts`/`opencode.ts`)，`index.ts` 用新的
- `BotConfig` 有两个不兼容定义：`modules/types.ts` vs `modules/core/types.ts`
- Session 文件存储在 `sessions/{botName}/{chatId}.memory.json`

## 已知遗留问题
- Telegram Bot 代理 `127.0.0.1:7890` 不可用时会熔断（非 bug，网络环境问题）
- 默认项目目录非 git 仓库时 `workspace.md` 生成会报 `fatal: not a git repository`
- 两套 `BotConfig` / `IMCapabilities` 类型定义未统一

## 修复历史
- 2026-05-18: 修复端口合并引入的 5 个 bug（/health 路由冲突、userId 未定义、audioSend 重复、lastCallUsage 缺失、关机超时）
