# Codex 上下文文档

供 Codex 新会话快速恢复上下文。

## 项目愿景

让每个人通过 IM 拥有自己的智能体。IMtoAgent 是 IM ↔ 多品种 Agent 的统一网关，打破 Agent 局限于桌面终端的现状。

详见 [ARCHITECTURE.md](./ARCHITECTURE.md) 开篇。

## 阅读顺序

| 序号 | 文件 | 内容 |
|------|------|------|
| 1 | [ARCHITECTURE.md](./ARCHITECTURE.md) | 愿景 + 完整三明治架构 + 模块接口设计 |
| 2 | [MESSAGE-FORMAT.md](./MESSAGE-FORMAT.md) | 统一消息格式、IM↔Agent 翻译机制、能力降级 |
| 3 | [COMMAND-SYSTEM.md](./COMMAND-SYSTEM.md) | 三层命令体系设计 |
| 4 | [SESSION-CONTINUITY.md](./SESSION-CONTINUITY.md) | CodexBot 会话连续性（已实现） |
| 5 | [CLAUDEBOT-SESSION-PATTERN.md](./CLAUDEBOT-SESSION-PATTERN.md) | ClaudeBot 会话管理模式（参考） |

## 演化进度

### Phase 1：飞书 ↔ 编程 Agent ✅ 已完成
- ✅ CodexBot 会话自主恢复 (`resume --last`)
- ✅ CodexBot 迁移到 app-server v2 协议（stdio JSON-RPC 长连接，流式输出 + 长记忆 + 自主多轮任务）
- ✅ CodexBot 自主多轮任务（不再需要用户反复发消息推进）
- ✅ 文件/图片上传修复（飞书 SDK 响应字段路径纠正）
- ✅ ClaudeBot 完整 SDK 集成
- ✅ `/model` 网关级 + Bot 级持久化 (`_bot.json`)
- ✅ `/help` 按后端类型动态生成
- ✅ `/mode` Claude only（条件注册）
- ✅ `/providers` 供应商列表
- ✅ `/clear` 翻译 (Codex: startFresh / Claude: SDK reset)
- ✅ `/reload` 热重载
- ✅ Codex stats 追踪（通过 Proxy 累加器）
- ✅ Token/费用统计（双 Bot 均支持）

### Phase 2：模块化重构 ✅ 已完成
- ✅ Claude 模块提取并切换纯模块路径（`modules/agent/claude.ts`）
- ✅ Codex 模块提取并切换纯模块路径（`modules/agent/codex.ts`）
- ✅ 新旧路径并存（旧代码未删，随时可回退）
- ✅ 双 Bot 均走纯模块路径（旧代码保留待删）
- ✅ Proxy 移入 `modules/proxy/`
- ✅ 飞书 IM 模块提取（`modules/im/feishu.ts`）
- ✅ Provider 配置动态化
- ✅ Feishu WS 自动重连
- ✅ Codex/Claude 异常自恢复（定价读 providers.json）
- ✅ 抽象层接口（`AgentContext` + `IMModule`）
- ✅ IM能力传递（飞书能力→Agent工具定义→输出拦截→原生渲染）

### Phase 3-4：通用/企业 Agent 🔜
- 🔜 OpenAI ChatGPT 接入
- 🔜 Anthropic Claude.ai 直接 API
- 🔜 Dify 平台接入
- 🔜 Coze 平台接入

### Phase 5：多 IM 渠道 📅
- 📅 微信公众号/企业微信
- 📅 钉钉机器人

## 当前文件结构

```
imtoagent/
├── index.ts                      # 主入口：飞书 WS、消息路由、命令系统
├── config.json / providers.json  # 配置
├── modules/
│   ├── agent/
│   │   ├── claude.ts             # ✅ Claude 模块（SDK）
│   │   ├── codex.ts              # ✅ Codex 模块（app-server v2 + exec 回退）
│   │   └── codex-exec-server.ts  # ✅ app-server v2 客户端
│   ├── proxy/
│   │   ├── anthropic-proxy.ts    # ✅ Proxy :18899
│   │   └── codex-proxy.ts        # ✅ Proxy :18900
│   └── im/
│       └── feishu.ts             # ✅ 飞书 IM 模块
├── sessions/
├── .codex-docs/
└── restore.sh                    # 🔧 一键还原脚本
```

## 关键文件路径

| 文件 | 职责 |
|------|------|
| `index.ts` | 主入口：飞书 WS、消息路由、命令系统、Bot 调度 |
| `modules/proxy/codex-proxy.ts` | Codex Proxy :18900 + usage 累加器 |
| `modules/proxy/anthropic-proxy.ts` | Claude Proxy :18899 |
| `modules/agent/claude.ts` | Claude 模块（SDK 对接 + 会话循环） |
| `modules/agent/codex.ts` | Codex 模块（app-server v2 优先 + exec CLI 回退） |
| `modules/agent/codex-exec-server.ts` | app-server 进程管理 + stdio JSON-RPC v2 客户端 |
| `config.json` | Bot 凭证、Provider 配置、模型映射 |

## 用户偏好（从 SOUL 继承）

- 全栈开发者，主力 TypeScript/Python/Bun
- 偏好简洁代码风格
- 不喜欢 Docker 部署
