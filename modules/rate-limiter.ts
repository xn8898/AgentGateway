// 滑动窗口请求限流器
// per-chatId 滑动窗口，防止短时间内发送过多消息

interface WindowEntry {
  timestamps: number[];
}

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const windows = new Map<string, WindowEntry>();

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 30,
  windowMs: 60_000,
};

let currentConfig: RateLimitConfig = { ...DEFAULT_CONFIG };

export function setRateLimitConfig(cfg: RateLimitConfig) {
  currentConfig = cfg;
}

export function checkRateLimit(chatId: string): { allowed: boolean; retryAfter?: number; remaining?: number } {
  const now = Date.now();
  let entry = windows.get(chatId);

  if (!entry) {
    entry = { timestamps: [] };
    windows.set(chatId, entry);
  }

  // 清理窗口外的时间戳
  entry.timestamps = entry.timestamps.filter(ts => now - ts < currentConfig.windowMs);

  if (entry.timestamps.length >= currentConfig.maxRequests) {
    const oldestInWindow = entry.timestamps[0];
    const retryAfter = Math.ceil((oldestInWindow + currentConfig.windowMs - now) / 1000);
    return { allowed: false, retryAfter, remaining: 0 };
  }

  entry.timestamps.push(now);

  // 定期清理过期条目（低概率触发，不影响性能）
  if (Math.random() < 0.01) {
    for (const [id, e] of windows.entries()) {
      e.timestamps = e.timestamps.filter(ts => now - ts < currentConfig.windowMs);
      if (e.timestamps.length === 0) windows.delete(id);
    }
  }

  return {
    allowed: true,
    remaining: currentConfig.maxRequests - entry.timestamps.length,
  };
}
