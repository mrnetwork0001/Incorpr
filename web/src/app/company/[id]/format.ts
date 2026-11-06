// Display helpers for the company cockpit. Pure functions: no network, no secrets. Amounts arrive
// as decimal strings in base units (micro-USDC, satoshis, lamports, wei) and are never passed
// through a float.

import type { EncumbranceState } from '@/lib/contracts';
import type { EncumbranceLabel } from '../../encumbrance-pill';

export const TOKEN_ID = /^\d{1,20}$/;

/** `12345678` with 6 decimals -> `12.345678`; trailing zeros trimmed down to `minFraction` digits. */
export function formatUnits(raw: string | bigint, decimals: number, minFraction = 2): string {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toLocaleString('en-US');
  let fraction = decimals > 0 ? (abs % base).toString().padStart(decimals, '0') : '';
  while (fraction.length > minFraction && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** micro-USDC -> `1,234.50`. Keeps sub-cent digits when they are not zero. */
export function formatUsdc(micro: string | bigint): string {
  return formatUnits(micro, 6, 2);
}

/** User input in USDC (`1.5`) -> micro-USDC string, or null when it is not a valid amount. */
export function parseUsdc(text: string): string | null {
  const trimmed = text.trim();
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(trimmed);
  if (!match) return null;
  const micro = BigInt(match[1] as string) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0') || '0');
  return micro.toString();
}

export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  return rest === 0 ? `${whole}%` : `${whole}.${rest.toString().padStart(2, '0').replace(/0$/, '')}%`;
}

export function encumbranceLabel(state: EncumbranceState): EncumbranceLabel {
  if (state === 'Free') return 'FREE';
  return 'Listed' in state ? 'LISTED' : 'PLEDGED';
}

/** `2026-11-06 15:03 UTC`. Zero or missing timestamps read as `never`. */
export function formatTime(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const KNOWN_ASSETS: Record<string, string> = {
  'nep141:btc.omft.near': 'BTC',
  'nep141:sol.omft.near': 'SOL',
  'nep141:eth.omft.near': 'ETH',
  'nep141:wrap.near': 'wNEAR',
};

/** Short name for an intents asset id. `usdcToken` is the vault's own USDC contract. */
export function assetName(assetId: string, usdcToken: string): string {
  if (assetId === `nep141:${usdcToken}` || assetId === usdcToken) return 'USDC';
  return KNOWN_ASSETS[assetId] ?? assetId;
}

/** Decimals for the assets the treasury holds. Null when unknown, so the raw amount is shown. */
export function assetDecimals(assetId: string, usdcToken: string): number | null {
  const name = assetName(assetId, usdcToken);
  if (name === 'USDC') return 6;
  if (name === 'BTC') return 8;
  if (name === 'SOL') return 9;
  if (name === 'ETH') return 18;
  if (name === 'wNEAR') return 24;
  return null;
}

export function formatAsset(raw: string, assetId: string, usdcToken: string): string {
  const decimals = assetDecimals(assetId, usdcToken);
  return decimals === null ? `${raw} base units` : `${formatUnits(raw, decimals, 2)} ${assetName(assetId, usdcToken)}`;
}
