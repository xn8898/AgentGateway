# 统一消息格式设计

> 2026-05-10 · Phase 2 规划文档

## 设计目标

IMtoAgent 连接多种 IM 和多种 Agent 系统，每种系统的消息格式各异。需要在中间建立一个**统一内部格式**，让 IM 模块和 Agent 模块各自只做"翻译"，不对接对方的细节。

```
IM 消息              统一内部格式              Agent 输入
┌────────┐         ┌────────────┐         ┌──────────┐
│ 飞书图片 │ ──────→ │ image: url │ ──────→ │ Claude   │
│ token   │  IM模块 │ (统一格式) │ Agent模块│ SDK传图  │
│ 换URL   │         └────────────┘         └──────────┘
└────────┘

Agent 输出            统一内部格式              IM 消息
┌──────────┐         ┌────────────┐         ┌────────┐
│ 代码块   │ ──────→ │ code: ts   │ ──────→ │ 飞书富  │
│          │ Agent模块│ block      │  IM模块 │ 文本    │
│          │         │            │         │ 微信纯  │
│          │         │            │         │ 文本    │
└──────────┘         └────────────┘         └────────┘
```

---

## 统一内部格式定义

### 输入：IM → Agent

```typescript
interface UnifiedMessage {
  /** 纯文本内容 */
  text?: string

  /** 富媒体附件（图片、文件、音频、视频） */
  attachments?: Attachment[]

  /** IM 特有结构化内容（卡片、位置、联系人等） */
  structuredContent?: StructuredContent[]

  /** 消息上下文 */
  context: MessageContext
}

interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video'
  mimeType: string        // 如 image/png
  url: string             // 可下载的 URL（IM 模块已处理认证）
  filename?: string
  size?: number           // 字节
  duration?: number       // 音频/视频时长（秒）
}

interface StructuredContent {
  type: 'card' | 'location' | 'contact' | 'event' | 'unknown'
  payload: unknown        // 保留原始数据，由 Agent 模块决定如何处理
  /** 从结构化内容中提取的文字摘要（降级用） */
  textSummary?: string
}

interface MessageContext {
  imType: 'feishu' | 'wechat' | 'dingtalk'
  userId: string
  userName?: string
  sessionId: string
  /** 引用回复的原消息内容 */
  repliedMessage?: string
  /** 消息时间戳 */
  timestamp: number
}
```

### 输出：Agent → IM

```typescript
interface UnifiedReply {
  /** 回复内容块列表（按展示顺序） */
  blocks: ReplyBlock[]
  
  /** 文件附件 */
  files?: ReplyFile[]
  
  /** 元信息 */
  meta?: ReplyMeta
}

type ReplyBlock =
  | TextBlock
  | CodeBlock
  | ImageBlock
  | CardBlock
  | FileLinkBlock
  | DividerBlock

interface TextBlock {
  type: 'text'
  content: string     // 支持简单 Markdown（粗体、斜体、链接）
}

interface CodeBlock {
  type: 'code'
  content: string
  language: string     // typescript, python, bash 等
  title?: string       // 代码块标题
}

interface ImageBlock {
  type: 'image'
  url: string
  alt?: string
  width?: number
  height?: number
}

interface CardBlock {
  type: 'card'
  title: string
  subtitle?: string
  content: string      // Markdown
  actions?: CardAction[]
}

interface CardAction {
  label: string
  url?: string          // 跳转链接
  callback?: string     // 回调标识
}

interface FileLinkBlock {
  type: 'file_link'
  url: string
  filename: string
  mimeType: string
  size?: number
}

interface DividerBlock {
  type: 'divider'
}

interface ReplyFile {
  url: string
  filename: string
  mimeType: string
  size?: number
}

interface ReplyMeta {
  model?: string
  tokensUsed?: number
  cost?: number
  durationMs?: number
}
```

---

## 翻译示例

### 示例 1：飞书图片消息 → Agent

```typescript
// 飞书模块翻译
feishu.onMessage(rawMsg: {
  msg_type: 'image',
  content: { image_key: 'img_v2_xxx' }
}) {
  // 1. 飞书特有：用 image_key 换临时下载 URL
  const downloadUrl = await feishuSDK.getImageUrl('img_v2_xxx')

  // 2. 转成统一格式
  router.route({
    text: undefined,
    attachments: [{
      type: 'image',
      mimeType: 'image/jpeg',
      url: downloadUrl,
      size: 204800
    }],
    structuredContent: [],
    context: {
      imType: 'feishu',
      userId: 'ou_xxx',
      sessionId: 'session_123',
      timestamp: Date.now()
    }
  })
}
```

### 示例 2：统一格式 → 不同 Agent

```typescript
// Claude 模块：图片作为上下文传给 SDK
claudeAdapter.send(msg: UnifiedMessage) {
  let prompt = msg.text || '请分析这张图片'
  
  for (const att of msg.attachments || []) {
    if (att.type === 'image') {
      // Claude SDK 支持 vision，直接传图
      return claudeSDK.query({
        prompt,
        images: [{ url: att.url }]
      })
    }
    if (att.type === 'file') {
      prompt += `\n[附件: ${att.filename}]`
    }
  }

  // 飞书卡片降级处理
  for (const sc of msg.structuredContent || []) {
    if (sc.type === 'card') {
      prompt += '\n[飞书卡片消息' + (sc.textSummary ? ': ' + sc.textSummary : '') + ']'
    }
  }
  
  return claudeSDK.query({ prompt })
}

// ChatGPT 模块：图片用 OpenAI vision 格式
chatgptAdapter.send(msg: UnifiedMessage) {
  const content: any[] = []
  
  if (msg.text) content.push({ type: 'text', text: msg.text })
  
  for (const att of msg.attachments || []) {
    if (att.type === 'image') {
      content.push({
        type: 'image_url',
        image_url: { url: att.url }
      })
    }
  }
  
  return openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content }],
    stream: true
  })
}
```

