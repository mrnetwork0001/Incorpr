// Rebalance proposal maths, the vault's TEE request format (docs/ARCHITECTURE.md section 4), and
// the solver relay and NEP-413 checks for executing a vault-signed swap.
// Pure code: no network or secrets. The route in app/api/rebalance and scripts/rebalance.mjs do
// the I/O. Node imports this file directly (type stripping), so it uses erasable syntax only.

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import type { SignedIntent, SwapProposal, TeeRequest, VaultState, WithdrawProposal } from './contracts';

/**
 * The prompt a shareholder pins with `tee_prompt_hash`. Changing a byte changes the hash, and every
 * vault then refuses approvals until its shareholder calls `set_tee_policy` with the new hash.
 */
export const TREASURY_SYSTEM_PROMPT =
  'You review treasury proposals for an on-chain company vault. The user message has two lines. ' +
  'Line 1 is a proposal: incorpr:v2:<vault>:<epoch>:<generation>:<kind>:<fields>:<nonce>. ' +
  'Line 2 is proposal_hash=<hex>. The vault has already enforced its token allowlist, spend cap and price floor. ' +
  'If line 1 is one well-formed proposal with positive amounts, reply with exactly: APPROVE <hex> ' +
  'using the hex from line 2. Otherwise reply with exactly: REJECT <short reason>. ' +
  'Reply with one line and nothing else.';

function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

export function treasuryPromptHash(): string {
  return sha256Hex(TREASURY_SYSTEM_PROMPT);
}

export interface ProposalContext {
  vaultAccount: string;
  treasuryEpoch: number;
  ownerGeneration: number;
}

export function swapFields(p: SwapProposal): string {
  return [p.sell_token, p.sell_amount, p.buy_token, p.min_buy_amount].join(':');
}

export function withdrawFields(p: WithdrawProposal): string {
  return [p.token, p.amount, p.destination, p.chain].join(':');
}

