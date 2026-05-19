# IMtoAgent

> 让每个人通过 IM 拥有自己的智能体

## 愿景

IMtoAgent 是 **IM ↔ 多品种成熟 Agent 系统的统一网关**。打破 Agent 局限于桌面终端和编程领域的现状——让用户通过飞书（及后续微信、钉钉等）的聊天框，就能调用各种 Agent 系统（Claude Code、Codex、ChatGPT、Dify 等）。

**核心价值**：拆掉 Agent 必须坐在电脑前的墙。Agent 不应只是 IDE 插件或终端命令，它是手机上、聊天框里随时能 @ 的智能伙伴。

## 设计理念

IMtoAgent 本质上是一个**智能路由中间件**——把消息从 IM 正确路由到 AI 后端，再把回复原路返回。

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
    │   Proxy Layer   │  ← :18899 统一端口
    │   (协议转换)     │     providers.json 配供应商
    └────────┬────────┘
             │
     DeepSeek / OpenAI / Anthropic ...
```

换 IM 只动 IM Module，换模型只配 providers.json，换 Agent 只加新 Module 类。

## 安装

### 方式一：npm 全局安装（推荐）

```bash
npm install -g imtoagent     # 或 bun install -g imtoagent
imtoagent setup              # 交互式配置向导
imtoagent start              # 启动网关
```

### 方式二：git clone 开发模式

```bash
cd ~/Desktop
git clone <repo> imtoagent
cd imtoagent
bun install
imtoagent setup              # 或手动编辑 config.json
imtoagent start              # 启动
# 或开发模式（自动重载）：
bash dev.sh
```

## 目录结构

```
~/.imtoagent/                ← 数据目录（配置、日志、会话）
├── config.json              ← Bot 配置（含密钥）
├── providers.json           ← 模型供应商
├── opencode.json            ← OpenCode 配置
├── soul/                    ← 各 Bot 的灵魂文件
├── sessions/                ← 会话数据
└── logs/                    ← 运行日志

~/Desktop/imtoagent/         ← 代码目录（项目本身）
├── index.ts                 ← 主入口
├── bin/imtoagent            ← CLI 命令入口
├── modules/                 ← 核心模块
├── templates/               ← 配置/灵魂模板
└── scripts/                 ← 安装后脚本
```

> **注意**：配置文件和运行数据统一存放在 `~/.imtoagent/`，代码目录只保留源代码。

## CLI 命令

| 命令 | 功能 |
|------|------|
| `imtoagent setup` | 交互式配置向导 |
| `imtoagent start` | 后台启动网关 |
| `imtoagent stop` | 停止网关 |
| `imtoagent status` | 查看运行状态 |
| `imtoagent restore` | 热重载（SIGHUP） |
| `imtoagent daemon` | 前台守护模式（自动重启 + 日志） |

### 守护模式

`imtoagent daemon` 是前台运行的守护进程，适合被进程管理器托管：

- 崩溃时自动重启（指数退避，最长 30s）
- 收到 SIGTERM/SIGINT 时优雅关闭
- 日志自动写入 `~/.imtoagent/logs/imtoagent.log`

**macOS launchd 示例：**
```xml
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/bun</string>
  <string>run</string>
  <string>/path/to/imtoagent/bin/imtoagent</string>
  <string>daemon</string>
</array>
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

## 依赖

- [Bun](https://bun.sh) 运行时
- 飞书应用（开通"消息"和"事件订阅"）
