import 'server-only';

// Live checks for the verify page. Every value comes from a JSON-RPC call made during this render;
// nothing is cached across requests except code bytes, which are keyed by their own hash.

import { RegistryClient, VaultClient, type CompanyView, type VaultState } from '@/lib/contracts';
import { checkVaultAddresses } from '@/lib/mpcAddresses';
import { getNetworkConfig, MAINNET_USDC, type NetworkConfig } from '@/lib/near';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { EMPTY_CODE_HASH, embeddedIn, nearCodeHash, sha256Hex } from './wasm';

const RPC_TIMEOUT_MS = 10_000;
/** Vaults checked per render. Each costs about six RPC calls. */
export const MAX_VAULTS = 20;

export const MAINNET_RPC = ['https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com'];

export class RpcError extends Error {
  constructor(
    message: string,
    readonly unknownAccount = false,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

async function rpc<T>(urls: string[], method: string, params: unknown): Promise<T> {
  let last: Error | null = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'verify', method, params }),
        cache: 'no-store',
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
      const body = (await response.json()) as { result?: T & { error?: string }; error?: { cause?: { name?: string }; data?: unknown; message?: string } };
      if (body.error) {
        const cause = body.error.cause?.name ?? '';
        const detail = typeof body.error.data === 'string' ? body.error.data : (body.error.message ?? 'RPC error');
        // The chain's answer, not a transport failure: other endpoints would say the same.
        throw new RpcError(`${cause || detail}`, cause === 'UNKNOWN_ACCOUNT' || /does not exist/i.test(detail));
      }
      if (body.result && typeof body.result.error === 'string') throw new RpcError(body.result.error, /does not exist/i.test(body.result.error));
      return body.result as T;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      last = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw last ?? new Error('No RPC endpoint configured');
}

function query<T>(urls: string[], params: Record<string, unknown>): Promise<T> {
  return rpc<T>(urls, 'query', { finality: 'final', ...params });
}

export interface AccountView {
  amount: string;
  code_hash: string;
  storage_usage: number;
}

/** `view_account`, or null when the account does not exist. */
export async function viewAccount(urls: string[], accountId: string): Promise<AccountView | null> {
  try {
    return await query<AccountView>(urls, { request_type: 'view_account', account_id: accountId });
  } catch (error) {
    if (error instanceof RpcError && error.unknownAccount) return null;
    throw error;
  }
}

export interface AccessKeyEntry {
  public_key: string;
  access_key: { permission: 'FullAccess' | { FunctionCall: unknown } };
}

export async function viewAccessKeyList(urls: string[], accountId: string): Promise<AccessKeyEntry[]> {
  const result = await query<{ keys: AccessKeyEntry[] }>(urls, { request_type: 'view_access_key_list', account_id: accountId });
  return result.keys;
}

const codeCache = new Map<string, Uint8Array>();

/** `view_code`. Cached by code hash, which names the bytes exactly. */
export async function viewCode(urls: string[], accountId: string, codeHash: string): Promise<Uint8Array> {
  const cached = codeCache.get(codeHash);
  if (cached) return cached;
  const result = await query<{ code_base64: string; hash: string }>(urls, { request_type: 'view_code', account_id: accountId });
  const bytes = base64.decode(result.code_base64);
  if (nearCodeHash(bytes) !== codeHash) throw new Error(`view_code for ${accountId} returned bytes that do not hash to ${codeHash}`);
  codeCache.set(codeHash, bytes);
  return bytes;
}

export interface NodeStatus {
  chain_id: string;
  protocol_version: number;
  latest_protocol_version: number;
  sync_info: { latest_block_height: number; latest_block_time: string };
}

export function nodeStatus(urls: string[]): Promise<NodeStatus> {
  return rpc<NodeStatus>(urls, 'status', []);
}

// ---------------------------------------------------------------------------- Results

export type CheckStatus = 'pass' | 'fail' | 'info' | 'unavailable';

export interface ContractRow {
  role: string;
  network: string;
  accountId: string | null;
  status: CheckStatus;
  detail: string;
  codeHash: string | null;
  /** Explorer link applies only when this row is on the app's own network. */
  ownNetwork: boolean;
}

