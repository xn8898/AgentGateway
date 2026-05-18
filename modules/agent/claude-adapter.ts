// ================================================================
// Claude Agent SDK Adapter — 实现 SDK AgentAdapter 接口
// ================================================================
// 职责：对接 Claude Agent SDK，将 AgentInput 转换为 AgentOutput
// 不负责：session 管理、统计、格式化、错误处理（由 SDK Runtime 接管）
// ================================================================

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentAdapter, AgentInput, AgentOutput, Session, buildAttachmentHint } from '../core/types';
import { buildSystemPrompt } from '../prompt-builder';

// ================================================================
// ClaudeAdapter 上下文
// ================================================================

export interface ClaudeAdapterContext {
  /** 用于构建 system prompt（IM 能力 + bot 名 + soul） */
  imModule?: { getCapabilities(): any } | null;
  botName: string;
  /** 模型别名映射（sonnet/opus/haiku → 实际供应商/模型） */
  modelAliases: Record<string, string>;
}

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

function extractToolCalls(msg: SDKMessage): Array<{ name: string; summary: string }> {
  if (msg.type !== 'assistant') return [];
  const content = (msg as any).message?.content;
  if (!Array.isArray(content)) return [];
  const results: Array<{ name: string; summary: string }> = [];
  for (const block of content) {
    if (block.type === 'tool_use' && block.name) {
      const input = block.input || {};
      let summary = '';
      if (['Read', 'Edit', 'Write'].includes(block.name) && input.file_path) {
        const p = String(input.file_path);
        summary = p.includes('/') ? p.split('/').pop()! : p;
      } else if (block.name === 'Bash' && input.command) {
        summary = String(input.command).trim().slice(0, 60);
      }
      results.push({ name: block.name, summary });
    }
  }
  return results;
}

// ================================================================
// ClaudeAdapter — 实现 AgentAdapter
// ================================================================

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'Claude Agent SDK';
  private ctx: ClaudeAdapterContext;

  constructor(ctx: ClaudeAdapterContext) {
    this.ctx = ctx;
  }

  /**
   * 处理单条用户消息
   * 
   * 接收 AgentInput，调用 Claude SDK，返回 AgentOutput
   * Session 管理、统计、格式化由 SDK Runtime 负责
   */
  async handleMessage(input: AgentInput): Promise<AgentOutput> {
    const { text, session, workingDir, model, systemPrompt: overrideSystemPrompt } = input;
    const sessionAny = session as any; // 向后兼容：访问旧字段

    // 确定模型名
    const modelName = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
    const aliases = this.ctx.modelAliases;

    // 附件信息注入：让 Agent 知道用户发送了附件（图片/文件/语音）及本地路径
    let effectiveText = text;
    if (input.attachments && input.attachments.length > 0) {
      effectiveText = buildAttachmentHint(input.attachments) + '\n\n---\n\n' + effectiveText;
    }

    // Claude SDK 环境变量（走本地 :18899 代理）
    const customEnv: Record<string, string> = {
      ...process.env,
      ANTHROPIC_BASE_URL: 'http://localhost:18899',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: resolveAlias(aliases.sonnet || ''),
      ANTHROPIC_DEFAULT_OPUS_MODEL: resolveAlias(aliases.opus || ''),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: resolveAlias(aliases.haiku || ''),
    };

    // 构建查询选项
    const queryOptions: any = {
      cwd: workingDir,
      maxTurns: 50,
      model: modelName,
      permissionMode: sessionAny.permissionMode || 'bypassPermissions',
      persistSession: true,
    };

    // System Prompt（优先使用传入的，否则自行构建）
    if (overrideSystemPrompt) {
      queryOptions.systemPrompt = overrideSystemPrompt;
    } else {
      queryOptions.systemPrompt = buildSystemPrompt({
        imModule: this.ctx.imModule || null,
        botName: this.ctx.botName,
      });
    }

    // 恢复/创建 SDK 会话 ID
    const shouldClear = session.startFresh;
    session.startFresh = false;
    const sdkSessionId = shouldClear ? undefined : (session.metadata?.sdkSessionId || sessionAny.sdkSessionId);
    if (sdkSessionId) {
      queryOptions.resume = sdkSessionId;
    } else {
      queryOptions.sessionId = crypto.randomUUID();
    }

    console.log(`[ClaudeAdapter] query model=${modelName} cwd=${workingDir} resume=${!!sdkSessionId}`);

    // 执行 Claude SDK 查询（流式）
    const q = query({
      prompt: [{
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: effectiveText }] },
      }],
      options: queryOptions,
      env: customEnv,
    });

    let fullResponse = '';
    const toolCalls: Array<{ name: string; summary: string }> = [];

    for await (const msg of q) {
      const msgAny = msg as any;

      // 捕获 SDK session ID（存入 metadata 供 SDK Runtime 持久化）
      if (msgAny.session_id && !session.metadata?.sdkSessionId) {
        session.metadata.sdkSessionId = msgAny.session_id;
        // 向后兼容：也写回旧字段
        sessionAny.sdkSessionId = msgAny.session_id;
      }

      // 提取文本
      const extractedText = extractText(msg);
      if (extractedText) fullResponse += extractedText;

      // 提取工具调用
      const calls = extractToolCalls(msg);
      toolCalls.push(...calls);

      // 处理最终结果
      if (msg.type === 'result') {
        const result = msgAny;

        if (result.subtype === 'error' || result.subtype === 'cancelled') {
          throw new Error(result.error || result.result || '未知错误');
        }

        const usage = {
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
          costUSD: result.total_cost_usd || 0,
          durationMs: result.duration_ms || 0,
          numTurns: result.num_turns || 0,
        };

        const responseText = fullResponse || `✅ 已完成 (${toolCalls.length} 步操作)`;

        return {
          text: responseText,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage,
        };
      }
    }

    // 流结束但没有 result 消息
    return {
      text: fullResponse || '✅ 完成',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
}
