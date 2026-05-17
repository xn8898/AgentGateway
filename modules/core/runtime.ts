// ================================================================
// AgentRuntime — 消息处理中枢
// ================================================================
// 协调 Session / Stats / Error / Config，调用 Agent 适配器处理消息
// 
// processMessage 流程：
//   1. 获取 session（通过 sessionManager.getOrCreate）
//   2. 检查 startFresh → 清除旧 backendSessionId
//   3. statsTracker.resetForCall()
//   4. ctx.sendProgress("💭 思考中...")
//   5. adapter.handleMessage(input) ← Agent 适配器
//   6. 成功 → statsTracker.accumulate() + ctx.reply() 或 ctx.sendBlocks()
//   7. 失败 → errorHandler.handle() → 可能 retry/fallback/reply
//   8. sessionManager.persist()
// ================================================================

import type {
  AgentAdapter,
  AgentInput,
  AgentOutput,
  MessageContext,
  RuntimeConfig,
  Session,
  ErrorAction,
  ErrorContext,
} from './types';
import { parseToBlocks } from '../capabilities';
import { DEFAULT_TERMINAL_CAPS } from '../prompt-builder';

// ================================================================
// AgentRuntime
// ================================================================

export class AgentRuntime {
  private adapters = new Map<string, AgentAdapter>();
  private config: RuntimeConfig;

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  /**
   * 注册 Agent 适配器
   * @param backend 后端标识 ('claude' | 'codex' | 'opencode' 等)
   * @param adapter Agent 适配器实例
   */
  registerAdapter(backend: string, adapter: AgentAdapter): void {
    this.adapters.set(backend, adapter);
    console.log(`[Runtime] 注册适配器: ${backend} → ${adapter.name}`);
  }

  /**
   * 获取已注册的适配器
   */
  getAdapter(backend: string): AgentAdapter | undefined {
    return this.adapters.get(backend);
  }

  /**
   * 处理用户消息
   * 
   * @param ctx 消息处理上下文
   * @param adapter Agent 适配器
   * @param botName Bot 名称（用于 session 隔离）
   */
  async processMessage(
    ctx: MessageContext,
    adapter: AgentAdapter,
    botName: string
  ): Promise<void> {
    const startTime = Date.now();
    let attempt = 0;
    const maxRetries = 2;

    while (attempt <= maxRetries) {
      attempt++;

      try {
        // 1. 获取 session
        const session = await this.config.sessionManager.getOrCreate(
          botName,
          ctx.chatId,
          ctx.userId
        );

        // 2. 检查 startFresh → 清除旧 backendSessionId
        if (session.startFresh) {
          session.backendSessionId = undefined;
          session.metadata = {};
          session.startFresh = false;
          session.running = false;
          console.log(`[Runtime] startFresh: 清除 ${ctx.chatId} 旧会话`);
        }

        // 3. 重置统计
        this.config.statsTracker.resetForCall(session);

        // 4. 发送进度提示
        await ctx.sendProgress('💭 思考中...');

        session.running = true;

        // 5. 调用 Agent 适配器
        const input: AgentInput = {
          chatId: ctx.chatId,
          text: ctx.text,
          session,
          workingDir: ctx.workingDir,
          systemPrompt: ctx.systemPrompt,
          model: ctx.model,
        };

        const output = await adapter.handleMessage(input);

        // 6. 处理成功结果
        session.running = false;

        if (output.error) {
          throw new Error(output.error);
        }

        // 累加统计
        if (output.usage) {
          const duration = Date.now() - startTime;
          this.config.statsTracker.accumulate(session, {
            inputTokens: output.usage.inputTokens,
            outputTokens: output.usage.outputTokens,
            costUSD: output.usage.costUSD,
            durationMs: output.usage.durationMs || duration,
            numTurns: output.usage.numTurns,
          });
        }

        // 发送回复 — 优先用 sendBlocks（parseToBlocks → 富文本渲染）
        if (output.text) {
          if (ctx.sendBlocks) {
            const caps = ctx.imCaps || DEFAULT_TERMINAL_CAPS;
            const blocks = parseToBlocks(output.text, caps);
            if (blocks.length === 1 && blocks[0].type === 'text') {
              await ctx.reply(output.text);
            } else {
              await ctx.sendBlocks(blocks);
            }
          } else {
            await ctx.reply(output.text);
          }
        }

        // 持久化 session
        this.config.sessionManager.persist(botName, session);

        return; // 成功，退出

      } catch (error: any) {
        console.error(`[Runtime] 处理消息失败 (attempt ${attempt}): ${error.message}`);

        // 7. 错误处理
        const errorCtx: ErrorContext = {
          chatId: ctx.chatId,
          backend: adapter.name,
          attempt,
        };

        const action = await this.config.errorHandler.handle(ctx.chatId, error, errorCtx);

        if (action.type === 'retry') {
          console.log(`[Runtime] 重试 ${adapter.name} 调用`);
          continue;
        }

        if (action.type === 'fallback') {
          console.log(`[Runtime] 降级到 ${action.adapter}`);
          // Phase 2 实现 fallback 逻辑
          const fallbackAdapter = this.adapters.get(action.adapter);
          if (fallbackAdapter) {
            return this.processMessage(ctx, fallbackAdapter, botName);
          }
        }

        if (action.type === 'reply') {
          await ctx.reply(action.message);
        }

        // 持久化 session（即使失败也要保存统计）
        try {
          const session = await this.config.sessionManager.getOrCreate(
            botName,
            ctx.chatId,
            ctx.userId
          );
          session.running = false;
          this.config.sessionManager.persist(botName, session);
        } catch {}

        return; // 不再重试
      }
    }
  }

  /**
   * 取消正在进行的会话
   */
  async cancelSession(adapterName: string, sessionId: string): Promise<void> {
    const adapter = this.adapters.get(adapterName);
    if (adapter?.cancel) {
      await adapter.cancel(sessionId);
    }
  }

  /**
   * 健康检查
   */
  async healthCheck(backend: string): Promise<boolean> {
    const adapter = this.adapters.get(backend);
    if (adapter?.healthCheck) {
      return adapter.healthCheck();
    }
    return true; // 默认认为健康
  }
}
