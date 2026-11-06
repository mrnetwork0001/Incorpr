// Webhook signature checks and the /api/market/webhook route. Expected HMACs are computed here with
// node:crypto, independently of src/lib/agentMarket.ts. The audit work behind the route is replaced
// by a spy; agentMarket.work.test.ts covers it.

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeenSet, WEBHOOK_MAX_SKEW_SECONDS, dedupeKeys, signWebhook, verifyWebhookSignature } from '@/lib/agentMarket';

const handleWebhookEvent = vi.fn();

vi.mock('@/lib/agentMarketWork', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agentMarketWork')>();
  return { ...actual, handleWebhookEvent: (...args: unknown[]) => handleWebhookEvent(...args) };
});

const { POST } = await import('@/app/api/market/webhook/route');

const SECRET = 'whsec-test-0123456789abcdef0123456789abcdef';
const ENV = ['AGENT_MARKET_WEBHOOK_SECRET', 'AGENT_MARKET_TOKEN', 'NEAR_AI_API_KEY'];
const saved: Record<string, string | undefined> = {};
const REQ_CONTEXT = Symbol.for('@vercel/request-context');

const expectedSignature = (secret: string, ts: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

const nowTs = () => String(Math.floor(Date.now() / 1000));
const bytes = (text: string) => new TextEncoder().encode(text);

let ip = 0;
function webhook(body: unknown, opts: { secret?: string; ts?: string; sign?: boolean; signature?: string; delivery?: string; event?: string } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const ts = opts.ts ?? nowTs();
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-real-ip': `10.9.0.${(ip += 1)}` };
  if (opts.sign !== false) {
    headers['x-market-timestamp'] = ts;
    headers['x-market-signature'] = opts.signature ?? expectedSignature(opts.secret ?? SECRET, ts, raw);
  }
  if (opts.delivery) headers['x-market-delivery'] = opts.delivery;
  const event = opts.event ?? (typeof body === 'object' && body && 'event' in body ? String((body as { event: string }).event) : undefined);
  if (event) headers['x-market-event'] = event;
  return new Request('http://localhost/api/market/webhook', { method: 'POST', headers, body: raw });
}

beforeEach(() => {
  for (const key of ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENT_MARKET_WEBHOOK_SECRET = SECRET;
  handleWebhookEvent.mockReset();
  delete (globalThis as unknown as Record<symbol, unknown>)[REQ_CONTEXT];
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete (globalThis as unknown as Record<symbol, unknown>)[REQ_CONTEXT];
});

describe('X-Market-Signature', () => {
  const ts = '1793990000';
  const body = '{"event":"hire.created","assignment_id":"7d3c1a52-6f0e-4c7b-9a1d-2b8f9e0c4d11"}';

  it('matches HMAC-SHA256(secret, "<timestamp>.<raw body>") computed with node:crypto', () => {
    expect(signWebhook(SECRET, ts, body)).toBe(expectedSignature(SECRET, ts, body));
    expect(signWebhook(SECRET, ts, bytes(body))).toBe(expectedSignature(SECRET, ts, body));
    // A fixed vector, so a change to the signed material shows up as a different digest.
    expect(signWebhook('k'.repeat(32), '1700000000', '{}')).toBe(
      `sha256=${createHmac('sha256', 'k'.repeat(32)).update('1700000000.{}').digest('hex')}`,
    );
  });

  it('accepts the exact bytes and refuses any change to body, timestamp or secret', () => {
    const signature = expectedSignature(SECRET, ts, body);
    const now = Number(ts) + 10;
    expect(verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature, rawBody: bytes(body), nowSeconds: now })).toEqual({ ok: true, timestamp: Number(ts) });
    expect(verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature: signature.toUpperCase().replace('SHA256=', 'sha256='), rawBody: bytes(body), nowSeconds: now }).ok).toBe(true);
    // Re-serialized JSON (a space added) is different bytes.
    expect(verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature, rawBody: bytes(body.replace(':', ': ')), nowSeconds: now })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyWebhookSignature({ secret: SECRET, timestamp: String(Number(ts) + 1), signature, rawBody: bytes(body), nowSeconds: now })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyWebhookSignature({ secret: `${SECRET}x`, timestamp: ts, signature, rawBody: bytes(body), nowSeconds: now })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature: signature.slice(0, -2), rawBody: bytes(body), nowSeconds: now })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature: signature.replace('sha256=', ''), rawBody: bytes(body), nowSeconds: now })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses missing headers, a non-numeric timestamp, and timestamps more than 300 s off', () => {
    const signature = expectedSignature(SECRET, ts, body);
    const base = { secret: SECRET, rawBody: bytes(body) };
    expect(verifyWebhookSignature({ ...base, timestamp: null, signature })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyWebhookSignature({ ...base, timestamp: ts, signature: null })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyWebhookSignature({ ...base, timestamp: '17939e5', signature, nowSeconds: Number(ts) })).toEqual({ ok: false, reason: 'bad_timestamp' });
    expect(verifyWebhookSignature({ ...base, timestamp: ts, signature, nowSeconds: Number(ts) + WEBHOOK_MAX_SKEW_SECONDS }).ok).toBe(true);
    expect(verifyWebhookSignature({ ...base, timestamp: ts, signature, nowSeconds: Number(ts) + WEBHOOK_MAX_SKEW_SECONDS + 1 })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verifyWebhookSignature({ ...base, timestamp: ts, signature, nowSeconds: Number(ts) - WEBHOOK_MAX_SKEW_SECONDS - 1 })).toEqual({ ok: false, reason: 'stale_timestamp' });
  });
});

