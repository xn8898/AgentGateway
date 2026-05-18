// OpenCode Agent 模块
// 对接 opencode serve HTTP API，通过 :18899 Anthropic Proxy 调 Provider
//
// 设计：薄模块 — oc serve 管理 session/工具/provider，Gateway 只做 IM 翻译

import type { AgentContext, SessionData } from '../types';
import { parseToBlocks } from '../capabilities';
import { resolveCapabilities, buildSystemPrompt } from '../prompt-builder';
import { calculateCost } from '../proxy/anthropic-proxy';

// ================================================================
// 配置（从 config.json 读取）
// ================================================================

interface OpenCodeConfig {
  serverUrl: string;
  defaultModel: { providerID: string; modelID: string };
}

let _ocConfig: OpenCodeConfig | null = null;

export function initOpenCodeConfig(cfg: OpenCodeConfig) {
  _ocConfig = cfg;
}

function getOcConfig(): OpenCodeConfig {
  if (!_ocConfig) {
    try {
      const fs = require('fs');
      const raw = JSON.parse(fs.readFileSync(process.env.HOME + '/Desktop/imtoagent/config.json', 'utf-8'));
      const oc = raw.opencode || {};
      _ocConfig = {
        serverUrl: oc.serverUrl || 'http://localhost:4096',
        defaultModel: oc.defaultModel || { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
      };
    } catch {
      _ocConfig = {
        serverUrl: 'http://localhost:4096',
        defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
      };
    }
  }
  return _ocConfig;
}

const OC_SERVER_URL = () => getOcConfig().serverUrl;
const OC_DEFAULT_MODEL = () => getOcConfig().defaultModel;

// ================================================================
// OpenCode Server HTTP 客户端
// ================================================================

interface OcMessagePart {
  type: string;
  text?: string;
  tool_call?: { name: string; arguments: Record<string, any> };
  tool_result?: { content: string };
}

interface OcMessage {
  info: { id: string; role: string; model?: string };
  parts: OcMessagePart[];
}

async function ocCreateSession(title: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 300_000);
  const res = await fetch(`${OC_SERVER_URL()}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    signal: ac.signal,
  }).finally(() => clearTimeout(timer));
  if (!res.ok) throw new Error(`oc create session: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.id;
}

async function ocSendPrompt(
  sessionId: string,
  initialText: string,
  system?: string,
  onTool?: (name: string, args: Record<string, any>) => void
): Promise<{ response: string }> {
  const MAX_TURNS = 50;
  const TURN_TIMEOUT = 300_000;
  const startTime = Date.now();
  const MAX_DURATION = 600_000; // 10 分钟总超时

  let promptText = initialText;
  let accumulatedResponse = '';
  let turn = 0;

  while (turn < MAX_TURNS) {
    if (Date.now() - startTime > MAX_DURATION) {
      console.error('[OpenCode] 任务总超时 (10min)');
      break;
    }
    turn++;

    const body: any = {
      model: OC_DEFAULT_MODEL(),
      parts: [{ type: 'text', text: promptText }],
    };
    if (turn === 1 && system) body.system = system;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TURN_TIMEOUT);
    const res = await fetch(`${OC_SERVER_URL()}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) throw new Error(`oc send prompt: ${res.status} ${await res.text()}`);

    const data: OcMessage = await res.json();
    let hasToolCall = false;

    for (const part of data.parts || []) {
      if (part.type === 'text' && part.text) {
        accumulatedResponse += (accumulatedResponse ? '\n' : '') + part.text;
      } else if (part.type === 'tool_call' && part.tool_call) {
        hasToolCall = true;
        if (onTool) onTool(part.tool_call.name, part.tool_call.arguments);
      }
    }

    // 纯文本回复或没有 tool_call → 任务完成
    if (!hasToolCall) break;

    // 有 tool_call，继续推进（空 prompt）
    promptText = '继续';
  }

  return { response: accumulatedResponse };
}

async function ocDeleteSession(sessionId: string): Promise<void> {
  await fetch(`${OC_SERVER_URL()}/session/${sessionId}`, { method: 'DELETE' }).catch(() => {});
}

async function ocHealthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${OC_SERVER_URL()}/global/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// ================================================================
// Agent 模块类
// ================================================================
export class OpenCodeAgentModule {
  private ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  async handleMessage(chatId: string, text: string, session: SessionData) {
    const ctx = this.ctx;
    console.log(`[${ctx.name}] OpenCode chat=${chatId.slice(-8)}`);

    // 工具回调
    const onTool = (name: string, args: Record<string, any>) => {
      const summary = args.command || args.cmd || args.query || JSON.stringify(args).slice(0, 80);
      ctx.addToolLog(chatId, { name, summary });
    };

    try {
      // ① Plan 模式处理
      let effectiveText = text;
      if (session.codexMode === 'plan') {
        effectiveText = `[模式: 先计划后执行] 请先制定一个清晰的计划，等我确认后再执行。用户请求: ${text}`;
      }

      // ② 清理标记
      const shouldClear = session.startFresh;
      session.startFresh = false;

      // ③ 获取或创建 OpenCode session
      if (shouldClear || !session.ocSessionId) {
        if (session.ocSessionId) {
          await ocDeleteSession(session.ocSessionId);
          console.log(`[${ctx.name}] 已清除 oc session=${session.ocSessionId.slice(-8)}`);
        }
        session.ocSessionId = await ocCreateSession(chatId);
        console.log(`[${ctx.name}] 新建 oc session=${session.ocSessionId.slice(-8)}`);
      }

      // ④ 发送进度提示
      await ctx.sendProgress(chatId, '💭 思考中...');

      // ④.⑤ 构建系统提示词
      const systemPrompt = buildSystemPrompt({
        imModule: ctx.imModule || null,
        botName: ctx.name,
      });
      console.log(`[${ctx.name}] 📝 system prompt built (${systemPrompt.length} chars, bot=${ctx.name})`);

      // ⑤ 发送 prompt（多轮循环）
      const { response } = await ocSendPrompt(
        session.ocSessionId,
        effectiveText,
        systemPrompt,
        onTool,
      );

      // ⑥ 刷新工具日志
      ctx.flushToolLog(chatId);

      // ⑦ 输出
      if (response) {
        await ctx.sendFormattedReply(chatId, response);
      } else {
        await ctx.reply(chatId, '✅ 已完成');
      }

      // ⑧ 统计
      const { sharedState } = await import('../proxy/anthropic-proxy');
      const lastUsage = sharedState.lastCallUsage;
      if (lastUsage && (lastUsage.inputTokens > 0 || lastUsage.outputTokens > 0)) {
        const cost = calculateCost(ctx.activeModel, lastUsage.inputTokens, lastUsage.outputTokens);
        ctx.accumulateStats(session, { ...lastUsage, costUSD: cost });
        await ctx.sendProgress(chatId,
          `输入 ${lastUsage.inputTokens.toLocaleString()} Token\n输出 ${lastUsage.outputTokens.toLocaleString()} Token\n费用 $${cost.toFixed(4)}`);
      }

      // ⑨ 持久化会话
      ctx.persistSession(chatId, session);

    } catch (err: any) {
      console.error(`[${ctx.name}] OpenCode 错误: ${err.message}`);
      await ctx.reply(chatId, `⚠️ OpenCode 出错：${err.message}`);
    }
  }

  /** 健康检查 */
  async healthCheck(): Promise<boolean> {
    return ocHealthCheck();
  }
}
