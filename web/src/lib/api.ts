import 'server-only';

// Shared route plumbing: rate limits, body parsing, and error mapping that never echoes a secret.

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { ConfigError, NearViewError } from './near';
import { NotAVaultError, OneClickError, SolverRelayError } from './nearIntents';
import { TeeApiError, TeeApiKeyMissingError, TeeModelError } from './nearAiTee';
import {
  OperatorNotConfiguredError,
  OperatorUnavailableError,
  TransactionFailedError,
  TransactionPendingError,
} from './operator';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const MAX_BODY_BYTES = 64 * 1024;

/** Stops reading at the cap, so a large body cannot be buffered first and refused later. */
async function readCapped(request: Request): Promise<string> {
  const tooLarge = () => new ApiError(413, `Request body is over ${MAX_BODY_BYTES} bytes`);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw tooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.length;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
}

export async function parseJsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const text = await readCapped(request);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Request body is not valid JSON');
  }
  return parseValue(json, schema);
}

export function parseValue<T>(value: unknown, schema: ZodType<T>): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(
      400,
      'Invalid request',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------- Rate limiting

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_BUCKETS = 20_000;

function take(key: string, perMinute: number, now: number): boolean {
  const bucket = buckets.get(key) ?? { tokens: perMinute, updatedAt: now };
  const refill = ((now - bucket.updatedAt) / 60_000) * perMinute;
  bucket.tokens = Math.min(perMinute, bucket.tokens + refill);
  bucket.updatedAt = now;
  const allowed = bucket.tokens >= 1;
  if (allowed) bucket.tokens -= 1;
  buckets.delete(key);
  buckets.set(key, bucket);
  if (buckets.size > MAX_TRACKED_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  return allowed;
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return request.headers.get('x-real-ip') ?? forwarded?.split(',')[0]?.trim() ?? 'unknown';
}

export interface RateLimit {
  route: string;
  /** Per client IP. The header can be forged where no trusted proxy sets it, so `globalPerMinute` also applies. */
  perIpPerMinute: number;
  /** Across all clients. Bounds what a route can spend even with forged IPs. */
  globalPerMinute: number;
}

/**
 * Token buckets held in this process. A multi-instance deployment multiplies the limits by its
 * instance count; put a shared limiter in front before running that way with real funds.
 */
export function enforceRateLimit(request: Request, limit: RateLimit, now: number = Date.now()): void {
  const ipAllowed = take(`${limit.route}:ip:${clientIp(request)}`, limit.perIpPerMinute, now);
  if (!ipAllowed) throw new ApiError(429, 'Too many requests. Try again in a minute.');
  const globalAllowed = take(`${limit.route}:global`, limit.globalPerMinute, now);
  if (!globalAllowed) throw new ApiError(429, 'This route is at its global limit. Try again in a minute.');
}

export function enforceKeyedLimit(key: string, perMinute: number, message: string): void {
  if (!take(key, perMinute, Date.now())) throw new ApiError(429, message);
}

// ---------------------------------------------------------------------------- Errors

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';

function secretValues(): string[] {
  return [process.env.NEAR_AI_API_KEY, process.env.NEAR_INTENTS_JWT, process.env.NEAR_OPERATOR_PRIVATE_KEY].filter(
    (value): value is string => Boolean(value),
  );
}

/** Applied to every message that leaves a route. A key can reach an error string through a library. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const secret of secretValues()) out = out.split(secret).join('[redacted]');
  return out
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(new RegExp(`ed25519:${BASE58}{70,}`, 'g'), 'ed25519:[redacted]');
}

function errorBody(status: number, code: string, message: string, details?: unknown): NextResponse {
  return NextResponse.json(
    { error: { code, message: scrubSecrets(message), ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

/** Known errors keep their message. Anything else gets a reference id and a log line. */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) return errorBody(error.status, 'bad_request', error.message, error.details);
  if (error instanceof TeeApiKeyMissingError) return errorBody(503, 'tee_unavailable', error.message);
  if (error instanceof OperatorNotConfiguredError || error instanceof OperatorUnavailableError) {
    return errorBody(503, 'operator_unavailable', error.message);
  }
  if (error instanceof ConfigError) return errorBody(503, 'not_configured', error.message);
  if (error instanceof TeeModelError) return errorBody(503, 'tee_model_unavailable', error.message);
  if (error instanceof TeeApiError) return errorBody(502, 'tee_upstream', error.message);
  if (error instanceof OneClickError) {
    // A 401 or 403 is about this server's credentials, not the caller's request.
    const callerError = error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403;
    const status = callerError ? error.status : 502;
    return errorBody(status, 'one_click', error.message, {
      correlationId: error.correlationId,
      minimumAmount: error.minimumAmount,
    });
  }
  if (error instanceof SolverRelayError) return errorBody(502, 'solver_relay', error.message);
  if (error instanceof NotAVaultError) return errorBody(422, 'recipient_not_a_vault', error.message);
  if (error instanceof TransactionFailedError) {
    return errorBody(409, 'transaction_failed', error.reason, { txHash: error.txHash });
  }
  if (error instanceof TransactionPendingError) {
    return errorBody(504, 'transaction_pending', error.message, { txHash: error.txHash });
  }
  if (error instanceof NearViewError) {
    if (error.failure === 'account_not_found' || error.failure === 'no_contract') {
      return errorBody(404, 'contract_not_found', error.message);
    }
    return errorBody(502, 'near_rpc', error.message);
  }
  const reference = randomUUID();
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${reference}] ${scrubSecrets(message)}`);
  return errorBody(500, 'internal', `Internal error. Reference ${reference}.`);
}
