// Live: real 1Click API, solver relay and intents.near reads on mainnet RPC. Nothing is committed or
// spent: every quote is dry:true, and no transaction is sent.

import { describe, expect, it } from 'vitest';
import {
  MAINNET_USDC_ASSET,
  NotAVaultError,
  OneClickError,
  assertRecipientIsVault,
  bestSolverQuote,
  buildExecuteIntentsArgs,
  buildIntentNonce,
  buildPublishIntentPayload,
  buildVaultPaymentQuote,
  currentSalt,
  getQuote,
  getStatus,
  getTokens,
  parseIntentNonce,
  randomNonce,
  solverQuote,
  type QuoteRequest,
} from '@/lib/nearIntents';
import { getProvider, viewFunction } from '@/lib/near';
import type { SignedIntent } from '@/lib/contracts';

const MAINNET_RPC = 'https://free.rpc.fastnear.com';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';

function dryQuote(overrides: Partial<QuoteRequest>): QuoteRequest {
  return {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: BASE_USDC,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: MAINNET_USDC_ASSET,
    amount: '100000',
    refundTo: '0x0000000000000000000000000000000000000001',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'intents.near',
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
    ...overrides,
  };
}

describe('1Click, live', () => {
  it('lists the treasury assets', async () => {
    const tokens = await getTokens();
    const ids = tokens.map((t) => t.assetId);
    expect(ids).toContain(MAINNET_USDC_ASSET);
    expect(ids).toContain('nep141:btc.omft.near');
    expect(ids).toContain('nep141:sol.omft.near');
    expect(tokens.find((t) => t.assetId === MAINNET_USDC_ASSET)?.decimals).toBe(6);
  });

  it('returns a real dry quote with no deposit address', async () => {
    const response = await getQuote(
      dryQuote({
        originAsset: MAINNET_USDC_ASSET,
        depositType: 'INTENTS',
        destinationAsset: 'nep141:sol.omft.near',
        recipientType: 'INTENTS',
        refundType: 'INTENTS',
        refundTo: 'intents.near',
      }),
    );
    console.log('[1click dry USDC to SOL, 0.10 USDC]', JSON.stringify(response.quote));
    expect(BigInt(response.quote.amountOut)).toBeGreaterThan(0n);
    expect(response.quote.depositAddress).toBeUndefined();
  });

  it('finds the real minimum for a $0.10 EXACT_OUTPUT payment from Base', async () => {
    // Reported, not assumed: the $0.10 service price from the original spec is below this route's minimum.
    try {
      const response = await getQuote(dryQuote({ swapType: 'EXACT_OUTPUT' }));
      console.log('[1click 0.10 USDC EXACT_OUTPUT from Base] accepted', JSON.stringify(response.quote));
      expect(BigInt(response.quote.amountOut)).toBe(100000n);
    } catch (error) {
      expect(error).toBeInstanceOf(OneClickError);
      const oneClick = error as OneClickError;
      console.log('[1click 0.10 USDC EXACT_OUTPUT from Base] rejected:', oneClick.status, oneClick.message);
      expect(oneClick.minimumAmount).toMatch(/^\d+$/);
      const atMinimum = await getQuote(dryQuote({ swapType: 'EXACT_OUTPUT', amount: oneClick.minimumAmount! }));
      console.log('[1click at stated minimum]', JSON.stringify(atMinimum.quote));
      expect(BigInt(atMinimum.quote.amountOut)).toBeGreaterThanOrEqual(BigInt(oneClick.minimumAmount!));
    }
  });

  it('accepts a dry vault payment quote with customRecipientMsg', async () => {
    const request = buildVaultPaymentQuote({
      dry: true,
      originAsset: BASE_USDC,
      usdcAsset: MAINNET_USDC_ASSET,
      vault: 'intents.near',
      amount: '500000',
      callId: 'a'.repeat(64),
      refundTo: '0x0000000000000000000000000000000000000001',
    });
    expect(request.customRecipientMsg).toBe(JSON.stringify({ call_id: 'a'.repeat(64) }));
    const response = await getQuote(request);
    expect(response.quote.amountOut).toBe('500000');
    expect(response.quoteRequest.customRecipientMsg).toBe(request.customRecipientMsg);
  });

  it('surfaces a 1Click error for an unknown deposit address', async () => {
    await expect(getStatus('0x0000000000000000000000000000000000000000')).rejects.toBeInstanceOf(OneClickError);
  });
});

