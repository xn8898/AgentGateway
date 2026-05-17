// ============================================================
// CC 路由 v4 — 多 Bot 架构（SDK 完整接入版）
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

// ===== 防止 fork 子进程 =====
const LOCK_FILE = '/tmp/.cc-gateway.lock';
let isPrimary = true;
try {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim());
    try { process.kill(pid, 0); isPrimary = false; } catch { fs.unlinkSync(LOCK_FILE); }
  }
  if (isPrimary) fs.writeFileSync(LOCK_FILE, String(process.pid));
} catch {}
if (!isPrimary) process.exit(0);
process.on('exit', () => {
  try { require('fs').unlinkSync(LOCK_FILE); } catch {}
});

import * as Lark from '@larksuiteoapi/node-sdk';
import {
  sharedState, loadProviders, getProviderConfig, saveActiveModel,
  loadSessionConfig, saveSessionConfig,
  saveSessionMemory, loadSessionMemory, deleteSessionMemory, listPersistedSessions,
  resolveModel, ModelAliases, SessionMemoryData
} from './modules/proxy/anthropic-proxy';
import { parseToBlocks } from './modules/capabilities';
import { resolveCapabilities } from './modules/prompt-builder';
import { FeishuIMModule } from './modules/im/feishu';
import type { IMModule } from './modules/types';
import { startAnthropicProxy, stopAnthropicProxy } from './modules/proxy/anthropic-proxy';
import { startCodexProxy, stopCodexProxy, getProxyUsage, resetProxyUsage, initCodexProxyConfig } from './modules/proxy/codex-proxy';
import { initOpenCodeConfig } from './modules/agent/opencode';
import { checkRateLimit, setRateLimitConfig } from './modules/rate-limiter';
import { setCurrentBot } from './modules/bot-context';

// ===== SDK 核心 =====
import { AgentRuntime, FileSessionManager, DefaultErrorHandler, DefaultStatsTracker } from './modules/core';
import { ClaudeAdapter } from './modules/agent/claude-adapter';
import { CodexAdapter } from './modules/agent/codex-adapter';
import { OpenCodeAdapter } from './modules/agent/opencode-adapter';
import type { CallStats, Session, AgentAdapter } from './modules/core/types';
import { startOpenCodeServer, stopOpenCodeServer } from './modules/agent/opencode-adapter';

// ===== 全局活跃请求计数 =====
let activeRequests = 0;

// ================================================================
// 解析飞书消息内容
// ================================================================
function parseMessage(content: string): string {
  try { return (JSON.parse(content).text || '').trim(); }
  catch { return content.trim(); }
}

// ================================================================
// ChatSession — 继承 SDK Session，兼容旧命令
// ================================================================
interface ChatSession extends Session {
  _raw?: any; // 保留原始加载数据
}

// ================================================================
// 自定义 SessionManager — 桥接 Bot.sessions 和 SDK
// ================================================================
class CustomSessionManager {
  sessions: Map<string, ChatSession>;
  botName: string;

  constructor(botName: string, sessions: Map<string, ChatSession>) {
    this.botName = botName;
    this.sessions = sessions;
  }

  private _sessionPath(chatId: string): string {
    const home = process.env.HOME || '/Users/keyi';
    return `${home}/Desktop/cc-gateway/sessions/${this.botName}/${chatId}.memory.json`;
  }

