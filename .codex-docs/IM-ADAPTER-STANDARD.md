# IM 适配器技术标准

> 本文档定义 IMtoAgent 网关的 IM 适配器架构、接口契约、设计模式和实现指南。新增 IM 平台时以此为准。

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    IMtoAgent Gateway                     │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │  飞书    │  │ Telegram │  │   企微   │  │   微信   │ │
│  │ FeishuIM │  │ Telegram │  │ WeComIM  │  │ WeChatIM │ │
│  │  Module  │  │ Adapter  │  │  Module  │  │  Module  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │              │             │              │       │
│  ┌────┴──────────────┴─────────────┴──────────────┴────┐ │
│  │              IM Registry (工厂模式)                   │ │
│  │       registerIM(type, factory) → IMModule           │ │
│  └────────────────────┬────────────────────────────────┘ │
│                       │                                   │
│  ┌────────────────────┴────────────────────────────────┐ │
│  │              AgentRuntime (SDK Core)                 │ │
│  │  SessionManager / ErrorHandler / StatsTracker       │ │
│  └────────────────────┬────────────────────────────────┘ │
│                       │                                   │
│  ┌────────────────────┴────────────────────────────────┐ │
│  │              AgentAdapter (统一代理)                  │ │
│  │  Claude Code │ Codex │ OpenCode                      │ │
│  └─────────────────────────────────────────────────────┘ │
│                       │                                   │
│  ┌────────────────────┴────────────────────────────────┐ │
│  │         Anthropic Proxy (:18899)                     │ │
│  │         → 上游模型 (DeepSeek / OpenAI / ...)          │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 1.1 设计原则

| 原则 | 说明 |
|------|------|
| **接口驱动** | 所有 IM 适配器必须实现 `IMModule` 接口，编译时保证契约 |
| **工厂注册** | `IM Registry` 工厂模式，新增 IM 只需添加 `registerIM()` 一行，不改 Bot 构造 |
| **能力声明** | `IMCapabilities` 声明式能力，Agent 根据 `getCapabilities()` 动态调整输出格式 |
| **统一解析** | `UnifiedBlock[]` 中间表示层，Agent 输出一次，各 IM 各自渲染为原生格式 |
| **降级安全** | 不支持的能力有明确降级策略（如 codeBlock → 反引号包裹、cardMessage → 纯文本） |

---

## 2. 核心接口

### 2.1 IMModule 接口

文件：`modules/types.ts`

```typescript
export interface IMModule {
  /** 发送文本回复 */
  reply(chatId: string, text: string, maxLen?: number): Promise<void>;

  /** 推送进度/工具日志 */
  sendProgress(chatId: string, text: string): Promise<void>;

  /** 获取 IM 输出能力 */
  getCapabilities(): IMCapabilities;

  /** 发送富文本块（代码块、卡片、图片等） */
  sendBlocks(chatId: string, blocks: UnifiedBlock[]): Promise<void>;

  /** 发送图片 */
  sendImage(chatId: string, imageKey: string, alt?: string): Promise<void>;

  /** 发送文件 */
  sendFile(chatId: string, fileKey: string, fileName: string): Promise<void>;

  /** 启动消息监听 */
  start(handler: MessageHandler): void;

  /** 停止 */
  stop(): void;
}
```

#### 方法契约详解

| 方法 | 必选 | 说明 |
|------|:---:|------|
| `reply()` | ✅ | 核心方法，发送纯文本消息。`maxLen` 为平台文本上限，实现需在内部做安全截断 |
| `sendProgress()` | ✅ | 推送"正在输入…"等进度提示。如平台不支持静默跳过 |
| `getCapabilities()` | ✅ | 返回 `IMCapabilities`，告诉 Agent 能输出什么格式 |
| `sendBlocks()` | ✅ | 接收 `UnifiedBlock[]` 数组，渲染为平台原生消息。需处理所有 block 类型 |
| `sendImage()` | ✅ | 发送单张图片。`imageKey` 为本地路径或 URL |
| `sendFile()` | ✅ | 发送单个文件。`fileKey` 为本地路径或 URL |
| `start()` | ✅ | 启动消息监听，注册 `MessageHandler` 回调 |
| `stop()` | ✅ | 停止监听，清理资源 |

#### 可选扩展方法

