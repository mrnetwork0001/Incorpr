import 'server-only';

// Agent Market (market.near.ai) worker client and webhook verification.
//
// Shapes follow https://market.near.ai/openapi.json (tags worker, jobs, files), checked by
// tests/agentMarket.openapi.live.test.ts against the live document. Flows follow the marketplace's
// worker skill: poll GET /v1/agents/me/assignments, POST /start, POST /submit. The aat_ token pins
// one agent; the marketplace never takes an agent id from a request body.
//
// Nothing here logs or returns the token or the webhook secret.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const DEFAULT_API_URL = 'https://market.near.ai/v1';
export const MARKET_HOST = 'market.near.ai';
/** The marketplace's own guidance: reject a webhook whose timestamp is more than 300 s off. */
export const WEBHOOK_MAX_SKEW_SECONDS = 300;
/** `deliverableMarkdown` limit from the submit endpoint (256 KiB). */
export const MAX_DELIVERABLE_BYTES = 256 * 1024;

const REQUEST_TIMEOUT_MS = 20_000;
const RETRIES_ON_5XX = 2;

// ---------------------------------------------------------------------------- Config

export class AgentMarketNotConfiguredError extends Error {
  readonly httpStatus = 503;
  constructor(variable: string, what: string) {
    super(`${variable} is not set, so ${what} is unavailable on this server`);
    this.name = 'AgentMarketNotConfiguredError';
  }
}

export class AgentMarketApiError extends Error {
  constructor(
    readonly status: number,
    /** The marketplace's `error` code, for example `invalid_state_transition`. */
    readonly code: string | null,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'AgentMarketApiError';
  }
}

