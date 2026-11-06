import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import type { SignedIntent, SwapProposal, VaultState } from '@/lib/contracts';
import {
  REBALANCE_GAS_TGAS,
  SOLVER_MIN_DEADLINES_MS,
  TREASURY_SYSTEM_PROMPT,
  bestSolverQuote,
  buildSwapTeeRequest,
  buildWithdrawTeeRequest,
  checkSignedSwapIntent,
  decodeIntentNonce,
  encodeIntentNonce,
  epochCapRemaining,
  fundingPaymentFor,
  nep413Hash,
  parseApproval,
  parseIntentStatus,
  parsePublishResult,
  parseSolverQuotes,
  planRebalance,
  priceFloorMinBuy,
  publishIntentParams,
  retainedFromPayment,
  solverQuoteParams,
  treasuryPromptHash,
  type TreasuryHolding,
} from '@/lib/rebalance';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const context = { vaultAccount: 'c-1.registry.test.near', treasuryEpoch: 3, ownerGeneration: 2 };
const swap: SwapProposal = {
  sell_token: 'nep141:usdc.test.near',
  sell_amount: '1000000',
  buy_token: 'nep141:btc.omft.near',
  min_buy_amount: '1200',
  nonce_b64: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
};

describe('TEE request format', () => {
  it('has the preimage, hash and body layout in docs/ARCHITECTURE.md section 4', () => {
    const preimage =
      'incorpr:v2:c-1.registry.test.near:3:2:swap:nep141:usdc.test.near:1000000:nep141:btc.omft.near:1200:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
    const request = buildSwapTeeRequest(context, swap, 'm/x', 'prompt "quoted"');
    expect(request.proposal_hash).toBe(sha(preimage));
    expect(request.body).toBe(
      `{"model":"m/x","messages":[{"role":"system","content":"prompt \\"quoted\\""},{"role":"user","content":"${preimage}\\nproposal_hash=${sha(preimage)}"}],"stream":false}`,
    );
  });

  it('orders withdraw fields as the vault does', () => {
    const request = buildWithdrawTeeRequest(
      context,
      { token: 'nep141:btc.omft.near', amount: '5', destination: 'tb1qx', chain: 'btc', nonce_b64: 'AA==' },
      'm/x',
      'p',
    );
    expect(request.proposal_hash).toBe(
      sha('incorpr:v2:c-1.registry.test.near:3:2:withdraw:nep141:btc.omft.near:5:tb1qx:btc:AA=='),
    );
  });

  it('keeps the prompt under the vault limit and hashes it as sha256', () => {
    expect(new TextEncoder().encode(TREASURY_SYSTEM_PROMPT).length).toBeLessThanOrEqual(4096);
    expect(treasuryPromptHash()).toBe(sha(TREASURY_SYSTEM_PROMPT));
  });
});

describe('model output is untrusted', () => {
  const hash = 'ab'.repeat(32);
  const body = (content: unknown, extra: object = {}) =>
    JSON.stringify({ created: 1_700_000_000, choices: [{ message: { content } }], ...extra });

  it('accepts only the exact approval for this hash', () => {
    expect(parseApproval(body(`APPROVE ${hash}`), hash)).toEqual({ approved: true, created: 1_700_000_000 });
    expect(parseApproval(body(`  APPROVE ${hash}\n`), hash).approved).toBe(true);
  });

  it.each([
    ['another hash', `APPROVE ${'cd'.repeat(32)}`],
    ['a rejection', 'REJECT amounts look wrong'],
    ['approval inside prose', `Sure! APPROVE ${hash}`],
    ['approval with a suffix', `APPROVE ${hash} because it looks fine`],
    ['lower case', `approve ${hash}`],
    ['null content', null],
  ])('refuses %s', (_name, content) => {
    expect(parseApproval(body(content), hash).approved).toBe(false);
  });

  it('refuses two choices, broken JSON and a missing created time', () => {
    const twoChoices = JSON.stringify({
      created: 1,
      choices: [{ message: { content: `APPROVE ${hash}` } }, { message: { content: 'x' } }],
    });
    expect(parseApproval(twoChoices, hash).approved).toBe(false);
    expect(parseApproval('not json', hash).approved).toBe(false);
    expect(parseApproval(JSON.stringify({ choices: [{ message: { content: `APPROVE ${hash}` } }] }), hash).approved).toBe(false);
  });
});