| 方法 | 说明 | 当前实现 |
|------|------|---------|
| `replyStream()` | 流式逐字回复 | 企微、微信 |
| `replyStreamNonBlocking()` | 流式跳过中间帧 | 企微、微信 |

> ⚠️ 可选方法不强制要求实现。如需要统一调用，应在 `IMModule` 接口中添加并给出默认实现。

---

### 2.2 IMCapabilities 接口

```typescript
export interface IMCapabilities {
  text: boolean;        // 纯文本（所有平台均为 true）
  codeBlock: boolean;   // 代码块（飞书、Telegram 支持）
  cardMessage: boolean; // 富文本卡片容器（飞书、企微支持）
  fileSend: boolean;    // 文件发送
  imageSend: boolean;   // 图片发送
  audioSend: boolean;   // 音频/语音发送（飞书、Telegram 支持）
  buttonAction: boolean;// 按钮交互回调（飞书、Telegram、企微支持）
  maxTextLength: number;// 单条消息最大字符数
}
```

#### 各平台能力矩阵

| 能力 | 飞书 | Telegram | 企微 | 微信 |
|------|:---:|:---:|:---:|:---:|
| `text` | ✅ | ✅ | ✅ | ✅ |
| `codeBlock` | ✅ | ✅ | ❌ | ❌ |
| `cardMessage` | ✅ | ❌ | ✅ | ❌ |
| `fileSend` | ✅ | ✅ | ✅ | ✅ |
| `imageSend` | ✅ | ✅ | ✅ | ✅ |
| `audioSend` | ✅ | ✅ | ❌ | ❌ |
| `buttonAction` | ✅ | ✅ | ✅ | ❌ |
| `maxTextLength` | 30,000 | 4,096 | 4,000 | 4,000 |

> 新增 IM 平台时，根据实际情况如实声明，不要为不支持的能力返回 `true`。

---

### 2.3 MessageHandler 类型

```typescript
export type MessageHandler = (
  chatId: string,
  text: string,
  userId: string,
  attachments?: MessageAttachment[]
) => Promise<void>;
```

所有 IM 适配器调用 `start(handler)` 时注册此回调，收到用户消息时通过 `handler(chatId, text, userId, attachments)` 上报给 `AgentRuntime`。

---

### 2.4 UnifiedBlock 类型

文件：`modules/capabilities.ts`

```typescript
export type UnifiedBlock =
  | { type: 'text';        content: string }
  | { type: 'code_block';  code: string; language: string; title?: string }
  | { type: 'image';       url: string; alt?: string }
  | { type: 'card';        title: string; content: string; color?: string;
                          buttons?: { label: string; url?: string }[] }
  | { type: 'table';       headers: string[]; rows: string[][]; caption?: string }
  | { type: 'file';        url: string; filename: string }
  | { type: 'audio';       url: string; filename: string; duration?: number }
  | { type: 'divider' };
```

这是 Agent 输出到 IM 原生渲染之间的**中间表示层**。`parseToBlocks()` 函数将 Agent 的纯文本回复（含 markdown 语法）解析为 `UnifiedBlock[]`，再由各适配器的 `sendBlocks()` 实现渲染为平台原生格式。

#### Block 类型与 Markdown 语法映射

| Block 类型 | 触发语法 | 需要的能力 |
|-----------|---------|-----------|
| `code_block` | ` ```语言\n代码\n``` ` | `codeBlock` |
| `image` | `![alt](URL)` | `imageSend` |
| `table` | `\| A \| B \|\n\|---\|---\|` | `cardMessage` |
| `file` | `📎 [文件名](file:///路径)` | `fileSend` |
| `audio` | `🎙️ [文件名](file:///路径)` | `audioSend` |
| `card` | 无直接语法，由 `AgentRuntime` 构造 | `cardMessage` |
| `divider` | `---` | 任何 |

---

## 3. 注册与实例化

### 3.1 IM Registry 工厂模式

文件：`index.ts`