  async getOrCreate(chatId: string, userId: string): Promise<ChatSession> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }

    // 从文件加载（兼容旧格式）
    const fp = this._sessionPath(chatId);
    let session: ChatSession;

    if (fs.existsSync(fp)) {
      try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const data = JSON.parse(raw);
        const EMPTY_STATS: CallStats = {
          calls: 0, totalTurns: 0, totalInputTokens: 0,
          totalOutputTokens: 0, totalCostUSD: 0, totalDurationMs: 0,
        };
        session = {
          chatId: data.chatId || chatId,
          userId: data.userId || userId,
          cwd: data.cwd,
          startFresh: data.startFresh || false,
          backendSessionId: data.sdkSessionId || data.codexThreadId || data.ocSessionId || data.backendSessionId,
          metadata: {
            sdkSessionId: data.sdkSessionId,
            codexThreadId: data.codexThreadId,
            ocSessionId: data.ocSessionId,
            ...(data.metadata || {}),
          },
          stats: data.stats || { ...EMPTY_STATS },
          lastUsed: data.lastUsed || Date.now(),
          running: false,
          permissionMode: data.permissionMode,
          codexMode: data.codexMode,
          recentMessages: data.recentMessages || [],
        };
      } catch (e: any) {
        console.error(`[Session] 加载失败 ${chatId}: ${e.message}`);
        session = this._newSession(chatId, userId);
      }
    } else {
      session = this._newSession(chatId, userId);
    }

    this.sessions.set(chatId, session);
    return session;
  }

  private _newSession(chatId: string, userId: string): ChatSession {
    const EMPTY_STATS: CallStats = {
      calls: 0, totalTurns: 0, totalInputTokens: 0,
      totalOutputTokens: 0, totalCostUSD: 0, totalDurationMs: 0,
    };
    return {
      chatId, userId, startFresh: false,
      backendSessionId: undefined, metadata: {},
      stats: { ...EMPTY_STATS },
      lastUsed: Date.now(), running: false, recentMessages: [],
    };
  }

  persist(_botName: string, session: Session): void {
    const cs = session as ChatSession;
    const fp = this._sessionPath(session.chatId);
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const output: Record<string, any> = {
      chatId: session.chatId,
      userId: session.userId,
      cwd: session.cwd,
      startFresh: session.startFresh,
      stats: session.stats,
      lastUsed: session.lastUsed,
      recentMessages: session.recentMessages || [],
      running: session.running,
    };

    if (session.backendSessionId) output.backendSessionId = session.backendSessionId;
    if (session.metadata) {
      if (session.metadata.sdkSessionId) output.sdkSessionId = session.metadata.sdkSessionId;
      if (session.metadata.codexThreadId) output.codexThreadId = session.metadata.codexThreadId;
      if (session.metadata.ocSessionId) output.ocSessionId = session.metadata.ocSessionId;
      if (session.permissionMode) output.permissionMode = session.permissionMode;
      if (session.codexMode) output.codexMode = session.codexMode;
    }
    output.metadata = session.metadata;

    try {
      fs.writeFileSync(fp, JSON.stringify(output, null, 2));
    } catch (e: any) {
      console.error(`[Session] 持久化失败 ${session.chatId}: ${e.message}`);
    }
  }

  delete(_botName: string, chatId: string): void {
    this.sessions.delete(chatId);
    try {
      const fp = this._sessionPath(chatId);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {}
  }

  cleanupIdle(timeoutMs: number): void {
    const now = Date.now();
    const toRemove: string[] = [];
    for (const [chatId, session] of this.sessions.entries()) {
      if (now - session.lastUsed > timeoutMs && !session.running) {
        toRemove.push(chatId);
      }
    }
    for (const chatId of toRemove) {
      this.sessions.delete(chatId);
      console.log(`[Session] 清理空闲 ${chatId.slice(-8)}`);
    }
  }

  listActive(): Session[] {
    return Array.from(this.sessions.values());
  }
}

// ================================================================
// 工具函数
// ================================================================
function levenshteinDistance(a: string, b: string): number {
  const m = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) m[0][i] = i;
  for (let j = 0; j <= b.length; j++) m[j][0] = j;
  for (let j = 1; j <= b.length; j++)
    for (let i = 1; i <= a.length; i++)
      m[j][i] = Math.min(m[j][i-1]+1, m[j-1][i]+1, m[j-1][i-1]+(a[i-1]===b[j-1]?0:1));
  return m[b.length][a.length];
}

function findSimilarCommand(input: string, cmds: Map<string, any>): string[] {
  return [...cmds.keys()].filter(c => levenshteinDistance(input, c) <= 2 && levenshteinDistance(input, c) > 0).slice(0, 3);
}

// ================================================================
// 命令类型
// ================================================================
interface CommandCtx {
  chatId: string;
  args: string;
  session: ChatSession | undefined;
}
type CommandHandler = (ctx: CommandCtx) => Promise<string> | string;

// ================================================================
// BotConfig
// ================================================================
interface BotConfig {
  name: string;
  appId: string;
  appSecret: string;
  backend: 'claude' | 'codex' | 'opencode';
  cwd?: string;
}

// ================================================================
// Bot 类 — SDK 完整接入版
// ================================================================
class Bot {
  name: string;
  backend: 'claude' | 'codex' | 'opencode';
  appId: string;
  appSecret: string;
  defaultCwd: string;
  activeModel: string;
  modelAliases: ModelAliases;
  modelPresets: Record<string, string>;
  soul: string;
  client: Lark.Client;
  im: IMModule;
  config: any;

  // SDK
  runtime: AgentRuntime;
  sessionManager: CustomSessionManager;
  sessions: Map<string, ChatSession> = new Map();
  commands: Map<string, CommandHandler> = new Map();
  adapter: AgentAdapter;