const btc = (balance: bigint): TreasuryHolding => ({ asset: 'btc', balance, decimals: 8, priceMicroUsd: 77_000_000_000n });
const sol = (balance: bigint): TreasuryHolding => ({ asset: 'sol', balance, decimals: 9, priceMicroUsd: 96_000_000n });
const usdc = (balance: bigint): TreasuryHolding => ({ asset: 'usdc', balance, decimals: 6, priceMicroUsd: 1_000_000n });
const roomy = new Map([['btc', 10n ** 12n], ['sol', 10n ** 15n], ['usdc', 10n ** 12n]]);

describe('planRebalance', () => {
  it('does nothing on an empty treasury', () => {
    const plan = planRebalance({ holdings: [btc(0n), sol(0n), usdc(0n)], targetBps: [3000, 3000, 4000], minDriftBps: 200, capRemaining: roomy });
    expect(plan.kind).toBe('noop');
  });

  it('sells the overweight asset into the most underweight, up to the smaller gap', () => {
    const plan = planRebalance({ holdings: [btc(0n), sol(0n), usdc(100_000_000n)], targetBps: [6000, 3000, 1000], minDriftBps: 200, capRemaining: roomy });
    expect(plan.kind).toBe('swap');
    if (plan.kind !== 'swap') return;
    expect(plan.sell.asset).toBe('usdc');
    expect(plan.buy.asset).toBe('btc');
    expect(plan.sellAmount).toBe(60_000_000n);
    expect(plan.driftBps).toEqual([-6000, -3000, 9000]);
    expect(plan.cappedByEpochLimit).toBe(false);
  });

  it('does nothing below the drift threshold', () => {
    const plan = planRebalance({ holdings: [btc(0n), sol(0n), usdc(100_000_000n)], targetBps: [100, 0, 9900], minDriftBps: 200, capRemaining: roomy });
    expect(plan.kind).toBe('noop');
  });

  it('never exceeds the epoch cap, and does nothing at zero room', () => {
    const capped = planRebalance({
      holdings: [btc(0n), sol(0n), usdc(100_000_000n)],
      targetBps: [6000, 3000, 1000],
      minDriftBps: 200,
      capRemaining: new Map([['usdc', 5_000_000n]]),
    });
    expect(capped.kind === 'swap' && capped.sellAmount).toBe(5_000_000n);
    expect(capped.kind === 'swap' && capped.cappedByEpochLimit).toBe(true);

    const none = planRebalance({
      holdings: [btc(0n), sol(0n), usdc(100_000_000n)],
      targetBps: [6000, 3000, 1000],
      minDriftBps: 200,
      capRemaining: new Map(),
    });
    expect(none.kind).toBe('noop');
  });
});

describe('vault policy mirrors', () => {
  const policy = {
    epoch_caps: [['usdc', '100'], ['btc', '50']],
    price_floors: [{ sell_token: 'usdc', buy_token: 'btc', min_buy: '3', per_sell: '7' }],
  } as unknown as VaultState['policy'];

  it('subtracts spend only inside the current window', () => {
    const now = 86_400_000 * 5 + 1;
    expect(epochCapRemaining({ policy, spend_window: 5, spent_this_window: [['usdc', '30']] }, now).get('usdc')).toBe(70n);
    expect(epochCapRemaining({ policy, spend_window: 4, spent_this_window: [['usdc', '30']] }, now).get('usdc')).toBe(100n);
    expect(epochCapRemaining({ policy, spend_window: 5, spent_this_window: [['usdc', '500']] }, now).get('usdc')).toBe(0n);
  });

  it('rounds the floor up, matching min_buy * per_sell >= sell * floor_min_buy', () => {
    const floor = priceFloorMinBuy({ policy }, 'usdc', 'btc', 10n);
    expect(floor).toBe(5n);
    expect(floor! * 7n >= 10n * 3n).toBe(true);
    expect((floor! - 1n) * 7n >= 10n * 3n).toBe(false);
    expect(priceFloorMinBuy({ policy }, 'btc', 'usdc', 10n)).toBeNull();
  });
});