/** Same bytes as `tee_request` in company-vault. JSON.stringify and serde_json escape text identically. */
export function buildTeeRequest(
  context: ProposalContext,
  kind: 'swap' | 'withdraw',
  fields: string,
  nonceB64: string,
  model: string,
  systemPrompt: string,
): TeeRequest {
  const preimage = `incorpr:v2:${context.vaultAccount}:${context.treasuryEpoch}:${context.ownerGeneration}:${kind}:${fields}:${nonceB64}`;
  const proposalHash = sha256Hex(preimage);
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${preimage}\nproposal_hash=${proposalHash}` },
    ],
    stream: false,
  });
  return { body, proposal_hash: proposalHash };
}

export function buildSwapTeeRequest(context: ProposalContext, p: SwapProposal, model: string, systemPrompt: string): TeeRequest {
  return buildTeeRequest(context, 'swap', swapFields(p), p.nonce_b64, model, systemPrompt);
}

export function buildWithdrawTeeRequest(
  context: ProposalContext,
  p: WithdrawProposal,
  model: string,
  systemPrompt: string,
): TeeRequest {
  return buildTeeRequest(context, 'withdraw', withdrawFields(p), p.nonce_b64, model, systemPrompt);
}

export type ApprovalDecision =
  | { approved: true; created: number }
  | { approved: false; reason: string; modelOutput: string | null };

/**
 * The model's output is untrusted text. This applies the vault's own rule and accepts nothing else:
 * one choice whose trimmed content is exactly `APPROVE <proposal_hash>`, with a numeric `created`.
 */
export function parseApproval(responseBody: string, proposalHash: string): ApprovalDecision {
  let parsed: { created?: unknown; choices?: { message?: { content?: unknown } }[] };
  try {
    parsed = JSON.parse(responseBody) as typeof parsed;
  } catch {
    return { approved: false, reason: 'response is not JSON', modelOutput: null };
  }
  if (!Array.isArray(parsed.choices) || parsed.choices.length !== 1) {
    return { approved: false, reason: 'response must have exactly one choice', modelOutput: null };
  }
  const content = parsed.choices[0]?.message?.content;
  if (typeof content !== 'string') {
    return { approved: false, reason: 'choice has no text content', modelOutput: null };
  }
  const modelOutput = content.slice(0, 500);
  if (content.trim() !== `APPROVE ${proposalHash}`) {
    return { approved: false, reason: 'model did not approve this proposal hash', modelOutput };
  }
  if (typeof parsed.created !== 'number' || !Number.isSafeInteger(parsed.created)) {
    return { approved: false, reason: 'response has no usable created time', modelOutput };
  }
  return { approved: true, created: parsed.created };
}

export interface TreasuryHolding {
  /** nep141 id, as listed in `allowed_tokens`. */
  asset: string;
  balance: bigint;
  decimals: number;
  /** USD per whole token, in millionths. Sizes the trade only: the amount out comes from a live quote. */
  priceMicroUsd: bigint;
}

export interface RebalanceInput {
  /** BTC, SOL, USDC. Same order as `target_bps`. */
  holdings: [TreasuryHolding, TreasuryHolding, TreasuryHolding];
  targetBps: [number, number, number];
  minDriftBps: number;
  /** Amount the vault's epoch cap still allows, per asset. A missing asset has a cap of zero. */
  capRemaining: Map<string, bigint>;
  /** Assets not to buy, for example one no solver quotes. The next most underweight is used. */
  excludeBuy?: string[];
}

export type RebalancePlan =
  | { kind: 'noop'; reason: string; driftBps: number[]; totalMicroUsd: string }
  | {
      kind: 'swap';
      sell: TreasuryHolding;
      buy: TreasuryHolding;
      sellAmount: bigint;
      cappedByEpochLimit: boolean;
      driftBps: number[];
      totalMicroUsd: string;
    };

function valueMicroUsd(holding: TreasuryHolding): bigint {
  return (holding.balance * holding.priceMicroUsd) / 10n ** BigInt(holding.decimals);
}

/** Sells the most overweight asset into the most underweight, up to whichever gap closes first. */
export function planRebalance(input: RebalanceInput): RebalancePlan {
  const values = input.holdings.map(valueMicroUsd);
  const total = values.reduce((sum, value) => sum + value, 0n);
  if (total === 0n) {
    return { kind: 'noop', reason: 'treasury holds nothing on intents', driftBps: [0, 0, 0], totalMicroUsd: '0' };
  }
  const targets = input.targetBps.map((bps) => (total * BigInt(bps)) / 10_000n);
  const driftBps = values.map((value, i) => Number((value * 10_000n) / total) - (input.targetBps[i] as number));

  let sellIndex = 0;
  driftBps.forEach((drift, i) => {
    if (drift > (driftBps[sellIndex] as number)) sellIndex = i;
  });
  const excluded = new Set(input.excludeBuy ?? []);
  let buyIndex = -1;
  driftBps.forEach((drift, i) => {
    if (i === sellIndex || excluded.has((input.holdings[i] as TreasuryHolding).asset)) return;
    if (buyIndex < 0 || drift < (driftBps[buyIndex] as number)) buyIndex = i;
  });
  const base = { driftBps, totalMicroUsd: total.toString() };
  if ((driftBps[sellIndex] as number) < input.minDriftBps) {
    return { kind: 'noop', reason: `largest drift is below ${input.minDriftBps} bps`, ...base };
  }
  if (buyIndex < 0) {
    return { kind: 'noop', reason: 'no asset left to buy', ...base };
  }

  const sell = input.holdings[sellIndex] as TreasuryHolding;
  const buy = input.holdings[buyIndex] as TreasuryHolding;
  const excess = (values[sellIndex] as bigint) - (targets[sellIndex] as bigint);
  const shortfall = (targets[buyIndex] as bigint) - (values[buyIndex] as bigint);
  if (shortfall <= 0n) {
    return { kind: 'noop', reason: `${buy.asset} is not below its target`, ...base };
  }
  const tradeMicroUsd = excess < shortfall ? excess : shortfall;

  let sellAmount = (tradeMicroUsd * 10n ** BigInt(sell.decimals)) / sell.priceMicroUsd;
  if (sellAmount > sell.balance) sellAmount = sell.balance;

  const cap = input.capRemaining.get(sell.asset) ?? 0n;
  const cappedByEpochLimit = sellAmount > cap;
  if (cappedByEpochLimit) sellAmount = cap;
  if (sellAmount <= 0n) {
    return { kind: 'noop', reason: `epoch cap for ${sell.asset} has no room left`, ...base };
  }
  return { kind: 'swap', sell, buy, sellAmount, cappedByEpochLimit, ...base };
}

const EPOCH_MS = 86_400_000;

/** What `charge_epoch_spend` would still allow per token, given the vault's current window. */
export function epochCapRemaining(state: Pick<VaultState, 'policy' | 'spend_window' | 'spent_this_window'>, nowMs: number): Map<string, bigint> {
  const window = Math.floor(nowMs / EPOCH_MS);
  const spent = new Map(state.spend_window === window ? state.spent_this_window.map(([t, a]) => [t, BigInt(a)]) : []);
  return new Map(
    state.policy.epoch_caps.map(([token, cap]) => {
      const left = BigInt(cap) - (spent.get(token) ?? 0n);
      return [token, left > 0n ? left : 0n] as const;
    }),
  );
}

/**
 * The floor the vault enforces, rounded up to the smallest amount that passes
 * `min_buy * per_sell >= sell * floor_min_buy`. Null when the pair has no floor, which the vault refuses.
 */
export function priceFloorMinBuy(
  state: Pick<VaultState, 'policy'>,
  sellToken: string,
  buyToken: string,
  sellAmount: bigint,
): bigint | null {
  const floor = state.policy.price_floors.find((f) => f.sell_token === sellToken && f.buy_token === buyToken);
  if (!floor) return null;
  const perSell = BigInt(floor.per_sell);
  return (sellAmount * BigInt(floor.min_buy) + perSell - 1n) / perSell;
}

// ---------------------------------------------------------------------------- Execution settings

/**
 * Attached gas, in TGas, for the operator calls of one rebalance. The app route and
 * scripts/rebalance.mjs both use these. Measured on a sandbox running the same vault wasm as
 * mainnet; see each entry. NEAR refuses a transaction before inclusion unless the signer can
 * prepay about 10 x gas_price x attached gas, so they are kept close to what the calls need.
 */
export const REBALANCE_GAS_TGAS = {
  /**
   * Static: derived_public_key 30 TGas (plus unused gas, weight 1) and a 30 TGas callback that
   * calls add_public_key. Sandbox burn: 14 TGas in total.
   */
  setupIntentsKey: 80,
  /** Static: ft_transfer_call to intents.near 80 TGas (plus unused gas) and a 15 TGas callback. Sandbox burn: 14 TGas. */
  deposit: 120,
  /**
   * The vault's own receipt burns 3.6 TGas (TEE proof parsing, two sha256, ecrecover), then
   * forwards all but 20 TGas to the MPC signer and refuses below 50 (ERR_INSUFFICIENT_GAS_FOR_SIGNATURE).
   * 90 forwards about 66. v1.signer itself requires 15 (`config.sign_call_gas_attachment_requirement_tera_gas`).
   */
  swap: 90,
  /** The shareholder's ft_transfer_call into the vault, used by the script to fund retained earnings. Sandbox burn: 10 TGas. */
  fund: 80,
  /** A plain USDC ft_transfer that hands the shareholder the funding amount first. */
  transfer: 30,
} as const;

/**
 * `min_deadline_ms` values tried in order. The relay forwards a quote to solvers for 3 s; on
 * 2026-11-06 a 0.5 USDC -> SOL request was answered at 60, 120 and 180 s and not at 240 or 300 s.
 * The longest that is answered leaves the most time for the TEE call and the MPC signature.
 */
export const SOLVER_MIN_DEADLINES_MS: readonly number[] = [180_000, 120_000, 60_000];

// ---------------------------------------------------------------------------- Funding

/**
 * The smallest single payment that raises retained earnings by `shortfall`. `ft_on_transfer` books
 * any amount at or above the price: `amount * reserve_bps / 10000` (rounded down) goes to the
 * compute reserve and the rest to retained earnings. Null when the reserve takes everything.
 */
export function fundingPaymentFor(shortfall: bigint, computeReserveBps: number, priceMicroUsdc: bigint): bigint | null {
  if (shortfall <= 0n) return 0n;
  const keepBps = 10_000n - BigInt(computeReserveBps);
  if (keepBps <= 0n) return null;
  // Retained part = amount - floor(amount * reserve / 10000) = ceil(amount * keep / 10000), which
  // reaches `shortfall` exactly when amount * keep > (shortfall - 1) * 10000.
  const amount = ((shortfall - 1n) * 10_000n) / keepBps + 1n;
  return amount < priceMicroUsdc ? priceMicroUsdc : amount;
}

/** What `ft_on_transfer` adds to retained earnings for one payment of `amount`. */
export function retainedFromPayment(amount: bigint, computeReserveBps: number): bigint {
  return amount - (amount * BigInt(computeReserveBps)) / 10_000n;
}

// ---------------------------------------------------------------------------- intents.near nonces

const VERSIONED_MAGIC_PREFIX = Uint8Array.of(0x56, 0x28, 0xf6, 0xc6);
const NONCE_VERSION_V1 = 0;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * `intents.near` V1 nonce: magic (4) || version 0 (1) || salt (4) || deadline ns, i64 LE (8) ||
 * random (15). Layout from near/intents rev 16d04f6, contracts/defuse/core/src/nonce/versioned.rs,
 * the revision `intents.near` reports in `contract_source_metadata`. The verifier refuses a salt
 * it has rotated out (`InvalidSalt`), an intent whose deadline is after the nonce's
 * (`DeadlineGreaterThanNonce`), and an expired nonce (`NonceExpired`).
 */
export function encodeIntentNonce(saltHex: string, deadlineMs: number, random: Uint8Array): string {
  if (!/^[0-9a-f]{8}$/i.test(saltHex)) throw new Error(`Invalid salt ${saltHex}`);
  if (random.length !== 15) throw new Error('Nonce needs 15 random bytes');
  const nonce = new Uint8Array(32);
  nonce.set(VERSIONED_MAGIC_PREFIX, 0);
  nonce[4] = NONCE_VERSION_V1;
  nonce.set(hexToBytes(saltHex.toLowerCase()), 5);
  new DataView(nonce.buffer).setBigInt64(9, BigInt(deadlineMs) * 1_000_000n, true);
  nonce.set(random, 17);
  return base64.encode(nonce);
}

/** Salt and deadline of a V1 nonce, or null for a nonce in another layout (which the verifier treats as legacy). */
export function decodeIntentNonce(nonceB64: string): { saltHex: string; deadlineMs: number } | null {
  const bytes = base64.decode(nonceB64);
  if (bytes.length !== 32) throw new Error('Nonce must be 32 bytes');
  if (VERSIONED_MAGIC_PREFIX.some((b, i) => bytes[i] !== b) || bytes[4] !== NONCE_VERSION_V1) return null;
  const deadlineNs = new DataView(bytes.buffer, bytes.byteOffset).getBigInt64(9, true);
  return { saltHex: bytesToHex(bytes.subarray(5, 9)), deadlineMs: Number(deadlineNs / 1_000_000n) };
}

// ---------------------------------------------------------------------------- Solver relay

/** One solver offer from the relay's `quote` method. */
export interface SolverQuote {
  defuse_asset_identifier_in: string;
  defuse_asset_identifier_out: string;
  amount_in: string;
  amount_out: string;
  expiration_time: string;
  quote_hash: string;
}

export interface SolverQuoteRequest {
  assetIn: string;
  assetOut: string;
  exactAmountIn: string;
  /** How long solvers must hold the offer. The relay's default is 60000. */
  minDeadlineMs?: number;
}

/** JSON-RPC params for `quote`, as documented at docs.near-intents.org (message-bus/rpc). */
export function solverQuoteParams(request: SolverQuoteRequest): Record<string, unknown> {
  return {
    defuse_asset_identifier_in: request.assetIn,
    defuse_asset_identifier_out: request.assetOut,
    exact_amount_in: request.exactAmountIn,
    ...(request.minDeadlineMs === undefined ? {} : { min_deadline_ms: request.minDeadlineMs }),
  };
}

const DIGITS = /^\d+$/;

/**
 * The relay answers `null` when no solver quotes. Offers for another pair or amount, malformed
 * offers and expired offers are dropped: a `token_diff` settles only against an offer for exactly
 * these amounts.
 */
export function parseSolverQuotes(result: unknown, request: SolverQuoteRequest, nowMs: number): SolverQuote[] {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) throw new Error('quote result is not an array');
  return result.filter((q): q is SolverQuote => {
    if (!q || typeof q !== 'object') return false;
    const o = q as Record<string, unknown>;
    return (
      o.defuse_asset_identifier_in === request.assetIn &&
      o.defuse_asset_identifier_out === request.assetOut &&
      o.amount_in === request.exactAmountIn &&
      typeof o.amount_out === 'string' &&
      DIGITS.test(o.amount_out) &&
      BigInt(o.amount_out) > 0n &&
      typeof o.quote_hash === 'string' &&
      o.quote_hash.length > 0 &&
      typeof o.expiration_time === 'string' &&
      Date.parse(o.expiration_time) > nowMs
    );
  });
}

export function bestSolverQuote(quotes: SolverQuote[]): SolverQuote | null {
  return quotes.reduce<SolverQuote | null>(
    (best, quote) => (!best || BigInt(quote.amount_out) > BigInt(best.amount_out) ? quote : best),
    null,
  );
}

export interface PublishIntentPayload {
  quote_hashes: string[];
  signed_data: SignedIntent;
}

/** `publish_intent` params. The quote hashes name the solver offers this intent fills. */
export function publishIntentParams(signed: SignedIntent, quoteHashes: string[]): PublishIntentPayload {
  if (quoteHashes.length === 0) throw new Error('publish_intent needs at least one quote hash');
  return { quote_hashes: quoteHashes, signed_data: signed };
}

export type PublishIntentResult = { status: 'OK'; intent_hash: string } | { status: 'FAILED'; reason: string; intent_hash: string | null };

export function parsePublishResult(result: unknown): PublishIntentResult {
  const o = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const hash = typeof o.intent_hash === 'string' && o.intent_hash ? o.intent_hash : null;
  if (o.status === 'OK' && hash) return { status: 'OK', intent_hash: hash };
  const reason = typeof o.reason === 'string' && o.reason ? o.reason : `relay answered ${JSON.stringify(result).slice(0, 300)}`;
  return { status: 'FAILED', reason, intent_hash: hash };
}

export type RelayIntentStatus = 'PENDING' | 'TX_BROADCASTED' | 'SETTLED' | 'NOT_FOUND_OR_NOT_VALID';
export const TERMINAL_RELAY_STATUSES: readonly RelayIntentStatus[] = ['SETTLED', 'NOT_FOUND_OR_NOT_VALID'];
const RELAY_STATUSES: readonly string[] = ['PENDING', 'TX_BROADCASTED', 'SETTLED', 'NOT_FOUND_OR_NOT_VALID'];

export interface IntentStatus {
  intent_hash: string;
  status: RelayIntentStatus;
  status_details: string | null;
  /** The NEAR transaction that carried the intent to `intents.near`, once the relay names one. */
  tx_hash: string | null;
  filled_amounts: string[] | null;
}

export function parseIntentStatus(result: unknown): IntentStatus {
  const o = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  if (typeof o.status !== 'string' || !RELAY_STATUSES.includes(o.status)) {
    throw new Error(`unknown get_status answer ${JSON.stringify(result).slice(0, 300)}`);
  }
  const data = (o.data && typeof o.data === 'object' ? o.data : {}) as Record<string, unknown>;
  return {
    intent_hash: typeof o.intent_hash === 'string' ? o.intent_hash : '',
    status: o.status as RelayIntentStatus,
    status_details: typeof o.status_details === 'string' ? o.status_details : null,
    tx_hash: typeof data.hash === 'string' && data.hash ? data.hash : null,
    filled_amounts: Array.isArray(o.filled_amounts) ? o.filled_amounts.map(String) : null,
  };
}

// ---------------------------------------------------------------------------- NEP-413 checks

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

/** `sha256(borsh(2147484061u32) || borsh({message, nonce, recipient, callback_url: None}))`, as the vault and intents.near compute it. */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== 32) throw new Error('NEP-413 nonce must be 32 bytes');
  const enc = new TextEncoder();
  const m = enc.encode(message);
  const r = enc.encode(recipient);
  const buf = new Uint8Array(4 + 4 + m.length + 32 + 4 + r.length + 1);
  let at = 0;
  for (const part of [u32le(2_147_484_061), u32le(m.length), m, nonce, u32le(r.length), r, Uint8Array.of(0)]) {
    buf.set(part, at);
    at += part.length;
  }
  return sha256(buf);
}

export interface SwapIntentMessage {
  signer_id: string;
  deadline: string;
  intents: { intent: string; diff?: Record<string, string> }[];
}

export interface SignedSwapCheck {
  ok: boolean;
  failures: string[];
  message: SwapIntentMessage | null;
  deadlineMs: number | null;
  /** base58 NEP-413 hash, the bytes the MPC signer signed. */
  nep413HashB58: string;
}

/**
 * Checks a vault-signed swap intent before it goes to the relay, the way `intents.near` will:
 * the ed25519 signature over the NEP-413 hash verifies against `public_key`, `public_key` is the
 * vault's intents key, the recipient and nonce are the expected ones, and the message is exactly
 * one `token_diff` from the vault for the proposal's amounts. It does not check that the key is
 * registered on `intents.near`; read `has_public_key` for that.
 */
export function checkSignedSwapIntent(
  signed: SignedIntent,
  expected: { vault: string; intentsContract: string; intentsKey: string; proposal: SwapProposal; nowMs: number },
): SignedSwapCheck {
  const failures: string[] = [];
  const { proposal } = expected;
  if (signed.standard !== 'nep413') failures.push(`standard is ${signed.standard}, not nep413`);
  if (signed.payload.recipient !== expected.intentsContract) failures.push(`recipient is ${signed.payload.recipient}, not ${expected.intentsContract}`);
  if (signed.payload.nonce !== proposal.nonce_b64) failures.push('nonce differs from the proposal nonce');
  if (signed.public_key !== expected.intentsKey) failures.push(`public_key ${signed.public_key} is not the vault intents key ${expected.intentsKey}`);

  let hash: Uint8Array = new Uint8Array(32);
  try {
    hash = nep413Hash(signed.payload.message, base64.decode(signed.payload.nonce), signed.payload.recipient);
    const publicKey = base58.decode(signed.public_key.replace(/^ed25519:/, ''));
    const signature = base58.decode(signed.signature.replace(/^ed25519:/, ''));
    if (!ed25519.verify(signature, hash, publicKey)) failures.push('ed25519 signature does not verify over the NEP-413 hash');
  } catch (error) {
    failures.push(`signature check failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let message: SwapIntentMessage | null = null;
  let deadlineMs: number | null = null;
  try {
    message = JSON.parse(signed.payload.message) as SwapIntentMessage;
  } catch {
    failures.push('message is not JSON');
  }
  if (message) {
    if (message.signer_id !== expected.vault) failures.push(`signer_id is ${message.signer_id}, not ${expected.vault}`);
    deadlineMs = Date.parse(message.deadline);
    if (!Number.isFinite(deadlineMs)) failures.push(`deadline ${message.deadline} is not a timestamp`);
    else if (deadlineMs <= expected.nowMs) failures.push(`deadline ${message.deadline} has passed`);
    const nonce = decodeIntentNonce(signed.payload.nonce);
    if (nonce && Number.isFinite(deadlineMs) && deadlineMs > nonce.deadlineMs) {
      failures.push('intent deadline is after the nonce deadline (intents.near: DeadlineGreaterThanNonce)');
    }
    const only = message.intents?.length === 1 ? message.intents[0] : undefined;
    if (!only || only.intent !== 'token_diff' || !only.diff) {
      failures.push('message is not exactly one token_diff intent');
    } else {
      const want: Record<string, string> = {
        [proposal.sell_token]: `-${proposal.sell_amount}`,
        [proposal.buy_token]: proposal.min_buy_amount,
      };
      const keys = Object.keys(only.diff).sort();
      const same = keys.length === 2 && keys.every((k) => only.diff?.[k] === want[k]);
      if (!same) failures.push(`diff ${JSON.stringify(only.diff)} is not ${JSON.stringify(want)}`);
    }
  }
  return { ok: failures.length === 0, failures, message, deadlineMs, nep413HashB58: base58.encode(hash) };
}