  constructor(cfg: BotConfig, globalConfig: any) {
    this.name = cfg.name;
    this.backend = cfg.backend;
    this.appId = cfg.appId;
    this.appSecret = cfg.appSecret;
    this.defaultCwd = cfg.cwd || globalConfig.system?.defaultProjectDir || '/Users/keyi/Projects';
    this.config = globalConfig;

    // Bot 级模型配置
    const botCfg = this._loadBotConfig();
    this.activeModel = botCfg.activeModel || globalConfig.defaultModel || 'deepseek/deepseek-v4-pro';
    this.modelAliases = botCfg.modelAliases || globalConfig.modelAliases || {};
    this.modelPresets = botCfg.modelPresets || {
      fast: 'deepseek/deepseek-v4-flash',
      pro: 'deepseek/deepseek-v4-pro',
    };

    // 灵魂
    this._initSoul();
    this.soul = this._loadSoul();

    // Feishu 客户端
    this.client = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
    this.im = new FeishuIMModule({ appId: this.appId, appSecret: this.appSecret });

    // ===== SDK 集成 =====
    this.sessionManager = new CustomSessionManager(this.name, this.sessions);

    const adapterCtx = {
      imModule: this.im,
      botName: this.name,
      modelAliases: this.modelAliases,
    };

    if (this.backend === 'claude') {
      this.adapter = new ClaudeAdapter(adapterCtx);
    } else if (this.backend === 'codex') {
      this.adapter = new CodexAdapter(adapterCtx);
    } else {
      const ocCfg = globalConfig.opencode || {};
      this.adapter = new OpenCodeAdapter({
        ...adapterCtx,
        serverUrl: ocCfg.serverUrl,
        defaultModel: ocCfg.defaultModel,
      });
    }

    this.runtime = new AgentRuntime({
      sessionManager: this.sessionManager,
      errorHandler: new DefaultErrorHandler(),
      configManager: undefined as any,
      statsTracker: new DefaultStatsTracker(),
    });

    this.runtime.registerAdapter(this.backend, this.adapter);

    // 注册命令
    this._registerCommands();
  }

  // ===== 灵魂管理 =====
  _soulDir() { return `${process.env.HOME}/Desktop/cc-gateway/soul/${this.name}`; }