describe('planRebalance with an excluded buy asset', () => {
  it('buys the next most underweight asset when the first has no market', () => {
    const input = { holdings: [btc(0n), sol(0n), usdc(100_000_000n)] as [TreasuryHolding, TreasuryHolding, TreasuryHolding], targetBps: [4000, 3000, 3000] as [number, number, number], minDriftBps: 200, capRemaining: roomy };
    const first = planRebalance(input);
    expect(first.kind === 'swap' && first.buy.asset).toBe('btc');
    const next = planRebalance({ ...input, excludeBuy: ['btc'] });
    expect(next.kind === 'swap' && next.buy.asset).toBe('sol');
    expect(next.kind === 'swap' && next.sellAmount).toBe(30_000_000n);
    expect(planRebalance({ ...input, excludeBuy: ['btc', 'sol'] }).kind).toBe('noop');
  });

  it('does nothing when the remaining asset is not below its target', () => {
    const plan = planRebalance({ holdings: [btc(0n), sol(0n), usdc(100_000_000n)], targetBps: [10_000, 0, 0], minDriftBps: 200, capRemaining: roomy, excludeBuy: ['btc'] });
    expect(plan).toMatchObject({ kind: 'noop', reason: 'sol is not below its target' });
  });
});

describe('funding retained earnings with one payment', () => {
  it('matches ft_on_transfer: reserve rounded down, the rest retained', () => {
    // Mainnet company 1: price 0.05 USDC, compute_reserve_bps 2000.
    const payment = fundingPaymentFor(460_000n, 2000, 50_000n) as bigint;
    expect(payment).toBe(574_999n);
    expect(retainedFromPayment(payment, 2000)).toBe(460_000n);
    expect(retainedFromPayment(payment - 1n, 2000) < 460_000n).toBe(true);
    for (const shortfall of [1n, 7n, 39_999n, 123_457n, 10_000_001n]) {
      const amount = fundingPaymentFor(shortfall, 2000, 1n) as bigint;
      expect(retainedFromPayment(amount, 2000) >= shortfall).toBe(true);
      expect(retainedFromPayment(amount - 1n, 2000) < shortfall).toBe(true);
    }
  });

  it('never pays below the price, and is impossible when the reserve takes everything', () => {
    expect(fundingPaymentFor(1n, 2000, 50_000n)).toBe(50_000n);
    expect(fundingPaymentFor(0n, 2000, 50_000n)).toBe(0n);
    expect(fundingPaymentFor(5n, 10_000, 50_000n)).toBeNull();
  });
});

describe('intents.near V1 nonce', () => {
  it('lays out magic, version, salt, deadline ns and random bytes', () => {
    const deadlineMs = 1_793_980_000_123;
    const nonce = encodeIntentNonce('252812b3', deadlineMs, new Uint8Array(15).fill(7));
    const bytes = base64.decode(nonce);
    expect(Buffer.from(bytes.subarray(0, 5)).toString('hex')).toBe('5628f6c600');
    expect(Buffer.from(bytes.subarray(5, 9)).toString('hex')).toBe('252812b3');
    expect(Buffer.from(bytes.subarray(9, 17)).readBigInt64LE()).toBe(BigInt(deadlineMs) * 1_000_000n);
    expect([...bytes.subarray(17)]).toEqual(new Array(15).fill(7));
    expect(decodeIntentNonce(nonce)).toEqual({ saltHex: '252812b3', deadlineMs });
    expect(decodeIntentNonce(base64.encode(new Uint8Array(32).fill(1)))).toBeNull();
    expect(() => encodeIntentNonce('xyz', deadlineMs, new Uint8Array(15))).toThrow(/salt/);
  });
});

const USDC_MAIN = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const SOL = 'nep141:sol.omft.near';

