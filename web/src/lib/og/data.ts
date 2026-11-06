// Live chain reads for share cards. Every loader returns a tagged result and never throws, so a
// card can always render: missing configuration, a missing company or an unreachable RPC each get
// their own plain state, and no value is ever filled in that the chain did not return.

import { RegistryClient, VaultClient, type CompanyView, type TreasuryAddresses } from '../contracts';
import { getNetworkConfig, transactionExplorerUrl, type NetworkConfig } from '../near';
import { CONTRACT_ERRORS, describeContractError, loggedRefusal, rootCauseFailure, type OutcomeLike } from '../txOutcome';
import { stateLabel, TOKEN_ID_PATTERN, TX_HASH_PATTERN, type StateLabel } from './format';

function networkConfig(): NetworkConfig | null {
  try {
    return getNetworkConfig();
  } catch {
    return null;
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ------------------------------------------------------------------------------------- Company

export type CompanyCardData =
  | { kind: 'no_registry'; network: string | null; tokenId: string }
  | { kind: 'not_found'; network: string; registryId: string; tokenId: string }
  | { kind: 'error'; network: string; registryId: string; tokenId: string; message: string }
  | {
      kind: 'ready';
      network: string;
      registryId: string;
      tokenId: string;
      name: string;
      vault: string;
      state: StateLabel;
      /** Micro-USDC: the ask while listed, the debt while pledged. */
      stateAmount: string | null;
      /** Micro-USDC paid by customers other than the current shareholder. */
      bookedRevenue: string;
      revenue30d: string;
      calls: number;
      addresses: TreasuryAddresses | null;
      /** True when revenue figures come from the vault itself, false for the registry's snapshot. */
      exact: boolean;
    };

export async function loadCompanyCard(tokenId: string): Promise<CompanyCardData> {
  const config = networkConfig();
  if (!config?.registryId) return { kind: 'no_registry', network: config?.network ?? null, tokenId };
  const { network, registryId } = config;
  if (!TOKEN_ID_PATTERN.test(tokenId)) return { kind: 'not_found', network, registryId, tokenId };

  let company: CompanyView | null;
  try {
    company = await new RegistryClient(registryId).getCompany(tokenId);
  } catch (error) {
    return { kind: 'error', network, registryId, tokenId, message: message(error) };
  }
  if (!company) return { kind: 'not_found', network, registryId, tokenId };

  const state = stateLabel(company.encumbrance);
  const enc = company.encumbrance;
  const stateAmount = enc === 'Free' ? null : 'Listed' in enc ? enc.Listed.ask : enc.Pledged.debt;
  const base = {
    kind: 'ready' as const,
    network,
    registryId,
    tokenId,
    name: company.name,
    vault: company.vault,
    state,
    stateAmount,
  };
  // The vault holds the exact ledger and the treasury addresses. If it cannot be read, the
  // registry's metrics snapshot still describes the company.
  try {
    const vault = await new VaultClient(company.vault).getState();
    return {
      ...base,
      bookedRevenue: vault.gross_revenue,
      revenue30d: vault.revenue_30d,
      calls: vault.api_calls_served,
      addresses: vault.addresses ?? null,
      exact: true,
    };
  } catch {
    return { ...base, bookedRevenue: company.gross, revenue30d: company.revenue_30d, calls: company.calls, addresses: null, exact: false };
  }
}

// ------------------------------------------------------------------------------------ Exchange

export type ExchangeCardData =
  | { kind: 'unavailable'; network: string | null }
  | {
      kind: 'ready';
      network: string;
      registryId: string;
      companies: number;
      listed: number;
      pledged: number;
      revenue30d: string;
    };

const PAGE = 100;

export async function loadExchangeCard(): Promise<ExchangeCardData> {
  const config = networkConfig();
  if (!config?.registryId) return { kind: 'unavailable', network: config?.network ?? null };
  try {
    const registry = new RegistryClient(config.registryId);
    const companies: CompanyView[] = [];
    // Bounded: a share card reads at most ten pages.
    for (let page = 0; page < 10; page += 1) {
      const batch = await registry.listCompanies(page * PAGE, PAGE);
      companies.push(...batch);
      if (batch.length < PAGE) break;
    }
    let revenue = 0n;
    let listed = 0;
    let pledged = 0;
    for (const c of companies) {
      revenue += BigInt(c.revenue_30d);
      const label = stateLabel(c.encumbrance);
      if (label === 'LISTED') listed += 1;
      if (label === 'PLEDGED') pledged += 1;
    }
    return {
      kind: 'ready',
      network: config.network,
      registryId: config.registryId,
      companies: companies.length,
      listed,
      pledged,
      revenue30d: revenue.toString(),
    };
  } catch {
    return { kind: 'unavailable', network: config.network };
  }
}

// ------------------------------------------------------------------------------- Rob attempt

export type RobTxData =
  | { kind: 'none'; network: string | null; reason: 'no_tx' | 'invalid' | 'not_found' | 'rpc' | 'pending' }
  | {
      kind: 'refused' | 'succeeded';
      network: string;
      hash: string;
      /** ERR_ code of the root-cause receipt, or a refund logged by a successful ft_transfer_call. */
      code: string | null;
      sentence: string;
      /** True when the transaction succeeded but the contract refunded a transfer with `code`. */
      refunded: boolean;
      method: string;
      signer: string;
      receiver: string;
      blockHeight: number | null;
      blockTime: string | null;
      explorerUrl: string | null;
    };

const ARCHIVAL: Partial<Record<string, string>> = {
  mainnet: 'https://archival-rpc.mainnet.fastnear.com',
  testnet: 'https://archival-rpc.testnet.fastnear.com',
};
const RPC_TIMEOUT_MS = 5_000;
/** Crawlers give up after a few seconds; past this the generic card is served. */
const ROB_DEADLINE_MS = 8_000;

type RpcAnswer = { result: unknown } | { error: { name?: string; cause?: { name?: string } } } | { transport: string };

async function rpc(url: string, method: string, params: unknown, deadline = Date.now() + RPC_TIMEOUT_MS): Promise<RpcAnswer> {
  const timeout = Math.min(RPC_TIMEOUT_MS, deadline - Date.now());
  if (timeout < 250) return { transport: 'deadline passed' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeout),
      cache: 'no-store',
    });
    if (!res.ok) return { transport: `HTTP ${res.status}` };
    const body = (await res.json()) as { result?: unknown; error?: { name?: string; cause?: { name?: string } } };
    return body.error ? { error: body.error } : { result: body.result };
  } catch (error) {
    return { transport: message(error) };
  }
}

