// Spend limits for the /rob routes. Every attempt is a real transaction paid by a server key, so
// attempts are counted per client IP over a sliding window and against one global daily cap.
// Pure code with an injectable clock; the routes keep one instance per process (see ./store.ts).

const DAY_MS = 86_400_000;

export interface LimiterOptions {
  /** Attempts one IP may make within `perIpWindowMs`. */
  perIpMax: number;
  perIpWindowMs: number;
  /** Attempts across all clients per UTC day. */
  dailyMax: number;
  /** Oldest IPs are dropped beyond this, so the map cannot grow without bound. */
  maxTrackedIps?: number;
}

export type Reservation =
  | { ok: true; remainingToday: number }
  | { ok: false; scope: 'ip' | 'daily'; retryAfterMs: number; message: string };

export class AttemptLimiter {
  private readonly perIp = new Map<string, number[]>();
  private day = -1;
  private usedToday = 0;

  constructor(
    readonly options: LimiterOptions,
    private readonly now: () => number = Date.now,
  ) {
    if (!(options.perIpMax >= 0 && options.dailyMax >= 0 && options.perIpWindowMs > 0)) {
      throw new Error('AttemptLimiter: limits must be non-negative and the window positive');
    }
  }

  private rollDay(now: number): void {
    const day = Math.floor(now / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.usedToday = 0;
    }
  }

  private recent(ip: string, now: number): number[] {
    const cutoff = now - this.options.perIpWindowMs;
    const kept = (this.perIp.get(ip) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.perIp.set(ip, kept);
    else this.perIp.delete(ip);
    return kept;
  }

  /** Takes `count` attempts for `ip`, or none if either limit would be passed. */
  reserve(ip: string, count = 1): Reservation {
    if (!Number.isInteger(count) || count < 1) throw new Error('AttemptLimiter.reserve: count must be a positive integer');
    const now = this.now();
    this.rollDay(now);
    const window = this.recent(ip, now);

    if (this.usedToday + count > this.options.dailyMax) {
      const nextDay = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
      return {
        ok: false,
        scope: 'daily',
        retryAfterMs: nextDay - now,
        message: `This server has sent its daily cap of ${this.options.dailyMax} attempt transactions. It resets at 00:00 UTC.`,
      };
    }
    if (window.length + count > this.options.perIpMax) {
      // The slot frees when enough of the oldest attempts leave the window.
      const freeing = window.length + count - this.options.perIpMax;
      const oldest = window[freeing - 1] ?? now;
      const minutes = Math.round(this.options.perIpWindowMs / 60_000);
      return {
        ok: false,
        scope: 'ip',
        retryAfterMs: Math.max(0, oldest + this.options.perIpWindowMs - now),
        message: `One address can send ${this.options.perIpMax} attempt transactions per ${minutes} minutes. Try again later.`,
      };
    }

    for (let i = 0; i < count; i += 1) window.push(now);
    this.perIp.delete(ip);
    this.perIp.set(ip, window);
    this.usedToday += count;
    const max = this.options.maxTrackedIps ?? 20_000;
    while (this.perIp.size > max) {
      const oldestIp = this.perIp.keys().next().value;
      if (oldestIp === undefined) break;
      this.perIp.delete(oldestIp);
    }
    return { ok: true, remainingToday: this.options.dailyMax - this.usedToday };
  }

  /** Returns attempts that were reserved but never sent, so a refusal before signing costs nothing. */
  release(ip: string, count = 1): void {
    if (count < 1) return;
    const now = this.now();
    this.rollDay(now);
    const window = this.recent(ip, now);
    const returned = Math.min(count, window.length);
    window.splice(window.length - returned, returned);
    if (window.length) this.perIp.set(ip, window);
    else this.perIp.delete(ip);
    this.usedToday = Math.max(0, this.usedToday - returned);
  }

  usage(): { usedToday: number; dailyMax: number } {
    this.rollDay(this.now());
    return { usedToday: this.usedToday, dailyMax: this.options.dailyMax };
  }
}

/** Positive integer from an env value, else the default. */
export function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
