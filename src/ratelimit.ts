// ratelimit.ts — 固定ウィンドウのレート制限（トークンごと）
//
// 単一プロセス前提のためインメモリでよい（§7）。

export interface RateLimitCheck {
  allowed: boolean;
  /** 拒否時、次のウィンドウまでの秒数（切り上げ、最小 1）。 */
  retryAfterSeconds?: number;
}

const WINDOW_MS = 60_000;

interface WindowEntry {
  windowStart: number;
  count: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, WindowEntry>();

  constructor(private readonly requestsPerMinute: number) {}

  /** トークンの今回のリクエストを許可するかどうかを判定し、カウントする。 */
  check(tokenId: string, now: number = Date.now()): RateLimitCheck {
    const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const entry = this.windows.get(tokenId);

    if (!entry || entry.windowStart !== windowStart) {
      this.windows.set(tokenId, { windowStart, count: 1 });
      return { allowed: true };
    }

    if (entry.count >= this.requestsPerMinute) {
      const retryAfterMs = windowStart + WINDOW_MS - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    entry.count += 1;
    return { allowed: true };
  }
}