export interface VaultRow {
  tokenId: string;
  name: string;
  vault: string;
  encumbrance: string;
  keys: { status: CheckStatus; count: number | null; detail: string };
  code: { status: CheckStatus; hash: string | null; detail: string };
  addresses: { status: CheckStatus; detail: string; btc: string | null; evm: string | null; sol: string | null };
  charter: { status: CheckStatus; detail: string };
  rawSigsThisEpoch: number | null;
}

export interface RegistryReport {
  registryId: string;
  status: CheckStatus;
  detail: string;
  codeHash: string | null;
  repoMatch: CheckStatus;
  evidenceMatch: CheckStatus;
  fullAccessKeys: number | null;
  companies: number | null;
  vaults: VaultRow[];
  truncated: boolean;
  /** The registry's deployed code contains the bytes each distinct vault code hash names. */
  embedded: { status: CheckStatus; detail: string };
}

export interface LiveReport {
  config: NetworkConfig;
  node: { status: CheckStatus; detail: string; value: NodeStatus | null };
  mainnetNode: NodeStatus | null;
  contracts: ContractRow[];
  registry: RegistryReport | null;
  checkedAt: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encumbranceName(state: CompanyView['encumbrance']): string {
  if (state === 'Free') return 'FREE';
  return 'Listed' in state ? 'LISTED' : 'PLEDGED';
}

async function contractRow(
  role: string,
  network: string,
  urls: string[],
  accountId: string | null,
  ownNetwork: boolean,
  absentNote: string,
): Promise<ContractRow> {
  if (!accountId) return { role, network, accountId, status: 'info', detail: absentNote, codeHash: null, ownNetwork };
  try {
    const account = await viewAccount(urls, accountId);
    if (!account) return { role, network, accountId, status: 'fail', detail: 'Account does not exist', codeHash: null, ownNetwork };
    if (account.code_hash === EMPTY_CODE_HASH) {
      return { role, network, accountId, status: 'fail', detail: 'Account exists but holds no contract', codeHash: null, ownNetwork };
    }
    return {
      role,
      network,
      accountId,
      status: 'pass',
      detail: `Contract deployed, ${account.storage_usage.toLocaleString('en-US')} bytes of storage`,
      codeHash: account.code_hash,
      ownNetwork,
    };
  } catch (error) {
    return { role, network, accountId, status: 'unavailable', detail: message(error), codeHash: null, ownNetwork };
  }
}

/** Base64 sha256 of the SVG inside a `data:image/svg+xml;base64,` URI, the NEP-177 `media_hash` form. */
function mediaHashOf(media: string): string | null {
  const prefix = 'data:image/svg+xml;base64,';
  if (!media.startsWith(prefix)) return null;
  return base64.encode(sha256(base64.decode(media.slice(prefix.length))));
}

async function vaultRow(
  urls: string[],
  registry: RegistryClient,
  company: CompanyView,
  expectedVaultHash: string | null,
): Promise<{ row: VaultRow; codeHash: string | null }> {
  const vault = company.vault;
  const row: VaultRow = {
    tokenId: company.token_id,
    name: company.name,
    vault,
    encumbrance: encumbranceName(company.encumbrance),
    keys: { status: 'unavailable', count: null, detail: '' },
    code: { status: 'unavailable', hash: null, detail: '' },
    addresses: { status: 'unavailable', detail: '', btc: null, evm: null, sol: null },
    charter: { status: 'unavailable', detail: '' },
    rawSigsThisEpoch: null,
  };
  let codeHash: string | null = null;

  const [keys, account, state, token] = await Promise.allSettled([
    viewAccessKeyList(urls, vault),
    viewAccount(urls, vault),
    new VaultClient(vault).getState(),
    registry.nftToken(company.token_id),
  ]);

  if (keys.status === 'fulfilled') {
    const count = keys.value.length;
    row.keys = {
      status: count === 0 ? 'pass' : 'fail',
      count,
      detail: count === 0 ? 'view_access_key_list returned no keys' : `${count} access key(s): ${keys.value.map((k) => k.public_key).join(', ')}`,
    };
  } else {
    row.keys.detail = message(keys.reason);
  }

  if (account.status === 'fulfilled' && account.value) {
    codeHash = account.value.code_hash;
    const matches = expectedVaultHash !== null && codeHash === expectedVaultHash;
    row.code = {
      status: expectedVaultHash === null ? 'info' : matches ? 'pass' : 'fail',
      hash: codeHash,
      detail:
        expectedVaultHash === null
          ? 'contracts/res/company_vault.wasm is not in this deployment, so there is nothing to compare with'
          : matches
            ? 'Equals the hash of contracts/res/company_vault.wasm'
            : `Differs from contracts/res/company_vault.wasm (${expectedVaultHash})`,
    };
  } else {
    row.code.detail = account.status === 'rejected' ? message(account.reason) : 'Vault account does not exist';
    if (account.status === 'fulfilled') row.code.status = 'fail';
  }

  if (state.status === 'fulfilled') {
    const s: VaultState = state.value;
    row.rawSigsThisEpoch = s.raw_sigs_this_epoch;
    const stored = s.addresses ?? null;
    row.addresses.btc = stored?.btc ?? null;
    row.addresses.evm = stored?.evm ?? null;
    row.addresses.sol = stored?.sol ?? null;
    if (!stored) {
      row.addresses = { ...row.addresses, status: 'info', detail: 'No addresses stored yet. Anyone can call refresh_treasury_keys.' };
    } else {
      try {
        const { comparison } = await checkVaultAddresses(vault, s);
        row.addresses.status = comparison.match ? 'pass' : 'fail';
        row.addresses.detail = comparison.match
          ? `Stored epoch ${s.treasury_epoch} addresses equal an off-chain derivation from ${s.mpc_contract}`
          : comparison.reason === 'mismatch'
            ? `Differs from the off-chain derivation in: ${comparison.mismatches.map((m) => m.field).join(', ')}`
            : 'No addresses stored';
      } catch (error) {
        row.addresses.detail = `Could not derive from the signer: ${message(error)}`;
      }
    }
  } else {
    row.addresses.detail = message(state.reason);
  }

  if (token.status === 'fulfilled' && token.value?.metadata?.media) {
    const { media, media_hash } = token.value.metadata;
    const computed = mediaHashOf(media);
    row.charter =
      computed === null
        ? { status: 'fail', detail: 'media is not an inline SVG data URI' }
        : computed === media_hash
          ? { status: 'pass', detail: 'sha256 of the on-chain SVG equals media_hash' }
          : { status: 'fail', detail: `media_hash ${media_hash ?? 'missing'} differs from the SVG hash ${computed}` };
  } else {
    row.charter.detail = token.status === 'rejected' ? message(token.reason) : 'Token has no media';
  }

  return { row, codeHash };
}

async function registryReport(
  config: NetworkConfig,
  repo: { vaultWasm: Uint8Array | null; registryWasm: Uint8Array | null },
  evidenceRegistryHash: string | null,
): Promise<RegistryReport | null> {
  const registryId = config.registryId;
  if (!registryId) return null;
  const urls = config.rpcUrls;
  const report: RegistryReport = {
    registryId,
    status: 'unavailable',
    detail: '',
    codeHash: null,
    repoMatch: 'unavailable',
    evidenceMatch: 'unavailable',
    fullAccessKeys: null,
    companies: null,
    vaults: [],
    truncated: false,
    embedded: { status: 'unavailable', detail: 'No vaults to compare' },
  };

  let account: AccountView | null;
  try {
    account = await viewAccount(urls, registryId);
  } catch (error) {
    report.detail = message(error);
    return report;
  }
  if (!account) {
    report.status = 'fail';
    report.detail = `${registryId} does not exist on ${config.network}`;
    return report;
  }
  if (account.code_hash === EMPTY_CODE_HASH) {
    report.status = 'fail';
    report.detail = `${registryId} exists but holds no contract`;
    return report;
  }
  report.status = 'pass';
  report.codeHash = account.code_hash;
  report.detail = `Contract deployed, ${account.storage_usage.toLocaleString('en-US')} bytes of storage`;
  report.repoMatch = repo.registryWasm ? (nearCodeHash(repo.registryWasm) === account.code_hash ? 'pass' : 'fail') : 'unavailable';
  report.evidenceMatch = evidenceRegistryHash ? (evidenceRegistryHash === account.code_hash ? 'pass' : 'fail') : 'unavailable';

  const registry = new RegistryClient(registryId);
  const [keys, companies] = await Promise.allSettled([viewAccessKeyList(urls, registryId), registry.listCompanies(0, MAX_VAULTS + 1)]);
  if (keys.status === 'fulfilled') report.fullAccessKeys = keys.value.filter((k) => k.access_key.permission === 'FullAccess').length;
  if (companies.status === 'rejected') {
    report.detail += `. list_companies failed: ${message(companies.reason)}`;
    return report;
  }
  report.truncated = companies.value.length > MAX_VAULTS;
  const checked = companies.value.slice(0, MAX_VAULTS);
  try {
    report.companies = Number(await registry.nftTotalSupply());
  } catch {
    report.companies = companies.value.length;
  }

  const expectedVaultHash = repo.vaultWasm ? nearCodeHash(repo.vaultWasm) : null;
  const results = await Promise.all(checked.map((c) => vaultRow(urls, registry, c, expectedVaultHash)));
  report.vaults = results.map((r) => r.row);

  // Each distinct vault code must appear byte for byte inside the registry's deployed code.
  const byHash = new Map<string, string>();
  for (const { row, codeHash } of results) if (codeHash && codeHash !== EMPTY_CODE_HASH && !byHash.has(codeHash)) byHash.set(codeHash, row.vault);
  if (byHash.size > 0) {
    try {
      const registryCode = await viewCode(urls, registryId, account.code_hash);
      const outcomes = await Promise.all(
        [...byHash].map(async ([hash, vault]) => ({ hash, found: embeddedIn(registryCode, await viewCode(urls, vault, hash)) })),
      );
      const missing = outcomes.filter((o) => !o.found);
      const vaultSha = outcomes.length === 1 && outcomes[0] ? sha256Hex(codeCache.get(outcomes[0].hash) as Uint8Array) : null;
      report.embedded =
        missing.length === 0
          ? {
              status: 'pass',
              detail: `${outcomes.length === 1 ? 'The vault code' : `All ${outcomes.length} distinct vault codes`} (view_code) ${outcomes.length === 1 ? 'appears' : 'appear'} byte for byte in the registry's deployed code (view_code)${vaultSha ? `. Vault sha256 ${vaultSha}` : ''}`,
            }
          : { status: 'fail', detail: `Vault code ${missing.map((m) => m.hash).join(', ')} is not inside the registry's code` };
    } catch (error) {
      report.embedded = { status: 'unavailable', detail: message(error) };
    }
  }
  return report;
}

export async function runLiveChecks(
  repo: { vaultWasm: Uint8Array | null; registryWasm: Uint8Array | null },
  evidenceRegistryHash: string | null,
): Promise<LiveReport> {
  const config = getNetworkConfig();
  const urls = config.rpcUrls;
  const onMainnet = config.network === 'mainnet';

  const nodePromise = nodeStatus(urls).then(
    (value) => ({ status: 'pass' as CheckStatus, detail: `${value.chain_id}, protocol ${value.protocol_version}`, value }),
    (error) => ({ status: 'unavailable' as CheckStatus, detail: message(error), value: null }),
  );
  const mainnetNodePromise = onMainnet ? Promise.resolve(null) : nodeStatus(MAINNET_RPC).catch(() => null);

  const own = config.network;
  const contractRows: Promise<ContractRow>[] = [
    contractRow('Chain Signatures signer', own, urls, config.mpcContract, true, ''),
    contractRow(
      'NEAR Intents verifier',
      own,
      urls,
      config.intentsContract,
      true,
      own === 'testnet' ? 'No intents.near deployment exists on testnet. Intents settle on mainnet only.' : 'Not configured',
    ),
    contractRow('USDC token', own, urls, config.usdcToken, true, 'NEXT_PUBLIC_USDC_CONTRACT_ID is not set. Test USDC is deployed with the registry.'),
  ];
  if (!onMainnet) {
    contractRows.push(
      contractRow('Chain Signatures signer', 'mainnet', MAINNET_RPC, 'v1.signer', false, ''),
      contractRow('NEAR Intents verifier', 'mainnet', MAINNET_RPC, 'intents.near', false, ''),
      contractRow('USDC token (Circle)', 'mainnet', MAINNET_RPC, MAINNET_USDC, false, ''),
    );
  }

  const [node, mainnetNode, contracts, registry] = await Promise.all([
    nodePromise,
    mainnetNodePromise,
    Promise.all(contractRows),
    registryReport(config, repo, evidenceRegistryHash),
  ]);

  return { config, node, mainnetNode, contracts, registry, checkedAt: new Date().toISOString() };
}