```typescript
const IM_REGISTRY = new Map<string, IMFactory>();

interface IMFactory {
  create(cfg: BotConfig): IMModule;
}

function registerIM(type: string, factory: IMFactory) {
  IM_REGISTRY.set(type, factory);
}

// 注册飞书
registerIM('feishu', {
  create(cfg: BotConfig) {
    return new FeishuIMModule({ appId: cfg.appId, appSecret: cfg.appSecret });
  },
});

// 注册 Telegram
registerIM('telegram', {
  create(cfg: BotConfig) {
    return new TelegramAdapter({ token: cfg.appId, proxy: (cfg as any).proxy });
  },
});

// 注册企微
registerIM('wecom', {
  create(cfg: BotConfig) {
    return new WeComIMModule({
      corpId: cfg.appId,
      corpSecret: cfg.appSecret,
      agentId: (cfg as any).agentId,
      token: (cfg as any).token,
      encodingAESKey: (cfg as any).encodingAESKey,
    });
  },
});

// 注册微信
registerIM('wechat', {
  create(cfg: BotConfig) {
    return new WeChatIMModule({
      botId: (cfg as any).botId,
      botToken: (cfg as any).botToken,
      ilinkUserId: (cfg as any).ilinkUserId,
    });
  },
});
```

### 3.2 创建 Bot 时的实例化

```typescript
function createBot(cfg: BotConfig) {
  const imType = cfg.im ?? 'feishu';
  const factory = IM_REGISTRY.get(imType);
  if (!factory) throw new Error(`未知的 IM 类型: ${imType}`);
  const imModule = factory.create(cfg);
  // ...
}
```

### 3.3 配置类型扩展

```typescript
export interface BotConfig {
  name: string;
  backend: 'claude' | 'codex' | 'opencode';
  appId: string;
  appSecret: string;
  cwd?: string;
  im?: 'feishu' | 'telegram' | 'wecom' | 'wechat';  // 新增 IM 需扩展此联合类型
}
```

> 📌 新增 IM 类型时，需要在 `BotConfig.im` 联合类型中添加字符串，并在 BotConfig 验证逻辑中跳过该 IM 的 `appId`/`appSecret` 检查（如果不是用这对凭证的话）。

---

## 4. 各适配器实现要点

### 4.1 飞书 (FeishuIMModule)

**文件**: `modules/im/feishu.ts` (~730 行)

**连接方式**: Lark SDK WebSocket 长连接

| 特性 | 实现 |
|------|------|
| 认证 | tenant_access_token / app_access_token（带 2h 过期管理 + 提前 5min 刷新） |
| 收消息 | WS 事件回调 `eventDispatcher.on('im.message.receive_v1')` |
| 文本发送 | `client.im.message.create()` 文本消息 |
| 卡片消息 | `msg_type: 'interactive'`，自定义卡片 JSON（config + elements） |
| 图片 | `client.im.v1.image.create()` 上传后发送 image_key |
| 文件 | `client.im.v1.file.create()` 上传后发送 file_key |
| 语音 | 本地 wav 上传，`msg_type: 'audio'` |
| 按钮 | 卡片内 `<action>` 元素 + `button` |
| 降级 | `sendBlocks()` catch 后降级为纯文本拼接 |

**配置项**: `appId`, `appSecret`

---

### 4.2 Telegram (TelegramAdapter)

**文件**: `modules/im/telegram.ts` (~640 行)

**连接方式**: HTTP 长轮询 (getUpdates)

| 特性 | 实现 |
|------|------|
| 认证 | Bot Token（HTTP 请求 header） |
| 收消息 | `_pollLoop()` 长轮询 `getUpdates`，支持 30s 超时 |
| 文本发送 | `sendMessage`（支持 MarkdownV2 格式） |
| 卡片消息 | 不支持 `cardMessage`，`sendBlocks()` 拼接为文本 |
| 图片 | `sendPhoto`（支持 URL 和本地上传） |
| 文件 | `sendDocument` |
| 语音 | `sendAudio` / `sendVoice` |
| 按钮 | Inline Keyboard（`sendInlineKeyboard`） |
| 代理 | 支持 HTTP(S) 代理 (`fetch` via `node:https` + agent) |

**配置项**: `appId`（即 Bot Token），可选 `proxy`

---

### 4.3 企业微信 (WeComIMModule)

**文件**: `modules/im/wecom.ts` (~600 行)

**连接方式**: WebSocket 长连接（企业微信 Agent 模式）

| 特性 | 实现 |
|------|------|
| 认证 | `corpId` + `corpSecret` + `agentId` + `token` + `encodingAESKey` |
| 收消息 | WS 事件回调 `ws.on('message')`，自动解密 |
| 文本发送 | `ws.reply(frame)` 被动回复 → `ws.sendMessage()` 主动推送 |
| 流式回复 | `replyStream()` / `replyStreamNonBlocking()` |
| 图片/文件 | `_uploadMediaFromSource()` 上传 media_id → `ws.sendMediaMessage()` |
| 卡片消息 | 模板卡片消息（含按钮回调） |
| 降级 | `sendBlocks()` 中不支持的 block 类型降级为文本 |

