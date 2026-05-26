import * as notificationStore from "../store/notification-store.js";

export interface ChannelLike {
  id: string;
  canPush: boolean;
  sendMessage(chatId: string, message: string): Promise<void>;
}

export class NotificationQueue {
  constructor(private dbPath: string) {}

  /**
   * 发送通知：能推送的 Channel 直接推送，不能的缓存到队列
   */
  async notify(channel: ChannelLike, chatId: string, message: string): Promise<void> {
    if (channel.canPush) {
      await channel.sendMessage(chatId, message);
    } else {
      notificationStore.enqueue(this.dbPath, channel.id, chatId, message);
    }
  }

  /**
   * 捎带检查：用户发消息时调用，返回待推送的通知列表
   */
  flushPending(channelId: string, chatId: string): string[] {
    return notificationStore.dequeuePending(this.dbPath, channelId, chatId);
  }

  /**
   * 定期清理旧通知
   */
  cleanup(days: number = 7) {
    notificationStore.cleanupOld(this.dbPath, days);
  }
}
