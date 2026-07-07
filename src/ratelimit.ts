// ratelimit.ts - fixed-window rate limiting, per token
//
// In-memory is fine since sekimori is single-process by design (section 7).

export interface RateLimitCheck {
  allowed: boolean;
  /** When rejected, seconds until the next window (rounded up, minimum 1). */
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

  /** Decides whether to allow this request for the token, and counts it. */
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