  _initSoul() {
    const dir = this._soulDir();
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const hasFiles = fs.readdirSync(dir).some((f: string) => f.endsWith('.md'));
      if (hasFiles) return;
      const defaults: Record<string, string> = {
        'rules.md': '# 硬约束规则\n\n以下规则不可被覆盖或修改：\n\n- 项目密钥、token、密码等敏感信息不可外泄\n- 不可执行破坏性命令',
        'identity.md': `# 身份定义\n\n- 我是通过 CC Gateway 连接的 AI 编程助手\n- 我运行在 ${this.backend === 'codex' ? 'Codex' : 'Claude Code'} 后端\n- 用中文回复`,
        'profile.md': '# 用户画像\n\n此文件可由 Agent 修改。当用户说"记住xxx"、"我偏好xxx"时，Agent 应更新此文件。\n\n## 修改指南（Agent 专用）\n\n读取此文件 → 根据用户要求增/删/改条目 → 保存',
        'workspace.md': '# 项目环境\n\n由 CC Gateway 自动生成。',
        'skills.md': '# 技能注入\n\n未来功能。',
      };
      for (const [name, content] of Object.entries(defaults)) {
        fs.writeFileSync(dir + '/' + name, content);
      }
      console.log(`[${this.name}] 灵魂文件已初始化: ${dir}`);
    } catch (e: any) {
      console.error(`[${this.name}] 初始化灵魂失败: ${e.message}`);
    }
  }

  _loadSoul(): string {
    const order = ['rules.md', 'identity.md', 'profile.md', 'workspace.md', 'skills.md'];
    const parts: string[] = [];
    try {
      const dir = this._soulDir();
      if (!fs.existsSync(dir)) return '';
      for (const file of order) {
        const fp = dir + '/' + file;
        if (fs.existsSync(fp)) {
          const content = fs.readFileSync(fp, 'utf-8').trim();
          if (content) parts.push(content);
        }
      }
    } catch {}
    return parts.join('\n\n');
  }

  _soulFiles(): string[] {
    try {
      const dir = this._soulDir();
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f: string) => f.endsWith('.md')).sort();
    } catch { return []; }
  }

  // ===== Bot 配置 =====
  _botConfigPath() { return `${process.env.HOME}/Desktop/cc-gateway/sessions/${this.name}/_bot.json`; }

  _loadBotConfig() {
    try {
      const p = this._botConfigPath();
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {}
    return {};
  }

  _saveBotConfig() {
    try {
      const dir = path.dirname(this._botConfigPath());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._botConfigPath(), JSON.stringify({
        activeModel: this.activeModel,
        modelAliases: this.modelAliases,
        modelPresets: this.modelPresets,
      }, null, 2));
    } catch (e: any) {
      console.error(`[${this.name}] 保存配置失败:`, e.message);
    }
  }

  // ===== 命令注册 =====
  _registerCommands() {
    const cmd = (name: string, handler: CommandHandler) => this.commands.set(name, handler);

    cmd('/help', () => {
      let out = '📋 **CC 快捷命令**\n\n';
      out += '/status — 状态\n/info — 配置\n/stats — 统计\n';
      out += '/model — 模型切换\n/providers — 供应商\n';
      out += '/dir — 目录\n/clear — 清空\n';
      if (this.backend === 'claude') out += '/mode — 权限\n';
      else if (this.backend === 'codex') out += '/mode — 模式(auto/plan)\n';
      out += '/memory — 概览\n/soul — 灵魂\n/reload — 重载';
      return out;
    });

    cmd('/status', ({ session }) =>
      session?.running
        ? `✅ ${this.backend} 运行中 | ${this.activeModel} | ${session.stats.calls} 次调用`
        : `⏸ ${this.backend} 空闲 | ${this.activeModel}`);

    cmd('/info', ({ session }) =>
      `🤖 ${this.name} (${this.backend})\n模型: ${this.activeModel}\n目录: ${session?.cwd || this.defaultCwd}\n会话数: ${this.sessions.size}`);

    cmd('/stats', ({ session }) => {
      if (!session || session.stats.calls === 0) return '📊 暂无调用';
      const s = session.stats;
      return `📊 调用 ${s.calls} 次 | ${s.totalTurns} 轮\nToken: ${s.totalInputTokens.toLocaleString()}入 + ${s.totalOutputTokens.toLocaleString()}出\n费用: $${s.totalCostUSD.toFixed(4)} | 耗时 ${(s.totalDurationMs/1000).toFixed(0)}s`;
    });

    cmd('/clear', ({ session }) => {
      if (session) {
        session.startFresh = true;
        return '🗑 已清空对话（下次消息将开启全新会话）';
      }
      return '✅ 无活跃对话';
    });

    cmd('/model', ({ args }) => {
      const raw = args.trim();
      if (!raw) {
        let out = `🤖 当前: ${this.activeModel}`;
        if ((this.backend === 'claude' || this.backend === 'opencode') && this.modelAliases) {
          if (this.backend === 'claude') {
            out += '\n\n🎭 角色映射 (Claude 内部角色 → 模型):';
            for (const role of ['default', 'sonnet', 'opus', 'haiku', 'best']) {
              const spec = this.modelAliases[role as keyof ModelAliases];
              if (spec) out += `\n• ${role} → ${spec}`;
            }
            out += '\n💡 /model sonnet 供应商/模型 可修改角色映射';
          } else if (this.backend === 'opencode') {
            out += '\n\n🎭 角色映射:';
            const spec = (this.modelAliases as any).opencode;
            if (spec) out += `\n• opencode → ${spec}`;
            out += '\n💡 /model opencode 供应商/模型 可修改映射';
          }
        }
        const presets = Object.entries(this.modelPresets || {});
        if (presets.length > 0) {
          out += '\n\n⚡ 快捷切换:';
          for (const [alias, spec] of presets) {
            const mark = spec === this.activeModel ? ' ✅' : '';
            out += `\n• /model ${alias} → ${spec}${mark}`;
          }
        }
        out += '\n\n📋 /model add <别名> <模型> — 添加预设';
        out += '\n🗑  /model del <别名> — 删除预设';
        out += '\n🔀 /model 供应商/模型 — 直接切换';
        return out;
      }

      if (raw.startsWith('add ')) {
        const rest = raw.slice(4).trim();
        const space = rest.indexOf(' ');
        if (space < 0) return '❌ 用法: /model add <别名> <供应商/模型>';
        const alias = rest.slice(0, space).trim();
        const spec = rest.slice(space + 1).trim();
        if (!this.modelPresets) this.modelPresets = {};
        this.modelPresets[alias] = spec;
        this._saveBotConfig();
        return `✅ 预设已添加: ${alias} → ${spec}`;
      }

      if (raw.startsWith('del ')) {
        const alias = raw.slice(4).trim();
        if (!this.modelPresets || !this.modelPresets[alias]) return `❌ 未找到预设: ${alias}`;
        delete this.modelPresets[alias];
        this._saveBotConfig();
        return `🗑 已删除预设: ${alias}`;
      }

      // 角色别名
      if ((this.backend === 'claude' && ['default', 'sonnet', 'opus', 'haiku', 'best'].includes(raw)) ||
          (this.backend === 'opencode' && raw === 'opencode')) {
        const spec = (this.modelAliases as any)[raw] || this.modelAliases[raw as keyof typeof this.modelAliases];
        if (spec) return `🎭 ${raw} → ${spec}\n💡 修改: /model ${raw} 供应商/模型名`;
        return `❌ 未设置角色: ${raw}`;
      }

      // 预设
      if (this.modelPresets && this.modelPresets[raw]) {
        const spec = this.modelPresets[raw];
        const cfg = getProviderConfig(spec);
        if (!cfg) return `❌ 预设目标无效: ${spec}`;
        this.activeModel = spec;
        this.modelAliases.default = spec;
        this._saveBotConfig();
        return `🤖 已切换: ${spec} (${raw})`;
      }

      // 角色映射修改 (Claude/OpenCode)
      if (this.backend === 'claude' || this.backend === 'opencode') {
        const space = raw.indexOf(' ');
        if (space > 0) {
          const role = raw.slice(0, space).trim();
          const spec = raw.slice(space + 1).trim();
          const validRoles = this.backend === 'opencode' ? ['opencode'] : ['default', 'sonnet', 'opus', 'haiku', 'best'];
          if (validRoles.includes(role)) {
            const cfg = getProviderConfig(spec);
            if (!cfg) return `❌ 未知模型: ${spec}`;
            (this.modelAliases as any)[role] = spec;
            if (role === 'default') this.activeModel = spec;
            this._saveBotConfig();
            return `🎭 ${role} → ${spec} (已更新)`;
          }
        }
      }

      // 直接切换
      const cfg = getProviderConfig(raw);
      if (!cfg) return `❌ 未知模型: ${raw}\n💡 用 /model 查看预设`;
      this.activeModel = raw;
      this.modelAliases.default = raw;
      this._saveBotConfig();
      return `🤖 已切换: ${raw}`;
    });

    cmd('/providers', () => {
      const providers = loadProviders();
      const list = Object.entries(providers).map(([name, p]: [string, any]) =>
        `• **${name}**: ${(p.models || []).join(', ')}`
      ).join('\n');
      return `📡 **可用供应商**\n\n${list}\n\n当前: ${this.activeModel}`;
    });

    cmd('/dir', ({ args, session }) => {
      const dir = args.trim();
      if (!dir) return `📁 ${session?.cwd || this.defaultCwd}`;
      if (session) session.cwd = dir;
      return `📁 已切换: ${dir}`;
    });

    cmd('/mode', ({ args, session }) => {
      const mode = args.trim();
      if (this.backend === 'claude') {
        if (!mode) return `🔐 当前权限: ${session?.permissionMode || 'bypassPermissions'}\n可选: bypassPermissions | default | plan`;
        if (!['bypassPermissions', 'default', 'plan'].includes(mode))
          return `❌ 无效: ${mode}\n可选: bypassPermissions | default | plan`;
        if (session) { session.permissionMode = mode; return `🔐 已切换: ${mode}`; }
        return '❌ 无活跃会话';
      }
      if (!mode) {
        const current = session?.codexMode || 'auto';
        return `🔧 当前模式: ${current}\n可选: auto (直接执行) | plan (先计划后执行)`;
      }
      if (!['auto', 'plan'].includes(mode))
        return `❌ 无效: ${mode}\n可选: auto | plan`;
      if (session) { session.codexMode = mode; return `🔧 已切换: ${mode}`; }
      return '❌ 无活跃会话';
    });

    cmd('/memory', ({ session }) => {
      if (!session) return '📦 无活跃会话';
      const s = session.stats;
      return `🧠 ${this.name} (${this.backend})\nstartFresh: ${session.startFresh || false}\nsdkSession: ${session.metadata?.sdkSessionId?.slice(-8) || session.backendSessionId?.slice(-8) || '无'}\n调用: ${s.calls} | 轮数: ${s.totalTurns}\nToken: ${s.totalInputTokens.toLocaleString()}入 + ${s.totalOutputTokens.toLocaleString()}出\n费用: $${s.totalCostUSD.toFixed(4)}`;
    });

    cmd('/soul', ({ args }) => {
      if (args.trim() === 'reload') {
        this._initSoul();
        this.soul = this._loadSoul();
        return `🧠 灵魂已重载 (${this.soul.length} 字符)`;
      }
      const files = this._soulFiles();
      if (files.length === 0) return `🧠 未配置灵魂\n💡 创建 ${this._soulDir()}/ 目录下的 .md 文件`;
      let out = `🧠 灵魂文件 (${this.soul.length} 字符):\n`;
      for (const f of files) {
        const fp = this._soulDir() + '/' + f;
        try {
          const s = fs.statSync(fp);
          const tag = f === 'rules.md' ? ' 🔒' : f === 'profile.md' ? ' ✏️' : '';
          out += `\n• ${f} (${s.size}B)${tag}`;
        } catch { out += `\n• ${f}`; }
      }
      out += '\n\n💡 /soul reload — 重新加载';
      out += '\n🔒 rules=只读 | ✏️ profile=Agent可改';
      return out;
    });

    cmd('/reload', async () => {
      await gracefulReload('/reload');
      return '🔄 热重载中...';
    });
  }

  async tryHandleCommand(chatId: string, text: string, session: ChatSession | undefined): Promise<string | null> {
    if (!text.startsWith('/')) return null;
    const space = text.indexOf(' ');
    const cmdName = space >= 0 ? text.slice(0, space).toLowerCase() : text.toLowerCase();
    const args = space >= 0 ? text.slice(space + 1) : '';
    const handler = this.commands.get(cmdName);
    if (handler) return handler({ chatId, args, session });
    const similar = findSimilarCommand(cmdName, this.commands);
    if (similar.length > 0)
      return `❌ 未知命令: ${cmdName}\n💡 ${similar.map(s => `\`${s}\``).join('、')}？\n输入 /help 查看`;
    return null;
  }

  // ===== 消息处理 — SDK 完整接入 =====
  async handleMessage(chatId: string, text: string, userId: string) {
    activeRequests++;
    try {
      // 限流
      const rlResult = checkRateLimit(chatId);
      if (!rlResult.allowed) {
        await this.reply(chatId, `⚠️ 请求过于频繁，请等待 ${rlResult.retryAfter} 秒后再试`);
        return;
      }

      // 获取/创建会话
      const session = await this.sessionManager.getOrCreate(chatId, userId);
      session.lastUsed = Date.now();

      // 命令处理
      const cmdResp = await this.tryHandleCommand(chatId, text, session);
      if (cmdResp !== null) {
        await this.reply(chatId, cmdResp);
        this.sessionManager.persist(this.name, session);
        return;
      }

      // 最近消息
      session.recentMessages.push(text);
      if (session.recentMessages.length > 5) session.recentMessages = session.recentMessages.slice(-5);

      // 构建系统提示词
      const systemPrompt = this.soul ? buildSystemPromptWithSoul(this.soul, this.name, this.im) : undefined;

      // SDK Runtime 处理
      await this.runtime.processMessage({
        chatId, text, userId,
        workingDir: session.cwd || this.defaultCwd,
        model: this.activeModel,
        systemPrompt,
        reply: async (t: string) => this.reply(chatId, t),
        sendProgress: async (t: string) => this.sendProgress(chatId, t),
        sendBlocks: async (blocks) => this.sendFormattedReplyDirect(chatId, blocks),
        imCaps: this.im.getCapabilities(),
      }, this.adapter, this.name);

    } catch (e: any) {
      console.error(`[${this.name}] handleMessage 异常: ${e.message}`);
      await this.reply(chatId, `❌ ${e.message}`);
    } finally {
      activeRequests--;
    }
  }

  async reply(chatId: string, text: string) {
    const maxLen = this.config.system?.maxReplyLength || 140000;
    await this.im.reply(chatId, text, maxLen);
    console.log(`[${this.name}] 回复 chat=${chatId.slice(-8)} len=${Math.min(text.length, maxLen)}`);
  }

  async sendProgress(chatId: string, text: string) {
    await this.im.sendProgress(chatId, text);
  }

  async sendFormattedReplyDirect(chatId: string, blocks: any[]) {
    if (this.im?.sendBlocks) {
      await this.im.sendBlocks(chatId, blocks);
    }
  }
}

// ===== 系统提示词构建（不依赖 prompt-builder 的旧接口） =====
import { buildSystemPrompt } from './modules/prompt-builder';

function buildSystemPromptWithSoul(soul: string, botName: string, imModule: FeishuIMModule | null): string {
  const base = buildSystemPrompt({ imModule, botName });
  return soul ? `${base}\n\n${soul}` : base;
}

// ================================================================
// 空闲清理
// ================================================================
function cleanupIdleSessions(bots: Bot[]) {
  const IDLE = 30 * 60 * 1000;
  for (const bot of bots) {
    bot.sessionManager.cleanupIdle(IDLE);
  }
}

// ================================================================
// 全局引用
// ================================================================
let _allBots: Bot[] = [];

// ================================================================
// 热重载
// ================================================================
async function gracefulReload(reason: string) {
  console.log(`[Reload] 🔄 ${reason}`);

  const sessionsDir = process.env.HOME + '/Desktop/cc-gateway/sessions';
  const botSnapshots: Record<string, { chats: { chatId: string; lastUsed: number }[] }> = {};
  try {
    if (fs.existsSync(sessionsDir)) {
      for (const botDir of fs.readdirSync(sessionsDir)) {
        const botPath = sessionsDir + '/' + botDir;
        if (!fs.statSync(botPath).isDirectory()) continue;
        const chats: { chatId: string; lastUsed: number }[] = [];
        for (const f of fs.readdirSync(botPath)) {
          if (!f.endsWith('.memory.json')) continue;
          try {
            const m = JSON.parse(fs.readFileSync(botPath + '/' + f, 'utf-8'));
            chats.push({ chatId: m.chatId, lastUsed: m.lastUsed || 0 });
          } catch {}
        }
        chats.sort((a, b) => b.lastUsed - a.lastUsed);
        botSnapshots[botDir] = { chats: chats.slice(0, 3) };
      }
    }
  } catch {}

  const backupPath = __filename + '.backup';
  try { fs.copyFileSync(__filename, backupPath); console.log(`[Reload] 已备份`); } catch {}

  const marker = process.env.HOME + '/Desktop/cc-gateway/sessions/.restore';
  try { fs.writeFileSync(marker, JSON.stringify({ timestamp: Date.now(), reason, bots: botSnapshots })); } catch {}

  await stopAnthropicProxy();
  await stopCodexProxy();
  await stopOpenCodeServer();
  for (const bot of _allBots) bot.im.stop();
  await new Promise(r => setTimeout(r, 1000));

  const child = Bun.spawn([process.execPath, 'run', __filename], {
    env: { ...process.env, CC_RESTORE: '1' },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log(`[Reload] 新进程 PID=${child.pid}，等待启动验证...`);

  await new Promise(r => setTimeout(r, 5000));
  try {
    if (child.exitCode !== undefined) throw new Error(`新进程已退出，exitCode=${child.exitCode}`);
    const net = require('net');
    const checkPort = (port: number) => new Promise<void>((res, rej) => {
      const s = net.createConnection({ port, host: '127.0.0.1' });
      s.setTimeout(2000);
      s.on('connect', () => { s.destroy(); res(); });
      s.on('error', () => rej(new Error(`端口 ${port} 未监听`)));
    });
    await Promise.race([checkPort(18899), checkPort(18900)]);
    console.log('[Reload] 新进程启动成功 ✅');
    process.exit(0);
  } catch (e: any) {
    console.error(`[Reload] ❌ 新进程启动失败: ${e.message}`);
    try { fs.copyFileSync(backupPath, __filename); } catch {}
    try {
      await startAnthropicProxy(18899);
      await startCodexProxy(18900);
      console.log('[Reload] 旧服务已恢复 ✅');
    } catch (e2: any) {
      console.error(`[Reload] 恢复失败: ${e2.message}`);
    }
  }
}

process.on('SIGHUP', () => gracefulReload('SIGHUP'));

// ================================================================
// 主入口
// ================================================================
async function main() {
  const CONFIG_PATH = path.join(__dirname, 'config.json');
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw);
  const DEFAULT_PROJECT_DIR = config.system?.defaultProjectDir || '/Users/keyi/Projects';

  if (config.modelAliases) sharedState.modelAliases = config.modelAliases;
  const { providers: _providers, defaultModel: DEFAULT_MODEL_SPEC } = loadProviders();
  const defaultCfg = getProviderConfig(DEFAULT_MODEL_SPEC);
  if (defaultCfg) sharedState.activeConfig = defaultCfg;

  process.env.ANTHROPIC_BASE_URL = 'http://localhost:18899';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_MODEL;

  let proxyPort = 0, codexPort = 0;
  try { proxyPort = await startAnthropicProxy(18899); } catch (e: any) {
    console.error(`❌ Anthropic Proxy :18899 启动失败: ${e.message}`);
  }
  try { codexPort = await startCodexProxy(18900); } catch (e: any) {
    console.error(`❌ Codex Proxy :18900 启动失败: ${e.message}`);
  }

  try {
    const codexCfg = config.codex || {};
    let apiKey = '';
    for (const name of Object.keys(config.providers || {})) {
      apiKey = config.providers[name].apiKey || '';
      if (apiKey) break;
    }
    initCodexProxyConfig({
      model: codexCfg.model || 'deepseek-v4-pro',
      reportedModel: codexCfg.reportedModel || 'gpt-5.5',
      upstream: codexCfg.upstream || 'https://api.deepseek.com/v1/chat/completions',
      apiKey,
    });
    const ocCfg = config.opencode || {};
    initOpenCodeConfig({
      serverUrl: ocCfg.serverUrl || 'http://localhost:4096',
      defaultModel: ocCfg.defaultModel || { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    });
    const rlCfg = config.rateLimit || {};
    if (rlCfg.enabled !== false) {
      setRateLimitConfig({
        maxRequests: rlCfg.maxRequests || 30,
        windowMs: rlCfg.windowMs || 60000,
      });
    }
  } catch (e: any) {
    console.error(`[Config] 初始化子模块配置失败: ${e.message}`);
  }

  // 自动启动 OpenCode 服务（如果配置了 OpenCode bot）
  const hasOpenCodeBot = (config.bots || []).some((b: any) => b.backend === 'opencode');
  if (hasOpenCodeBot) {
    try {
      await startOpenCodeServer();
    } catch (e: any) {
      console.error(`[OpenCode] 启动失败: ${e.message}`);
    }
  }

  if (!proxyPort && !codexPort) {
    console.error('❌ 所有 Proxy 启动失败，无法继续');
    process.exit(1);
  }

  const botCfgs: any[] = config.bots || [];
  if (botCfgs.length === 0) {
    console.log('💡 config.json 中未配置 bots，仅启动代理');
    return;
  }

  const bots: Bot[] = [];
  for (const c of botCfgs) {
    const appId = c.appId || c.feishu?.appId || '';
    const appSecret = c.appSecret || c.feishu?.appSecret || '';
    if (!appId || !appSecret || appId.startsWith('YOUR_') || appSecret.startsWith('YOUR_')) {
      console.log(`[Config] ⚠️  Bot "${c.name}" 凭证为占位符，跳过`);
      continue;
    }
    bots.push(new Bot({ ...c, appId, appSecret }, config));
  }

  if (bots.length === 0) {
    console.log('⚠️  没有配置有效凭证的 Bot，仅启动代理');
    return;
  }

  _allBots = bots;
  console.log(`\n🚀 CC 路由 v4 — 多 Bot 架构 (SDK 完整接入)`);
  console.log(`   Anthropic: http://localhost:${proxyPort}`);
  console.log(`   Codex:     http://localhost:${codexPort}`);
  console.log(`   Bots:`);

  for (const bot of bots) {
    bot.im.start(async (chatId, text, userId) => {
      console.log(`[${bot.name}] 收到 chat=${chatId.slice(-8)} "${text.slice(0, 80)}"`);
      setCurrentBot({ botName: bot.name, caps: bot.im.getCapabilities(), modelAliases: bot.modelAliases });
      bot.handleMessage(chatId, text, userId).catch((e: Error) =>
        console.error(`[${bot.name}] handleMessage unhandled:`, e.message)
      );
    });
    console.log(`   - ${bot.name}: ${bot.backend} ✅ (appId=${bot.appId.slice(-8)}…) [SDK]`);
  }
  console.log('');

  // 自动生成 workspace.md
  const updateWorkspace = (bot: Bot) => {
    try {
      const dir = bot._soulDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const cwd = bot.defaultCwd;
      let gitBranch = '', gitStatus = '';
      try {
        gitBranch = require('child_process').execSync('git branch --show-current', { cwd, timeout: 3000 }).toString().trim();
        gitStatus = require('child_process').execSync('git status --short', { cwd, timeout: 3000 }).toString().trim();
      } catch {}
      const content = [
        '# 项目环境', '', `- 工作目录: ${cwd}`,
        gitBranch ? `- Git 分支: ${gitBranch}` : '',
        gitStatus ? `- 未提交变更:\n\`\`\`\n${gitStatus.slice(0, 500)}\n\`\`\`` : '',
        '', '> 此文件由 CC Gateway 自动生成，启动时和切换目录时更新。',
      ].filter(Boolean).join('\n');
      fs.writeFileSync(dir + '/workspace.md', content);
    } catch {}
  };
  for (const bot of bots) updateWorkspace(bot);

  // 重启后汇报
  if (process.env.CC_RESTORE === '1') {
    const marker = process.env.HOME + '/Desktop/cc-gateway/sessions/.restore';
    const tryRestore = async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if (!fs.existsSync(marker)) return;
          const data = JSON.parse(fs.readFileSync(marker, 'utf-8'));
          const reason = data.reason || '未知';
          const uptime = Date.now() - (data.timestamp || Date.now());
          const summary = `🔄 CC Gateway 已重启\n原因: ${reason}\n耗时: ${(uptime / 1000).toFixed(1)}s`;
          let sent = 0;
          for (const bot of bots) {
            const snap = data.bots?.[bot.name];
            if (!snap?.chats?.length) continue;
            for (const { chatId } of snap.chats) {
              try { await bot.reply(chatId, summary); sent++; break; }
              catch (e: any) { console.error(`[Restore] ${bot.name} 发送失败(attempt ${attempt}): ${e.message}`); }
            }
          }
          if (sent > 0 || attempt >= 4) { try { fs.unlinkSync(marker); } catch {} return; }
        } catch {}
        await new Promise(r => setTimeout(r, 2000));
      }
    };
    setTimeout(tryRestore, 4000);
  }

  // 空闲清理
  setInterval(() => cleanupIdleSessions(bots), 5 * 60 * 1000);

  // 优雅关闭
  async function gracefulShutdown(signal: string) {
    console.log(`[Shutdown] 收到 ${signal}，优雅关闭中...`);
    for (const bot of bots) bot.im.stop();
    console.log('[Shutdown] 持久化所有 session...');
    for (const bot of bots) {
      for (const [chatId, session] of bot.sessions.entries()) {
        try { bot.sessionManager.persist(bot.name, session); } catch {}
      }
    }
    const DRAIN_TIMEOUT = 30_000;
    const start = Date.now();
    while (activeRequests > 0 && Date.now() - start < DRAIN_TIMEOUT) {
      console.log(`[Shutdown] 等待 ${activeRequests} 个请求完成...`);
      await new Promise(r => setTimeout(r, 500));
    }
    if (activeRequests > 0) {
      console.warn(`[Shutdown] ⚠️ 超时，仍有 ${activeRequests} 个请求未完成`);
    } else {
      console.log('[Shutdown] 所有请求已完成');
    }
    await stopAnthropicProxy();
    await stopCodexProxy();
    console.log('[Shutdown] 所有服务已关闭');
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

process.on('uncaughtException', (err) => { console.error(`[uncaught] ${err.message}`); console.error(err.stack); });

let _rejectionCount = 0;
let _rejectionLastMinute = 0;
process.on('unhandledRejection', (reason, promise) => {
  const now = Date.now();
  if (now - _rejectionLastMinute > 60000) { _rejectionCount = 0; _rejectionLastMinute = now; }
  _rejectionCount++;
  if (_rejectionCount > 5) return;
  if (reason instanceof Error) {
    console.error(`[unhandled #${_rejectionCount}] ${reason.message}`);
    console.error(reason.stack?.split('\n').slice(0, 4).join('\n'));
  } else {
    console.error(`[unhandled #${_rejectionCount}] ${String(reason)} (type=${typeof reason})`);
  }
});

main().catch((err) => { console.error(`[启动失败] ${err.message}`); process.exit(1); });
