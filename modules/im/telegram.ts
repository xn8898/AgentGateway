// Telegram IM 适配器
// 实现 IMModule 接口，对接 Telegram Bot API（长轮询模式）
//
// 使用方式：config.json bot 配置 "im": "telegram"
//   appId    = Bot Token（从 @BotFather 获取）
//   appSecret = 留空即可

import type { IMModule, IMCapabilities, MessageHandler } from '../types';
import type { UnifiedBlock } from '../capabilities';

export interface TelegramConfig {
  /** Bot Token（从 @BotFather 获取） */
  token: string;
}

export class TelegramAdapter implements IMModule {
  private token: string;
  private apiUrl: string;
  private handler: MessageHandler | null = null;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;

  constructor(cfg: TelegramConfig) {
    this.token = cfg.token;
    this.apiUrl = `https://api.telegram.org/bot${this.token}`;
  }

  // ================================================================
  // 能力声明
  // ================================================================

  getCapabilities(): IMCapabilities {
    return {
      text: true,
      codeBlock: true,       // MarkdownV2 支持 ``` 代码块
      cardMessage: false,    // Telegram 无原生卡片，sendBlocks 降级为文本
      fileSend: true,
      imageSend: true,
      audioSend: true,
      buttonAction: true,    // 内联键盘
      maxTextLength: 4096,
    };
  }

  // ================================================================
  // 生命周期
  // ================================================================

  start(handler: MessageHandler): void {
    this.handler = handler;
    this.running = true;
    this._poll();
    console.log('[Telegram] 长轮询已启动');
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    console.log('[Telegram] 已停止');
  }

  private async _poll(): Promise<void> {
    if (!this.running) return;

    try {
      const url = `${this.apiUrl}/getUpdates?timeout=30&offset=${this.lastUpdateId + 1}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.ok && data.result) {
        for (const update of data.result) {
          this.lastUpdateId = update.update_id;
          const msg = update.message || update.edited_message;
          if (!msg || !msg.text) continue;

          const chatId = String(msg.chat.id);
          const userId = String(msg.from?.id || chatId);
          const text = msg.text.trim();

          if (this.handler) {
            this.handler(chatId, text, userId).catch(e =>
              console.error('[Telegram] 消息处理异常:', e.message)
            );
          }
        }
      }
    } catch (e: any) {
      console.error('[Telegram] 长轮询错误:', e.message);
    }

    // 立即发起下一次轮询
    this.pollTimer = setTimeout(() => this._poll(), 100);
  }

  // ================================================================
  // 文本发送
  // ================================================================

  async reply(chatId: string, text: string, maxLen = 4096): Promise<void> {
    const safe = text.length > maxLen ? text.slice(0, maxLen) + '\n\n…(截断)' : text;
    await this._api('sendMessage', {
      chat_id: chatId,
      text: safe,
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    }).catch(() =>
      // MarkdownV2 解析失败时降级为纯文本
      this._api('sendMessage', {
        chat_id: chatId,
        text: safe,
        link_preview_options: { is_disabled: true },
      })
    );
  }

  async sendProgress(chatId: string, text: string): Promise<void> {
    // Telegram 用"正在输入..."状态 + 临时消息
    await this._api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    await this.reply(chatId, text);
  }

  // ================================================================
  // 富文本块发送（降级为 MarkdownV2 文本）
  // ================================================================

  async sendBlocks(chatId: string, blocks: UnifiedBlock[]): Promise<void> {
    const lines: string[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          lines.push(block.content);
          break;

        case 'code_block': {
          const lang = block.language || '';
          lines.push(`\`\`\`${lang}\n${block.code}\n\`\`\``);
          break;
        }

        case 'image':
          if (block.url) {
            try {
              await this.sendImageByUrl(chatId, block.url, block.alt);
            } catch (e: any) {
              lines.push(`⚠️ 图片加载失败`);
            }
          }
          break;

        case 'file':
          if (block.url) {
            try {
              await this.sendFileByUrl(chatId, block.url, block.filename);
            } catch (e: any) {
              lines.push(`⚠️ 文件发送失败: ${block.filename}`);
            }
          }
          break;

