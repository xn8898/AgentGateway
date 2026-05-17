// ================================================================
// StatsTracker — 调用统计追踪
// ================================================================
// 统一管理 token/cost/duration 统计，替代各 Agent 中的重复逻辑
// ================================================================

import type { Session, StatsTracker, CallStats } from './types';

// ================================================================
// DefaultStatsTracker
// ================================================================

export class DefaultStatsTracker implements StatsTracker {
  /**
   * 重置单次调用的统计（在调用开始时）
   */
  resetForCall(session: Session): void {
    session.stats.calls += 1;
  }

  /**
   * 累加统计（在调用成功后）
   */
  accumulate(session: Session, usage: {
    inputTokens: number;
    outputTokens: number;
    costUSD?: number;
    durationMs?: number;
    numTurns?: number;
  }): void {
    session.stats.totalInputTokens += usage.inputTokens || 0;
    session.stats.totalOutputTokens += usage.outputTokens || 0;
    session.stats.totalCostUSD += usage.costUSD || 0;
    session.stats.totalDurationMs += usage.durationMs || 0;
    if (usage.numTurns) {
      session.stats.totalTurns += usage.numTurns;
    }
    session.lastUsed = Date.now();
  }

  /**
   * 生成统计摘要字符串（用于发送给用户）
   */
  formatSummary(session: Session): string {
    const s = session.stats;
    const parts: string[] = [];

    // 调用次数
    parts.push(`📊 调用 ${s.calls} 次`);

    // Token 用量
    const totalTokens = s.totalInputTokens + s.totalOutputTokens;
    if (totalTokens > 0) {
      parts.push(`Token ${this.formatTokens(totalTokens)}`);
    }

    // 成本
    if (s.totalCostUSD > 0) {
      parts.push(`费用 $${s.totalCostUSD.toFixed(4)}`);
    }

    // 耗时
    if (s.totalDurationMs > 0) {
      parts.push(`耗时 ${this.formatDuration(s.totalDurationMs)}`);
    }

    return parts.join(' | ');
  }

  /** 格式化 Token 数量 */
  private formatTokens(count: number): string {
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(1)}M`;
    }
    if (count >= 1_000) {
      return `${(count / 1_000).toFixed(1)}K`;
    }
    return `${count}`;
  }

  /** 格式化时长 */
  private formatDuration(ms: number): string {
    const secs = ms / 1000;
    if (secs >= 3600) {
      return `${(secs / 3600).toFixed(1)}h`;
    }
    if (secs >= 60) {
      return `${(secs / 60).toFixed(1)}m`;
    }
    return `${secs.toFixed(0)}s`;
  }
}
