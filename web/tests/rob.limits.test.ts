import { describe, expect, it } from 'vitest';
import { AttemptLimiter, intFromEnv } from '@/lib/rob/limits';

const MINUTE = 60_000;
const DAY = 86_400_000;

function clock(start = Date.UTC(2026, 10, 6, 12, 0, 0)) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('AttemptLimiter', () => {
  it('allows up to perIpMax within the window, then refuses with the time until a slot frees', () => {
    const c = clock();
    const limiter = new AttemptLimiter({ perIpMax: 3, perIpWindowMs: 10 * MINUTE, dailyMax: 100 }, c.now);
    expect(limiter.reserve('1.1.1.1', 2).ok).toBe(true);
    c.advance(MINUTE);
    expect(limiter.reserve('1.1.1.1').ok).toBe(true);
    const refused = limiter.reserve('1.1.1.1');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.scope).toBe('ip');
    // The first two were taken at t0; one of them leaves the window at t0 + 10 min, 9 min from now.
    expect(refused.retryAfterMs).toBe(9 * MINUTE);
    expect(refused.message).toContain('3 attempt transactions per 10 minutes');
  });

  it('frees slots as old attempts leave the sliding window', () => {
    const c = clock();
    const limiter = new AttemptLimiter({ perIpMax: 2, perIpWindowMs: 10 * MINUTE, dailyMax: 100 }, c.now);
    expect(limiter.reserve('ip', 2).ok).toBe(true);
    c.advance(10 * MINUTE - 1);
    expect(limiter.reserve('ip').ok).toBe(false);
    c.advance(1);
    expect(limiter.reserve('ip', 2).ok).toBe(true);
  });

  it('counts each IP separately', () => {
    const c = clock();
    const limiter = new AttemptLimiter({ perIpMax: 1, perIpWindowMs: MINUTE, dailyMax: 100 }, c.now);
    expect(limiter.reserve('a').ok).toBe(true);
    expect(limiter.reserve('a').ok).toBe(false);
    expect(limiter.reserve('b').ok).toBe(true);
  });

  it('takes all or nothing: a batch that does not fit reserves no slot', () => {
    const c = clock();
    const limiter = new AttemptLimiter({ perIpMax: 5, perIpWindowMs: MINUTE, dailyMax: 100 }, c.now);
    expect(limiter.reserve('a', 4).ok).toBe(true);
    expect(limiter.reserve('a', 2).ok).toBe(false);
    expect(limiter.usage().usedToday).toBe(4);
    expect(limiter.reserve('a', 1).ok).toBe(true);
  });

  it('enforces the global daily cap across IPs and resets at 00:00 UTC', () => {
    const c = clock(Date.UTC(2026, 10, 6, 23, 0, 0));
    const limiter = new AttemptLimiter({ perIpMax: 100, perIpWindowMs: MINUTE, dailyMax: 3 }, c.now);
    expect(limiter.reserve('a', 2).ok).toBe(true);
    expect(limiter.reserve('b').ok).toBe(true);
    const refused = limiter.reserve('c');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.scope).toBe('daily');
    expect(refused.retryAfterMs).toBe(60 * MINUTE);
    expect(refused.message).toContain('daily cap of 3');
    c.advance(60 * MINUTE);
    expect(limiter.reserve('c').ok).toBe(true);
    expect(limiter.usage()).toEqual({ usedToday: 1, dailyMax: 3 });
  });

  it('checks the daily cap before the IP window, so the reason given is the binding one', () => {
    const c = clock();
    const limiter = new AttemptLimiter({ perIpMax: 1, perIpWindowMs: MINUTE, dailyMax: 1 }, c.now);
    expect(limiter.reserve('a').ok).toBe(true);
    const refused = limiter.reserve('a');
    expect(!refused.ok && refused.scope).toBe('daily');
  });

  it('release returns unsent attempts to both the IP window and the daily count', () => {
    const c = clock();
    const limiter = new AttemptLimiter({ perIpMax: 3, perIpWindowMs: MINUTE, dailyMax: 3 }, c.now);
    expect(limiter.reserve('a', 3).ok).toBe(true);
    limiter.release('a', 2);
    expect(limiter.usage().usedToday).toBe(1);
    expect(limiter.reserve('a', 2).ok).toBe(true);
    // Never below zero, and never more than the IP actually holds.
    limiter.release('b', 5);
    limiter.release('a', 10);
    expect(limiter.usage().usedToday).toBe(0);
  });

  it('remainingToday counts down', () => {
    const limiter = new AttemptLimiter({ perIpMax: 10, perIpWindowMs: MINUTE, dailyMax: 5 }, clock().now);
    const first = limiter.reserve('a', 2);
    expect(first.ok && first.remainingToday).toBe(3);
  });

  it('bounds the number of tracked IPs', () => {
    const c = clock();
    const limiter = new AttemptLimiter({ perIpMax: 1, perIpWindowMs: DAY, dailyMax: 1_000, maxTrackedIps: 2 }, c.now);
    expect(limiter.reserve('a').ok).toBe(true);
    expect(limiter.reserve('b').ok).toBe(true);
    expect(limiter.reserve('c').ok).toBe(true);
    // 'a' was evicted as the oldest entry, so it is counted afresh.
    expect(limiter.reserve('a').ok).toBe(true);
    expect(limiter.reserve('c').ok).toBe(false);
  });

  it('rejects invalid options and counts', () => {
    expect(() => new AttemptLimiter({ perIpMax: 1, perIpWindowMs: 0, dailyMax: 1 })).toThrow();
    const limiter = new AttemptLimiter({ perIpMax: 1, perIpWindowMs: MINUTE, dailyMax: 1 });
    expect(() => limiter.reserve('a', 0)).toThrow();
    expect(() => limiter.reserve('a', 1.5)).toThrow();
  });

  it('a zero cap refuses everything', () => {
    const limiter = new AttemptLimiter({ perIpMax: 5, perIpWindowMs: MINUTE, dailyMax: 0 });
    expect(limiter.reserve('a').ok).toBe(false);
  });
});

describe('intFromEnv', () => {
  it('reads non-negative integers and falls back otherwise', () => {
    expect(intFromEnv('7', 3)).toBe(7);
    expect(intFromEnv('0', 3)).toBe(0);
    expect(intFromEnv(undefined, 3)).toBe(3);
    expect(intFromEnv('', 3)).toBe(3);
    expect(intFromEnv('-1', 3)).toBe(3);
    expect(intFromEnv('2.5', 3)).toBe(3);
    expect(intFromEnv('ten', 3)).toBe(3);
  });
});
