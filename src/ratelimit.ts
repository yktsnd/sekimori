// ratelimit.ts - rolling-window rate limiting + active-request cap, per token
//
// In-memory is fine since sekimori is single-process by design (section 7).

export interface RateLimitCheck {
  allowed: boolean;
  /** When rejected, seconds until the next window (rounded up, minimum 1). */
  retryAfterSeconds?: number;
}

const WINDOW_MS = 60_000;
export const MAX_REQUESTS_PER_MINUTE = 10_000;
export const MAX_GLOBAL_ACTIVE_REQUESTS = 256;

export class RateLimiter {
  private readonly requests = new Map<string, number[]>();
  private readonly active = new Map<string, number>();
  private globalActive = 0;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly globalActiveLimit = MAX_GLOBAL_ACTIVE_REQUESTS,
  ) {}

  /**
   * Decides whether to allow this request, counts it in the minute window,
   * and acquires one active-request slot. `release` must be called exactly
   * once after an allowed request finishes or its response stream is
   * cancelled. Capping active requests at the configured per-minute limit
   * prevents one invite token from accumulating unbounded long-lived SSE
   * streams across successive windows.
   */
  check(tokenId: string, now: number = Date.now()): RateLimitCheck {
    if (this.globalActive >= this.globalActiveLimit) {
      return { allowed: false, retryAfterSeconds: 1 };
    }
    if ((this.active.get(tokenId) ?? 0) >= this.requestsPerMinute) {
      return { allowed: false, retryAfterSeconds: 1 };
    }
    const cutoff = now - WINDOW_MS;
    const recent = (this.requests.get(tokenId) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.requestsPerMinute) {
      this.requests.set(tokenId, recent);
      const oldest = recent[0] as number;
      const retryAfterMs = oldest + WINDOW_MS - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    recent.push(now);
    this.requests.set(tokenId, recent);
    this.active.set(tokenId, (this.active.get(tokenId) ?? 0) + 1);
    this.globalActive += 1;
    return { allowed: true };
  }

  release(tokenId: string): void {
    const current = this.active.get(tokenId) ?? 0;
    if (current <= 0) return;
    if (current === 1) this.active.delete(tokenId);
    else this.active.set(tokenId, current - 1);
    this.globalActive -= 1;
  }
}
