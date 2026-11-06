import 'server-only';

// Live treasury readings for the cockpit, fetched on the server so that SOLANA_RPC_URL,
// BASE_RPC_URL and BTC_MEMPOOL_API apply and browser CORS rules do not. A failed read is reported
// as unavailable with its reason, never as a zero balance.

import { ftViews, type VaultState } from '@/lib/contracts';
import { l1Endpoints } from '@/lib/l1FreshnessCheck';
import { checkVaultAddresses } from '@/lib/mpcAddresses';
import { getNetworkConfig, viewFunction, type NearNetwork, type ViewOptions } from '@/lib/near';
import { formatUnits } from './format';

const TIMEOUT_MS = 8_000;
/** Public fallback when the configured mainnet Solana RPC refuses (api.mainnet-beta answers 403 to some networks). */
const SOLANA_MAINNET_FALLBACK = 'https://solana-rpc.publicnode.com';

export type Reading =
  | { ok: true; amount: string; detail: string | null; source: string }
  | { ok: false; error: string };

export type AddressCheck =
  | { kind: 'match' }
  | { kind: 'no_addresses' }
  | { kind: 'mismatch'; fields: string[] }
  | { kind: 'error'; message: string };

export interface IntentsHolding {
  asset: string;
  symbol: string;
  reading: Reading;
}

export interface TreasuryReadings {
  addressCheck: AddressCheck;
  btc: Reading | null;
  sol: Reading | null;
  evm: Reading | null;
  evmChain: string;
  usdcOnNear: Reading;
  intents: { contract: string; holdings: IntentsHolding[] } | { contract: null; reason: string };
  readAtMs: number;
}

function message(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return cause ? `${error.message} (${cause})` : error.message;
  }
  return String(error);
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function jsonRpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  if (body.result === undefined) throw new Error(`${method} returned no result`);
  return body.result;
}

interface EsploraStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
}

/** Confirmed balance from an Esplora API (mempool.space), with unconfirmed movement as detail. */
export async function btcBalance(address: string, endpoints: string[]): Promise<Reading> {
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(`${endpoint}/address/${address}`, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { chain_stats?: EsploraStats; mempool_stats?: EsploraStats };
      if (!body.chain_stats || !body.mempool_stats) throw new Error('response has no chain_stats');
      const confirmed = BigInt(body.chain_stats.funded_txo_sum) - BigInt(body.chain_stats.spent_txo_sum);
      const pending = BigInt(body.mempool_stats.funded_txo_sum) - BigInt(body.mempool_stats.spent_txo_sum);
      return {
        ok: true,
        amount: `${formatUnits(confirmed, 8, 2)} BTC`,
        detail: pending === 0n ? null : `${pending > 0n ? '+' : ''}${formatUnits(pending, 8, 2)} BTC unconfirmed`,
        source: host(endpoint),
      };
    } catch (error) {
      errors.push(`${host(endpoint)}: ${message(error)}`);
    }
  }
  return { ok: false, error: errors.join('; ') || 'no Esplora endpoint configured' };
}

export async function solBalance(address: string, rpcs: string[]): Promise<Reading> {
  const errors: string[] = [];
  for (const rpc of rpcs) {
    try {
      const result = await jsonRpc<{ value: number }>(rpc, 'getBalance', [address, { commitment: 'confirmed' }]);
      return { ok: true, amount: `${formatUnits(BigInt(result.value), 9, 2)} SOL`, detail: null, source: host(rpc) };
    } catch (error) {
      errors.push(`${host(rpc)}: ${message(error)}`);
    }
  }
  return { ok: false, error: errors.join('; ') };
}

export async function evmBalance(address: string, rpc: string, symbol = 'ETH'): Promise<Reading> {
  try {
    const hex = await jsonRpc<string>(rpc, 'eth_getBalance', [address, 'latest']);
    return { ok: true, amount: `${formatUnits(BigInt(hex), 18, 2)} ${symbol}`, detail: null, source: host(rpc) };
  } catch (error) {
    return { ok: false, error: `${host(rpc)}: ${message(error)}` };
  }
}

async function nearReading(read: () => Promise<string>, decimals: number, symbol: string, source: string): Promise<Reading> {
  try {
    return { ok: true, amount: `${formatUnits(await read(), decimals, 2)} ${symbol}`, detail: null, source };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

const INTENTS_ASSETS: { id: (usdc: string) => string; decimals: number; symbol: string }[] = [
  { id: () => 'nep141:btc.omft.near', decimals: 8, symbol: 'BTC' },
  { id: () => 'nep141:sol.omft.near', decimals: 9, symbol: 'SOL' },
  { id: (usdc) => `nep141:${usdc}`, decimals: 6, symbol: 'USDC' },
];

export async function loadTreasury(
  vault: string,
  state: VaultState,
  network: NearNetwork,
  options: ViewOptions = {},
): Promise<TreasuryReadings> {
  const endpoints = l1Endpoints(network);
  const solRpcs = [endpoints.solanaRpc, ...(network === 'mainnet' && endpoints.solanaRpc !== SOLANA_MAINNET_FALLBACK ? [SOLANA_MAINNET_FALLBACK] : [])];
  const addresses = state.addresses ?? null;
  const rpcHost = host(options.rpcUrl ?? getNetworkConfig().rpcUrl);

  const addressCheck: Promise<AddressCheck> = checkVaultAddresses(vault, state, options).then(
    ({ comparison }): AddressCheck =>
      comparison.match
        ? { kind: 'match' }
        : comparison.reason === 'vault_has_no_addresses'
          ? { kind: 'no_addresses' }
          : { kind: 'mismatch', fields: comparison.mismatches.map((m) => m.field) },
    (error: unknown): AddressCheck => ({ kind: 'error', message: message(error) }),
  );

  const intents: Promise<TreasuryReadings['intents']> = state.intents_contract
    ? Promise.all(
        INTENTS_ASSETS.map(async ({ id, decimals, symbol }) => {
          const asset = id(state.usdc_token);
          return {
            asset,
            symbol,
            reading: await nearReading(
              () => viewFunction<string>(state.intents_contract, 'mt_balance_of', { account_id: vault, token_id: asset }, options),
              decimals,
              symbol,
              rpcHost,
            ),
          };
        }),
      ).then((holdings) => ({ contract: state.intents_contract, holdings }))
    : Promise.resolve({ contract: null, reason: 'This network has no intents contract. intents.near settles on mainnet only.' });

  const [check, btc, sol, evm, usdcOnNear, intentsHoldings] = await Promise.all([
    addressCheck,
    addresses ? btcBalance(addresses.btc, endpoints.btcMempool) : Promise.resolve(null),
    addresses ? solBalance(addresses.sol, solRpcs) : Promise.resolve(null),
    addresses ? evmBalance(addresses.evm, endpoints.evm.base.rpc) : Promise.resolve(null),
    nearReading(() => ftViews.balanceOf(state.usdc_token, vault, options), 6, 'USDC', rpcHost),
    intents,
  ]);

  return {
    addressCheck: check,
    btc,
    sol,
    evm,
    evmChain: endpoints.evm.base.name,
    usdcOnNear,
    intents: intentsHoldings,
    readAtMs: Date.now(),
  };
}