const isNotFound = (answer: RpcAnswer) =>
  'error' in answer && /UNKNOWN_TRANSACTION|TIMEOUT_ERROR/.test(`${answer.error.cause?.name ?? ''} ${answer.error.name ?? ''}`);

/**
 * nearcore uses `sender_account_id` only to pick the shard to look in, so any account on the
 * signer's shard finds the transaction. The signer is not in a share URL, so after a miss this
 * tries one account per shard from the live shard layout. Indexing RPCs answer on the first try.
 */
async function shardProbeAccounts(url: string, deadline: number): Promise<string[]> {
  const answer = await rpc(url, 'EXPERIMENTAL_protocol_config', { finality: 'final' }, deadline);
  if (!('result' in answer)) return [];
  const layout = (answer.result as { shard_layout?: Record<string, { boundary_accounts?: string[] }> }).shard_layout ?? {};
  const version = Object.values(layout)[0];
  return ['00', ...(version?.boundary_accounts ?? [])];
}

interface TxView extends OutcomeLike {
  transaction: { hash?: string; signer_id: string; receiver_id: string; actions: unknown[] };
  transaction_outcome: { block_hash: string; id: string; outcome: Record<string, unknown> };
}

async function fetchTx(urls: string[], hash: string, signer: string | null, deadline: number): Promise<TxView | 'not_found' | 'rpc'> {
  let sawChainAnswer = false;
  const attempt = async (url: string, sender: string): Promise<TxView | 'miss' | 'stop'> => {
    const answer = await rpc(url, 'tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' }, deadline);
    if ('result' in answer) {
      sawChainAnswer = true;
      const view = answer.result as Partial<TxView>;
      return view.transaction && view.status ? (view as TxView) : 'stop';
    }
    if (isNotFound(answer)) {
      sawChainAnswer = true;
      return 'miss';
    }
    return 'stop';
  };
  // Every endpoint once with the first guess (indexing and archival RPCs ignore the sender), then
  // one account per shard for nodes that route by it.
  for (const url of urls) {
    const found = await attempt(url, signer ?? 'near');
    if (typeof found === 'object') return found;
  }
  if (!signer && sawChainAnswer && urls[0]) {
    const probes = await shardProbeAccounts(urls[0], deadline);
    for (const url of urls) {
      for (const sender of probes) {
        if (Date.now() >= deadline) return 'not_found';
        const found = await attempt(url, sender);
        if (typeof found === 'object') return found;
        if (found === 'stop') break;
      }
    }
  }
  return sawChainAnswer ? 'not_found' : 'rpc';
}

