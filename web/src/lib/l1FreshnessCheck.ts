// Reads pending activity on a vault's current-epoch L1 addresses.
//
// A failed fetch is `unavailable`, never clean. This check sees broadcast transactions only: a
// signature held unbroadcast is invisible here, which is why the vault itself refuses to freeze or
// sell a company with `raw_sigs_this_epoch > 0` (docs/ARCHITECTURE.md section 3).

import type { VaultState } from './contracts';
import { checkVaultAddresses, deriveIntentsKey, type AddressComparison } from './mpcAddresses';
import { viewFunction, type NearNetwork, type ViewOptions } from './near';

export type FreshnessState = 'clean' | 'dirty' | 'unavailable';

export interface L1Endpoints {
  /** Esplora-compatible APIs in failover order. */
  btcMempool: string[];
  evm: Record<EvmChain, { name: string; rpc: string }>;
  solanaRpc: string;
}

export type EvmChain = 'base' | 'ethereum' | 'arbitrum';

const TESTNET_ENDPOINTS: L1Endpoints = {
  btcMempool: ['https://mempool.space/testnet4/api', 'https://blockstream.info/testnet4/api'],
  evm: {
    base: { name: 'Base Sepolia', rpc: 'https://sepolia.base.org' },
    ethereum: { name: 'Ethereum Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
    arbitrum: { name: 'Arbitrum Sepolia', rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
  },
  solanaRpc: 'https://api.devnet.solana.com',
};

// Two hosts each, because some networks cannot reach mempool.space.
const ENDPOINTS: Record<NearNetwork, L1Endpoints> = {
  mainnet: {
    btcMempool: ['https://mempool.space/api', 'https://blockstream.info/api'],
    evm: {
      base: { name: 'Base', rpc: 'https://mainnet.base.org' },
      ethereum: { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com' },
      arbitrum: { name: 'Arbitrum One', rpc: 'https://arb1.arbitrum.io/rpc' },
    },
    solanaRpc: 'https://api.mainnet-beta.solana.com',
  },
  testnet: TESTNET_ENDPOINTS,
  // The sandbox vault derives testnet-format addresses (btc_hrp tb), so it reads the test networks.
  sandbox: TESTNET_ENDPOINTS,
};

export function l1Endpoints(network: NearNetwork): L1Endpoints {
  const defaults = ENDPOINTS[network];
  const configuredBtc = (process.env.BTC_MEMPOOL_API ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  return {
    btcMempool: configuredBtc.length > 0 ? configuredBtc : defaults.btcMempool,
    evm: {
      base: { ...defaults.evm.base, rpc: process.env.BASE_RPC_URL || defaults.evm.base.rpc },
      ethereum: { ...defaults.evm.ethereum, rpc: process.env.ETHEREUM_RPC_URL || defaults.evm.ethereum.rpc },
      arbitrum: { ...defaults.evm.arbitrum, rpc: process.env.ARBITRUM_RPC_URL || defaults.evm.arbitrum.rpc },
    },
    solanaRpc: process.env.SOLANA_RPC_URL || defaults.solanaRpc,
  };
}

const FETCH_TIMEOUT_MS = 8_000;
const RATE_LIMIT_RETRY_MS = 2_000;

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return cause ? `${error.message} (${cause})` : error.message;
  }
  return String(error);
}

export interface BtcCheck {
  state: FreshnessState;
  address: string;
  endpoint: string | null;
  /** Mempool transactions that spend from this address. */
  spendingTxids: string[];
  /** Mempool transactions that only pay this address. These cannot drain it. */
  incomingTxids: string[];
  errors: string[];
}

interface EsploraTx {
  txid: string;
  vin?: { prevout?: { scriptpubkey_address?: string } | null }[];
}

export async function checkBtcMempool(address: string, endpoints: string[]): Promise<BtcCheck> {
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const url = `${endpoint}/address/${address}/txs/mempool`;
      const init = { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) } as const;
      let res = await fetch(url, init);
      if (res.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_MS));
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const txs = (await res.json()) as EsploraTx[];
      if (!Array.isArray(txs)) throw new Error('response is not a list');
      // An input with no prevout cannot be attributed, so it counts as a spend.
      const spends = (tx: EsploraTx) =>
        (tx.vin ?? []).length === 0 ||
        (tx.vin ?? []).some((input) => (input.prevout?.scriptpubkey_address ?? address) === address);
      const spendingTxids = txs.filter(spends).map((tx) => tx.txid);
      const incomingTxids = txs.filter((tx) => !spends(tx)).map((tx) => tx.txid);
      return {
        state: spendingTxids.length > 0 ? 'dirty' : 'clean',
        address,
        endpoint,
        spendingTxids,
        incomingTxids,
        errors,
      };
    } catch (error) {
      errors.push(`${endpoint}: ${errorText(error)}`);
    }
  }
  return { state: 'unavailable', address, endpoint: null, spendingTxids: [], incomingTxids: [], errors };
}

