/** A small token bucket. `waitMs()` says how long until a token is available; `take()` spends one. */
import type { RateLimit } from "./config";

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly limit: RateLimit, private readonly now: () => number) { this.tokens = limit.burst; this.last = now(); }
  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.limit.burst, this.tokens + ((t - this.last) / 1000) * this.limit.rate);
    this.last = t;
  }
  waitMs(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.limit.rate) * 1000);
  }
  take(): void { this.refill(); this.tokens -= 1; }
}