describe('dedupe keys', () => {
  it('uses (event, assignment_id) only for once-per-assignment events', () => {
    expect(dedupeKeys('hire.created', 'a1', 'd1')).toEqual(['delivery:d1', 'event:hire.created:a1']);
    expect(dedupeKeys('hire.changes_requested', 'a1', 'd2')).toEqual(['delivery:d2']);
    expect(dedupeKeys('hire.created', 'a1', null)).toEqual(['event:hire.created:a1']);
  });

  it('SeenSet expires entries and evicts the oldest past its size', () => {
    const seen = new SeenSet(2, 1_000);
    expect(seen.checkAndAdd('a', 0)).toBe(false);
    expect(seen.checkAndAdd('a', 10)).toBe(true);
    expect(seen.checkAndAdd('a', 2_000)).toBe(false);
    seen.checkAndAdd('b', 2_001);
    seen.checkAndAdd('c', 2_002);
    expect(seen.size).toBe(2);
    expect(seen.has('a', 2_003)).toBe(false);
  });
});

describe('POST /api/market/webhook', () => {
  const hire = (id: string) => ({ event: 'hire.created', job_id: 'j-1', assignment_id: id, title: 'Audit', description: 'x', tags: [], amount: '5.00', token: 'USDC' });

  it('503 without AGENT_MARKET_WEBHOOK_SECRET, naming the variable', async () => {
    delete process.env.AGENT_MARKET_WEBHOOK_SECRET;
    const res = await POST(webhook({ event: 'webhook.ping' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('AGENT_MARKET_WEBHOOK_SECRET');
  });

  it('401 for unsigned, mismatched and stale requests', async () => {
    expect((await POST(webhook({ event: 'webhook.ping' }, { sign: false }))).status).toBe(401);
    expect((await POST(webhook({ event: 'webhook.ping' }, { secret: 'another-secret-another-secret-0000' }))).status).toBe(401);
    const stale = String(Math.floor(Date.now() / 1000) - WEBHOOK_MAX_SKEW_SECONDS - 5);
    const res = await POST(webhook({ event: 'webhook.ping' }, { ts: stale }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toContain('stale_timestamp');
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });

  it('answers webhook.ping 200 with no side effects, even before the token is set', async () => {
    const res = await POST(webhook({ event: 'webhook.ping', agent_id: 'x', delivery_id: 'test-1', test: true }, { delivery: 'test-1' }));
    expect(res.status).toBe(200);
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });

  it('400 when X-Market-Event disagrees with the body, or the body has no event', async () => {
    expect((await POST(webhook({ event: 'webhook.ping' }, { event: 'hire.created' }))).status).toBe(400);
    expect((await POST(webhook({ nothing: true }))).status).toBe(400);
    expect((await POST(webhook('not json'))).status).toBe(400);
  });

  it('acknowledges events with no assignment or no work and does nothing', async () => {
    for (const body of [
      { event: 'hire.created', hire_id: 'h-1', hirer_account_id: 'acc', kind: 'manual' },
      { event: 'agent.suspended', agent_id: 'x', reason: 'policy', disposition: 'drain' },
      { event: 'hire.accepted', job_id: 'j', assignment_id: 'a-accepted' },
      { event: 'message.created', job_id: 'j', assignment_id: 'a-msg' },
      { event: 'hire.dispute_resolved', job_id: 'j', assignment_id: 'a-d', ruling: 'worker_wins' },
    ]) {
      const res = await POST(webhook(body));
      expect(res.status).toBe(200);
      expect((await res.json()).ignored).toBe(true);
    }
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });

  it('503 for work events without AGENT_MARKET_TOKEN or NEAR_AI_API_KEY', async () => {
    const noToken = await POST(webhook(hire('a-503')));
    expect(noToken.status).toBe(503);
    expect((await noToken.json()).error.message).toContain('AGENT_MARKET_TOKEN');
    process.env.AGENT_MARKET_TOKEN = 'aat_00000000000000000000000000000000';
    const noKey = await POST(webhook(hire('a-503')));
    expect(noKey.status).toBe(503);
    expect((await noKey.json()).error.message).toContain('NEAR_AI_API_KEY');
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });

  describe('with the token and NEAR AI key set', () => {
    beforeEach(() => {
      process.env.AGENT_MARKET_TOKEN = 'aat_00000000000000000000000000000000';
      process.env.NEAR_AI_API_KEY = 'sk-routing-test-not-a-key';
    });

    it('runs hire.created once per assignment, deduped across delivery ids', async () => {
      handleWebhookEvent.mockResolvedValue({ action: 'delivered', assignmentId: 'a-1', round: 'fresh', chatId: 'c', model: 'm' });
      const first = await POST(webhook(hire('a-1'), { delivery: 'd-1' }));
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ ok: true, mode: 'inline', outcome: { action: 'delivered' } });
      const again = await POST(webhook(hire('a-1'), { delivery: 'd-2' }));
      expect((await again.json()).duplicate).toBe(true);
      const sameDelivery = await POST(webhook(hire('a-1'), { delivery: 'd-1' }));
      expect((await sameDelivery.json()).duplicate).toBe(true);
      expect(handleWebhookEvent).toHaveBeenCalledTimes(1);
      expect(handleWebhookEvent.mock.calls[0]?.[1]).toMatchObject({ event: 'hire.created', assignment_id: 'a-1' });
    });

    it('runs every hire.changes_requested round, deduped on the delivery id only', async () => {
      handleWebhookEvent.mockResolvedValue({ action: 'delivered', assignmentId: 'a-2', round: 'rework', chatId: 'c', model: 'm' });
      const body = { event: 'hire.changes_requested', job_id: 'j', assignment_id: 'a-2' };
      await POST(webhook(body, { delivery: 'r-1' }));
      await POST(webhook(body, { delivery: 'r-1' }));
      await POST(webhook(body, { delivery: 'r-2' }));
      expect(handleWebhookEvent).toHaveBeenCalledTimes(2);
    });

    it('treats a dispute redo ruling as work', async () => {
      handleWebhookEvent.mockResolvedValue({ action: 'delivered', assignmentId: 'a-3', round: 'redo', chatId: 'c', model: 'm' });
      await POST(webhook({ event: 'hire.dispute_resolved', job_id: 'j', assignment_id: 'a-3', dispute_id: 'x', ruling: 'redo' }, { delivery: 'dr-1' }));
      expect(handleWebhookEvent).toHaveBeenCalledTimes(1);
    });

    it('inline failure answers 503 and forgets the keys, so the marketplace retry runs again', async () => {
      handleWebhookEvent.mockResolvedValueOnce({ action: 'failed', assignmentId: 'a-4', reason: 'NEAR AI returned HTTP 500', retryable: true });
      const failed = await POST(webhook(hire('a-4'), { delivery: 'f-1' }));
      expect(failed.status).toBe(503);
      // Inline mode makes one attempt; the marketplace's redelivery is the retry.
      expect(handleWebhookEvent.mock.calls[0]?.[2]).toBeUndefined();
      handleWebhookEvent.mockResolvedValueOnce({ action: 'retry_later', assignmentId: 'a-4', reason: 'too soon', retryAfterMs: 31_000 });
      const tooSoon = await POST(webhook(hire('a-4'), { delivery: 'f-1' }));
      expect(tooSoon.status).toBe(503);
      expect((await tooSoon.json()).error.code).toBe('retry_later');
      handleWebhookEvent.mockResolvedValueOnce({ action: 'delivered', assignmentId: 'a-4', round: 'fresh', chatId: 'c', model: 'm' });
      const retried = await POST(webhook(hire('a-4'), { delivery: 'f-1' }));
      expect(retried.status).toBe(200);
      expect(handleWebhookEvent).toHaveBeenCalledTimes(3);
    });

    it('answers 200 to a failure a retry cannot fix, so the marketplace does not redeliver it', async () => {
      handleWebhookEvent.mockResolvedValueOnce({ action: 'failed', assignmentId: 'a-6', reason: 'Deliverable too large', retryable: false });
      const res = await POST(webhook(hire('a-6'), { delivery: 'n-1' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ mode: 'inline', outcome: { action: 'failed' } });
    });

    it('answers before the work when a Vercel request context offers waitUntil', async () => {
      let release: (value: unknown) => void = () => {};
      handleWebhookEvent.mockReturnValue(new Promise((resolve) => (release = resolve)));
      const waitUntil = vi.fn();
      (globalThis as unknown as Record<symbol, unknown>)[REQ_CONTEXT] = { get: () => ({ waitUntil }) };
      const res = await POST(webhook(hire('a-5'), { delivery: 'w-1' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ mode: 'after_response' });
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
      // After the 2xx there is no redelivery, so the work retries in-process until near maxDuration.
      const retryUntil = (handleWebhookEvent.mock.calls[0]?.[2] as { retryUntil?: number } | undefined)?.retryUntil;
      expect(retryUntil).toBeGreaterThan(Date.now() + 250_000);
      expect(retryUntil).toBeLessThanOrEqual(Date.now() + 300_000);
      release({ action: 'delivered', assignmentId: 'a-5', round: 'fresh', chatId: 'c', model: 'm' });
      await waitUntil.mock.calls[0]?.[0];
    });
  });
});