export interface EvmChainCheck {
  state: FreshnessState;
  chain: EvmChain;
  name: string;
  endpoint: string;
  address: string;
  latestNonce: number | null;
  pendingNonce: number | null;
  error: string | null;
}

async function jsonRpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  if (body.result === undefined) throw new Error(`${method} returned no result`);
  return body.result;
}

/** Pending above latest means a transaction from this address is in the node's mempool. */
export async function checkEvmNonce(
  chain: EvmChain,
  name: string,
  endpoint: string,
  address: string,
): Promise<EvmChainCheck> {
  try {
    const [latest, pending] = await Promise.all([
      jsonRpc<string>(endpoint, 'eth_getTransactionCount', [address, 'latest']),
      jsonRpc<string>(endpoint, 'eth_getTransactionCount', [address, 'pending']),
    ]);
    const latestNonce = Number.parseInt(latest, 16);
    const pendingNonce = Number.parseInt(pending, 16);
    if (!Number.isFinite(latestNonce) || !Number.isFinite(pendingNonce)) {
      throw new Error(`Unreadable nonces ${latest}, ${pending}`);
    }
    return {
      state: pendingNonce > latestNonce ? 'dirty' : 'clean',
      chain,
      name,
      endpoint,
      address,
      latestNonce,
      pendingNonce,
      error: null,
    };
  } catch (error) {
    return {
      state: 'unavailable',
      chain,
      name,
      endpoint,
      address,
      latestNonce: null,
      pendingNonce: null,
      error: errorText(error),
    };
  }
}

export interface SolanaCheck {
  state: FreshnessState;
  address: string;
  endpoint: string;
  windowSeconds: number;
  recentSignatures: string[];
  /** Most recent signature of any age, for context. */
  lastSignature: string | null;
  error: string | null;
}

/** Solana has no public mempool. Activity inside a recent window is the available signal. */
export const SOLANA_WINDOW_SECONDS = 300;

export async function checkSolanaSignatures(
  address: string,
  endpoint: string,
  windowSeconds: number = SOLANA_WINDOW_SECONDS,
): Promise<SolanaCheck> {
  try {
    const signatures = await jsonRpc<{ signature: string; blockTime: number | null }[]>(
      endpoint,
      'getSignaturesForAddress',
      [address, { limit: 20, commitment: 'confirmed' }],
    );
    const cutoff = Date.now() / 1000 - windowSeconds;
    const recent = signatures.filter((s) => s.blockTime === null || s.blockTime >= cutoff).map((s) => s.signature);
    return {
      state: recent.length > 0 ? 'dirty' : 'clean',
      address,
      endpoint,
      windowSeconds,
      recentSignatures: recent,
      lastSignature: signatures[0]?.signature ?? null,
      error: null,
    };
  } catch (error) {
    return {
      state: 'unavailable',
      address,
      endpoint,
      windowSeconds,
      recentSignatures: [],
      lastSignature: null,
      error: errorText(error),
    };
  }
}

export type IntentsKeysCheck =
  | { state: 'not_applicable'; reason: string }
  | { state: FreshnessState; intentsContract: string; expectedKey: string | null; registeredKeys: string[]; error: string | null };

/** Exactly the derived key, and nothing else, or a second key could spend the vault's balance. */
export async function checkIntentsKeys(
  vaultAccount: string,
  state: Pick<VaultState, 'mpc_contract' | 'token_id' | 'intents_contract' | 'intents_key'>,
  network: NearNetwork,
  options: ViewOptions = {},
): Promise<IntentsKeysCheck> {
  if (network !== 'mainnet') {
    return { state: 'not_applicable', reason: 'intents.near settles on mainnet only' };
  }
  const intentsContract = state.intents_contract;
  try {
    const [expectedKey, registeredKeys] = await Promise.all([
      deriveIntentsKey(state.mpc_contract, vaultAccount, state.token_id, options),
      viewFunction<string[]>(intentsContract, 'public_keys_of', { account_id: vaultAccount }, options),
    ]);
    const exact = registeredKeys.length === 1 && registeredKeys[0] === expectedKey;
    return { state: exact ? 'clean' : 'dirty', intentsContract, expectedKey, registeredKeys, error: null };
  } catch (error) {
    return { state: 'unavailable', intentsContract, expectedKey: null, registeredKeys: [], error: errorText(error) };
  }
}

