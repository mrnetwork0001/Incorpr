import 'server-only';

// NEAR AI Cloud inference and verification, following
// vendor/near-agent-skills/skills/near-ai-cloud/references/{chat,model,gateway}-verification.md and
// nearai/nearai-cloud-verifier for the report_data layout.
//
// Every check is `true`, `false`, or a string that says why it did not run. A string is never a pass.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from 'node:crypto';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import { ConfigError } from './near';

export type Check = boolean | string;

export class TeeApiKeyMissingError extends Error {
  readonly httpStatus = 503;
  constructor() {
    super('NEAR_AI_API_KEY is not set, so TEE inference is unavailable on this server');
    this.name = 'TeeApiKeyMissingError';
  }
}

export class TeeApiError extends Error {
  constructor(
    readonly upstreamStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'TeeApiError';
  }
}

export class TeeModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeeModelError';
  }
}

const GATEWAY_URL = () => (process.env.NEAR_AI_CLOUD_URL || 'https://cloud-api.near.ai/v1').replace(/\/$/, '');
const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const NRAS_JWKS_URL = new URL('https://nras.attestation.nvidia.com/.well-known/jwks.json');
const INTEL_PCS_URL = 'https://api.trustedservices.intel.com/tdx/certification/v4/';

const INFERENCE_TIMEOUT_MS = 90_000;
const ATTESTATION_TIMEOUT_MS = 45_000;
const SIGNATURE_RETRIES = 10;
const SIGNATURE_RETRY_DELAY_MS = 750;

/**
 * Model id to direct completions host. The vault accepts only the three-field `provider_tee`
 * signature, which the model's own host always produces. `/v1/models` does not list these hosts.
 * Add entries with NEAR_AI_DIRECT_ENDPOINTS, a JSON object of model id to base URL.
 */
const KNOWN_DIRECT_ENDPOINTS: Record<string, string> = {
  'Qwen/Qwen3-VL-30B-A3B-Instruct': 'https://qwen3-vl-30b.completions.near.ai/v1',
};

function directEndpoints(): Record<string, string> {
  const extra = process.env.NEAR_AI_DIRECT_ENDPOINTS;
  if (!extra) return KNOWN_DIRECT_ENDPOINTS;
  try {
    return { ...KNOWN_DIRECT_ENDPOINTS, ...(JSON.parse(extra) as Record<string, string>) };
  } catch {
    throw new ConfigError('NEAR_AI_DIRECT_ENDPOINTS is not valid JSON');
  }
}

export function directEndpointFor(model: string): string | null {
  return directEndpoints()[model]?.replace(/\/$/, '') ?? null;
}

function apiKey(): string {
  const key = process.env.NEAR_AI_API_KEY;
  if (!key) throw new TeeApiKeyMissingError();
  return key;
}

export function teeConfigured(): boolean {
  return Boolean(process.env.NEAR_AI_API_KEY);
}

