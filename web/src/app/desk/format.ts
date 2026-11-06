// Formatting for the Desk and the Exchange. Amounts on-chain are U128 decimal strings in
// micro-USDC (6 decimals); these helpers never go through floating point.

import type { CompanyView, EncumbranceState } from '@/lib/contracts';
import type { EncumbranceLabel } from '../encumbrance-pill';

const MICRO = 1_000_000n;

/** `1234567890` micro-USDC -> `1,234.56`. Cents are truncated, never rounded up. */
export function formatUsdc(micro: string | bigint): string {
  const value = typeof micro === 'bigint' ? micro : BigInt(micro);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / MICRO).toLocaleString('en-US');
  const cents = ((abs % MICRO) / 10_000n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${cents}`;
}

/** Exact form for confirmations: all six decimals, trailing zeros removed. */
export function formatUsdcExact(micro: string | bigint): string {
  const value = typeof micro === 'bigint' ? micro : BigInt(micro);
  const whole = (value / MICRO).toLocaleString('en-US');
  const frac = (value % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Parses a USDC amount typed by a person (`1,250.5`) into micro-USDC. Returns null for anything
 * that is not a non-negative decimal with at most six places.
 */
export function parseUsdc(input: string): string | null {
  const text = input.trim().replace(/[,_\s]/g, '');
  const match = /^(\d+)(?:\.(\d{0,6}))?$/.exec(text);
  if (!match) return null;
  const whole = BigInt(match[1] as string);
  const frac = BigInt((match[2] ?? '').padEnd(6, '0') || '0');
  return (whole * MICRO + frac).toString();
}

export function encumbranceLabel(state: EncumbranceState): EncumbranceLabel {
  if (state === 'Free') return 'FREE';
  return 'Listed' in state ? 'LISTED' : 'PLEDGED';
}

export function askOf(state: EncumbranceState): string | null {
  return state !== 'Free' && 'Listed' in state ? state.Listed.ask : null;
}

/** Ask divided by annualized 30-day revenue, to one decimal. Null when there is no ask or no revenue. */
export function impliedMultiple(company: Pick<CompanyView, 'encumbrance' | 'revenue_30d'>): string | null {
  const ask = askOf(company.encumbrance);
  if (ask === null) return null;
  const annualized = (BigInt(company.revenue_30d) * 365n) / 30n;
  if (annualized === 0n) return null;
  const tenths = (BigInt(ask) * 10n) / annualized;
  return `${tenths / 10n}.${tenths % 10n}x`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `30d`, `12h`, `45m`, `20s`. Largest unit only, plus a second unit when it is not zero. */
export function formatDuration(ms: number): string {
  const abs = Math.max(0, Math.round(ms));
  if (abs >= DAY) {
    const d = Math.floor(abs / DAY);
    const h = Math.floor((abs % DAY) / HOUR);
    return h ? `${d}d ${h}h` : `${d}d`;
  }
  if (abs >= HOUR) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MINUTE);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  if (abs >= MINUTE) return `${Math.floor(abs / MINUTE)}m`;
  return `${Math.floor(abs / 1000)}s`;
}

/** `2026-11-06 14:05 UTC`. UTC so the server render and the browser agree. */
export function formatTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Simple interest of an offer: (repay - principal) / principal, and the same scaled to a year.
 * Basis points, so the caller formats them.
 */
export function offerRate(principal: string, repay: string, termMs: number): { termBps: bigint; aprBps: bigint | null } {
  const p = BigInt(principal);
  if (p === 0n) return { termBps: 0n, aprBps: null };
  const termBps = ((BigInt(repay) - p) * 10_000n) / p;
  const aprBps = termMs > 0 ? (termBps * BigInt(365 * DAY)) / BigInt(termMs) : null;
  return { termBps, aprBps };
}

export function formatBps(bps: bigint): string {
  const sign = bps < 0n ? '-' : '';
  const abs = bps < 0n ? -bps : bps;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}%`;
}

/**
 * Dutch auction state from the registry's views. The window length is not exposed as a view, so the
 * end is derived from the price: it falls linearly from 2x debt to 0.5x debt over the window, and
 * `auction_price` returns the floor once the window has closed.
 */
export function auctionState(
  debt: string,
  startMs: number | null | undefined,
  price: string | null,
  nowMs: number,
): { phase: 'none' } | { phase: 'running'; price: string; estimatedEndMs: number | null } | { phase: 'closed'; price: string } {
  if (startMs == null || price === null) return { phase: 'none' };
  const d = BigInt(debt);
  const p = BigInt(price);
  const floor = d / 2n;
  if (p <= floor) return { phase: 'closed', price };
  const drop = 2n * d - p;
  const elapsed = Math.max(0, nowMs - startMs);
  // duration = 1.5 * debt * elapsed / (2 * debt - price). Unknown until the price has moved.
  const estimatedEndMs = drop > 0n && elapsed > 0 ? startMs + Number(((3n * d) / 2n) * BigInt(elapsed) / drop) : null;
  return { phase: 'running', price, estimatedEndMs };
}