export interface FreshnessReport {
  overall: FreshnessState;
  network: NearNetwork;
  vault: string;
  epoch: number;
  checkedAtMs: number;
  dirtyReasons: string[];
  unavailableReasons: string[];
  vaultChecks: {
    rawSignaturesThisEpoch: number;
    latestIntentDeadlineMs: number;
    unexpiredIntents: boolean;
    addressesMatchMpc: AddressComparison | { match: 'unavailable'; error: string };
  };
  btc: BtcCheck | null;
  evm: EvmChainCheck[];
  solana: SolanaCheck | null;
  intentsKeys: IntentsKeysCheck;
  limits: string;
}

const LIMITS =
  'Sees broadcast transactions only. A signature held unbroadcast leaves no trace here; the vault ' +
  'covers that case by refusing a freeze or sale while raw_sigs_this_epoch is above zero. Public EVM ' +
  'nodes report their own mempool, so a transaction sent privately to a builder would not appear.';

export async function checkFreshness(
  vaultAccount: string,
  state: VaultState,
  network: NearNetwork,
  endpoints: L1Endpoints = l1Endpoints(network),
): Promise<FreshnessReport> {
  const dirty: string[] = [];
  const unavailable: string[] = [];

  const unexpiredIntents = Date.now() <= state.latest_intent_deadline_ms;
  if (state.raw_sigs_this_epoch > 0) {
    dirty.push(`vault issued ${state.raw_sigs_this_epoch} raw signature(s) this epoch`);
  }
  if (unexpiredIntents) dirty.push('vault has a signed intent that has not expired');

  let addressesMatchMpc: FreshnessReport['vaultChecks']['addressesMatchMpc'];
  try {
    addressesMatchMpc = (await checkVaultAddresses(vaultAccount, state)).comparison;
    if (!addressesMatchMpc.match) {
      if (addressesMatchMpc.reason === 'mismatch') dirty.push('stored addresses differ from the MPC derivation');
      else unavailable.push('vault has no stored addresses for this epoch: call refresh_treasury_keys');
    }
  } catch (error) {
    addressesMatchMpc = { match: 'unavailable', error: errorText(error) };
    unavailable.push(`MPC derivation read failed: ${errorText(error)}`);
  }

  const addresses = state.addresses;
  const [btc, evm, solana, intentsKeys] = await Promise.all([
    addresses ? checkBtcMempool(addresses.btc, endpoints.btcMempool) : Promise.resolve(null),
    addresses
      ? Promise.all(
          (Object.entries(endpoints.evm) as [EvmChain, { name: string; rpc: string }][]).map(([chain, { name, rpc }]) =>
            checkEvmNonce(chain, name, rpc, addresses.evm),
          ),
        )
      : Promise.resolve([]),
    addresses ? checkSolanaSignatures(addresses.sol, endpoints.solanaRpc) : Promise.resolve(null),
    checkIntentsKeys(vaultAccount, state, network),
  ]);

  if (btc?.state === 'dirty') dirty.push(`BTC mempool has ${btc.spendingTxids.length} spend(s) from ${btc.address}`);
  if (btc?.state === 'unavailable') unavailable.push(`BTC mempool: ${btc.errors.join('; ')}`);
  for (const check of evm) {
    if (check.state === 'dirty') {
      dirty.push(`${check.name} pending nonce ${check.pendingNonce} is above latest ${check.latestNonce}`);
    }
    if (check.state === 'unavailable') unavailable.push(`${check.name}: ${check.error}`);
  }
  if (solana?.state === 'dirty') {
    dirty.push(`Solana address signed ${solana.recentSignatures.length} transaction(s) in the last ${solana.windowSeconds}s`);
  }
  if (solana?.state === 'unavailable') unavailable.push(`Solana: ${solana.error}`);
  if (intentsKeys.state === 'dirty') {
    dirty.push(`intents.near keys are ${JSON.stringify(intentsKeys.registeredKeys)}, expected only ${intentsKeys.expectedKey}`);
  }
  if (intentsKeys.state === 'unavailable') unavailable.push(`intents.near: ${intentsKeys.error}`);

  return {
    overall: dirty.length > 0 ? 'dirty' : unavailable.length > 0 ? 'unavailable' : 'clean',
    network,
    vault: vaultAccount,
    epoch: state.treasury_epoch,
    checkedAtMs: Date.now(),
    dirtyReasons: dirty,
    unavailableReasons: unavailable,
    vaultChecks: {
      rawSignaturesThisEpoch: state.raw_sigs_this_epoch,
      latestIntentDeadlineMs: state.latest_intent_deadline_ms,
      unexpiredIntents,
      addressesMatchMpc,
    },
    btc,
    evm,
    solana,
    intentsKeys,
    limits: LIMITS,
  };
}
