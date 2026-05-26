// ================================================================
// Hermes Agent Adapter — 实现 AgentAdapter 接口
// ================================================================
// 职责：对接 Hermes Gateway HTTP API，将 AgentInput 转换为 AgentOutput
// Hermes 启动方式：hermes gateway start
// 默认 API：http://host:3000/api
// ================================================================

import type { AgentAdapter, AgentInput, AgentOutput } from '../core/types';

// ================================================================
// HermesAdapter 配置
// ================================================================

export interface HermesAdapterConfig {
  /** 适配器显示名称 */
  name?: string;
  /** Hermes Gateway 地址（host:port），默认 localhost:3000 */
  host?: string;
  /** API Key（可选） */
  apiKey?: string;
}

// ================================================================
// Hermes Gateway HTTP 客户端
// ================================================================

interface HermesChatResponse {
  response?: string;
  text?: string;
  message?: string;
  error?: string;
}

// ================================================================
// HermesAdapter — 实现 AgentAdapter
// ================================================================

export class HermesAdapter implements AgentAdapter {
  readonly name: string;
  private baseUrl: string;
  private apiKey?: string;

  constructor(config?: HermesAdapterConfig) {
    this.name = config?.name || 'Hermes';
    const host = config?.host || 'localhost:3000';
    this.baseUrl = `http://${host}`;
    this.apiKey = config?.apiKey;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  /**
   * 处理单条用户消息
   *
   * 向 Hermes Gateway 的 /api/chat 端点发送请求。
   * Hermes 内部自行管理 agent loop，返回最终文本响应。
   */
  async handleMessage(input: AgentInput): Promise<AgentOutput> {
    const { text, session, cancelSignal } = input;

    try {
      // 构建请求体
      const body: Record<string, any> = {
        message: text,
      };

      // 传递 session ID 以支持多轮对话
      const sessionAny = session as any;
      const sessionId = sessionAny.backendSessionId || session.metadata?.hermesSessionId;
      if (sessionId) {
        body.session_id = sessionId;
      }

      // 发送请求，支持外部取消信号
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: cancelSignal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          error: `Hermes API error: ${res.status} ${res.statusText}${errText ? ` — ${errText}` : ''}`,
        };
      }

      const data = (await res.json()) as HermesChatResponse;

      // 保存 session ID 供后续多轮对话
      if ((data as any).session_id) {
        sessionAny.backendSessionId = (data as any).session_id;
        session.metadata.hermesSessionId = (data as any).session_id;
      }

      const responseText = data.response || data.text || data.message || '';

      if (!responseText) {
        return { error: data.error || 'Hermes returned empty response' };
      }

      return { text: responseText };
    } catch (err: any) {
      // AbortError 来自 cancelSignal，不是真正的错误
      if (err?.name === 'AbortError') {
        if (cancelSignal?.aborted) {
          console.log('[HermesAdapter] Task cancelled by user');
          return { text: 'Task cancelled' };
        }
      }
      return { error: `Hermes connection error: ${err.message}` };
    }
  }

  /**
   * 健康检查：探测 Hermes Gateway /api/status 端点
   */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/status`, {
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * 取消当前任务：调用 Hermes Gateway /api/stop 端点
   */
  async cancel(_sessionId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/stop`, {
        method: 'POST',
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // 忽略取消失败
    }
  }
}