### 示例 3：Agent 代码块 → 不同 IM

```typescript
// Agent 模块产生统一格式
agentModule.onReply() {
  return {
    blocks: [
      { type: 'text', content: '重构完成，主要改动：' },
      { type: 'code', content: 'const x = await fetchData();', language: 'typescript' },
      { type: 'text', content: '以上是核心改动。' }
    ]
  }
}

// 飞书模块：代码块用富文本（带语法高亮）
feishu.sendReply(reply: UnifiedReply) {
  const postContent: any[] = []
  
  for (const block of reply.blocks) {
    if (block.type === 'text') {
      postContent.push([{ tag: 'text', text: block.content }])
    }
    else if (block.type === 'code') {
      postContent.push([
        { tag: 'text', text: `\n${block.language}\n${block.content}\n`, 
          style: ['code'] }  // 飞书富文本代码块
      ])
    }
  }
  
  return feishuSDK.sendMessage({
    msg_type: 'post',
    content: { post: { zh_cn: { content: [postContent] } } }
  })
}

// 微信模块：代码块降级为纯文本，用 markdown 包一下
wechat.sendReply(reply: UnifiedReply) {
  let text = ''
  
  for (const block of reply.blocks) {
    if (block.type === 'text') {
      text += block.content + '\n'
    }
    else if (block.type === 'code') {
      // 微信不支持代码块，降级
      text += `\`\`\`${block.language}\n${block.content}\n\`\`\`\n`
    }
    else if (block.type === 'card') {
      // 卡片降级：提取文字
      text += `📋 ${block.title}\n${block.content}\n`
    }
  }
  
  // 微信限制 2048 字
  if (text.length > 2000) {
    text = text.slice(0, 1997) + '...'
  }
  
  return wechatSDK.sendText(text)
}
```

---

## 能力降级机制

每个 IM 模块声明自己能展示什么，路由层根据能力做降级：

```typescript
interface IMCapabilities {
  text: boolean              // 所有 IM 都有
  markdown: boolean          // 飞书 ✅  微信 ❌
  codeBlock: boolean         // 飞书 ✅  微信 ❌
  image: boolean             // 大部分有
  file: boolean              // 飞书 ✅  微信 ❌
  cardMessage: boolean       // 飞书 ✅  微信 ❌
  interactiveButton: boolean
  maxTextLength: number      // 飞书 30K  微信 2K
  maxImageSize: number       // 字节
}

// 路由层：自动降级
class MessageRouter {
  sendReply(reply: UnifiedReply, imType: string) {
    const im = this.getIMModule(imType)
    const caps = im.getCapabilities()
    
    // 降级处理
    reply.blocks = reply.blocks.map(block => {
      if (block.type === 'code' && !caps.codeBlock) {
        return this.codeToMarkdown(block)   // 代码块 → ``` 文本
      }
      if (block.type === 'card' && !caps.cardMessage) {
        return this.cardToText(block)       // 卡片 → 纯文本
      }
      if (block.type === 'image' && !caps.image) {
        return this.imageToLink(block)      // 图片 → 链接
      }
      return block
    })
    
    // 截断超长文本
    let totalText = this.countTextLength(reply)
    if (totalText > caps.maxTextLength) {
      reply.blocks = this.truncateBlocks(reply.blocks, caps.maxTextLength)
    }
    
    im.sendReply(reply)
  }
}
```

---

## 降级规则矩阵

| 内容类型 | 飞书 | 微信 | 钉钉 |
|----------|------|------|------|
| text | ✅ 原生 | ✅ 原生 | ✅ 原生 |
| code block | ✅ 富文本代码块 | ⚠️ 转为 ``` | ✅ 富文本 |
| image | ✅ 图片消息 | ✅ 图片消息 | ✅ 图片消息 |
| file | ✅ 文件消息 | ⚠️ 转为链接 | ✅ 文件消息 |
| card | ✅ 交互卡片 | ⚠️ 提取文字 | ⚠️ 提取文字 |
| button | ✅ 按钮 | ❌ 转为文字链接 | ⚠️ 简单按钮 |
| divider | ✅ 分割线 | ⚠️ 转为 --- | ✅ 分割线 |

---

## 设计原则

1. **IM 模块负责"对外"翻译** — 飞书 token 换 URL、微信 XML 解析，都是 IM 模块的事
2. **Agent 模块负责"对内"翻译** — 图片变成 SDK image 字段还是 API vision 格式，是 Agent 模块的事
3. **降级不丢信息** — 代码块降级为文本不会丢内容，只是格式没了
4. **内部格式只加不减** — 新能力扩展内部格式，不破坏已有字段
5. **Agent 不感知 IM 细节** — Agent 模块永远不知道消息来自飞书还是微信
