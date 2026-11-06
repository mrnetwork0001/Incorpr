import { NextResponse } from 'next/server';
import { ApiError, enforceRateLimit } from '@/lib/api';
import { SeenSet, WebhookBody, dedupeKeys, scrubMarketSecrets, verifyWebhookSignature } from '@/lib/agentMarket';
import { eventOwesWork, handleWebhookEvent, marketErrorResponse, outcomeWantsRetry, vercelWaitUntil, workDepsFromEnv } from '@/lib/agentMarketWork';

// Agent Market webhook (market.near.ai). Signed POSTs: X-Market-Signature is
// "sha256=" + hex HMAC-SHA256(AGENT_MARKET_WEBHOOK_SECRET, "<X-Market-Timestamp>.<raw body>").
// The body is read as bytes and verified before it is parsed. A 2xx on hire.created stamps the
// assignment's start, so the answer goes out first and the audit runs after it through Vercel's
// waitUntil, with transient failures retried until shortly before maxDuration. Without a Vercel
// request context (next dev, next start) one attempt runs before the answer, and a retryable
// failure answers 503 so the marketplace redelivers.

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const RATE_LIMIT = { route: 'market-webhook', perIpPerMinute: 120, globalPerMinute: 600 };
const MAX_BODY_BYTES = 256 * 1024;
const MIN_SECRET_LENGTH = 32;
/** In-process retries stop 20 s before maxDuration (300 s). */
const RETRY_WINDOW_MS = (300 - 20) * 1000;

// Per instance. Serverless instances do not share it, so processAssignment also re-reads the
// assignment from the marketplace and takes a lease before any work.
const seen = new SeenSet();

function log(line: string) {
  console.log(`[agent-market] ${scrubMarketSecrets(line)}`);
}

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

async function readRawBody(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new ApiError(413, 'Webhook body is too large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) throw new ApiError(413, 'Webhook body is too large');
  return bytes;
}

export async function POST(request: Request): Promise<NextResponse> {
  const receivedAt = Date.now();
  try {
    enforceRateLimit(request, RATE_LIMIT);
    const secret = process.env.AGENT_MARKET_WEBHOOK_SECRET;
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      return json(503, {
        error: { code: 'not_configured', message: `AGENT_MARKET_WEBHOOK_SECRET is not set (at least ${MIN_SECRET_LENGTH} characters), so this webhook is unavailable` },
      });
    }

    // Exact received bytes: the signature covers them, so they are never re-serialized.
    const raw = await readRawBody(request);
    const check = verifyWebhookSignature({
      secret,
      timestamp: request.headers.get('x-market-timestamp'),
      signature: request.headers.get('x-market-signature'),
      rawBody: raw,
    });
    if (!check.ok) return json(401, { error: { code: 'unauthorized', message: `Webhook refused: ${check.reason}` } });

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return json(400, { error: { code: 'bad_request', message: 'Webhook body is not JSON' } });
    }
    const parsed = WebhookBody.safeParse(parsedJson);
    if (!parsed.success) return json(400, { error: { code: 'bad_request', message: 'Webhook body has no event' } });
    const body = parsed.data;
    const headerEvent = request.headers.get('x-market-event');
    if (headerEvent && headerEvent !== body.event) {
      return json(400, { error: { code: 'bad_request', message: 'X-Market-Event does not match the body' } });
    }
    const deliveryId = request.headers.get('x-market-delivery')?.slice(0, 128) ?? null;

    if (body.event === 'webhook.ping') return json(200, { ok: true, event: body.event });
    if (!eventOwesWork(body)) {
      log(`event ${body.event} assignment=${body.assignment_id ?? 'none'} acknowledged, no work`);
      return json(200, { ok: true, event: body.event, ignored: true });
    }

    // 503 here makes the marketplace retry on its schedule, which helps once the variables are set.
    const deps = workDepsFromEnv();

    const keys = dedupeKeys(body.event, body.assignment_id, deliveryId);
    if (keys.some((key) => seen.has(key))) {
      log(`event ${body.event} assignment=${body.assignment_id} delivery=${deliveryId} duplicate`);
      return json(200, { ok: true, event: body.event, duplicate: true });
    }
    for (const key of keys) seen.checkAndAdd(key);
    const forget = () => keys.forEach((key) => seen.delete(key));

    log(`event ${body.event} assignment=${body.assignment_id} delivery=${deliveryId}`);
    const waitUntil = vercelWaitUntil();
    if (waitUntil) {
      // After the 2xx the marketplace does not redeliver, so transient failures are retried here
      // until shortly before maxDuration. What is still owed after that waits for the poll.
      const work = handleWebhookEvent(deps, body, { retryUntil: receivedAt + RETRY_WINDOW_MS });
      waitUntil(
        work.then(
          (outcome) => {
            if (outcomeWantsRetry(outcome)) forget();
            log(`outcome ${JSON.stringify(outcome)}`);
          },
          (error: unknown) => {
            forget();
            log(`outcome error ${error instanceof Error ? error.message : String(error)}`);
          },
        ),
      );
      return json(200, { ok: true, event: body.event, mode: 'after_response' });
    }

    const outcome = await handleWebhookEvent(deps, body);
    log(`outcome ${JSON.stringify(outcome)}`);
    if (outcomeWantsRetry(outcome)) {
      // Answering non-2xx asks the marketplace to retry (10 s, 30 s, 90 s, 270 s).
      forget();
      const message = outcome && 'reason' in outcome ? outcome.reason : 'work not finished';
      return json(503, { error: { code: outcome?.action === 'retry_later' ? 'retry_later' : 'work_failed', message } });
    }
    return json(200, { ok: true, event: body.event, mode: 'inline', outcome: outcome ? { action: outcome.action } : null });
  } catch (error) {
    if (error instanceof ApiError) return json(error.status, { error: { code: 'bad_request', message: error.message } });
    return marketErrorResponse(error);
  }
}
