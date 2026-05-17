# SDK 重构实施计划

来源: quiet-singing-fountain.md

## Phase 1: SDK 核心

创建 `modules/core/`，不改现有代码：

1. `modules/core/types.ts` — 核心接口 (AgentAdapter, AgentInput, AgentOutput, Session)
2. `modules/core/session.ts` — SessionManager + FileSessionManager
3. `modules/core/error.ts` — ErrorHandler + DefaultErrorHandler
4. `modules/core/stats.ts` — StatsTracker
5. `modules/core/config.ts` — ConfigManager
6. `modules/core/runtime.ts` — AgentRuntime (shell)

## Phase 2: ClaudeBot 适配

将 `modules/agent/claude.ts` 拆成 ClaudeAdapter (实现 AgentAdapter)
目标: 从 160 行 → ~100 行

## Phase 3: Codex + OpenCode 迁移

- `modules/agent/codex.ts` → CodexAdapter (~100 行)
- `modules/agent/opencode.ts` → OpenCodeAdapter (~100 行)

## Phase 4: Index.ts 瘦身

- index.ts 从 1100 行 → ~300 行
- Bot 类精简化，委托给 AgentRuntime + SessionManager

## 重要约束

- 现有 `modules/types.ts` 保留（向后兼容），新的放 `modules/core/types.ts`
- 现有 Agent 模块在 Phase 2/3 完成前继续可用
- `index.ts` 在 Phase 4 才大改
- 所有改动保持向后兼容