**配置项**: `appId`(corpId), `appSecret`(corpSecret), `agentId`, `token`, `encodingAESKey`

---

### 4.4 微信 (WeChatIMModule)

**文件**: `modules/im/wechat.ts` (~1090 行)

**连接方式**: iLink HTTP 长轮询

| 特性 | 实现 |
|------|------|
| 认证 | QR 扫码绑定 → `get_bot_qrcode` → `get_qrcode_status` → `bot_token` |
| 收消息 | `_pollLoop()` 长轮询 `ilink/bot/getupdates`（35s 超时 + 续传 buf） |
| 文本发送 | `ilink/bot/sendmessage`（需携带 `context_token`） |
| 流式回复 | `initStream` + `syncStream`（piece 批量上传） |
| 图片/文件 | CDN 下载/上传 + AES-128-ECB 加解密 |
| 语音 | CDN 下载 → silk 转 wav（待实现） |
| context_token | 内存 Map + 磁盘持久化（`wechat-context-tokens.json`） |

**配置项**: `botId`, `botToken`, `ilinkUserId`

**凭证存储**:
- `~/.imtoagent/wechat-creds.json`
- `~/.imtoagent/wechat-context-tokens.json`
- `~/.imtoagent/wechat-media/`

---

## 5. 新增 IM 适配器实现指南

### 5.1 文件位置

```
modules/im/<platform>.ts
```

### 5.2 类声明模板

```typescript
// modules/im/<platform>.ts
// <平台名> IM 模块
// 连接方式: <描述>
// 支持: <能力列表>

import type { IMModule, IMCapabilities, MessageHandler } from '../types';
import type { UnifiedBlock } from '../capabilities';
import type { MessageAttachment } from '../core/types';

export interface <Platform>Config {
  // 平台特有的配置项
}

export class <Platform>IMModule implements IMModule {
  private messageHandler: MessageHandler | null = null;
  private running = false;
  // ... 平台特有状态

  constructor(cfg: <Platform>Config) {
    // 初始化
  }

  // === IMModule 接口实现 ===

  getCapabilities(): IMCapabilities {
    return {
      text: true,
      codeBlock: false,    // 根据实际情况
      cardMessage: false,
      fileSend: true,
      imageSend: true,
      audioSend: false,
      buttonAction: false,
      maxTextLength: 4096, // 平台限制
    };
  }

  async reply(chatId: string, text: string, maxLen?: number): Promise<void> {
    const max = maxLen || this.getCapabilities().maxTextLength;
    const safe = text.length > max ? text.slice(0, max) + '\n\n...(截断)' : text;
    // 平台发送逻辑
  }

  async sendProgress(chatId: string, text: string): Promise<void> {
    // 如不支持静默跳过
  }

  async sendBlocks(chatId: string, blocks: UnifiedBlock[]): Promise<void> {
    const texts: string[] = [];
    for (const b of blocks) {
      switch (b.type) {
        case 'text':       texts.push(b.content); break;
        case 'code_block': /* 根据能力降级 */ break;
        case 'image':      /* 调用 sendImage */ break;
        case 'file':       /* 调用 sendFile */ break;
        case 'card':       texts.push(`**${b.title}**\n${b.content || ''}`); break;
        case 'table':      /* 渲染为文本表格 */ break;
        case 'divider':    texts.push('---'); break;
        case 'audio':      /* 如不支持跳过 */ break;
      }
    }
    if (texts.length) await this.reply(chatId, texts.join('\n\n'));
  }

  async sendImage(chatId: string, imageKey: string, _alt?: string): Promise<void> {
    // 平台图片发送逻辑
  }

  async sendFile(chatId: string, fileKey: string, fileName: string): Promise<void> {
    // 平台文件发送逻辑
  }

  start(handler: MessageHandler): void {
    this.messageHandler = handler;
    this.running = true;
    // 启动连接 / 开始轮询
  }

  stop(): void {
    this.running = false;
    // 清理资源
  }
}
```

### 5.3 注册步骤

