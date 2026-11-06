// Text formatting for share cards. Pure functions, no I/O.

import type { EncumbranceState } from '../contracts';

/** Share card size X and Open Graph expect. */
export const OG_SIZE = { width: 1200, height: 630 };

export type StateLabel = 'FREE' | 'LISTED' | 'PLEDGED';

export function stateLabel(state: EncumbranceState): StateLabel {
  if (state === 'Free') return 'FREE';
  return 'Listed' in state ? 'LISTED' : 'PLEDGED';
}

/** Micro-USDC (6 decimals) as "$1,234.56". Below one cent it keeps all six decimals so a small payment is not shown as zero. */
export function formatUsdc(micro: string | bigint): string {
  const value = BigInt(micro);
  const whole = value / 1_000_000n;
  const frac = value % 1_000_000n;
  if (whole === 0n && frac > 0n && frac < 10_000n) return `$0.${frac.toString().padStart(6, '0')}`;
  return `$${whole.toLocaleString('en-US')}.${(frac / 10_000n).toString().padStart(2, '0')}`;
}

/** Keeps the start and end of a long hash or address: "tb1qtg56…ej60r". */
export function middle(text: string, head = 10, tail = 8): string {
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export function networkLabel(network: string): string {
  if (network === 'mainnet') return 'NEAR mainnet';
  if (network === 'testnet') return 'NEAR testnet';
  if (network === 'sandbox') return 'Local sandbox';
  return network;
}

/** "2026-11-06 15:03 UTC" */
export function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A NEAR transaction hash: base58 of 32 bytes. */
export const TX_HASH_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** Registry token ids are decimal counters. */
export const TOKEN_ID_PATTERN = /^[0-9]{1,20}$/;
