// Claude Agent 模块
// 对接 Claude Agent SDK，通过 :18899 Proxy 调用 Provider

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentContext } from '../types';
import { parseToBlocks, type UnifiedBlock } from '../capabilities';
import { buildSystemPrompt, resolveCapabilities } from '../prompt-builder';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// ================================================================
// 工具函数
// ================================================================
function resolveAlias(modelSpec: string): string {
  const i = modelSpec.indexOf('/');
  return i >= 0 ? modelSpec.slice(i + 1) : modelSpec;
}

function extractText(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') return null;
  const content = (msg as any).message?.content;
  if (!Array.isArray(content)) return null;
  return content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || null;
}

function extractToolInfo(msg: SDKMessage): { name: string; summary: string } | null {
  if (msg.type !== 'assistant') return null;
  const content = (msg as any).message?.content;
  if (!Array.isArray(content)) return null;
  const tool = content.find((b: any) => b.type === 'tool_use');
  if (!tool?.name) return null;
  const input = tool.input || {};
  let summary = '';
  if (['Read','Edit','Write'].includes(tool.name) && input.file_path) {
    const p = String(input.file_path);
    summary = p.includes('/') ? p.split('/').pop()! : p;
  } else if (tool.name === 'Bash' && input.command) {
    summary = String(input.command).trim().slice(0, 60);
  }
  return { name: tool.name, summary };
}

// ================================================================
// Claude 模块类
// ================================================================

/**
 * 注意：此模块目前依赖宿主 Bot 实例的方法（reply/sendProgress/addToolLog 等）。
 * Phase 2 第一步先原样提取，后续逐步解耦为干净接口。
 */
export class ClaudeAgentModule {
  private ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  async handleMessage(chatId: string, text: string, session: any) {
    session.generator.push({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text }] },
    });
    if (!session.running) this._startLoop(chatId);
  }

  private async _startLoop(chatId: string) {
    const ctx = this.ctx;
    const session = ctx.sessions.get(chatId);
    if (!session || session.running) return;
    session.running = true;
    console.log(`[${ctx.name}] Claude loop started chat=${chatId.slice(-8)}`);

    try {
      const modelSpec = ctx.activeModel;
      const modelName = modelSpec.slice(modelSpec.indexOf('/') + 1);
      const aliases = ctx.modelAliases;
      const customEnv: Record<string, string> = {
        ...process.env,
        ANTHROPIC_BASE_URL: 'http://localhost:18899',
        ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: resolveAlias(aliases.sonnet),
        ANTHROPIC_DEFAULT_OPUS_MODEL: resolveAlias(aliases.opus),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: resolveAlias(aliases.haiku),
      };

      const queryOptions: any = {
        cwd: session.cwd || ctx.defaultCwd,
        maxTurns: 50, model: modelName,
        permissionMode: session.permissionMode || 'bypassPermissions',
        persistSession: true,
      };
      if (session.sdkSessionId) {
        queryOptions.resume = session.sdkSessionId;
      } else {
        queryOptions.sessionId = crypto.randomUUID();
      }

      const botName = ctx.name;
      const systemPrompt = buildSystemPrompt({
        imModule: ctx.imModule || null,
        botName,
      });
      console.log(`[Claude] 📝 system prompt built (${systemPrompt.length} chars, bot=${botName})`);
      queryOptions.systemPrompt = systemPrompt;

      const q = query({
        prompt: session.generator.generate(),
        options: queryOptions, env: customEnv,
      });

      let fullResponse = '', toolCalls = 0;
      let callInput = 0, callOutput = 0, callCost = 0, callDur = 0;

      for await (const msg of q) {
        const msgAny = msg as any;
        if (msgAny.session_id && !session.sdkSessionId) {
          session.sdkSessionId = msgAny.session_id;
          ctx.persistSession(chatId, session);
        }
        const text = extractText(msg);
        if (text) fullResponse += text;
        const toolInfo = extractToolInfo(msg);
        if (toolInfo) { toolCalls++; ctx.addToolLog(chatId, toolInfo); }

        if (msg.type === 'result') {
          const result = msg as any;
          callInput = result.usage?.input_tokens || 0;
          callOutput = result.usage?.output_tokens || 0;
          callCost = result.total_cost_usd || 0;
          callDur = result.duration_ms || 0;

          ctx.accumulateStats(session, {
            inputTokens: callInput, outputTokens: callOutput,
            costUSD: callCost, durationMs: callDur,
            numTurns: result.num_turns || 0,
          });

          if (result.subtype === 'error' || result.subtype === 'cancelled') {
            await ctx.reply(chatId, `❌ ${result.error || result.result || 'Unknown error'}`);
          } else if (fullResponse) {
            await ctx.sendFormattedReply(chatId, fullResponse);
          } else {
            await ctx.reply(chatId, `✅ Completed (${toolCalls} steps)`);
          }

          ctx.flushToolLog(chatId);
          const costStr = callCost > 0 ? `Cost $${callCost.toFixed(4)}\n` : '';
          await ctx.sendProgress(chatId,
            `✅ Completed (${toolCalls} steps)\nInput ${callInput.toLocaleString()} Token\nOutput ${callOutput.toLocaleString()} Token\n${costStr}Duration ${(callDur/1000).toFixed(1)}s`);
          fullResponse = ''; toolCalls = 0;
        }
      }
    } catch (e: any) {
      console.error(`[${ctx.name}] Claude error: ${e.message}`);
      await ctx.reply(chatId, `❌ ${e.message}`);
    } finally {
      session.running = false;
      session.generator.close();
      ctx.persistSession(chatId, session);
    }
  }
}