1. **在 `index.ts` 中导入模块**:
   ```typescript
   import { <Platform>IMModule } from './modules/im/<platform>';
   ```

2. **注册到 IM Registry**:
   ```typescript
   registerIM('<platform>', {
     create(cfg: BotConfig) {
       return new <Platform>IMModule({
         // 映射 BotConfig 到平台配置
       });
     },
   });
   ```

3. **扩展 BotConfig.im 联合类型**:
   ```typescript
   // modules/types.ts
   export interface BotConfig {
     // ...
     im?: 'feishu' | 'telegram' | 'wecom' | 'wechat' | '<platform>';
   }
   ```

4. **如使用非标准凭证，更新 BotConfig 验证逻辑**（跳过 `appId`/`appSecret` 检查）:
   ```typescript
   // index.ts 中的 validateConfig 函数
   if (cfg.im !== 'feishu' && cfg.im !== 'telegram' && cfg.im !== 'wecom' &&
       cfg.im !== 'wechat' && cfg.im !== '<platform>') {
     // ...
   }
   ```

### 5.4 sendBlocks 实现模式

`sendBlocks()` 是**最复杂的方法**，需要处理所有 `UnifiedBlock` 类型。推荐模式：

**模式 A — 能力完整型**（飞书）:
- 文件 block 单独发送
- 其余 block 组合为卡片消息
- 卡片不支持时降级为纯文本

**模式 B — 能力精简型**（微信）:
- text/code_block/card/table/divider → 拼接为文本
- image/file → 调用 `sendImage`/`sendFile`
- 不支持的 block → 静默跳过或打印错误日志

**必须处理的行为**:
- 空 blocks 数组 → 什么都不做（return）
- 只有文本 block → 直接 `reply()`
- 部分 block 发送失败 → 捕获错误，继续处理其他 block

---

## 6. 设计决策记录

### 6.1 为什么用工厂注册而不是硬编码？

`IM Registry` 工厂模式允许新增 IM 适配器时**只改一个文件**（`index.ts` 添加一行 `registerIM()`），不需要修改 Bot 构造函数或任何核心逻辑。

### 6.2 为什么有 UnifiedBlock 中间层？

各 IM 平台的消息格式差异巨大（飞书卡片、Telegram Markdown、企微模板卡片、微信纯文本）。`UnifiedBlock[]` 作为中间表示，让 Agent 只需学习一套输出格式，各适配器各自负责渲染为平台原生格式。

### 6.3 为什么能力声明是声明式的？

`IMCapabilities` 让 `AgentRuntime` 在运行时动态构建 System Prompt（`buildCapabilityPrompt()`），告诉 Agent "你能用哪些格式输出"。这避免了为每个平台写死 prompt 模板。

### 6.4 为什么 reply() 先被动后主动？

企微和微信的 `reply()` 都先尝试 `ws.reply(frame)` 被动回复（走 WS 响应通道，带 req_id，时效短），失败时 fallback 到 `ws.sendMessage()` 主动推送。这保证了最快的响应速度。

### 6.5 为什么飞书没有 replyStream？

飞书 WebSocket SDK 天然支持流式更新消息内容（通过 `updateMessage`），但当前实现选择直接发送完整文本。如需流式，可通过 `sendProgress()` + `reply()` 模拟。

---

## 7. 测试清单

新增 IM 适配器完成后，逐项验证：

- [ ] `implements IMModule` 编译通过
- [ ] `getCapabilities()` 返回合理的能力声明
- [ ] `reply()` 发送文本，超长自动截断
- [ ] `sendProgress()` 不报错（如不支持静默跳过）
- [ ] `sendBlocks()` 处理所有 8 种 block 类型
- [ ] `sendImage()` 从本地路径和 URL 都能发送
- [ ] `sendFile()` 从本地路径和 URL 都能发送
- [ ] `start(handler)` 注册回调后能收到消息
- [ ] `stop()` 能干净停止，无资源泄漏
- [ ] 注册到 IM Registry，Bot 配置能创建实例
- [ ] 消息 handler 正确提取 `chatId`/`text`/`userId`/`attachments`
- [ ] 异常情况下不崩溃（网络错误、API 限流、认证过期等）

---

## 8. 版本历史

| 日期 | 变更 |
|------|------|
| 2026-05-19 | 初始版本，覆盖飞书/Telegram/企微/微信 4 个适配器 |
