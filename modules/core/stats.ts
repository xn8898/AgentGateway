// ================================================================
// StatsTracker — call statistics tracking
// ================================================================
// Unified token/cost/duration stats management across agents
// ================================================================

import type { Session, StatsTracker, CallStats } from './types';

// ================================================================
// DefaultStatsTracker
// ================================================================

export class DefaultStatsTracker implements StatsTracker {
  /**
   * Reset call stats (at call start)
   */
  resetForCall(session: Session): void {
    session.stats.calls += 1;
  }

  /**
   * Accumulate stats (after call success)
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
   * Generate stats summary string (sent to user)
   */
  formatSummary(session: Session): string {
    const s = session.stats;
    const parts: string[] = [];

    // Call count
    parts.push(`📊 ${s.calls} calls`);

    // Token usage
    const totalTokens = s.totalInputTokens + s.totalOutputTokens;
    if (totalTokens > 0) {
      parts.push(`Token ${this.formatTokens(totalTokens)}`);
    }

    // Cost
    if (s.totalCostUSD > 0) {
      parts.push(`Cost $${s.totalCostUSD.toFixed(4)}`);
    }

    // Duration
    if (s.totalDurationMs > 0) {
      parts.push(`Duration ${this.formatDuration(s.totalDurationMs)}`);
    }

    return parts.join(' | ');
  }

  /** Format token count */
  private formatTokens(count: number): string {
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(1)}M`;
    }
    if (count >= 1_000) {
      return `${(count / 1_000).toFixed(1)}K`;
    }
    return `${count}`;
  }

  /** Format duration */
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
