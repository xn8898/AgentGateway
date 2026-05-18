// ================================================================
// Inbound Media — 适配器 + 抽象层类型定义
// ================================================================
// 设计思路（参考 OpenClaw）：
//   1. IM 平台只管从自己平台下载原始 buffer（InboundMediaAdapter）
//   2. MediaStore 负责存储、MIME sniff、生命周期管理
//   3. InboundMediaResolver 负责串联下载→存储→生成 Agent 提示
// ================================================================

/** 媒体资源类型（对应飞书 API 的 type 参数） */
export type MediaResourceType = 'image' | 'file' | 'media';

/** 下载后的原始媒体元数据 */
export interface DownloadedMedia {
  /** 文件内容 buffer */
  buffer: Buffer;
  /** 平台提供的原始文件名（如有） */
  fileName?: string;
  /** 平台提供的 MIME 类型（如有，可能不准确） */
  contentType?: string;
  /** 平台资源标识（image_key / file_key 等，调试用） */
  sourceKey?: string;
}

/** 统一媒体条目 — MediaStore 返回的标准格式 */
export interface MediaEntry {
  /** 本地存储路径 */
  localPath: string;
  /** 嗅探/推断出的 MIME 类型 */
  mimeType: string;
  /** 原始文件名（保留扩展名信息） */
  fileName: string;
  /** 媒体分类：image | document | audio | video | archive | spreadsheet | presentation | text | other */
  category: MediaCategory;
  /** 文件大小（bytes） */
  sizeBytes: number;
  /** 平台来源标识 */
  source?: string;
}

/** 媒体分类（用于差异化 Agent 提示） */
export type MediaCategory =
  | 'image'
  | 'document'     // PDF, DOC, DOCX, TXT, MD 等
  | 'audio'
  | 'video'
  | 'archive'      // ZIP, TAR, RAR, 7Z 等
  | 'spreadsheet'  // XLS, XLSX, CSV 等
  | 'presentation' // PPT, PPTX 等
  | 'text'         // 纯文本文件
  | 'other';

/**
 * InboundMediaAdapter — IM 平台必须实现的媒体下载接口
 *
 * 职责：从各自 IM 平台下载消息附件的原始 buffer
 * 不负责：存储、MIME sniff、扩展名处理
 */
export interface InboundMediaAdapter {
  /**
   * 从 IM 平台下载消息附件
   * @param messageId  消息 ID
   * @param resourceKey 平台资源 key（image_key / file_key 等）
   * @param type       资源类型
   * @param fileName   原始文件名（如有，用于扩展名推断）
   */
  downloadResource(
    messageId: string,
    resourceKey: string,
    type: MediaResourceType,
    fileName?: string
  ): Promise<DownloadedMedia | null>;

  /** 平台标识（'feishu' / 'telegram' / ...） */
  readonly platform: string;
}
