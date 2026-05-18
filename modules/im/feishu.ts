// 飞书 IM 模块
// 封装 Lark SDK：WS 长连接(含自动重连)、消息收发
// 支持：纯文本、富文本卡片、图片、文件、表格

import * as Lark from '@larksuiteoapi/node-sdk';
import type { IMCapabilities } from '../types';
import type { UnifiedBlock } from '../capabilities';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export type FeishuMessageHandler = (chatId: string, text: string, userId: string) => Promise<void>;

// 飞书消息卡片元素类型
interface CardElement {
  tag: string;
  [key: string]: any;
}

interface CardAction {
  tag: string;
  [key: string]: any;
}

// Token 缓存条目，含过期时间
interface TokenEntry {
  token: string;
  expiresAt: number;  // 毫秒时间戳
}

export class FeishuIMModule {
  private client: Lark.Client;
  private wsClient: any = null;
  private appId: string;
  private appSecret: string;
  private messageHandler: FeishuMessageHandler | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private running = false;
  private _tenantAccessToken: TokenEntry | null = null;
  private _appAccessToken: TokenEntry | null = null;

  constructor(cfg: FeishuConfig) {
    this.appId = cfg.appId;
    this.appSecret = cfg.appSecret;
    this.client = new Lark.Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
  }

  // ================================================================
  // 认证（带过期检查，提前 5 分钟刷新）
  // ================================================================

  private async getTenantToken(): Promise<string> {
    const now = Date.now();
    if (this._tenantAccessToken && this._tenantAccessToken.expiresAt > now + 5 * 60 * 1000) {
      return this._tenantAccessToken.token;
    }

    try {
      const res = await this.client.request({
        method: 'POST',
        url: '/open-apis/auth/v3/tenant_access_token/internal',
        data: { app_id: this.appId, app_secret: this.appSecret },
      });
      if (res.code === 0 && res.tenant_access_token) {
        // 飞书 tenant_token 有效期约 2 小时
        this._tenantAccessToken = {
          token: res.tenant_access_token,
          expiresAt: now + 2 * 60 * 60 * 1000,
        };
        return this._tenantAccessToken.token;
      }
      throw new Error(`获取 token 失败: ${res.code} ${res.msg}`);
    } catch (e: any) {
      throw new Error(`获取 token 失败: ${e.message}`);
    }
  }

  private async getAppToken(): Promise<string> {
    const now = Date.now();
    if (this._appAccessToken && this._appAccessToken.expiresAt > now + 5 * 60 * 1000) {
      return this._appAccessToken.token;
    }

    try {
      const res = await this.client.request({
        method: 'POST',
        url: '/open-apis/auth/v3/app_access_token/internal',
        data: { app_id: this.appId, app_secret: this.appSecret },
      });
      if (res.code === 0 && res.app_access_token) {
        // 飞书 app_token 有效期约 2 小时
        this._appAccessToken = {
          token: res.app_access_token,
          expiresAt: now + 2 * 60 * 60 * 1000,
        };
        return this._appAccessToken.token;
      }
      throw new Error(`获取 app token 失败: ${res.code} ${res.msg}`);
    } catch (e: any) {
      throw new Error(`获取 app token 失败: ${e.message}`);
    }
  }

  // ================================================================
  // 基础发送
  // ================================================================