export function apiBaseUrl(): string {
  return (process.env.AGENT_MARKET_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
}

/** Handle rules from the marketplace's registration docs: 3 to 30 chars, lowercase, digits and `-`. */
export const HANDLE_PATTERN = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;

export function marketHandle(): string | null {
  const handle = process.env.AGENT_MARKET_HANDLE?.trim().toLowerCase();
  return handle && HANDLE_PATTERN.test(handle) ? handle : null;
}

export function listingUrls(handle: string): { agentHost: string; profile: string } {
  return { agentHost: `https://${handle}.${MARKET_HOST}`, profile: `https://${MARKET_HOST}/a/${handle}` };
}

const TOKEN_PATTERN = /aat_[0-9a-zA-Z]+/g;

/** Removes the token, the webhook secret and any aat_ value from text that may leave the server. */
export function scrubMarketSecrets(text: string): string {
  let out = text;
  for (const secret of [process.env.AGENT_MARKET_TOKEN, process.env.AGENT_MARKET_WEBHOOK_SECRET, process.env.CRON_SECRET]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out.replace(TOKEN_PATTERN, 'aat_[redacted]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
}

// ---------------------------------------------------------------------------- Schemas (openapi.json)

const nullableString = z.string().nullable();
const optionalNullableString = z.string().nullable().optional();

/** components.schemas.AssignmentStatus */
export const AssignmentStatus = z.enum(['in_progress', 'submitted', 'accepted', 'disputed', 'dispute_resolved', 'cancelled']);
export type AssignmentStatus = z.infer<typeof AssignmentStatus>;

/** components.schemas.AttachmentBrief */
export const AttachmentBrief = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  byteSize: z.number().int(),
  sha256: z.string(),
  createdAt: z.string(),
  downloadUrl: z.string(),
});
export type AttachmentBrief = z.infer<typeof AttachmentBrief>;

/** components.schemas.JobAssignment */
export const JobAssignment = z.object({
  assignmentId: z.string(),
  jobId: z.string(),
  workerAgentId: z.string(),
  status: AssignmentStatus,
  escrowAmount: z.string(),
  escrowToken: z.string(),
  slaSeconds: z.number().int(),
  slaDeadlineAt: z.string(),
  acceptanceWindowDays: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  bidId: optionalNullableString,
  cancelDetail: optionalNullableString,
  cancelReason: optionalNullableString,
  deliverableHash: optionalNullableString,
  deliverableUrl: optionalNullableString,
  finalizedAt: optionalNullableString,
  startedAt: optionalNullableString,
  submittedAt: optionalNullableString,
});
export type JobAssignment = z.infer<typeof JobAssignment>;

/**
 * components.schemas.WorkerJobBrief. `jobKind` and `status` are enums in the document; they are read
 * as strings here so a value added later does not fail the whole list.
 */
export const WorkerJobBrief = z.object({
  jobId: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  jobKind: z.string(),
  status: z.string(),
  attachments: z.array(AttachmentBrief),
  entriesCloseAt: optionalNullableString,
});
export type WorkerJobBrief = z.infer<typeof WorkerJobBrief>;

/** components.schemas.LatestMessageBrief. `senderSide` is `buyer` or `worker`. */
export const LatestMessageBrief = z.object({
  senderSide: z.string(),
  origin: z.string(),
  body: z.string(),
  truncated: z.boolean(),
  attachments: z.array(AttachmentBrief),
  createdAt: z.string(),
});
export type LatestMessageBrief = z.infer<typeof LatestMessageBrief>;

/** components.schemas.MyAssignmentItem */
export const MyAssignmentItem = z.object({
  assignment: JobAssignment,
  job: WorkerJobBrief,
  latestMessage: LatestMessageBrief.nullable().optional(),
  autoAcceptAt: optionalNullableString,
});
export type MyAssignmentItem = z.infer<typeof MyAssignmentItem>;

/** components.schemas.MyAssignmentsResponse */
export const MyAssignmentsResponse = z.object({ assignments: z.array(MyAssignmentItem) });

/** components.schemas.StartAssignmentResponse */
export const StartAssignmentResponse = z.object({ startedAt: z.string() });

/** components.schemas.WorkerProgressReport */
export const WorkerProgressReport = z.object({
  assignmentId: z.string(),
  message: z.string(),
  reportedAt: z.string(),
  percent: z.number().int().nullable().optional(),
});
export type WorkerProgressReport = z.infer<typeof WorkerProgressReport>;

/** components.schemas.ThreadMessage (AssignmentMessage flattened, plus attachments) */
export const ThreadMessage = z.object({
  messageId: z.string(),
  assignmentId: z.string(),
  senderAccountId: z.string(),
  origin: z.string(),
  body: z.string(),
  createdAt: z.string(),
  senderAgentId: optionalNullableString,
  attachments: z.array(AttachmentBrief),
});
export type ThreadMessage = z.infer<typeof ThreadMessage>;

/** components.schemas.ListMessagesResponse. `workerActivity` is `{state: idle}` or `{state: working, since}`. */
export const ListMessagesResponse = z.object({
  messages: z.array(ThreadMessage),
  total: z.number().int(),
  workerActivity: z.looseObject({ state: z.string() }),
  workerProgress: WorkerProgressReport.nullable().optional(),
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>;

/** components.schemas.AgentPublic, only the fields the status endpoint shows. */
export const AgentPublicSummary = z.object({
  agent_id: z.string(),
  handle: z.string(),
  name: z.string(),
  listing_status: z.string(),
  delivered_jobs: z.number().int(),
  success_rate: z.number().int().nullable().optional(),
  response_time_seconds_median: z.number().int().nullable().optional(),
});
export type AgentPublicSummary = z.infer<typeof AgentPublicSummary>;

/** Error body from the marketplace's error conventions: `{"error": code, "message"?, "retry_after"?}`. */
const ErrorBody = z.object({
  error: z.string(),
  message: z.string().optional(),
  retry_after: z.number().optional(),
});

// ---------------------------------------------------------------------------- Client

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AgentMarketClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Delay between 5xx retries. Tests pass 0. */
  retryDelayMs?: number;
}

/** Worker-side REST client for one agent (the token's). */
export class AgentMarketClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly doFetch: FetchLike;
  private readonly retryDelayMs: number;

  constructor(options: AgentMarketClientOptions) {
    if (!options.token) throw new AgentMarketNotConfiguredError('AGENT_MARKET_TOKEN', 'Agent Market');
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? apiBaseUrl()).replace(/\/$/, '');
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.retryDelayMs = options.retryDelayMs ?? 750;
  }

  /** Origin of the API, for joining attachment paths such as `/v1/jobs/{id}/attachments/{a}/raw`. */
  get origin(): string {
    return new URL(this.baseUrl).origin;
  }

  private async send(method: 'GET' | 'POST', path: string, body?: unknown, accept = 'application/json'): Promise<Response> {
    const url = path.startsWith('http') ? path : path.startsWith('/v1/') ? `${this.origin}${path}` : `${this.baseUrl}${path}`;
    let lastError: AgentMarketApiError | null = null;
    for (let attempt = 0; attempt <= RETRIES_ON_5XX; attempt += 1) {
      if (attempt > 0 && this.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
      let res: Response;
      try {
        res = await this.doFetch(url, {
          method,
          headers: {
            accept,
            authorization: `Bearer ${this.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = new AgentMarketApiError(502, null, `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (res.status >= 500) {
        lastError = new AgentMarketApiError(res.status, null, `${method} ${path} returned HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw await apiError(method, path, res);
      return res;
    }
    throw lastError ?? new AgentMarketApiError(502, null, `${method} ${path} failed`);
  }

  private async json<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    const text = await res.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new AgentMarketApiError(502, null, `${method} ${path}: response is not JSON`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new AgentMarketApiError(
        502,
        'schema_mismatch',
        `${method} ${path}: response does not match openapi.json (${issue ? `${issue.path.join('.')}: ${issue.message}` : 'unknown'})`,
      );
    }
    return parsed.data;
  }

  /** GET /v1/agents/me/assignments. `status` is an assignment status or `all`; default `in_progress`. */
  async listAssignments(params: { status?: AssignmentStatus | 'all'; limit?: number; offset?: number } = {}): Promise<MyAssignmentItem[]> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    query.set('limit', String(params.limit ?? 100));
    if (params.offset) query.set('offset', String(params.offset));
    return (await this.json('GET', `/agents/me/assignments?${query}`, MyAssignmentsResponse)).assignments;
  }

  /** Every row for `status`, paging 100 at a time, up to `maxRows`. */
  async listAllAssignments(status: AssignmentStatus | 'all', maxRows = 1_000): Promise<MyAssignmentItem[]> {
    const rows: MyAssignmentItem[] = [];
    for (let offset = 0; offset < maxRows; offset += 100) {
      const page = await this.listAssignments({ status, limit: 100, offset });
      rows.push(...page);
      if (page.length < 100) break;
    }
    return rows;
  }

  /**
   * Re-reads one assignment. The worker surface has no single-assignment GET, so this scans the
   * in_progress list first (where work is owed) and then every status.
   */
  async findAssignment(assignmentId: string): Promise<MyAssignmentItem | null> {
    for (const status of ['in_progress', 'all'] as const) {
      const rows = await this.listAllAssignments(status);
      const row = rows.find((r) => r.assignment.assignmentId === assignmentId);
      if (row) return row;
    }
    return null;
  }

  /** POST /v1/assignments/{id}/start. Idempotent: a repeat returns the original stamp. */
  async startAssignment(assignmentId: string): Promise<string> {
    return (await this.json('POST', `/assignments/${encodeURIComponent(assignmentId)}/start`, StartAssignmentResponse, {})).startedAt;
  }

  /** POST /v1/assignments/{id}/progress. 409 `progress_report_too_soon` within 30 s of the last one. */
  async reportProgress(assignmentId: string, message: string, percent?: number): Promise<WorkerProgressReport> {
    const body: { message: string; percent?: number } = { message: message.trim().slice(0, 280) };
    if (percent !== undefined) body.percent = Math.max(0, Math.min(100, Math.round(percent)));
    return this.json('POST', `/assignments/${encodeURIComponent(assignmentId)}/progress`, WorkerProgressReport, body);
  }

  /** GET /v1/assignments/{id}/messages, newest first, with the latest progress report. */
  async listMessages(assignmentId: string, limit = 10): Promise<ListMessagesResponse> {
    return this.json('GET', `/assignments/${encodeURIComponent(assignmentId)}/messages?limit=${limit}`, ListMessagesResponse);
  }

  /** POST /v1/assignments/{id}/messages. A retry with the same `clientRequestId` stores nothing new. */
  async sendMessage(assignmentId: string, body: string, clientRequestId?: string): Promise<ThreadMessage> {
    return this.json('POST', `/assignments/${encodeURIComponent(assignmentId)}/messages`, ThreadMessage, {
      body,
      ...(clientRequestId ? { clientRequestId } : {}),
    });
  }

  /** POST /v1/assignments/{id}/submit. Completes the assignment (or a rework round). */
  async submitDeliverable(assignmentId: string, deliverableMarkdown: string, files: string[] = []): Promise<JobAssignment> {
    if (Buffer.byteLength(deliverableMarkdown, 'utf8') > MAX_DELIVERABLE_BYTES) {
      throw new AgentMarketApiError(400, 'invalid_deliverable', `deliverable is over ${MAX_DELIVERABLE_BYTES} bytes`);
    }
    return this.json('POST', `/assignments/${encodeURIComponent(assignmentId)}/submit`, JobAssignment, {
      deliverableMarkdown,
      ...(files.length ? { files } : {}),
    });
  }

  /** GET /v1/assignments/{id}/deliverable/raw: the latest Markdown this agent submitted, or null. */
  async latestDeliverable(assignmentId: string): Promise<string | null> {
    try {
      const res = await this.send('GET', `/assignments/${encodeURIComponent(assignmentId)}/deliverable/raw`, undefined, 'text/markdown');
      return await res.text();
    } catch (error) {
      if (error instanceof AgentMarketApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** Downloads a brief or thread attachment (party-scoped path, fetched with this token), capped at `maxBytes`. */
  async downloadAttachment(attachment: AttachmentBrief, maxBytes: number): Promise<Uint8Array> {
    if (attachment.byteSize > maxBytes) {
      throw new AgentMarketApiError(413, 'attachment_too_large', `${attachment.filename} is ${attachment.byteSize} bytes, over ${maxBytes}`);
    }
    const path = attachment.downloadUrl.startsWith('/') ? attachment.downloadUrl : `/${attachment.downloadUrl}`;
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new AgentMarketApiError(400, 'attachment_origin', `${attachment.filename} is not on ${this.origin}`);
    const res = await this.send('GET', url.toString(), undefined, '*/*');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new AgentMarketApiError(413, 'attachment_too_large', `${attachment.filename} is over ${maxBytes} bytes`);
    return bytes;
  }
}

async function apiError(method: string, path: string, res: Response): Promise<AgentMarketApiError> {
  const text = await res.text().catch(() => '');
  let code: string | null = null;
  let message = text.slice(0, 300);
  let retryAfter: number | null = Number(res.headers.get('retry-after')) || null;
  try {
    const body = ErrorBody.parse(JSON.parse(text));
    code = body.error;
    message = body.message ?? body.error;
    retryAfter = body.retry_after ?? retryAfter;
  } catch {
    // Not the documented error shape; keep the text.
  }
  return new AgentMarketApiError(res.status, code, scrubMarketSecrets(`${method} ${path} returned HTTP ${res.status}: ${message}`), retryAfter);
}

/** The client for AGENT_MARKET_TOKEN. Throws AgentMarketNotConfiguredError (HTTP 503) when it is unset. */
export function marketClientFromEnv(fetchImpl?: FetchLike): AgentMarketClient {
  const token = process.env.AGENT_MARKET_TOKEN;
  if (!token) throw new AgentMarketNotConfiguredError('AGENT_MARKET_TOKEN', 'Agent Market');
  return new AgentMarketClient({ token, fetch: fetchImpl });
}

/** Public GET /v1/agents/{handle}. No token. Null when the listing is not public (draft, paused, archived). */
export async function fetchPublicAgent(handle: string, fetchImpl: FetchLike = (i, init) => fetch(i, init)): Promise<AgentPublicSummary | null> {
  const res = await fetchImpl(`${apiBaseUrl()}/agents/${encodeURIComponent(handle)}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new AgentMarketApiError(res.status, null, `GET /agents/${handle} returned HTTP ${res.status}`);
  const parsed = AgentPublicSummary.safeParse(await res.json());
  if (!parsed.success) throw new AgentMarketApiError(502, 'schema_mismatch', `GET /agents/${handle}: response does not match openapi.json`);
  return parsed.data;
}

// ---------------------------------------------------------------------------- Webhooks

export type WebhookCheck =
  | { ok: true; timestamp: number }
  | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'stale_timestamp' | 'bad_signature' };

/** `sha256=` + hex HMAC-SHA256(secret, "<timestamp>.<raw body>"), as the marketplace signs. */
export function signWebhook(secret: string, timestamp: string, rawBody: Uint8Array | string): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${timestamp}.`, 'utf8');
  mac.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody);
  return `sha256=${mac.digest('hex')}`;
}

/**
 * Verifies X-Market-Signature over the exact received bytes. Constant-time compare; a timestamp more
 * than WEBHOOK_MAX_SKEW_SECONDS from `nowSeconds`, in either direction, is refused.
 */
export function verifyWebhookSignature(params: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: Uint8Array;
  nowSeconds?: number;
}): WebhookCheck {
  const { secret, timestamp, signature, rawBody } = params;
  if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const ts = Number(timestamp);
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_MAX_SKEW_SECONDS) return { ok: false, reason: 'stale_timestamp' };
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody), 'utf8');
  const provided = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, timestamp: ts };
}

/** Webhook body fields this server reads. Every body carries `event`; the rest depends on the event. */
export const WebhookBody = z.looseObject({
  event: z.string().min(1).max(64),
  assignment_id: z.string().nullable().optional(),
  job_id: z.string().nullable().optional(),
  ruling: z.string().nullable().optional(),
});
export type WebhookBody = z.infer<typeof WebhookBody>;

/** Events that happen once per assignment, so `(event, assignment_id)` is a safe dedupe key. */
export const ONCE_PER_ASSIGNMENT = new Set(['hire.created', 'hire.accepted', 'hire.refunded']);

/** Small insertion-ordered LRU of seen keys with a TTL. Per serverless instance only. */
export class SeenSet {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly max = 2_000,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {}

  /** True when `key` was already seen (and not expired). Records it otherwise. */
  checkAndAdd(key: string, now = Date.now()): boolean {
    const at = this.seen.get(key);
    if (at !== undefined && now - at < this.ttlMs) return true;
    this.seen.delete(key);
    this.seen.set(key, now);
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return false;
  }

  has(key: string, now = Date.now()): boolean {
    const at = this.seen.get(key);
    return at !== undefined && now - at < this.ttlMs;
  }

  delete(key: string): void {
    this.seen.delete(key);
  }

  get size(): number {
    return this.seen.size;
  }
}

/** Dedupe keys for one delivery: the delivery id always, plus `(event, assignment_id)` for once-only events. */
export function dedupeKeys(event: string, assignmentId: string | null | undefined, deliveryId: string | null): string[] {
  const keys: string[] = [];
  if (deliveryId) keys.push(`delivery:${deliveryId}`);
  if (assignmentId && ONCE_PER_ASSIGNMENT.has(event)) keys.push(`event:${event}:${assignmentId}`);
  return keys;
}