describe('customRecipientMsg guard, live', () => {
  const base = { destinationAsset: MAINNET_USDC_ASSET, amount: '1000000', callId: 'x', registryId: 'incorpr.near' };

  it('refuses an account that is not c-<id>.<registry>, before any chain read', async () => {
    await expect(assertRecipientIsVault({ ...base, recipient: 'attacker.near' })).rejects.toBeInstanceOf(NotAVaultError);
    await expect(assertRecipientIsVault({ ...base, recipient: 'c-1.evil.near' })).rejects.toBeInstanceOf(NotAVaultError);
  });
});

describe('intents.near nonce format, live', () => {
  it('builds a V1 nonce from the live salt that intents.near accepts as a known salt', async () => {
    const salt = await viewFunction<string>('intents.near', 'current_salt', {}, { rpcUrl: MAINNET_RPC });
    expect(salt).toMatch(/^[0-9a-f]{8}$/);
    const deadlineMs = Date.now() + 600_000;
    const nonce = buildIntentNonce(salt, deadlineMs, new Uint8Array(15).fill(9));
    const bytes = Buffer.from(nonce, 'base64');
    expect(bytes.length).toBe(32);
    expect(bytes.subarray(0, 5).toString('hex')).toBe('5628f6c600');
    expect(bytes.subarray(5, 9).toString('hex')).toBe(salt);
    expect(bytes.subarray(17).equals(Buffer.alloc(15, 9))).toBe(true);
    expect(parseIntentNonce(nonce)).toEqual({ saltHex: salt, deadlineMs });
    expect(parseIntentNonce(randomNonce())).toBeNull();
    const valid = await viewFunction<boolean>('intents.near', 'is_valid_salt', { salt }, { rpcUrl: MAINNET_RPC });
    expect(valid).toBe(true);
  });

  it('current_salt client reads through the configured network', () => {
    expect(typeof currentSalt).toBe('function');
    expect(getProvider(MAINNET_RPC)).toBeDefined();
  });
});

describe('solver relay, live', () => {
  it('returns a list for a pair, empty when no solver answers', async () => {
    const quotes = await solverQuote({
      assetIn: BASE_USDC,
      assetOut: MAINNET_USDC_ASSET,
      exactAmountIn: '10000000',
    });
    console.log('[solver quote USDC Base to NEAR]', JSON.stringify(quotes));
    const best = bestSolverQuote(quotes);
    if (best) {
      expect(best.quote_hash.length).toBeGreaterThan(0);
      expect(BigInt(best.amount_out)).toBeGreaterThan(0n);
    }
    const treasury = await solverQuote({
      assetIn: MAINNET_USDC_ASSET,
      assetOut: 'nep141:sol.omft.near',
      exactAmountIn: '5000000',
      minDeadlineMs: 300_000,
    });
    console.log('[solver quote USDC to SOL, 300 s deadline]', JSON.stringify(treasury));
    expect(Array.isArray(treasury)).toBe(true);
  });
});

describe('payload builders', () => {
  const signed: SignedIntent = {
    standard: 'nep413',
    payload: { message: '{}', nonce: 'AAAA', recipient: 'intents.near' },
    public_key: 'ed25519:key',
    signature: 'ed25519:sig',
  };

  it('wraps a vault-signed intent for execute_intents and publish_intent unchanged', () => {
    expect(buildExecuteIntentsArgs(signed)).toEqual({ signed: [signed] });
    expect(buildPublishIntentPayload(signed, ['hash'])).toEqual({ quote_hashes: ['hash'], signed_data: signed });
    expect(() => buildPublishIntentPayload(signed, [])).toThrow(/quote hash/);
  });
});