  async reply(chatId: string, text: string, maxLen = 140000) {
    const safe = text.length > maxLen ? text.slice(0, maxLen) + '\n\n...(截断)' : text;
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: safe }) },
      });
    } catch (e: any) {
      console.error(`[Feishu] 回复失败: ${e.message}`);
    }
  }

  async sendProgress(chatId: string, text: string) {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
      });
    } catch (e: any) {
      console.error(`[Feishu] 进度推送失败: ${e.message}`);
    }
  }

  // ================================================================
  // 富文本卡片发送
  // ================================================================

  async sendBlocks(chatId: string, blocks: UnifiedBlock[]) {
    // 拆分：文件 block 必须单独发飞书文件消息，不能进卡片
    const fileBlocks = blocks.filter(b => b.type === 'file' && b.url);
    const cardBlocks = blocks.filter(b => b.type !== 'file');

    // 先发送文件消息（飞书原生文件类型，可下载）
    for (const fb of fileBlocks) {
      try {
        let fileKey: string | null = null;
        if (fb.url.startsWith('file://')) {
          const localPath = fb.url.replace('file://', '');
          fileKey = await this.uploadFileFromPath(localPath);
        } else {
          fileKey = await this.uploadFileFromUrl(fb.url, fb.filename);
        }
        if (fileKey) {
          await this.sendFile(chatId, fileKey, fb.filename);
          console.log(`[Feishu] 文件已发送: ${fb.filename}`);
        }
      } catch (e: any) {
        console.error(`[Feishu] 文件发送失败: ${fb.filename} - ${e.message}`);
      }
    }

    // 如果只剩下一个文本块，直接发文本
    if (cardBlocks.length === 1 && cardBlocks[0].type === 'text') {
      if (fileBlocks.length === 0) return this.reply(chatId, cardBlocks[0].content);
      // 有文件在前，文本块附后
      await this.reply(chatId, cardBlocks[0].content);
      return;
    }

    // 如果没有非文件块了，只发文件就够了
    if (cardBlocks.length === 0) return;

    // 构建飞书消息卡片
    const cardElements: CardElement[] = [];

    for (const block of cardBlocks) {
      switch (block.type) {
        case 'text':
          cardElements.push({
            tag: 'markdown',
            content: this.escapeCardMarkdown(block.content),
          });
          break;

        case 'code_block':
          cardElements.push({
            tag: 'markdown',
            content: `\`\`\`${block.language || ''}
${this.escapeCodeBlock(block.code)}
\`\`\``,
          });
          break;

        case 'image':
          if (block.url) {
            try {
              const imageKey = await this.uploadImageFromUrl(block.url);
              if (imageKey) {
                cardElements.push({ tag: 'img', img_key: imageKey, alt: { tag: 'plain_text', content: block.alt || '' } });
              }
            } catch (e: any) {
              console.error(`[Feishu] 图片上传失败: ${e.message}`);
              cardElements.push({ tag: 'markdown', content: `⚠️ 图片加载失败` });
            }
          }
          break;

        case 'card':
          cardElements.push({
            tag: 'markdown',
            content: `**${this.escapeCardMarkdown(block.title)}**
${this.escapeCardMarkdown(block.content || '')}`,
          });
          if (block.buttons?.length) {
            const actions: CardAction[] = [];
            for (const b of block.buttons) {
              actions.push({
                tag: 'button',
                text: { tag: 'plain_text', content: b.label },
                type: 'primary',
                multi_url: b.url ? { url: b.url, pc_url: b.url, android_url: b.url, ios_url: b.url } : undefined,
              });
            }
            cardElements.push({ tag: 'action', actions });
          }
          break;

        case 'table':
          const mdTable = this.renderMarkdownTable(block.headers, block.rows, block.caption);
          cardElements.push({ tag: 'markdown', content: mdTable });
          break;

        case 'divider':
          cardElements.push({ tag: 'hr' });
          break;
      }
    }

    // 构建卡片 JSON
    const card: any = {
      config: { wide_screen_mode: true },
      elements: cardElements,
    };

    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      console.log(`[Feishu] 卡片消息已发送 (${cardBlocks.length} blocks)`);
    } catch (e: any) {
      console.error(`[Feishu] 卡片发送失败: ${e.message}`);
      // 降级：拼接为纯文本发送
      const fallback = cardBlocks.map(b => {
        switch (b.type) {
          case 'code_block': return `\`\`\`${b.language || ''}
${b.code}
\`\`\``;
          case 'image': return `![${b.alt || ''}](${b.url})`;
          case 'text': return b.content;
          case 'card': return `**${b.title}**
${b.content || ''}`;
          case 'table': return this.renderMarkdownTable(b.headers, b.rows, b.caption);
          case 'divider': return '---';
          default: return '';
        }
      }).join('\n\n');
      await this.reply(chatId, fallback);
    }
  }

  // ================================================================
  // 图片发送
  // ================================================================

  async sendImage(chatId: string, imageKey: string, _alt?: string) {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });
    } catch (e: any) {
      console.error(`[Feishu] 图片发送失败: ${e.message}`);
    }
  }

  // 从 URL 上传图片到飞书，返回 image_key
  async uploadImageFromUrl(url: string): Promise<string | null> {
    try {
      let buffer: Buffer | null = null;
      // 判断是本地文件路径还是远程 URL
      if (url.startsWith('http://') || url.startsWith('https://')) {
        buffer = await this.downloadFile(url);
      } else if (url.startsWith('file://')) {
        const filePath = url.replace('file://', '');
        buffer = require('fs').readFileSync(filePath);
      } else {
        // 可能是相对/绝对本地路径
        try {
          buffer = require('fs').readFileSync(url);
        } catch {
          buffer = await this.downloadFile(url);
        }
      }
      if (!buffer) return null;

      // 使用 SDK 原生上传方法
      const r = await (this.client as any).im.v1.image.create({
        data: { image_type: 'message', image: buffer },
      });
      const key = r?.image_key || r?.data?.image_key;
      if (key) return key;
      console.error(`[Feishu] 图片上传失败: image_key missing`);
      return null;
    } catch (e: any) {
      console.error(`[Feishu] 图片上传异常: ${e.message}`);
      return null;
    }
  }

  // 从本地文件上传到飞书，返回 image_key
  async uploadImageFromFile(filePath: string): Promise<string | null> {
    try {
      const buffer = fs.readFileSync(filePath);
      // 使用 SDK 原生上传方法
      const r = await (this.client as any).im.v1.image.create({
        data: { image_type: 'message', image: buffer },
      });
      const key = r?.image_key || r?.data?.image_key;
      if (key) return key;
      console.error(`[Feishu] 图片上传失败: image_key missing`);
      return null;
    } catch (e: any) {
      console.error(`[Feishu] 图片上传失败: ${e.message}`);
      return null;
    }
  }

  // ================================================================
  // 文件上传
  // ================================================================

  // 从 URL 下载并上传到飞书，返回 file_key
  async uploadFileFromUrl(url: string, filename: string): Promise<string | null> {
    try {
      const buffer = await this.downloadFile(url);
      if (!buffer) return null;
      return this.uploadFileFromBuffer(buffer, filename || path.basename(new URL(url).pathname) || 'file');
    } catch (e: any) {
      console.error(`[Feishu] 文件上传异常: ${e.message}`);
      return null;
    }
  }

  // 从本地路径上传文件到飞书，返回 file_key
  async uploadFileFromPath(filePath: string): Promise<string | null> {
    try {
      const buffer = fs.readFileSync(filePath);
      return this.uploadFileFromBuffer(buffer, path.basename(filePath));
    } catch (e: any) {
      console.error(`[Feishu] 文件上传失败: ${e.message}`);
      return null;
    }
  }

  // 从 Buffer 上传文件到飞书，返回 file_key
  private async uploadFileFromBuffer(buffer: Buffer, filename: string): Promise<string | null> {
    try {
      const token = await this.getAppToken();
      const form = new FormData();
      form.append('file_type', 'stream');
      form.append('file_name', filename);
      form.append('file', new Blob([buffer]), filename);

      const res = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (data.code === 0 && data.data?.file_key) {
        return data.data.file_key;
      }
      console.error(`[Feishu] 文件上传失败: ${data.code} ${data.msg}`);
      return null;
    } catch (e: any) {
      console.error(`[Feishu] 文件上传异常: ${e.message}`);
      return null;
    }
  }

  // 发送文件（直接传 file_key）
  async sendFile(chatId: string, fileKey: string, fileName: string) {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });
    } catch (e: any) {
      console.error(`[Feishu] 文件发送失败: ${e.message}`);
    }
  }

  // ================================================================
  // 能力声明
  // ================================================================

  getCapabilities(): IMCapabilities {
    return {
      text: true,
      codeBlock: true,       // 卡片 markdown 支持 ``` 语法
      cardMessage: true,
      fileSend: true,
      imageSend: true,
      buttonAction: true,
      maxTextLength: 30000,
    };
  }

  // ================================================================
  // 生命周期
  // ================================================================

  start(handler: FeishuMessageHandler) {
    this.messageHandler = handler;
    this.running = true;
    this._connect();
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.wsClient?.stop?.(); } catch {}
    console.log(`[Feishu] WS 已停止 (appId=${this.appId.slice(-8)})`);
  }

  private _connect() {
    if (!this.running || !this.messageHandler) return;

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        const { message } = data;
        if (!message || message.message_type !== 'text') return;
        const text = parseFeishuMessage(message.content || '');
        if (!text) return;
        const chatId = message.chat_id;
        const senderId = message.sender_id;
        const userId = senderId?.open_id || senderId?.user_id || senderId?.union_id || chatId;
        await this.messageHandler!(chatId, text, userId);
      },
    });

    // 自定义 Logger — 过滤 SDK 内部 WS 重连噪音
    const quietLogger = {
      info: (...args: any[]) => { /* 静默 info */ },
      warn: (...args: any[]) => { /* 静默 warn */ },
      error: (...args: any[]) => {
        const msg = args.join(' ');
        // 过滤已知的 SDK 内部 WS 重连噪音（不影响功能，SDK 自带自动重连）
        if (msg.includes('[ws]') && (msg.includes('ECONNREFUSED') || msg.includes('connect failed') || msg.includes('system busy') || msg.includes('repeat connection'))) return;
        console.error(`[Feishu-SDK] ${msg}`);
      },
      debug: (...args: any[]) => { /* 静默 debug */ },
    };

    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      logger: quietLogger,
      loggerLevel: Lark.LoggerLevel.info,
    });

    this.wsClient.start({ eventDispatcher: dispatcher })
      .then(() => {
        this.reconnectAttempts = 0;
        console.log(`[Feishu] WS 已连接`);
      })
      .catch((e: any) => {
        console.error(`[Feishu] WS 连接失败: ${e.message}`);
        this._scheduleReconnect();
      });

    this.wsClient.on?.('close', () => {
      console.log('[Feishu] WS 断开');
      this._scheduleReconnect();
    });
    this.wsClient.on?.('error', (e: any) => {
      console.error(`[Feishu] WS 错误: ${e.message || e}`);
    });
  }

  private _scheduleReconnect() {
    if (!this.running) return;
    if (this.reconnectTimer) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    console.log(`[Feishu] ${delay/1000}s 后重连 (第${this.reconnectAttempts}次)`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  // ================================================================
  // 工具方法
  // ================================================================

  // 飞书卡片 markdown：仅处理破坏解析的边界情况
  // Agent 输出是可信的 markdown，不应全量转义
  private escapeCardMarkdown(text: string): string {
    return text;
  }

  // 代码块内容：保护内部的三反引号不被解析器截断
  private escapeCodeBlock(code: string): string {
    return code.replace(/```/g, '\\`\\`\\`');
  }

  // 渲染 markdown 表格
  private renderMarkdownTable(headers: string[], rows: string[][], caption?: string): string {
    const lines: string[] = [];
    if (caption) lines.push(`**${this.escapeCardMarkdown(caption)}**\n`);

    // 表头
    lines.push('| ' + headers.map(h => this.escapeCardMarkdown(h)).join(' | ') + ' |');
    // 分隔线
    lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
    // 数据行
    for (const row of rows) {
      const cells = [];
      for (let i = 0; i < headers.length; i++) {
        cells.push(i < row.length ? this.escapeCardMarkdown(row[i]) : '');
      }
      lines.push('| ' + cells.join(' | ') + ' |');
    }
    return lines.join('\n');
  }

  // 下载文件/图片
  private downloadFile(url: string): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const get = url.startsWith('https') ? https.get : http.get;
      get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', () => resolve(null));
    });
  }

  // 下载图片（便捷别名）
  private async downloadImage(url: string): Promise<Buffer | null> {
    return this.downloadFile(url);
  }
}

function parseFeishuMessage(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return (parsed.text || '').trim();
  } catch {
    return content.trim();
  }
}
