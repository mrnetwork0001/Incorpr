import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SwapProposal, VaultState } from '@/lib/contracts';
import {
  TREASURY_SYSTEM_PROMPT,
  buildSwapTeeRequest,
  buildWithdrawTeeRequest,
  epochCapRemaining,
  parseApproval,
  planRebalance,
  priceFloorMinBuy,
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
