import 'server-only';

// 1Click API client (OpenAPI: 1click.chaindefuser.com), the solver relay, and payload builders for
// intents the vault signed. `intents.near` and 1Click settle on mainnet only.

import { randomBytes } from 'node:crypto';
import { base64 } from '@scure/base';
import { RegistryClient, VaultClient, ftViews, type Payment, type SignedIntent } from './contracts';
import type { OneClickToken, QuoteRequest, QuoteResponse, StatusResponse } from './intentsQuotes';
import { getNetworkConfig, getProvider, viewFunction } from './near';
import {
  bestSolverQuote,
  decodeIntentNonce,
  encodeIntentNonce,
  parseIntentStatus,
  parsePublishResult,
  parseSolverQuotes,
  publishIntentParams,
  solverQuoteParams,
  type IntentStatus,
  type PublishIntentPayload,
  type PublishIntentResult,
  type RelayIntentStatus,
  type SolverQuote,
  type SolverQuoteRequest,
} from './rebalance';

const oneClickUrl = () => (process.env.NEAR_INTENTS_ONE_CLICK_URL || 'https://1click.chaindefuser.com/v0').replace(/\/$/, '');
const solverRpcUrl = () => process.env.NEAR_INTENTS_SOLVER_RPC_URL || 'https://solver-relay-v2.chaindefuser.com/rpc';

export class OneClickError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'OneClickError';
  }

  /** The smallest amount 1Click named, when it rejected a quote as too small. */
  get minimumAmount(): string | null {
    return /try at least (\d+)/i.exec(this.message)?.[1] ?? null;
  }
}

export class SolverRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolverRelayError';
  }
}

export class NotAVaultError extends Error {
  constructor(recipient: string, reason: string) {
    super(`${recipient} cannot receive a customRecipientMsg payment: ${reason}`);
    this.name = 'NotAVaultError';
  }
}

export {
  MAINNET_USDC_ASSET,
  TERMINAL_STATUSES,
  buildSelfDeliveryQuote,
  buildVaultPaymentQuote,
  nep141Contract,
  vaultPaymentMsg,
} from './intentsQuotes';
export type {
  DepositType,
  ExecutionStatus,
  OneClickToken,
  QuoteDetails,
  QuoteRequest,
  QuoteResponse,
  RecipientType,
  RefundType,
  StatusResponse,
  SwapType,
} from './intentsQuotes';

function oneClickHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (process.env.NEAR_INTENTS_JWT) headers.authorization = `Bearer ${process.env.NEAR_INTENTS_JWT}`;
  return headers;
}

async function oneClick<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${oneClickUrl()}${path}`, {
      ...init,
      headers: oneClickHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new OneClickError(502, `1Click request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = `1Click returned HTTP ${res.status}`;
    let correlationId: string | undefined;
    try {
      const body = JSON.parse(text) as { message?: string; correlationId?: string };
      if (body.message) message = body.message;
      correlationId = body.correlationId;
    } catch {
      // Keep the status message: a non-JSON body is not safe to relay.
    }
    throw new OneClickError(res.status, message, correlationId);
  }
  return JSON.parse(text) as T;
}

let tokensCache: { at: number; tokens: OneClickToken[] } | null = null;
const TOKENS_CACHE_MS = 60_000;

export async function getTokens(): Promise<OneClickToken[]> {
  if (tokensCache && Date.now() - tokensCache.at < TOKENS_CACHE_MS) return tokensCache.tokens;
  const tokens = await oneClick<OneClickToken[]>('/tokens');
  tokensCache = { at: Date.now(), tokens };
  return tokens;
}

/** `dry: true` previews. `dry: false` commits and returns a deposit address; depositing is what spends. */
export function getQuote(request: QuoteRequest): Promise<QuoteResponse> {
  return oneClick<QuoteResponse>('/quote', { method: 'POST', body: JSON.stringify(request) });
}

export function getStatus(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
  const params = new URLSearchParams({ depositAddress });
  if (depositMemo) params.set('depositMemo', depositMemo);
  return oneClick<StatusResponse>(`/status?${params}`);
}

export interface DepositSubmit {
  txHash: string;
  depositAddress: string;
  nearSenderAccount?: string;
  memo?: string;
}