function methodOf(actions: unknown[]): string {
  return actions
    .map((action) => {
      if (typeof action === 'string') return action;
      const [kind, body] = Object.entries(action as Record<string, { method_name?: string }>)[0] ?? ['?', {}];
      return kind === 'FunctionCall' ? (body.method_name ?? kind) : kind;
    })
    .join(' + ');
}

/** Reads a transaction by hash for the rob card. `signer` is optional and only speeds up the lookup. */
export async function loadRobTx(hash: string | null | undefined, signer?: string | null): Promise<RobTxData> {
  const config = networkConfig();
  const network = config?.network ?? null;
  if (!hash) return { kind: 'none', network, reason: 'no_tx' };
  if (!TX_HASH_PATTERN.test(hash) || !config) return { kind: 'none', network, reason: 'invalid' };

  const deadline = Date.now() + ROB_DEADLINE_MS;
  const archival = ARCHIVAL[config.network];
  const urls = archival && !process.env.NEXT_PUBLIC_NEAR_RPC_URL ? [...config.rpcUrls, archival] : config.rpcUrls;
  const view = await fetchTx(urls, hash, signer ?? null, deadline);
  if (view === 'not_found' || view === 'rpc') return { kind: 'none', network, reason: view };

  const status = view.status as { SuccessValue?: string; Failure?: unknown } | string;
  if (typeof status === 'string') return { kind: 'none', network, reason: 'pending' };

  let block: { height: number; time: string } | null = null;
  const blockHash = view.transaction_outcome?.block_hash;
  if (blockHash) {
    for (const url of urls) {
      const answer = await rpc(url, 'block', { block_id: blockHash }, Math.max(deadline, Date.now() + 2_000));
      if ('result' in answer) {
        const header = (answer.result as { header: { height: number; timestamp_nanosec: string } }).header;
        block = { height: header.height, time: new Date(Number(BigInt(header.timestamp_nanosec) / 1_000_000n)).toISOString() };
        break;
      }
    }
  }

  const failed = status.Failure !== undefined;
  const error = failed ? (rootCauseFailure(view) ?? describeContractError(status.Failure)) : loggedRefusal(view);
  const code = error?.code ?? null;
  return {
    kind: failed || error ? 'refused' : 'succeeded',
    network: config.network,
    hash,
    code,
    sentence: code ? (CONTRACT_ERRORS[code] ?? error?.message ?? '') : (error?.message ?? 'The transaction executed without a refusal.'),
    refunded: !failed && Boolean(error),
    method: methodOf(view.transaction.actions ?? []),
    signer: view.transaction.signer_id,
    receiver: view.transaction.receiver_id,
    blockHeight: block?.height ?? null,
    blockTime: block?.time ?? null,
    explorerUrl: transactionExplorerUrl('near', hash, config),
  };
}
