// Form parsing for the incorporate wizard. Amounts are parsed as decimal strings into integers with
// bigint, never through floating point, so 0.1 USDC is exactly 100000 micro-USDC.

import type { Incorporate } from '@/lib/contracts';

const YOCTO_PER_NEAR = 10n ** 24n;
const MICRO_PER_USDC = 1_000_000n;

/** "1.25" with `decimals` 2 -> 125n. Null for anything that is not a plain non-negative decimal. */
export function parseDecimal(input: string, decimals: number): bigint | null {
  const text = input.trim();
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text) ?? /^()\.(\d+)$/.exec(text);
  if (!match) return null;
  const whole = match[1] || '0';
  const frac = match[2] ?? '';
  if (frac.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Trims trailing zeros: 4594540000000000000000000 -> "4.59454". */
function formatUnits(value: bigint, unit: bigint, maxDecimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / unit;
  const digits = unit.toString().length - 1;
  const frac = (abs % unit).toString().padStart(digits, '0').slice(0, maxDecimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

export function formatNear(yocto: string | bigint, maxDecimals = 5): string {
  return `${formatUnits(BigInt(yocto), YOCTO_PER_NEAR, maxDecimals)} NEAR`;
}

export function formatUsdc(micro: string | bigint): string {
  return `${formatUnits(BigInt(micro), MICRO_PER_USDC, 6)} USDC`;
}

/** 2000 bps -> "20%". */
export function formatBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}

export const MAX_TEXT_BYTES = 64;

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface FormValues {
  name: string;
  template: string;
  price: string;
  reserve: string;
  royalty: string;
  btc: string;
  sol: string;
  usdc: string;
}

export type FieldErrors = Partial<Record<keyof FormValues | 'targets', string>>;

function textError(text: string, what: string): string | undefined {
  const bytes = utf8Length(text);
  if (bytes === 0) return `Enter a ${what}.`;
  if (bytes > MAX_TEXT_BYTES) return `${bytes} bytes. The registry accepts at most ${MAX_TEXT_BYTES}.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return 'Line breaks and control characters are rejected by the registry.';
  return undefined;
}

function percentBps(input: string): bigint | null {
  return parseDecimal(input, 2);
}

/**
 * Checks the form and builds the `incorporate_company` arguments. Mirrors the registry's checks
 * (and `validateIncorporate` in lib/actions.ts, which runs again before signing).
 */
export function buildArgs(values: FormValues): { args: Incorporate | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const name = textError(values.name, 'company name');
  if (name) errors.name = name;
  const template = textError(values.template, 'service instruction');
  if (template) errors.template = template;

  const price = parseDecimal(values.price, 6);
  if (price === null) errors.price = 'Enter a USDC amount with at most 6 decimals.';
  else if (price === 0n) errors.price = 'The price must be above zero.';

  const reserve = percentBps(values.reserve);
  if (reserve === null) errors.reserve = 'Enter a percentage with at most 2 decimals.';
  else if (reserve < 100n || reserve > 10_000n) errors.reserve = 'The registry accepts 1% to 100%.';

  const royalty = percentBps(values.royalty);
  if (royalty === null) errors.royalty = 'Enter a percentage with at most 2 decimals.';
  else if (royalty > 1_000n) errors.royalty = 'The registry accepts at most 10%.';

  const targets = [values.btc, values.sol, values.usdc].map(percentBps);
  const keys = ['btc', 'sol', 'usdc'] as const;
  targets.forEach((t, i) => {
    if (t === null) errors[keys[i] as (typeof keys)[number]] = 'At most 2 decimals.';
    else if (t > 10_000n) errors[keys[i] as (typeof keys)[number]] = 'At most 100%.';
  });
  if (targets.every((t) => t !== null)) {
    const sum = targets.reduce<bigint>((a, t) => a + (t as bigint), 0n);
    if (sum !== 10_000n) errors.targets = `The three targets add up to ${formatBps(Number(sum))}. They must add up to 100%.`;
  }

  if (Object.keys(errors).length > 0) return { args: null, errors };
  return {
    errors,
    args: {
      name: values.name,
      service_template: values.template,
      price_micro_usdc: (price as bigint).toString(),
      target_bps: targets.map((t) => Number(t)) as [number, number, number],
      founder_royalty_bps: Number(royalty),
      compute_reserve_bps: Number(reserve),
    },
  };
}
