// Calls the route handlers directly. The 1Click and NEAR RPC calls behind them are real.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as attestationGet } from '@/app/api/attestation/route';
import { POST as intentsPost, GET as intentsGet } from '@/app/api/intents/route';
import { POST as rebalancePost, GET as rebalanceGet } from '@/app/api/rebalance/route';
import { POST as runServicePost } from '@/app/api/run-service/route';
import { POST as verifyPost } from '@/app/api/verify-l1/route';
import { enforceRateLimit, scrubSecrets, errorResponse, ApiError } from '@/lib/api';
import { serviceCallId } from '@/lib/contracts';
import { MAINNET_USDC_ASSET } from '@/lib/nearIntents';
import { TeeApiKeyMissingError } from '@/lib/nearAiTee';
import { treasuryPromptHash } from '@/lib/rebalance';

let ipCounter = 0;

function request(path: string, body: unknown, ip?: string): Request {
  ipCounter += 1;
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip ?? `10.0.0.${ipCounter}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const SECRETS = ['NEAR_AI_API_KEY', 'NEAR_OPERATOR_PRIVATE_KEY', 'NEAR_OPERATOR_ACCOUNT_ID', 'NEXT_PUBLIC_REGISTRY_CONTRACT_ID', 'NEAR_INTENTS_JWT'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of SECRETS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of SECRETS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const input = 'Summarize this.';
const salt = '0123456789abcdef0123';
const paid = { token_id: '1', call_id: serviceCallId(input, salt), salt, input };

describe('POST /api/run-service', () => {
  it('400 on invalid fields and unknown keys', async () => {
    const res = await runServicePost(request('/api/run-service', { token_id: 'abc', call_id: 'x', salt: 's', input: '' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.details.length).toBeGreaterThan(0);
    const extra = await runServicePost(request('/api/run-service', { ...paid, model: 'anything' }));
    expect(extra.status).toBe(400);
  });

  it('400 on a body that is not JSON', async () => {
    expect((await runServicePost(request('/api/run-service', '{nope'))).status).toBe(400);
  });

  it('403 when the call id does not commit to the input', async () => {
    const res = await runServicePost(request('/api/run-service', { ...paid, input: 'A different prompt.' }));
    expect(res.status).toBe(403);
  });

  it('503 without NEAR_AI_API_KEY, naming the variable', async () => {
    const res = await runServicePost(request('/api/run-service', paid));
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('NEAR_AI_API_KEY');
  });

  it('503 when the operator or registry is not configured', async () => {
    process.env.NEAR_AI_API_KEY = 'sk-not-a-real-key-for-routing-test';
    const noOperator = await runServicePost(request('/api/run-service', paid));
    expect(noOperator.status).toBe(503);
    expect((await noOperator.json()).error.code).toBe('operator_unavailable');

    process.env.NEAR_OPERATOR_ACCOUNT_ID = 'operator.testnet';
    const noRegistry = await runServicePost(request('/api/run-service', paid));
    expect(noRegistry.status).toBe(503);
    expect((await noRegistry.json()).error.message).toContain('NEXT_PUBLIC_REGISTRY_CONTRACT_ID');
  });

  it('answers from the real chain, before inference, when the registry account does not exist', async () => {
    process.env.NEAR_AI_API_KEY = 'sk-not-a-real-key-for-routing-test';
    process.env.NEAR_OPERATOR_ACCOUNT_ID = 'operator.testnet';
    process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID = 'no-such-registry-for-incorpr-tests.testnet';
    const res = await runServicePost(request('/api/run-service', paid));
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('contract_not_found');
    expect(JSON.stringify(body)).not.toContain('sk-not-a-real-key');
  });
});

describe('POST /api/rebalance', () => {
  it('400 on invalid fields, and caller-chosen targets are refused', async () => {
    expect((await rebalancePost(request('/api/rebalance', { token_id: '1', target_bps: [10000, 0, 0] }))).status).toBe(400);
  });

  it('503 without a configured registry', async () => {
    const res = await rebalancePost(request('/api/rebalance', { token_id: '2', dry_run: true }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('NEXT_PUBLIC_REGISTRY_CONTRACT_ID');
  });

  it('GET exposes the prompt hash for comparison with tee_prompt_hash', async () => {
    const body = await (await rebalanceGet()).json();
    expect(body.prompt_sha256).toBe(treasuryPromptHash());
  });
});

describe('POST /api/verify-l1', () => {
  it('400 on invalid fields', async () => {
    expect((await verifyPost(request('/api/verify-l1', { token_id: '../etc' }))).status).toBe(400);
  });

  it('503 without a configured registry', async () => {
    expect((await verifyPost(request('/api/verify-l1', { token_id: '1' }))).status).toBe(503);
  });
});

describe('/api/intents, live', () => {
  const quote = {
    op: 'quote',
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: MAINNET_USDC_ASSET,
    depositType: 'INTENTS',
    destinationAsset: 'nep141:wrap.near',
    amount: '1000000',
    refundTo: 'intents.near',
    refundType: 'INTENTS',
    recipient: 'intents.near',
    recipientType: 'INTENTS',
    deadline: new Date(Date.now() + 600_000).toISOString(),
  };

  it('proxies tokens', async () => {
    const res = await intentsGet(new Request('http://localhost/api/intents?op=tokens', { headers: { 'x-real-ip': '10.1.0.1' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).tokens.length).toBeGreaterThan(50);
  });

  it('proxies a real dry quote', async () => {
    const res = await intentsPost(request('/api/intents', quote));
    expect(res.status).toBe(200);
    expect(BigInt((await res.json()).quote.amountOut)).toBeGreaterThan(0n);
  });

  it('relays the real 1Click error and its minimum for a too-small amount', async () => {
    const res = await intentsPost(
      request('/api/intents', {
        ...quote,
        swapType: 'EXACT_OUTPUT',
        originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: MAINNET_USDC_ASSET,
        amount: '1000',
        refundTo: '0x0000000000000000000000000000000000000001',
        refundType: 'ORIGIN_CHAIN',
        recipientType: 'DESTINATION_CHAIN',
      }),
    );
    const body = await res.json();
    console.log('[route too-small quote]', res.status, JSON.stringify(body));
    expect(res.status).toBe(400);
    expect(body.error.details.minimumAmount).toMatch(/^\d+$/);
  });

  it('refuses a committed quote on testnet', async () => {
    const res = await intentsPost(request('/api/intents', { ...quote, dry: false }));
    expect(res.status).toBe(422);
  });

  it('refuses customRecipientMsg on testnet, where it cannot settle', async () => {
    const res = await intentsPost(request('/api/intents', { ...quote, customRecipientMsg: '{"call_id":"x"}' }));
    expect(res.status).toBe(422);
  });

  it('on mainnet, refuses customRecipientMsg to an account that is not a vault', async () => {
    process.env.NEXT_PUBLIC_NEAR_NETWORK = 'mainnet';
    process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID = 'incorpr.near';
    try {
      const res = await intentsPost(
        request('/api/intents', {
          ...quote,
          swapType: 'EXACT_OUTPUT',
          recipient: 'attacker.near',
          recipientType: 'DESTINATION_CHAIN',
          customRecipientMsg: '{"call_id":"x"}',
        }),
      );
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe('recipient_not_a_vault');
    } finally {
      delete process.env.NEXT_PUBLIC_NEAR_NETWORK;
    }
  });

  it('on mainnet, refuses customRecipientMsg with a swap type that can underpay', async () => {
    process.env.NEXT_PUBLIC_NEAR_NETWORK = 'mainnet';
    process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID = 'incorpr.near';
    try {
      const res = await intentsPost(
        request('/api/intents', {
          ...quote,
          recipient: 'c-1.incorpr.near',
          recipientType: 'DESTINATION_CHAIN',
          customRecipientMsg: '{"call_id":"x"}',
        }),
      );
      expect(res.status).toBe(422);
      expect((await res.json()).error.message).toContain('EXACT_OUTPUT');
    } finally {
      delete process.env.NEXT_PUBLIC_NEAR_NETWORK;
    }
  });

  it('400 on unknown ops and fields', async () => {
    expect((await intentsPost(request('/api/intents', { op: 'drain' }))).status).toBe(400);
    expect((await intentsPost(request('/api/intents', { ...quote, appFees: [{ recipient: 'x.near', fee: 100 }] }))).status).toBe(400);
  });
});

describe('GET /api/attestation, live', () => {
  it('returns real hardware checks with no API key', async () => {
    const res = await attestationGet(new Request('http://localhost/api/attestation', { headers: { 'x-real-ip': '10.2.0.1' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intelQuoteVerified).toBe(true);
    expect(body.nrasOverallResult).toBe(true);
    expect(body.treasury_prompt_sha256).toBe(treasuryPromptHash());
  });

  it('404 for a model that is not Private', async () => {
    const res = await attestationGet(
      new Request('http://localhost/api/attestation?model=openai/gpt-6-luna', { headers: { 'x-real-ip': '10.2.0.2' } }),
    );
    expect(res.status).toBe(404);
  });
});

describe('body size cap', () => {
  it('413 over the cap, with and without a content-length header', async () => {
    const big = 'x'.repeat(70_000);
    expect((await runServicePost(request('/api/run-service', big))).status).toBe(413);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const streamed = new Request('http://localhost/api/run-service', {
      method: 'POST',
      headers: { 'x-real-ip': '10.3.0.1' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect((await runServicePost(streamed)).status).toBe(413);
  });
});

describe('rate limiting', () => {
  it('429 after the per-IP allowance, for that IP only', () => {
    const limit = { route: `test-${Date.now()}`, perIpPerMinute: 3, globalPerMinute: 100 };
    const now = 1_000_000;
    const from = (ip: string) => new Request('http://localhost/x', { headers: { 'x-real-ip': ip } });
    for (let i = 0; i < 3; i += 1) enforceRateLimit(from('1.1.1.1'), limit, now);
    expect(() => enforceRateLimit(from('1.1.1.1'), limit, now)).toThrow(ApiError);
    expect(() => enforceRateLimit(from('2.2.2.2'), limit, now)).not.toThrow();
    expect(() => enforceRateLimit(from('1.1.1.1'), limit, now + 60_000)).not.toThrow();
  });

  it('applies the global allowance to forged IPs', () => {
    const limit = { route: `test-global-${Date.now()}`, perIpPerMinute: 100, globalPerMinute: 2 };
    const now = 2_000_000;
    const from = (ip: string) => new Request('http://localhost/x', { headers: { 'x-real-ip': ip } });
    enforceRateLimit(from('3.3.3.1'), limit, now);
    enforceRateLimit(from('3.3.3.2'), limit, now);
    expect(() => enforceRateLimit(from('3.3.3.3'), limit, now)).toThrow(/global/);
  });

  it('the run-service route answers 429', async () => {
    let last = 0;
    for (let i = 0; i < 25; i += 1) {
      const res = await runServicePost(request('/api/run-service', { bad: true }, '9.9.9.9'));
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

describe('errors do not leak secrets', () => {
  it('redacts configured secrets, bearer tokens and private-key shapes', () => {
    process.env.NEAR_AI_API_KEY = 'sk-super-secret';
    process.env.NEAR_OPERATOR_PRIVATE_KEY = 'ed25519:abc';
    const scrubbed = scrubSecrets(
      `failed with sk-super-secret and ed25519:abc and Authorization: Bearer abc.def and ed25519:${'3'.repeat(88)}`,
    );
    expect(scrubbed).not.toContain('sk-super-secret');
    expect(scrubbed).not.toContain('Bearer abc');
    expect(scrubbed).not.toContain('3'.repeat(88));
  });

  it('hides unknown errors behind a reference id', async () => {
    process.env.NEAR_AI_API_KEY = 'sk-super-secret';
    const res = errorResponse(new Error('upstream said sk-super-secret'));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('sk-super-secret');
    expect(text).toContain('Reference');
  });

  it('maps the TEE key error to 503', () => {
    expect(errorResponse(new TeeApiKeyMissingError()).status).toBe(503);
  });
});