describe('solver relay requests and answers', () => {
  const request = { assetIn: USDC_MAIN, assetOut: SOL, exactAmountIn: '500000', minDeadlineMs: 180_000 };
  // Recorded from solver-relay-v2.chaindefuser.com `quote` on 2026-11-06.
  const live = {
    defuse_asset_identifier_in: USDC_MAIN,
    defuse_asset_identifier_out: SOL,
    amount_in: '500000',
    amount_out: '5500156',
    expiration_time: '2026-11-06T16:40:44.129Z',
    quote_hash: 'Cn8f58umXBkDWmRVX8auB5o8VxMqD2witgZ7gkRkCMsx',
  };
  const before = Date.parse('2026-11-06T16:39:35Z');

  it('builds the documented quote params', () => {
    expect(solverQuoteParams(request)).toEqual({
      defuse_asset_identifier_in: USDC_MAIN,
      defuse_asset_identifier_out: SOL,
      exact_amount_in: '500000',
      min_deadline_ms: 180_000,
    });
    expect(solverQuoteParams({ ...request, minDeadlineMs: undefined })).not.toHaveProperty('min_deadline_ms');
    expect(SOLVER_MIN_DEADLINES_MS[0]).toBe(180_000);
  });

  it('reads a live answer, a null answer, and drops offers that cannot settle this intent', () => {
    expect(parseSolverQuotes([live], request, before)).toEqual([live]);
    expect(parseSolverQuotes(null, request, before)).toEqual([]);
    expect(parseSolverQuotes([live], request, Date.parse(live.expiration_time) + 1)).toEqual([]);
    expect(parseSolverQuotes([{ ...live, amount_in: '499999' }], request, before)).toEqual([]);
    expect(parseSolverQuotes([{ ...live, defuse_asset_identifier_out: 'nep141:btc.omft.near' }], request, before)).toEqual([]);
    expect(parseSolverQuotes([{ ...live, amount_out: '-1' }, { ...live, amount_out: '0' }, { ...live, quote_hash: '' }, null], request, before)).toEqual([]);
    expect(() => parseSolverQuotes({ not: 'an array' }, request, before)).toThrow(/not an array/);
  });

  it('picks the offer with the most out', () => {
    const better = { ...live, amount_out: '5600000', quote_hash: 'h2' };
    expect(bestSolverQuote([live, better])?.quote_hash).toBe('h2');
    expect(bestSolverQuote([])).toBeNull();
  });

  it('builds publish_intent params and reads its answers', () => {
    const signed = { standard: 'nep413', payload: { message: '{}', nonce: 'AA==', recipient: 'intents.near' }, public_key: 'ed25519:x', signature: 'ed25519:y' } as SignedIntent;
    expect(publishIntentParams(signed, ['q'])).toEqual({ quote_hashes: ['q'], signed_data: signed });
    expect(() => publishIntentParams(signed, [])).toThrow(/quote hash/);
    expect(parsePublishResult({ status: 'OK', intent_hash: 'abc' })).toEqual({ status: 'OK', intent_hash: 'abc' });
    expect(parsePublishResult({ status: 'FAILED', reason: 'quote expired' })).toEqual({ status: 'FAILED', reason: 'quote expired', intent_hash: null });
    expect(parsePublishResult({ status: 'OK' }).status).toBe('FAILED');
    expect(parsePublishResult(null).status).toBe('FAILED');
  });

  it('reads get_status answers in the documented shape', () => {
    expect(
      parseIntentStatus({
        intent_hash: 'ih',
        status: 'SETTLED',
        status_details: 'Settled in block 123456789',
        data: { hash: '8yFNEk7GmRcM3NMJihwCKXt8ZANLpL2koVFWWH1MEEj' },
        filled_amounts: ['300'],
      }),
    ).toEqual({
      intent_hash: 'ih',
      status: 'SETTLED',
      status_details: 'Settled in block 123456789',
      tx_hash: '8yFNEk7GmRcM3NMJihwCKXt8ZANLpL2koVFWWH1MEEj',
      filled_amounts: ['300'],
    });
    expect(parseIntentStatus({ intent_hash: 'ih', status: 'PENDING' })).toMatchObject({ status: 'PENDING', tx_hash: null });
    expect(() => parseIntentStatus({ status: 'DONE' })).toThrow(/unknown/);
  });
});

