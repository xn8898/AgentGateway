// ================================================================
// SDK 核心类型 — IMtoAgent 新模块只需实现 AgentAdapter
// ================================================================

import type { UnifiedBlock, IMCapabilities } from '../capabilities';

// ================================================================
// 统计
// ================================================================

/** 调用统计 */
export interface CallStats {
  calls: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  totalDurationMs: number;
}

// ================================================================
// Session
// ================================================================

/**
 * 统一 Session — 替代各 Agent 特有的 session 字段
 * 
 * 与现有 .memory.json 格式保持向后兼容：
 * - metadata 中存放 sdkSessionId / codexThreadId / ocSessionId 等
 * - 直接字段存放通用属性
 */
export interface Session {
  chatId: string;
  userId: string;
  cwd?: string;
  startFresh: boolean;

  // 后端会话 ID（通用，替代 sdkSessionId/codexThreadId/ocSessionId）
  backendSessionId?: string;

  // 各 Agent 特有的元数据（扩展用）
  // 向后兼容：从旧 .memory.json 迁移时，sdkSessionId/codexThreadId/ocSessionId 存在这里
  metadata: Record<string, any>;

  // 统计
  stats: CallStats;

  // 元数据
  lastUsed: number;
  running: boolean;
  permissionMode?: string;
  codexMode?: string; // plan/auto

  // 最近消息（向后兼容）
  recentMessages: string[];
}

// ================================================================
// Agent 输入 / 输出
// ================================================================

/** 消息附件（图片/文件/语音等） */
export interface MessageAttachment {
  /** 类型：image | file | audio */
  type: 'image' | 'file' | 'audio';
  /** 本地下载后的文件路径 */
  localPath: string;
  /** 原始文件名（如有） */
  filename?: string;
  /** 飞书 image_key / file_key（调试用） */
  sourceKey?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 语音时长（毫秒） */
  durationMs?: number;
  /** 预计算的 Agent 提示文本（由 MediaResolver 按文件类型生成，优先级高于 buildAttachmentHint 自动生成的） */
  hint?: string;
}

/** 构建附件提示文本，注入到 Agent 输入消息中 */
export function buildAttachmentHint(attachments: MessageAttachment[]): string {
  return attachments.map((att, i) => {
    const icon = att.type === 'image' ? '🖼️' : att.type === 'audio' ? '🎵' : '📎';
    const typeLabel = att.type === 'image' ? '图片' : att.type === 'audio' ? '语音' : '文件';
    const detail = att.filename ? ` (${att.filename})` : '';
    const dur = att.durationMs ? ` [时长: ${Math.round(att.durationMs / 1000)}秒]` : '';
    const mimeInfo = att.mimeType ? ` [${att.mimeType}]` : '';

    // 优先使用预计算的提示（由 MediaResolver 按文件类型生成）
    let hint: string;
    if (att.hint) {
      hint = `\n> 💡 ${att.hint}`;
    } else if (att.type === 'image') {
      hint = `\n> 💡 图片已保存到本地，路径: \`${att.localPath}\`，格式: ${att.mimeType || '未知'}，可使用查看图片工具读取`;
    } else if (att.type === 'audio') {
      hint = `\n> 💡 语音文件路径: \`${att.localPath}\`，可用语音识别工具处理`;
    } else {
      const ext = att.filename ? `，扩展名: ${att.filename.split('.').pop()}` : '';
      hint = `\n> 💡 文件路径: \`${att.localPath}\`，可直接读取内容${ext}`;
    }

    return `${icon} [用户消息附带${typeLabel} #${i + 1}]${detail}${mimeInfo}${dur}${hint}`;
  }).join('\n\n');
}

/** Agent 输入 */
export interface AgentInput {
  chatId: string;
  text: string;
  /** 消息附带的附件/媒体（图片、文件、语音等，已下载到本地） */
  attachments?: MessageAttachment[];
  session: Session;
  workingDir: string;
  systemPrompt?: string;
  model: string;
}

/** Agent 输出 */
export interface AgentOutput {
  text?: string;
  toolCalls?: Array<{ name: string; summary: string }>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUSD?: number;
    durationMs?: number;
    numTurns?: number;
  };
  error?: string;
}

// ================================================================
// AgentAdapter — 新 Agent 模块只需实现这个接口
// ================================================================

/**
 * AgentAdapter — 新 Agent 模块只需实现这个接口
 * 
 * 职责：接收用户消息，调用后端 API，返回响应
 * SDK Runtime 负责：session 管理、统计、格式化、错误处理、配置
 */
export interface AgentAdapter {
  readonly name: string;
  handleMessage(input: AgentInput): Promise<AgentOutput>;
  healthCheck?(): Promise<boolean>;
  cancel?(sessionId: string): Promise<void>;
}

// ================================================================
// Runtime 接口
// ================================================================

/** 消息处理上下文 */
export interface MessageContext {
  chatId: string;
  text: string;
  /** 消息附带的附件/媒体 */
  attachments?: MessageAttachment[];
  userId: string;
  workingDir: string;
  model: string;
  systemPrompt?: string;
  reply: (text: string) => Promise<void>;
  sendProgress: (text: string) => Promise<void>;
  sendBlocks?: (blocks: UnifiedBlock[]) => Promise<void>;
  /** IM 能力声明，用于 parseToBlocks 正确解析 */
  imCaps?: IMCapabilities;
}

/** Session 管理器 */
export interface SessionManager {
  /** 获取或创建 Session */
  getOrCreate(botName: string, chatId: string, userId: string): Promise<Session>;
  /** 持久化 Session */
  persist(botName: string, session: Session): void;
  /** 删除 Session */
  delete(botName: string, chatId: string): void;
  /** 清理空闲 Session */
  cleanupIdle(botName: string, timeoutMs: number): void;
  /** 列出所有活跃 Session */
  listActive(botName: string): Session[];
}

/** 错误处理器 */
export interface ErrorHandler {
  handle(chatId: string, error: Error, ctx: ErrorContext): Promise<ErrorAction>;
}

/** 配置管理器 */
export interface ConfigManager {
  get<T>(path: string): T;
  getBotConfig(name: string): BotConfig | null;
  getProviderConfig(providerId: string): ProviderConfig | null;
  getActiveModel(): string;
  resolveModel(modelSpec: string): string;
}

/** 统计追踪器 */
export interface StatsTracker {
  resetForCall(session: Session): void;
  accumulate(session: Session, usage: { inputTokens: number; outputTokens: number; costUSD?: number; durationMs?: number; numTurns?: number }): void;
  formatSummary(session: Session): string;
}

// ================================================================
// Runtime 配置
// ================================================================

export interface RuntimeConfig {
  sessionManager: SessionManager;
  errorHandler: ErrorHandler;
  configManager: ConfigManager;
  statsTracker: StatsTracker;
}

// ================================================================
// 错误处理
// ================================================================

export type ErrorAction =
  | { type: 'reply'; message: string }
  | { type: 'retry'; maxAttempts: number }
  | { type: 'fallback'; adapter: string };

export interface ErrorContext {
  chatId: string;
  backend: string;
  attempt: number;
}

// ================================================================
// 配置类型
// ================================================================

export interface BotConfig {
  name: string;
  backend: string; // 'claude' | 'codex' | 'opencode'
  appId: string;
  appSecret: string;
  cwd?: string;
  activeModel?: string;
  modelAliases?: Record<string, string>;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  format: 'anthropic' | 'openai';
}