        case 'card':
          lines.push(`*${this._escape(block.title)}*`);
          if (block.content) lines.push(block.content);
          if (block.buttons?.length) {
            await this._sendInlineButtons(chatId, lines.join('\n'), block.buttons);
            return; // 按钮消息已发送，不继续拼接
          }
          break;

        case 'table': {
          const tableLines: string[] = [];
          tableLines.push('| ' + block.headers.join(' | ') + ' |');
          tableLines.push('| ' + block.headers.map(() => '---').join(' | ') + ' |');
          for (const row of block.rows) {
            tableLines.push('| ' + row.join(' | ') + ' |');
          }
          if (block.caption) lines.push(`*${this._escape(block.caption)}*`);
          lines.push(tableLines.join('\n'));
          break;
        }

        case 'audio':
          if (block.url) {
            try {
              await this._sendAudio(chatId, block.url, block.filename);
            } catch (e: any) {
              lines.push(`⚠️ 音频发送失败`);
            }
          }
          break;

        case 'divider':
          lines.push('---');
          break;
      }
    }

    const text = lines.join('\n\n').trim();
    if (text) await this.reply(chatId, text);
  }

  // ================================================================
  // 图片
  // ================================================================

  async sendImage(chatId: string, imageKey: string, alt?: string): Promise<void> {
    // imageKey 可能是 file_id 或 URL
    await this._api('sendPhoto', {
      chat_id: chatId,
      photo: imageKey,
      caption: alt || '',
    }).catch(async () => {
      console.error(`[Telegram] 图片发送失败`);
    });
  }

  private async sendImageByUrl(chatId: string, url: string, alt?: string): Promise<void> {
    let imageSource: string;

    if (url.startsWith('file://')) {
      const filePath = url.replace('file://', '');
      const blob = new Blob([require('fs').readFileSync(filePath)]);
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('photo', blob, 'image.png');
      if (alt) form.append('caption', alt);
      await fetch(`${this.apiUrl}/sendPhoto`, { method: 'POST', body: form });
    } else {
      await this._api('sendPhoto', {
        chat_id: chatId,
        photo: url,
        caption: alt || '',
      });
    }
  }

  // ================================================================
  // 文件
  // ================================================================

  async sendFile(chatId: string, fileKey: string, fileName: string): Promise<void> {
    await this._api('sendDocument', {
      chat_id: chatId,
      document: fileKey,
      caption: fileName,
    }).catch(() => {
      console.error(`[Telegram] 文件发送失败: ${fileName}`);
    });
  }

  private async sendFileByUrl(chatId: string, url: string, filename: string): Promise<void> {
    if (url.startsWith('file://')) {
      const filePath = url.replace('file://', '');
      const buffer = require('fs').readFileSync(filePath);
      const blob = new Blob([buffer]);
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', blob, filename);
      form.append('caption', filename);
      await fetch(`${this.apiUrl}/sendDocument`, { method: 'POST', body: form });
    } else {
      await this._api('sendDocument', {
        chat_id: chatId,
        document: url,
        caption: filename,
      });
    }
  }

  // ================================================================
  // 音频
  // ================================================================

  private async _sendAudio(chatId: string, url: string, filename: string): Promise<void> {
    if (url.startsWith('file://')) {
      const filePath = url.replace('file://', '');
      const buffer = require('fs').readFileSync(filePath);
      const blob = new Blob([buffer]);
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('audio', blob, filename);
      await fetch(`${this.apiUrl}/sendAudio`, { method: 'POST', body: form });
    } else {
      await this._api('sendAudio', { chat_id: chatId, audio: url });
    }
  }

  // ================================================================
  // 内联按钮
  // ================================================================

  private async _sendInlineButtons(chatId: string, text: string, buttons: { label: string; url?: string }[]): Promise<void> {
    const keyboard = {
      inline_keyboard: [buttons.map(b => ({
        text: b.label,
        url: b.url || 'https://t.me',
      }))],
    };

    await this._api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    }).catch(() =>
      this._api('sendMessage', {
        chat_id: chatId,
        text,
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      })
    );
  }

  // ================================================================
  // 工具方法
  // ================================================================

  private async _api(method: string, params: Record<string, any>): Promise<any> {
    const res = await fetch(`${this.apiUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return res.json();
  }

  /** MarkdownV2 转义（Telegram 要求转义特殊字符） */
  private _escape(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }
}