/** Next caches fetches by default in some contexts, and a stale attestation or signature is wrong. */
async function upstream(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, cache: 'no-store' });
  } catch (error) {
    throw new TeeApiError(502, `NEAR AI request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------- Models

export interface LiveModel {
  id: string;
  owned_by?: string;
  is_ready?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  pricing?: { input?: number; output?: number };
}

let modelCache: { at: number; models: LiveModel[] } | null = null;
const MODEL_CACHE_MS = 5 * 60_000;

export async function listLiveModels(): Promise<LiveModel[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
  const res = await upstream(`${GATEWAY_URL()}/models`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new TeeApiError(res.status, `GET /v1/models returned HTTP ${res.status}`);
  const models = ((await res.json()) as { data: LiveModel[] }).data;
  modelCache = { at: Date.now(), models };
  return models;
}

/**
 * The listing has no privacy flag. `owned_by: nearai` is what NEAR's own attested TEE hosts report;
 * "attested 3p" models run on third-party TEEs and vendor-owned models are anonymised proxies.
 */
export function isPrivateTeeModel(model: LiveModel): boolean {
  return (
    model.owned_by === 'nearai' &&
    model.is_ready === true &&
    !/abliterated/i.test(model.id) &&
    (model.input_modalities ?? []).includes('text') &&
    (model.output_modalities ?? []).includes('text')
  );
}

/** NEAR_AI_DEFAULT_MODEL if it is live and Private, else the cheapest live Private model with a direct host. */
export async function pickDefaultModel(): Promise<string> {
  const models = await listLiveModels();
  const configured = process.env.NEAR_AI_DEFAULT_MODEL;
  if (configured) {
    const model = models.find((m) => m.id === configured);
    if (!model) throw new TeeModelError(`NEAR_AI_DEFAULT_MODEL ${configured} is not in the live model list`);
    if (!isPrivateTeeModel(model)) {
      throw new TeeModelError(`NEAR_AI_DEFAULT_MODEL ${configured} is not a ready Private TEE model`);
    }
    return configured;
  }
  const candidates = models
    .filter((m) => isPrivateTeeModel(m) && directEndpointFor(m.id))
    .sort((a, b) => (a.pricing?.output ?? Infinity) - (b.pricing?.output ?? Infinity));
  const first = candidates[0];
  if (!first) throw new TeeModelError('No ready Private TEE model with a known direct host in the live model list');
  return first.id;
}

// ---------------------------------------------------------------------------- Inference

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

export interface ChatParams {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}

/** Key order is fixed, because the signature covers these exact bytes. */
export function buildChatBody({ model, system, user, maxTokens }: ChatParams): string {
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
  });
}

export interface InferenceResult {
  chatId: string;
  model: string;
  content: string | null;
  /** Exact bytes sent. */
  requestBody: string;
  /** Exact bytes received. */
  responseBody: string;
  /** The host that served the request. The signature must be fetched from the same one. */
  baseUrl: string;
}

/** Non-streaming, because a gateway-rewritten stream can lose the model TEE's byte-exact signature. */
export async function runInference(requestBody: string): Promise<InferenceResult> {
  const key = apiKey();
  const model = (JSON.parse(requestBody) as { model: string }).model;
  const baseUrl = directEndpointFor(model) ?? GATEWAY_URL();
  const res = await upstream(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: requestBody,
    signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
  });
  const responseBody = await res.text();
  if (!res.ok) {
    throw new TeeApiError(res.status, `Inference returned HTTP ${res.status}: ${responseBody.slice(0, 300)}`);
  }
  let parsed: { id?: string; choices?: { message?: { content?: string | null } }[] };
  try {
    parsed = JSON.parse(responseBody) as typeof parsed;
  } catch {
    throw new TeeApiError(res.status, 'Inference response is not JSON');
  }
  if (!parsed.id) throw new TeeApiError(res.status, 'Inference response has no chat id');
  return {
    chatId: parsed.id,
    model,
    content: parsed.choices?.[0]?.message?.content ?? null,
    requestBody,
    responseBody,
    baseUrl,
  };
}

export interface SignatureBundle {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: 'provider_tee' | 'gateway';
}

/** A model can run on several nodes and only the serving node holds the signature, so "not found" is retried. */
export async function fetchChatSignature(
  inference: Pick<InferenceResult, 'chatId' | 'model' | 'baseUrl'>,
  { retries = SIGNATURE_RETRIES, delayMs = SIGNATURE_RETRY_DELAY_MS } = {},
): Promise<SignatureBundle> {
  const key = apiKey();
  const query =
    inference.baseUrl === GATEWAY_URL()
      ? `model=${encodeURIComponent(inference.model)}&signing_algo=ecdsa`
      : 'signing_algo=ecdsa';
  const url = `${inference.baseUrl}/signature/${encodeURIComponent(inference.chatId)}?${query}`;
  let lastError = '';
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const res = await upstream(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as SignatureBundle;
    lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    if (res.status !== 404 && !/not found|expired/i.test(text)) break;
  }
  throw new TeeApiError(502, `Could not fetch signature for chat ${inference.chatId}: ${lastError}`);
}

// ---------------------------------------------------------------------------- Signature checks

export function eip191Hash(text: string): Uint8Array {
  const message = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const joined = new Uint8Array(prefix.length + message.length);
  joined.set(prefix);
  joined.set(message, prefix.length);
  return keccak_256(joined);
}

/** Recovers the `0x` lowercase signer of an EIP-191 message. Throws on a malformed signature. */
export function recoverEip191Address(text: string, signatureHex: string): string {
  const raw = hexToBytes(signatureHex.replace(/^0x/i, ''));
  if (raw.length !== 65) throw new Error(`Expected a 65-byte signature, got ${raw.length}`);
  const v = raw[64] as number;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error(`Invalid recovery id ${v}`);
  const point = secp256k1.Signature.fromBytes(raw.subarray(0, 64), 'compact')
    .addRecoveryBit(recovery)
    .recoverPublicKey(eip191Hash(text));
  return `0x${bytesToHex(keccak_256(point.toBytes(false).subarray(1)).slice(12))}`;
}

export interface SignedText {
  kind: 'provider_tee' | 'gateway';
  model: string | null;
  requestHash: string;
  responseHash: string;
}

const HASH = /^[0-9a-f]{64}$/i;

/** `{model}:{request}:{response}` from a model TEE, `{request}:{response}` from the gateway TEE. */
export function parseSignedText(text: string): SignedText | null {
  const parts = text.split(':');
  const [a, b, c] = parts;
  if (parts.length === 3 && a && b && c && HASH.test(b) && HASH.test(c)) {
    return { kind: 'provider_tee', model: a, requestHash: b.toLowerCase(), responseHash: c.toLowerCase() };
  }
  if (parts.length === 2 && a && b && HASH.test(a) && HASH.test(b)) {
    return { kind: 'gateway', model: null, requestHash: a.toLowerCase(), responseHash: b.toLowerCase() };
  }
  return null;
}

export interface ChatSignatureChecks {
  signedText: string;
  signatureKind: 'provider_tee' | 'gateway' | 'unparsed';
  recoveredAddress: string | null;
  signingAddress: string;
  signedTextParsed: Check;
  requestHashMatches: Check;
  responseHashMatches: Check;
  signedModelMatchesRequest: Check;
  /** The signature recovers to the `signing_address` that came with it. Proves nothing alone: attestation must bind that address. */
  eip191RecoversSigningAddress: Check;
}

export function checkChatSignature(input: {
  requestBody: string;
  responseBody: string;
  model: string;
  bundle: SignatureBundle;
}): ChatSignatureChecks {
  const { requestBody, responseBody, model, bundle } = input;
  const parsed = parseSignedText(bundle.text);
  let recovered: string | null = null;
  let recoverCheck: Check;
  try {
    recovered = recoverEip191Address(bundle.text, bundle.signature);
    recoverCheck = recovered === bundle.signing_address.toLowerCase();
  } catch {
    // A malformed signature recovers no address, which is a failed check.
    recoverCheck = false;
  }
  const notParsed = 'not run: signed text did not parse';
  return {
    signedText: bundle.text,
    signatureKind: parsed?.kind ?? 'unparsed',
    recoveredAddress: recovered,
    signingAddress: bundle.signing_address.toLowerCase(),
    signedTextParsed: parsed !== null,
    requestHashMatches: parsed ? parsed.requestHash === sha256Hex(requestBody) : notParsed,
    responseHashMatches: parsed ? parsed.responseHash === sha256Hex(responseBody) : notParsed,
    signedModelMatchesRequest: !parsed
      ? notParsed
      : parsed.kind === 'gateway'
        ? 'not run: a gateway signature does not name the model'
        : parsed.model === model,
    eip191RecoversSigningAddress: recoverCheck,
  };
}

// ---------------------------------------------------------------------------- Attestation

export interface AttestationEntry {
  model_name?: string;
  signing_address: string;
  signing_algo?: string;
  request_nonce?: string;
  intel_quote: string;
  nvidia_payload?: string;
  tls_cert_fingerprint?: string;
  info?: { tcb_info?: string | { app_compose?: string }; compose_hash?: string };
}

export interface AttestationReport {
  gateway_attestation?: AttestationEntry;
  model_attestations?: AttestationEntry[];
}

export async function fetchAttestationReport(model: string | null, nonce: string): Promise<AttestationReport> {
  const params = new URLSearchParams({ signing_algo: 'ecdsa', nonce });
  if (model) params.set('model', model);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (process.env.NEAR_AI_API_KEY) headers.authorization = `Bearer ${process.env.NEAR_AI_API_KEY}`;
  const res = await upstream(`${GATEWAY_URL()}/attestation/report?${params}`, {
    headers,
    signal: AbortSignal.timeout(ATTESTATION_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new TeeApiError(res.status, `Attestation report returned HTTP ${res.status}`);
  }
  return (await res.json()) as AttestationReport;
}

const TDX_V4_REPORT_DATA_OFFSET = 48 + 520;
const REPORT_DATA_LENGTH = 64;

/** TD report body at offset 48 of a v4 quote, with report_data its last 64 bytes. */
export function reportDataFromQuote(quoteHex: string): Uint8Array {
  const quote = hexToBytes(quoteHex.replace(/^0x/i, ''));
  const end = TDX_V4_REPORT_DATA_OFFSET + REPORT_DATA_LENGTH;
  if (quote.length < end) throw new Error(`Quote too short: ${quote.length} bytes`);
  return quote.slice(TDX_V4_REPORT_DATA_OFFSET, end);
}

/** report_data[0..32] = address right-padded with zeros, report_data[32..64] = raw nonce. */
export function checkReportData(
  reportData: Uint8Array,
  signingAddress: string,
  nonceHex: string,
): { bindsSigningAddress: boolean; bindsNonce: boolean } {
  const address = hexToBytes(signingAddress.replace(/^0x/i, '').toLowerCase());
  const expected = new Uint8Array(32);
  expected.set(address.subarray(0, 32));
  return {
    bindsSigningAddress: bytesToHex(reportData.subarray(0, 32)) === bytesToHex(expected),
    bindsNonce: bytesToHex(reportData.subarray(32, 64)) === nonceHex.toLowerCase(),
  };
}

interface IntelResult {
  intelQuoteVerified: Check;
  intelTcbStatus: string | null;
  intelAdvisoryIds: string[];
  composeHashMatchesMrConfig: Check;
}

const ACCEPTED_TCB_STATUS = new Set(['UpToDate', 'OutOfDate']);

function appComposeOf(entry: AttestationEntry): string | null {
  const tcb = entry.info?.tcb_info;
  if (!tcb) return null;
  const parsed = typeof tcb === 'string' ? (JSON.parse(tcb) as { app_compose?: string }) : tcb;
  return parsed.app_compose ?? null;
}

/**
 * Uses `@phala/dcap-qvl`, the pure JS verifier. The `-node` and `-web` packages from the upstream
 * reference skip QE Identity verification (GHSA-796p-j2gh-9m2q). Collateral comes from Intel's PCS.
 * A fetch failure is "not run". A verifier rejection is `false`.
 */
async function verifyIntelQuote(entry: AttestationEntry, reportData: Uint8Array): Promise<IntelResult> {
  const notRun = (reason: string): IntelResult => ({
    intelQuoteVerified: `not run: ${reason}`,
    intelTcbStatus: null,
    intelAdvisoryIds: [],
    composeHashMatchesMrConfig: 'not run: Intel quote not verified',
  });
  const qvl = await import('@phala/dcap-qvl');
  const quote = Buffer.from(entry.intel_quote.replace(/^0x/i, ''), 'hex');
  let collateral: Awaited<ReturnType<typeof qvl.getCollateral>>;
  try {
    collateral = await qvl.getCollateral(INTEL_PCS_URL, quote);
  } catch (error) {
    return notRun(`Intel collateral fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  let verified: ReturnType<typeof qvl.verify>;
  try {
    verified = qvl.verify(quote, collateral, Math.floor(Date.now() / 1000));
  } catch (error) {
    return {
      intelQuoteVerified: false,
      intelTcbStatus: `rejected: ${error instanceof Error ? error.message : String(error)}`,
      intelAdvisoryIds: [],
      composeHashMatchesMrConfig: 'not run: Intel quote rejected',
    };
  }
  const td = verified.report.data as { reportData?: Uint8Array; mrConfigId?: Uint8Array };
  const verifiedReportData = td.reportData ? bytesToHex(td.reportData) : null;
  const statusOk = ACCEPTED_TCB_STATUS.has(String(verified.status));

  let composeCheck: Check = 'not run: attestation has no app_compose';
  const compose = appComposeOf(entry);
  if (compose !== null) {
    composeCheck = td.mrConfigId
      ? bytesToHex(td.mrConfigId).startsWith(`01${sha256Hex(compose)}`)
      : 'not run: verified report has no mr_config_id';
  }
  return {
    intelQuoteVerified: statusOk && verifiedReportData === bytesToHex(reportData),
    intelTcbStatus: String(verified.status),
    intelAdvisoryIds: verified.advisory_ids ?? [],
    composeHashMatchesMrConfig: composeCheck,
  };
}

export interface NrasChecks {
  nrasPayloadNonceMatches: Check;
  nrasOverallResult: Check;
  nrasEatNonceMatches: Check;
  nrasGpuClaims: Check;
  nrasJwtSignatures: Check;
  nrasTokensUnexpired: Check;
  nrasGpuCount: number | null;
  nrasFailedClaims: string[];
}

function nrasNotRun(reason: string): NrasChecks {
  const value = `not run: ${reason}`;
  return {
    nrasPayloadNonceMatches: value,
    nrasOverallResult: value,
    nrasEatNonceMatches: value,
    nrasGpuClaims: value,
    nrasJwtSignatures: value,
    nrasTokensUnexpired: value,
    nrasGpuCount: null,
    nrasFailedClaims: [],
  };
}

/** Per-GPU claims listed in model-verification.md. Returns the names of those that failed. */
export function failedGpuClaims(claims: JWTPayload): string[] {
  const failed: string[] = [];
  if (claims.secboot !== true) failed.push('secboot');
  if (claims.dbgstat !== 'disabled') failed.push('dbgstat');
  if (claims.measres !== 'success') failed.push('measres');
  if (claims.hwmodel === undefined) failed.push('hwmodel');
  if (claims.ueid === undefined) failed.push('ueid');
  if (claims['x-nvidia-attestation-warning'] !== null) failed.push('x-nvidia-attestation-warning');
  for (const [key, value] of Object.entries(claims)) {
    if (/^x-nvidia-.*-(verified|validated|fetched|available|parsed|match|no-conflict|check)$/.test(key) && value !== true) {
      failed.push(key);
    }
  }
  return failed;
}

const nrasJwks = createRemoteJWKSet(NRAS_JWKS_URL);

async function verifyNras(entry: AttestationEntry, nonce: string): Promise<NrasChecks> {
  if (!entry.nvidia_payload) return nrasNotRun('attestation has no nvidia_payload');
  let payloadNonce: Check;
  try {
    payloadNonce = String((JSON.parse(entry.nvidia_payload) as { nonce?: string }).nonce).toLowerCase() === nonce;
  } catch {
    payloadNonce = false;
  }

  let body: unknown;
  try {
    const res = await upstream(NRAS_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: entry.nvidia_payload,
      signal: AbortSignal.timeout(ATTESTATION_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) return { ...nrasNotRun(`NRAS returned HTTP ${res.status}`), nrasPayloadNonceMatches: payloadNonce };
    body = JSON.parse(text);
  } catch (error) {
    return {
      ...nrasNotRun(`NRAS request failed: ${error instanceof Error ? error.message : String(error)}`),
      nrasPayloadNonceMatches: payloadNonce,
    };
  }

  const overallJwt = (body as [[string, string], Record<string, string>])?.[0]?.[1];
  const gpus = (body as [[string, string], Record<string, string>])?.[1] ?? {};
  if (typeof overallJwt !== 'string') {
    return { ...nrasNotRun('NRAS response has no overall JWT'), nrasPayloadNonceMatches: payloadNonce };
  }
  const overall = decodeJwt(overallJwt);
  const gpuClaims = Object.values(gpus).map((jwt) => decodeJwt(jwt));
  const allClaims = [overall, ...gpuClaims];
  const failedClaims = Object.entries(gpus).flatMap(([gpu, jwt]) =>
    failedGpuClaims(decodeJwt(jwt)).map((claim) => `${gpu}:${claim}`),
  );

  let signatures: Check;
  try {
    await Promise.all(
      [overallJwt, ...Object.values(gpus)].map((jwt) =>
        jwtVerify(jwt, nrasJwks, { issuer: 'https://nras.attestation.nvidia.com', clockTolerance: 60 }),
      ),
    );
    signatures = true;
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    signatures =
      name === 'JWKSTimeout' || /fetch|network/i.test(error instanceof Error ? error.message : '')
        ? `not run: NRAS JWKS unavailable: ${error instanceof Error ? error.message : String(error)}`
        : false;
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    nrasPayloadNonceMatches: payloadNonce,
    nrasOverallResult: overall['x-nvidia-overall-att-result'] === true,
    nrasEatNonceMatches: allClaims.every((claims) => claims.eat_nonce === nonce),
    nrasGpuClaims: gpuClaims.length === 0 ? 'not run: NRAS returned no per-GPU tokens' : failedClaims.length === 0,
    nrasJwtSignatures: signatures,
    nrasTokensUnexpired: allClaims.every((claims) => typeof claims.exp === 'number' && claims.exp > now),
    nrasGpuCount: gpuClaims.length,
    nrasFailedClaims: failedClaims,
  };
}

export interface AttestationChecks extends IntelResult, NrasChecks {
  /** Fresh, random, 32 bytes, hex. */
  attestationNonce: string;
  attestationNodes: number;
  /** The signer of this chat is one of the addresses in a report fetched after the chat. */
  signingAddressInFreshAttestation: Check;
  attestationEchoesNonce: Check;
  /** Read from the raw quote. Meaningful as hardware evidence only when `intelQuoteVerified` is true. */
  tdxReportDataBindsSigningAddress: Check;
  tdxReportDataBindsNonce: Check;
}

function attestationNotRun(nonce: string, nodes: number, reason: string, inAttestation: Check): AttestationChecks {
  const value = `not run: ${reason}`;
  return {
    attestationNonce: nonce,
    attestationNodes: nodes,
    signingAddressInFreshAttestation: inAttestation,
    attestationEchoesNonce: value,
    tdxReportDataBindsSigningAddress: value,
    tdxReportDataBindsNonce: value,
    intelQuoteVerified: value,
    intelTcbStatus: null,
    intelAdvisoryIds: [],
    composeHashMatchesMrConfig: value,
    ...nrasNotRun(reason),
  };
}

/**
 * Fetches a fresh report and checks the entry for `signingAddress`. `kind` selects the model nodes
 * or the gateway. With no `signingAddress`, checks the first model node, for a standalone attestation.
 */
export async function verifyAttestation(params: {
  model: string;
  signingAddress?: string;
  kind?: 'provider_tee' | 'gateway';
}): Promise<AttestationChecks & { attestedSigningAddress: string | null }> {
  const nonce = randomBytes(32).toString('hex');
  const kind = params.kind ?? 'provider_tee';
  let report: AttestationReport;
  try {
    report = await fetchAttestationReport(params.model, nonce);
  } catch (error) {
    const reason = `attestation report unavailable: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ...attestationNotRun(nonce, 0, reason, `not run: ${reason}`),
      attestedSigningAddress: null,
    };
  }

  const entries =
    kind === 'gateway'
      ? report.gateway_attestation
        ? [report.gateway_attestation]
        : []
      : (report.model_attestations ?? []);
  const entry = params.signingAddress
    ? entries.find((e) => e.signing_address.toLowerCase() === params.signingAddress?.toLowerCase())
    : entries[0];
  if (!entry) {
    const reason = params.signingAddress
      ? `no attested node has signing address ${params.signingAddress}`
      : 'report has no attestation entries';
    return {
      ...attestationNotRun(nonce, entries.length, reason, params.signingAddress ? false : `not run: ${reason}`),
      attestedSigningAddress: null,
    };
  }

  let reportData: Uint8Array;
  try {
    reportData = reportDataFromQuote(entry.intel_quote);
  } catch (error) {
    const reason = `quote unreadable: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ...attestationNotRun(nonce, entries.length, reason, true),
      attestationEchoesNonce: entry.request_nonce === nonce,
      tdxReportDataBindsSigningAddress: false,
      tdxReportDataBindsNonce: false,
      attestedSigningAddress: entry.signing_address.toLowerCase(),
    };
  }
  const binding = checkReportData(reportData, entry.signing_address, nonce);
  const [intel, nras] = await Promise.all([
    verifyIntelQuote(entry, reportData),
    kind === 'gateway'
      ? Promise.resolve(nrasNotRun('the gateway TEE has no GPU evidence'))
      : verifyNras(entry, nonce),
  ]);
  return {
    attestationNonce: nonce,
    attestationNodes: entries.length,
    signingAddressInFreshAttestation: params.signingAddress ? true : 'not run: no signing address to compare',
    attestationEchoesNonce: entry.request_nonce === nonce,
    tdxReportDataBindsSigningAddress: binding.bindsSigningAddress,
    tdxReportDataBindsNonce: binding.bindsNonce,
    ...intel,
    ...nras,
    attestedSigningAddress: entry.signing_address.toLowerCase(),
  };
}

// ---------------------------------------------------------------------------- Whole chat

export type TeeVerification = ChatSignatureChecks &
  AttestationChecks & {
    model: string;
    chatId: string;
    signature: string;
  };

export async function verifyChat(inference: InferenceResult): Promise<TeeVerification> {
  const bundle = await fetchChatSignature(inference);
  const signatureChecks = checkChatSignature({
    requestBody: inference.requestBody,
    responseBody: inference.responseBody,
    model: inference.model,
    bundle,
  });
  const { attestedSigningAddress: _attested, ...attestation } = await verifyAttestation({
    model: inference.model,
    signingAddress: bundle.signing_address,
    kind: signatureChecks.signatureKind === 'gateway' ? 'gateway' : 'provider_tee',
  });
  return {
    ...signatureChecks,
    ...attestation,
    model: inference.model,
    chatId: inference.chatId,
    signature: bundle.signature,
  };
}

export interface VerificationSummary {
  /** Checks that ran and failed. */
  failed: string[];
  /** Checks that did not run, with the reason. */
  notRun: Record<string, string>;
  passed: string[];
}

const NON_CHECK_FIELDS = new Set([
  'signedText',
  'signatureKind',
  'recoveredAddress',
  'signingAddress',
  'attestationNonce',
  'intelTcbStatus',
  'model',
  'chatId',
  'signature',
]);

/** Groups the fields. It does not reduce them to one verdict: callers decide what they require. */
export function summarizeVerification(verification: Partial<TeeVerification>): VerificationSummary {
  const summary: VerificationSummary = { failed: [], notRun: {}, passed: [] };
  for (const [field, value] of Object.entries(verification)) {
    if (NON_CHECK_FIELDS.has(field)) continue;
    if (value === true) summary.passed.push(field);
    else if (value === false) summary.failed.push(field);
    else if (typeof value === 'string') summary.notRun[field] = value;
  }
  return summary;
}

/** Runs inference and verifies it. Used where the content has to be attested as a whole. */
export async function attestedChat(params: ChatParams): Promise<{ inference: InferenceResult; verification: TeeVerification }> {
  const inference = await runInference(buildChatBody(params));
  return { inference, verification: await verifyChat(inference) };
}
