// Rebalance proposal maths and the vault's TEE request format (docs/ARCHITECTURE.md section 4).
// Pure code: no network or secrets. The route in app/api/rebalance does the I/O.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SwapProposal, TeeRequest, VaultState, WithdrawProposal } from './contracts';

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
  let buyIndex = 0;
  driftBps.forEach((drift, i) => {
    if (drift > (driftBps[sellIndex] as number)) sellIndex = i;
    if (drift < (driftBps[buyIndex] as number)) buyIndex = i;
  });
  const base = { driftBps, totalMicroUsd: total.toString() };
  if ((driftBps[sellIndex] as number) < input.minDriftBps) {
    return { kind: 'noop', reason: `largest drift is below ${input.minDriftBps} bps`, ...base };
  }

  const sell = input.holdings[sellIndex] as TreasuryHolding;
  const buy = input.holdings[buyIndex] as TreasuryHolding;
  const excess = (values[sellIndex] as bigint) - (targets[sellIndex] as bigint);
  const shortfall = (targets[buyIndex] as bigint) - (values[buyIndex] as bigint);
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