export function submitDeposit(body: DepositSubmit): Promise<Record<string, unknown>> {
  return oneClick<Record<string, unknown>>('/deposit/submit', { method: 'POST', body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------- Paying a vault

const VAULT_ACCOUNT = /^c-(\d+)\.(.+)$/;

/**
 * Required before any quote that sets `customRecipientMsg`. The 1Click OpenAPI marks that field
 * **HIGHLY EXPERIMENTAL** and warns that funds are lost with a non-NEP-141 token, without a
 * `storage_deposit`, or if the recipient lacks `ft_on_transfer`. Each condition is checked here
 * against chain state, because a wrong recipient cannot be recovered afterwards:
 *
 * - the recipient is the vault the registry records for its token, it names that registry, and it
 *   has no access keys
 * - the destination asset is the vault's USDC, the only token its `ft_on_transfer` books
 * - the vault holds a `storage_deposit` on that token
 * - the amount meets the vault's price and the call id is unused, or the vault would refund the
 *   solver, which is not the customer
 */
export async function assertRecipientIsVault(params: {
  recipient: string;
  destinationAsset: string;
  amount: string;
  callId: string;
  registryId: string;
}): Promise<void> {
  const { recipient, destinationAsset, amount, callId, registryId } = params;
  const match = VAULT_ACCOUNT.exec(recipient);
  if (!match || match[2] !== registryId) {
    throw new NotAVaultError(recipient, `the account is not c-<id>.${registryId}`);
  }
  const company = await new RegistryClient(registryId, { finality: 'optimistic' }).getCompany(match[1] as string);
  if (!company || company.vault !== recipient) {
    throw new NotAVaultError(recipient, 'the registry records no such vault');
  }
  const vault = new VaultClient(recipient, { finality: 'optimistic' });
  const state = await vault.getState();
  if (state.registry !== registryId || state.token_id !== company.token_id) {
    throw new NotAVaultError(recipient, 'the vault does not name this registry and token');
  }
  const keys = await getProvider().viewAccessKeyList({ accountId: recipient, finalityQuery: { finality: 'final' } });
  if (keys.keys.length > 0) {
    throw new NotAVaultError(recipient, 'the account has access keys, and a vault has none');
  }
  if (destinationAsset !== `nep141:${state.usdc_token}`) {
    throw new NotAVaultError(recipient, `the vault books only nep141:${state.usdc_token}`);
  }
  const storage = await ftViews.storageBalanceOf(state.usdc_token, recipient);
  if (!storage) {
    throw new NotAVaultError(recipient, `the vault has no storage deposit on ${state.usdc_token}`);
  }
  if (BigInt(amount) < BigInt(state.price_micro_usdc)) {
    throw new NotAVaultError(recipient, `amount ${amount} is below the price ${state.price_micro_usdc}`);
  }
  if ((await vault.getPayment(callId)) !== null) {
    throw new NotAVaultError(recipient, `call id ${callId} is already paid`);
  }
}

export interface VaultPaymentState {
  /** True only when the vault holds a payment record for this call id. */
  booked: boolean;
  payment: Payment | null;
  /** The vault's price now, for comparison with what was sent. */
  price_micro_usdc: string;
}

/**
 * Whether a payment is booked, read from the vault at optimistic finality. A 1Click SUCCESS or a
 * successful `ft_transfer_call` transaction does not imply this: the vault returns any payment it
 * does not accept, and the transfer still succeeds.
 */
export async function vaultPaymentState(vault: string, callId: string): Promise<VaultPaymentState> {
  const client = new VaultClient(vault, { finality: 'optimistic' });
  const [payment, state] = await Promise.all([client.getPayment(callId), client.getState()]);
  return { booked: payment !== null, payment, price_micro_usdc: state.price_micro_usdc };
}

// ---------------------------------------------------------------------------- Intent nonces

/** See `encodeIntentNonce` in ./rebalance for the layout and the deployed revision it follows. */
export function buildIntentNonce(saltHex: string, deadlineMs: number, random: Uint8Array = randomBytes(15)): string {
  return encodeIntentNonce(saltHex, deadlineMs, random);
}

export const parseIntentNonce = decodeIntentNonce;

/** Random 32 bytes. Valid for the vault, and for a verifier that does not use salts. */
export function randomNonce(): string {
  return base64.encode(randomBytes(32));
}

export function currentSalt(intentsContract: string): Promise<string> {
  return viewFunction<string>(intentsContract, 'current_salt');
}

// ---------------------------------------------------------------------------- Vault-signed intents

/** Argument of `intents.near.execute_intents`. A `token_diff` still needs a matching counterparty. */
export function buildExecuteIntentsArgs(signed: SignedIntent): { signed: SignedIntent[] } {
  return { signed: [signed] };
}

export type { IntentStatus, PublishIntentPayload, PublishIntentResult, RelayIntentStatus, SolverQuote };
export { bestSolverQuote };

/** Solver relay `publish_intent` params. The quote hashes name the solver quotes this intent fills. */
export function buildPublishIntentPayload(signed: SignedIntent, quoteHashes: string[]): PublishIntentPayload {
  if (quoteHashes.length === 0) throw new SolverRelayError('publish_intent needs at least one quote hash');
  return publishIntentParams(signed, quoteHashes);
}

/**
 * The relay documentation asks for a partner key in `X-API-Key`. `quote` answers without one;
 * set NEAR_INTENTS_RELAY_API_KEY if `publish_intent` refuses.
 */
function relayHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.NEAR_INTENTS_RELAY_API_KEY) headers['x-api-key'] = process.env.NEAR_INTENTS_RELAY_API_KEY;
  return headers;
}

async function solverRpc<T>(method: string, params: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(solverRpcUrl(), {
      method: 'POST',
      headers: relayHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [params] }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new SolverRelayError(`Solver relay request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) throw new SolverRelayError(`Solver relay returned HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string; data?: unknown } };
  if (body.error) {
    const detail = body.error.data === undefined ? '' : `: ${JSON.stringify(body.error.data).slice(0, 300)}`;
    throw new SolverRelayError(`${body.error.message ?? `${method} failed`}${detail}`);
  }
  return body.result as T;
}

/**
 * Live solver quotes, filtered to offers for exactly this pair and amount that have not expired.
 * Solvers often answer null for a pair: this returns an empty list, not an error.
 */
export async function solverQuote(params: SolverQuoteRequest): Promise<SolverQuote[]> {
  const result = await solverRpc<unknown>('quote', solverQuoteParams(params));
  try {
    return parseSolverQuotes(result, params, Date.now());
  } catch (error) {
    throw new SolverRelayError(error instanceof Error ? error.message : String(error));
  }
}

/** Sends the intent. Mainnet only: the relay settles on `intents.near`. */
export async function publishIntent(payload: PublishIntentPayload): Promise<PublishIntentResult> {
  if (getNetworkConfig().network !== 'mainnet') {
    throw new SolverRelayError('The solver relay settles on mainnet only');
  }
  return parsePublishResult(await solverRpc<unknown>('publish_intent', payload));
}

export async function intentStatus(intentHash: string): Promise<IntentStatus> {
  try {
    return parseIntentStatus(await solverRpc<unknown>('get_status', { intent_hash: intentHash }));
  } catch (error) {
    if (error instanceof SolverRelayError) throw error;
    throw new SolverRelayError(error instanceof Error ? error.message : String(error));
  }
}

/** Polls `get_status` until SETTLED, NOT_FOUND_OR_NOT_VALID three times in a row, or `timeoutMs`. Returns the last status seen. */
export async function waitForIntent(intentHash: string, { timeoutMs = 90_000, intervalMs = 2_000 } = {}): Promise<IntentStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: IntentStatus | null = null;
  let notFound = 0;
  for (;;) {
    try {
      last = await intentStatus(intentHash);
      // A read just after publish_intent can miss the intent; only a repeated answer is final.
      notFound = last.status === 'NOT_FOUND_OR_NOT_VALID' ? notFound + 1 : 0;
      if (last.status === 'SETTLED' || notFound >= 3) return last;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) {
      return last ?? { intent_hash: intentHash, status: 'PENDING', status_details: 'no answer before the timeout', tx_hash: null, filled_amounts: null };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** `intents.near` balance of one asset. The sandbox and testnet stand-in answers the same method. */
export function intentsBalance(intentsContract: string, accountId: string, tokenId: string): Promise<string> {
  return viewFunction<string>(intentsContract, 'mt_balance_of', { account_id: accountId, token_id: tokenId });
}

/** Balances of several assets, read one by one so the sandbox stand-in (no `mt_batch_balance_of`) answers too. */
export async function intentsBalances(intentsContract: string, accountId: string, tokenIds: string[]): Promise<Record<string, string>> {
  const values = await Promise.all(tokenIds.map((id) => intentsBalance(intentsContract, accountId, id)));
  return Object.fromEntries(tokenIds.map((id, i) => [id, values[i] as string]));
}

/**
 * Whether `intents.near` lists `publicKey` for `accountId`. Uses `has_public_key` and falls back
 * to `public_keys_of`, the only one of the two the sandbox stand-in implements.
 */
export async function intentsHasPublicKey(intentsContract: string, accountId: string, publicKey: string): Promise<boolean> {
  try {
    return await viewFunction<boolean>(intentsContract, 'has_public_key', { account_id: accountId, public_key: publicKey });
  } catch {
    const keys = await viewFunction<string[]>(intentsContract, 'public_keys_of', { account_id: accountId });
    return keys.includes(publicKey);
  }
}
