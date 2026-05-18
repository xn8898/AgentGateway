# IMtoAgent

> 让每个人通过 IM 拥有自己的智能体

## 愿景

IMtoAgent 是 **IM ↔ 多品种成熟 Agent 系统的统一网关**。打破 Agent 局限于桌面终端和编程领域的现状——让用户通过飞书（及后续微信、钉钉等）的聊天框，就能调用各种 Agent 系统（Claude Code、Codex、ChatGPT、Dify 等）。

**核心价值**：拆掉 Agent 必须坐在电脑前的墙。Agent 不应只是 IDE 插件或终端命令，它是手机上、聊天框里随时能 @ 的智能伙伴。

## 设计理念

IMtoAgent 本质上是一个**智能路由中间件**——把消息从 IM 正确路由到 AI 后端，再把回复原路返回。

### 路由管线

```
飞书事件 → Bot 匹配 → Agent 路由 → Proxy 转发 → 模型
                                              ↓
飞书消息 ← IM 发送 ← 输出解析 ← Agent 响应 ← 模型
```

### 三层解耦

```
        飞书 / 微信 / 钉钉（未来）
             │
    ┌────────┴────────┐
    │   IM Module     │  ← getCapabilities() + 收发
    │   (feishu.ts)   │
    └────────┬────────┘
             │
    ┌────────┴────────┐
    │  Prompt Builder │  ← IM 能力 → 系统提示词 + Soul 注入
    │  (统一构建层)    │
    └────────┬────────┘
             │
    ┌────────┴────────┐
    │  Agent Module   │  ← claude.ts / codex.ts
    │  (handleMessage) │     backend 字段决定，可插拔
    └────────┬────────┘
             │
    ┌────────┴────────┐
    │   Proxy Layer   │  ← :18899 / :18900
    │   (协议转换)     │     providers.json 配供应商
    └────────┬────────┘
             │
    DeepSeek / OpenAI / Anthropic ...
```

**三个"不关心"**：
- Agent 不关心 IM 是什么
- IM 不关心 Agent 是什么
- Prompt 构建不关心 Agent 类型

| 层 | 抽象 | 可替换性 |
|----|------|---------|
| IM 通道 | `IMModule` | 飞书 → 微信/钉钉 换 `feishu.ts` 即可 |
| Agent 后端 | `AgentModule` | Claude Code ↔ Codex ↔ ChatGPT 插拔 |
| 模型代理 | `Proxy` HTTP | Anthropic API ↔ Chat API 协议转换 |
| 输出解析 | `parseToBlocks()` | 文本 → UnifiedBlock[] → IM 原生元素 |

换 IM 只动 IM Module，换模型只配 providers.json，换 Agent 只加新 Module 类。

## 演化路线

| 阶段 | 目标 | 状态 |
|------|------|------|
| Phase 1 | 飞书 ↔ Claude Code / Codex（双 Bot + Token/费用统计） | ✅ 已完成 |
| Phase 2 | 模块化重构：Agent 模块提取 + 纯模块路径 | ✅ 已完成 |
| Phase 3 | 接入通用对话型 Agent（ChatGPT、Claude.ai） | 🔜 |
| Phase 4 | 接入低代码 Agent 平台（Dify、Coze） | 🔜 |
| Phase 5 | 多 IM 渠道（微信、钉钉） | 📅 远期 |

## 快速启动

```bash
cd ~/Desktop/imtoagent
./start.sh        # 前台
./daemon.sh       # 守护进程
```

## 飞书命令

| 命令 | 功能 |
|------|------|
| `/help` | 动态命令列表（按后端类型） |
| `/status` | 运行状态 |
| `/info` | 配置信息 |
| `/stats` | Token/费用统计 |
| `/model <spec>` | 切换模型（Bot 级，持久化） |
| `/providers` | 供应商列表 |
| `/clear` | 清空对话 |
| `/dir <path>` | 切换目录 |
| `/mode <mode>` | 权限模式（仅 Claude） |
| `/reload` | 热重载 |

## 详细文档

参见 [.codex-docs/](./.codex-docs/)：
- [ARCHITECTURE.md](./.codex-docs/ARCHITECTURE.md) — 完整架构、愿景、模块设计
- [MESSAGE-FORMAT.md](./.codex-docs/MESSAGE-FORMAT.md) — 统一消息格式与能力降级
- [COMMAND-SYSTEM.md](./.codex-docs/COMMAND-SYSTEM.md) — 三层命令体系
- [SESSION-CONTINUITY.md](./.codex-docs/SESSION-CONTINUITY.md) — 会话连续性
- [CLAUDEBOT-SESSION-PATTERN.md](./.codex-docs/CLAUDEBOT-SESSION-PATTERN.md) — ClaudeBot 参考实现

## 配置

编辑 `config.json`，配置 Bot 凭证和供应商。格式：

```json
{
  "bots": [
    { "name": "CodexBot", "appId": "...", "appSecret": "...", "backend": "codex" },
    { "name": "ClaudeBot", "appId": "...", "appSecret": "...", "backend": "claude" }
  ],
  "defaultModel": "deepseek/deepseek-v4-pro"
}
```

## 依赖

- [Bun](https://bun.sh) 运行时
- 飞书应用（开通"消息"和"事件订阅"）
