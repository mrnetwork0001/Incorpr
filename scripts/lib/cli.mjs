// Argument parsing, output and unit formatting shared by deploy.mjs and demo.mjs.

import { parseArgs } from 'node:util';

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function parseCli(options, argv = process.argv.slice(2)) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false, strict: true }).values;
  } catch (error) {
    throw new CliError(error.message, 2);
  }
}

export function requireNetwork(value) {
  if (value !== 'mainnet' && value !== 'testnet' && value !== 'sandbox') {
    throw new CliError('--network must be mainnet, testnet or sandbox', 2);
  }
  return value;
}

/** Runs `main`, prints CliError messages without a stack, and sets the exit code. */
export function runMain(main) {
  main().then(
    (code) => {
      process.exitCode = typeof code === 'number' ? code : 0;
    },
    (error) => {
      if (error instanceof CliError) {
        console.error(`\nerror: ${error.message}`);
        process.exitCode = error.exitCode;
      } else {
        console.error('\nerror:', error?.stack ?? error);
        process.exitCode = 1;
      }
    },
  );
}

export const log = (...parts) => console.log(...parts);
export const heading = (text) => console.log(`\n== ${text}`);
export const item = (label, value) => console.log(`   ${label.padEnd(24)} ${value}`);

export const ONE_NEAR = 10n ** 24n;
export const MILLI_NEAR = 10n ** 21n;

export function parseNear(text) {
  const match = /^(\d+)(?:\.(\d{1,24}))?$/.exec(String(text).trim());
  if (!match) throw new CliError(`not a NEAR amount: ${text}`, 2);
  return BigInt(match[1]) * ONE_NEAR + BigInt((match[2] ?? '').padEnd(24, '0') || '0');
}

export function formatNear(yocto, digits = 5) {
  const value = BigInt(yocto);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / ONE_NEAR;
  const frac = (abs % ONE_NEAR).toString().padStart(24, '0').slice(0, digits);
  return `${negative ? '-' : ''}${whole}.${frac} NEAR`;
}

export function parseUsdc(text) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(text).trim());
  if (!match) throw new CliError(`not a USDC amount: ${text}`, 2);
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0') || '0');
}

export function formatUsdc(micro) {
  const value = BigInt(micro);
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')} USDC`;
}

export const tgas = (n) => BigInt(n) * 10n ** 12n;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
