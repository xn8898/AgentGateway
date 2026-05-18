// ================================================================
// MediaStore — 统一媒体存储抽象层
// ================================================================
// 职责：
//   1. 保存 buffer 到本地，带正确扩展名
//   2. MIME sniff（优先用 buffer 内容判断，其次用文件名推断）
//   3. 媒体分类（image / document / audio / ...）
//   4. 生命周期管理（清理过期文件）
//
// 参考 OpenClaw 的 parseMessageWithAttachments + saveMediaBuffer 设计
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { MediaEntry, MediaCategory } from './types';
import { getDataDir } from '../utils/paths';

// ================================================================
// MIME 推断
// ================================================================

/** 通过 buffer 头部字节 sniff MIME 类型 */
export function sniffMimeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  const header = buffer.toString('hex', 0, 16);

  // PNG
  if (header.startsWith('89504e47')) return 'image/png';
  // JPEG
  if (header.startsWith('ffd8ff')) return 'image/jpeg';
  // GIF
  if (header.startsWith('47494638')) return 'image/gif';
  // WebP
  if (header.startsWith('52494646') && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  // PDF
  if (header.startsWith('25504446')) return 'application/pdf';
  // ZIP / XLSX / DOCX / PPTX (PK)
  if (header.startsWith('504b0304') || header.startsWith('504b0506')) {
    // 需要进一步判断，先返回通用 ZIP
    return 'application/zip';
  }
  // MP3
  if (header.startsWith('494433') || header.startsWith('fff3') || header.startsWith('fff2')) return 'audio/mpeg';
  // WAV
  if (header.startsWith('52494646') && buffer.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  // OGG
  if (header.startsWith('4f676753')) return 'audio/ogg';
  // MP4
  if (header.startsWith('000000') && buffer.toString('ascii', 4, 8).includes('ftyp')) return 'video/mp4';

  return null;
}

/** 从文件名推断 MIME 类型 */
export function mimeFromFileName(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  const mimeMap: Record<string, string> = {
    // 图片
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    // 文档
    '.pdf': 'application/pdf', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
    // 表格
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // 演示文稿
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // 音频
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    // 视频
    '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.webm': 'video/webm',
    // 压缩包
    '.zip': 'application/zip', '.rar': 'application/x-rar-compressed',
    '.tar': 'application/x-tar', '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed',
    // 代码
    '.js': 'application/javascript', '.ts': 'text/typescript', '.py': 'text/x-python',
    '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  };
  return mimeMap[ext] || null;
}

/** 从 MIME 类型推断扩展名 */
export function extensionForMime(mime: string): string {
  const extMap: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/bmp': '.bmp',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
    'video/mp4': '.mp4', 'video/x-msvideo': '.avi',
    'application/zip': '.zip', 'application/gzip': '.gz',
    'application/json': '.json', 'application/xml': '.xml',
  };
  return extMap[mime] || '';
}

// ================================================================
// 媒体分类
// ================================================================

/** 根据 MIME 类型 + 文件名判断媒体分类 */
export function categorizeMedia(mimeType: string, fileName?: string): MediaCategory {
  // 图片
  if (mimeType.startsWith('image/')) return 'image';
  // 音频
  if (mimeType.startsWith('audio/')) return 'audio';
  // 视频
  if (mimeType.startsWith('video/')) return 'video';

  const ext = fileName ? path.extname(fileName).toLowerCase() : '';

  // 压缩包
  if (['.zip', '.rar', '.tar', '.gz', '.7z', '.bz2', '.xz'].includes(ext)) return 'archive';
  // 表格
  if (['.xls', '.xlsx', '.csv', '.tsv', '.ods'].includes(ext)) return 'spreadsheet';
  // 演示文稿
  if (['.ppt', '.pptx', '.odp', '.key'].includes(ext)) return 'presentation';
  // 文档
  if (['.pdf', '.doc', '.docx', '.odt', '.rtf', '.txt', '.md'].includes(ext)) return 'document';
  // 纯文本
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
    return 'text';
  }

  return 'other';
}

