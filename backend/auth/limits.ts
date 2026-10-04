import { AuthFailure } from "./errors";

interface Counter {
  count: number;
  resetAt: number;
}

/** Small, bounded in-process fixed windows. No unauthenticated pubkey is a key. */
export class RequestLimiter {
  private readonly counters = new Map<string, Counter>();
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  take(
    bucket: string,
    identity: string,
    limit: number,
    windowMs: number,
    nowMs: number,
  ): void {
    const key = `${bucket}:${identity}`;
    const previous = this.counters.get(key);
    if (previous !== undefined && nowMs < previous.resetAt) {
      if (previous.count >= limit) throw new AuthFailure("rate_limited");
      previous.count++;
      return;
    }
    if (this.counters.size >= this.maxEntries) {
      for (const [candidate, value] of this.counters) {
        if (nowMs >= value.resetAt) this.counters.delete(candidate);
      }
      if (this.counters.size >= this.maxEntries && !this.counters.has(key))
        throw new AuthFailure("rate_limited");
    }
    this.counters.set(key, { count: 1, resetAt: nowMs + windowMs });
  }
}