describe('NEP-413 hash and the vault-signed swap check', () => {
  it('hashes the borsh layout the vault uses (chain.rs nep413_hash)', () => {
    const u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      return b;
    };
    const manual = createHash('sha256')
      .update(Buffer.concat([u32(2_147_484_061), u32(5), Buffer.from('hello'), Buffer.alloc(32, 9), u32(12), Buffer.from('intents.near'), Buffer.from([0])]))
      .digest('hex');
    expect(Buffer.from(nep413Hash('hello', new Uint8Array(32).fill(9), 'intents.near')).toString('hex')).toBe(manual);
  });

  const secret = new Uint8Array(32).fill(3);
  const publicKey = `ed25519:${base58.encode(ed25519.getPublicKey(secret))}`;
  const now = Date.parse('2026-11-06T17:00:00Z');
  const proposal: SwapProposal = {
    sell_token: USDC_MAIN,
    sell_amount: '500000',
    buy_token: SOL,
    min_buy_amount: '5498346',
    nonce_b64: encodeIntentNonce('252812b3', now + 15 * 60_000, new Uint8Array(15).fill(1)),
  };
  // The exact message shape company-vault builds (serde field order: signer_id, deadline, intents).
  const message = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      signer_id: 'c-1.incorpr.near',
      deadline: '2026-11-06T17:05:00.000Z',
      intents: [{ intent: 'token_diff', diff: { [USDC_MAIN]: '-500000', [SOL]: '5498346' } }],
      ...overrides,
    });
  const sign = (msg: string, nonce = proposal.nonce_b64): SignedIntent => ({
    standard: 'nep413',
    payload: { message: msg, nonce, recipient: 'intents.near' },
    public_key: publicKey,
    signature: `ed25519:${base58.encode(ed25519.sign(nep413Hash(msg, base64.decode(nonce), 'intents.near'), secret))}`,
  });
  const expected = { vault: 'c-1.incorpr.near', intentsContract: 'intents.near', intentsKey: publicKey, proposal, nowMs: now };

  it('accepts the intent the vault would return', () => {
    const check = checkSignedSwapIntent(sign(message()), expected);
    expect(check.failures).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.deadlineMs).toBe(Date.parse('2026-11-06T17:05:00.000Z'));
  });

  it.each([
    ['another signer', message({ signer_id: 'thief.near' }), /signer_id/],
    ['a smaller sale', message({ intents: [{ intent: 'token_diff', diff: { [USDC_MAIN]: '-1', [SOL]: '5498346' } }] }), /diff/],
    ['a withdrawal', message({ intents: [{ intent: 'ft_withdraw', token: 'x', receiver_id: 'y', amount: '1' }] }), /token_diff/],
    ['two intents', message({ intents: [{ intent: 'token_diff', diff: {} }, { intent: 'token_diff', diff: {} }] }), /exactly one/],
    ['an expired deadline', message({ deadline: '2026-11-06T16:59:00.000Z' }), /has passed/],
    ['a deadline past the nonce', message({ deadline: '2026-11-06T17:30:00.000Z' }), /DeadlineGreaterThanNonce/],
  ])('refuses %s', (_name, msg, pattern) => {
    const check = checkSignedSwapIntent(sign(msg), expected);
    expect(check.ok).toBe(false);
    expect(check.failures.join(' ')).toMatch(pattern);
  });

  it('refuses a signature over other bytes, another key, recipient or nonce', () => {
    const good = sign(message());
    const swapped = { ...good, payload: { ...good.payload, message: message({ deadline: '2026-11-06T17:04:00.000Z' }) } };
    expect(checkSignedSwapIntent(swapped, expected).failures.join(' ')).toMatch(/does not verify/);
    expect(checkSignedSwapIntent(good, { ...expected, intentsKey: 'ed25519:other' }).failures.join(' ')).toMatch(/not the vault intents key/);
    expect(checkSignedSwapIntent({ ...good, payload: { ...good.payload, recipient: 'intents.far' } }, expected).ok).toBe(false);
    expect(checkSignedSwapIntent(sign(message(), base64.encode(new Uint8Array(32))), expected).failures.join(' ')).toMatch(/nonce differs/);
  });
});

describe('execution gas', () => {
  it('leaves the signer at least the 50 TGas the vault requires, after the vault receipt and its 20 TGas reserve', () => {
    // 3.6 TGas: the vault receipt of agent_swap_intent measured in rebalance.execute.e2e.test.ts, rounded up.
    expect(REBALANCE_GAS_TGAS.swap - 4 - 20).toBeGreaterThanOrEqual(50);
    // Static allocations the vault makes before any unused gas is shared out.
    expect(REBALANCE_GAS_TGAS.setupIntentsKey).toBeGreaterThan(30 + 30 + 3);
    expect(REBALANCE_GAS_TGAS.deposit).toBeGreaterThan(80 + 15 + 3);
  });
});