// ================================================================
// MediaStore
// ================================================================

export interface MediaStoreOptions {
  /** 存储根目录（默认使用数据目录下的 media/inbound） */
  rootDir?: string;
  /** 单文件最大字节数（默认 20MB） */
  maxBytes?: number;
}

export class MediaStore {
  private readonly rootDir: string;
  private readonly maxBytes: number;

  constructor(options?: MediaStoreOptions) {
    this.maxBytes = options?.maxBytes ?? 20 * 1024 * 1024;

    if (options?.rootDir) {
      this.rootDir = options.rootDir;
    } else {
      // 默认: ~/.imtoagent/media/inbound/
      this.rootDir = path.join(getDataDir(), 'media', 'inbound');
    }

    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  /**
   * 保存 buffer 到本地存储
   *
   * 策略（参考 OpenClaw）：
   *   1. sniff buffer 获取真实 MIME
   *   2. 如果 sniff 失败，用 fileName 推断
   *   3. 如果 MIME 是通用容器（octet-stream），用 fileName 覆盖
   *   4. 文件名保留原始扩展名，前缀加时间戳防冲突
   */
  save(
    buffer: Buffer,
    mimeType: string | undefined,
    originalFileName?: string,
    source?: string
  ): MediaEntry {
    // 大小检查
    if (buffer.length > this.maxBytes) {
      throw new Error(`Media exceeds size limit: ${buffer.length} > ${this.maxBytes} bytes`);
    }

    // MIME 推断优先级: sniff > provided > fileName-derived
    const sniffedMime = sniffMimeFromBuffer(buffer);
    const fileNameMime = originalFileName ? mimeFromFileName(originalFileName) : null;

    // 通用容器 MIME 不够具体，优先用 sniff 或文件名推断
    const isGeneric = (mime?: string) => !mime || mime === 'application/octet-stream';

    let finalMime = sniffedMime || mimeType || fileNameMime || 'application/octet-stream';

    // 如果 sniff 到了具体类型，优先使用
    if (sniffedMime && !isGeneric(sniffedMime)) {
      finalMime = sniffedMime;
    } else if (isGeneric(mimeType) && fileNameMime) {
      finalMime = fileNameMime;
    }

    // 构造文件名（保留原始扩展名）
    const localFileName = this.buildFileName(originalFileName, finalMime);

    // 写入磁盘
    const localPath = path.join(this.rootDir, localFileName);
    fs.writeFileSync(localPath, buffer);

    const category = categorizeMedia(finalMime, originalFileName);

    return {
      localPath,
      mimeType: finalMime,
      fileName: originalFileName || localFileName,
      category,
      sizeBytes: buffer.length,
      source,
    };
  }

  /** 清理过期文件（超过 maxAge 毫秒的文件） */
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let count = 0;

    const files = fs.readdirSync(this.rootDir);
    for (const file of files) {
      const filePath = path.join(this.rootDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          count++;
        }
      } catch {
        // 忽略删除失败
      }
    }

    if (count > 0) {
      console.log(`[MediaStore] Cleaned up ${count} expired files`);
    }
    return count;
  }

  /** 获取存储根目录 */
  getRootDir(): string {
    return this.rootDir;
  }

  // ================================================================
  // Private
  // ================================================================

  private buildFileName(originalFileName?: string, mimeType?: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 10);

    if (originalFileName) {
      // 保留原始文件名 + 时间戳防冲突
      const ext = path.extname(originalFileName);
      const base = path.basename(originalFileName, ext);
      // 截断过长的文件名
      const truncatedBase = base.length > 50 ? base.slice(0, 50) : base;
      return `${timestamp}-${random}-${truncatedBase}${ext}`;
    }

    // 没有原始文件名，用 MIME 推断扩展名
    const ext = mimeType ? extensionForMime(mimeType) : '';
    return `${timestamp}-${random}${ext}`;
  }
}
