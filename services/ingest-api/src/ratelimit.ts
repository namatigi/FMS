/** Simple in-memory token bucket per key (gateway code / controller pts id). Per instance. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private ratePerSec: number, private burst: number, private now: () => number = Date.now) {}

  /** Returns 0 when allowed, otherwise the number of seconds to wait. */
  take(key: string, cost = 1): number {
    if (this.ratePerSec <= 0) return 0;
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, at: t };
      this.buckets.set(key, b);
      if (this.buckets.size > 100_000) this.gc(t);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.ratePerSec);
      b.at = t;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return 0;
    }
    return Math.max(1, Math.ceil((cost - b.tokens) / this.ratePerSec));
  }

  private gc(t: number) {
    for (const [k, b] of this.buckets) if (t - b.at > 60_000) this.buckets.delete(k);
  }
}
