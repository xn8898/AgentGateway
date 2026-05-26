// ================================================================
// RunnerAdapter — Gateway-side client for remote Runner service
// ================================================================
// 部署在 Gateway 侧，通过 HTTP/SSE 与远程 Runner 通信
// 发送命令 via HTTP POST，接收实时输出 via SSE 流
// ================================================================

import type { AgentAdapter, AgentInput, AgentOutput, RunnerSSEEvent } from '../core/types';

// ================================================================
// 配置
// ================================================================

export interface RunnerAdapterConfig {
  /** 适配器显示名称 */
  name?: string;
  /** Runner 地址（host:port） */
  host: string;
  /** Agent 类型（claude-code, opencode） */
  agentType: string;
  /** API Key */
  apiKey?: string;
  /** Approval 回调 */
  onApproval?: (req: { sessionId: string; prompt: string; options: string[]; detail: string }) => void;
}

// ================================================================
// RunnerAdapter — 实现 AgentAdapter
// ================================================================

/**
 * Runner 客户端适配器
 * 部署在 Gateway 侧，通过 HTTP/SSE 与远程 Runner 通信
 */
export class RunnerAdapter implements AgentAdapter {
  readonly name: string;
  private host: string;
  private agentType: string;
  private apiKey?: string;
  private onApproval?: RunnerAdapterConfig['onApproval'];

  constructor(config: RunnerAdapterConfig) {
    this.name = config.name || `runner-${config.host}`;
    this.host = config.host;
    this.agentType = config.agentType;
    this.apiKey = config.apiKey;
    this.onApproval = config.onApproval;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['X-API-Key'] = this.apiKey;
    return h;
  }

  // ==============================================================
  // handleMessage — 核心方法，发送命令并处理 SSE 流
  // ==============================================================

  async handleMessage(input: AgentInput): Promise<AgentOutput> {
    try {
      const res = await fetch(`http://${this.host}/run`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          command: this.agentType,
          sessionId: input.session.backendSessionId || undefined,
          input: input.text,
        }),
        signal: input.cancelSignal,
      });

      if (!res.ok) {
        return { error: `Runner error: ${res.status}` };
      }

      return this.processSSEStream(res, input);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { text: 'Cancelled', error: 'cancelled' };
      }
      return { error: `Runner connection error: ${err.message}` };
    }
  }

  // ==============================================================
  // SSE 流处理
  // ==============================================================

  private async processSSEStream(res: Response, input: AgentInput): Promise<AgentOutput> {
    const reader = res.body?.getReader();
    if (!reader) return { error: 'No response body' };

    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let sessionId = input.session.backendSessionId || '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          try {
            const event: RunnerSSEEvent = JSON.parse(data);

            switch (event.type) {
              case 'output':
                fullText += event.text || '';
                await input.sendProgress?.(event.text || '');
                break;

              case 'approval_required':
                sessionId = event.sessionId || sessionId;
                this.onApproval?.({
                  sessionId,
                  prompt: event.prompt || '',
                  options: event.options || [],
                  detail: event.detail || '',
                });
                break;

              case 'done':
                break;

              case 'error':
                return { text: fullText, error: event.text || 'Runner error' };
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { text: fullText, error: 'cancelled' };
      }
      throw err;
    }

    return { text: fullText };
  }

  // ==============================================================
  // healthCheck — 探测 Runner /health 端点
  // ==============================================================

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`http://${this.host}/health`, {
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ==============================================================
  // cancel — 取消正在运行的会话
  // ==============================================================

  async cancel(sessionId?: string): Promise<void> {
    await fetch(`http://${this.host}/cancel`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ sessionId }),
    });
  }

  // ==============================================================
  // sendApprovalResponse — 转发用户确认结果到 Runner
  // ==============================================================

  async sendApprovalResponse(sessionId: string, answer: string): Promise<void> {
    await fetch(`http://${this.host}/approval`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ sessionId, answer }),
    });
  }
}
