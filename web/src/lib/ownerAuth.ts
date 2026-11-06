import 'server-only';

// Holder-gated access for the owner room (/company/<id>/owner and /api/owner/*).
//
// Sign-in: the wallet signs a NEP-413 message naming the token, for recipient = the configured
// site host (NEXT_PUBLIC_SITE_URL, see siteOrigin; never a request header),
// over a 32-byte nonce the server issued (single use, 5 minute TTL). The server checks the ed25519
// signature over the NEP-413 payload hash, that the key is a full access key on the account
// (view_access_key), and that the account holds the token right now (nft_token). It then issues an
// HMAC-SHA256 session cookie bound to {account, token, registry, network}, valid at most 12 hours.
//
// Every gated request reads nft_token(token_id).owner_id again and refuses when it is not the
// session account. A sale moves access to the buyer without any logout: the seller's cookie still
// verifies, but the chain no longer names the seller.
//
// Challenges live in this process's memory. A deployment with several instances needs a shared
// store, or sticky sessions, for sign-in to land on the instance that issued the nonce.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64, base64urlnopad } from '@scure/base';
import { getNetworkConfig, type NearNetwork } from './near';

// ---------------------------------------------------------------------------- Errors

/** A refusal the caller can act on. `status` is the HTTP status the routes answer with. */
export class OwnerAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OwnerAuthError';
  }
}

/** A required server secret is missing in production. Routes answer 503. */
export class OwnerNotConfiguredError extends Error {
  constructor(readonly variable: string) {
    super(`${variable} is not set on this server, so owner sign-in is unavailable. Set it in the server environment and restart.`);
    this.name = 'OwnerNotConfiguredError';
  }
}

// ---------------------------------------------------------------------------- NEP-413

/** 2^31 + 413. Borsh u32 prefix that keeps a NEP-413 payload from ever parsing as a transaction. */
export const NEP413_TAG = 2 ** 31 + 413;

export interface Nep413Payload {
  message: string;
  /** Exactly 32 bytes. */
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | null;
}

const utf8 = new TextEncoder();

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function borshString(value: string): Uint8Array[] {
  const bytes = utf8.encode(value);
  return [u32le(bytes.length), bytes];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** borsh(u32 tag) || borsh({ message: String, nonce: [u8; 32], recipient: String, callback_url: Option<String> }). */
export function serializeNep413(payload: Nep413Payload): Uint8Array {
  if (payload.nonce.length !== 32) throw new OwnerAuthError(400, 'bad_nonce', 'A NEP-413 nonce is exactly 32 bytes');
  const callback = payload.callbackUrl == null ? [new Uint8Array([0])] : [new Uint8Array([1]), ...borshString(payload.callbackUrl)];
  return concat([u32le(NEP413_TAG), ...borshString(payload.message), payload.nonce, ...borshString(payload.recipient), ...callback]);
}

/** The 32 bytes the wallet signs. */
export function nep413Hash(payload: Nep413Payload): Uint8Array {
  return sha256(serializeNep413(payload));
}

/** `ed25519:<base58 of 32 bytes>`. Other key types cannot have signed a NEP-413 message here. */
export function parseEd25519PublicKey(text: string): Uint8Array {
  const match = /^ed25519:([1-9A-HJ-NP-Za-km-z]{32,50})$/.exec(text.trim());
  if (!match) throw new OwnerAuthError(400, 'bad_public_key', 'The public key must be an ed25519 key in the form ed25519:<base58>');
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(match[1] as string);
  } catch {
    throw new OwnerAuthError(400, 'bad_public_key', 'The public key is not valid base58');
  }
  if (bytes.length !== 32) throw new OwnerAuthError(400, 'bad_public_key', 'An ed25519 public key is 32 bytes');
  return bytes;
}

/**
 * Wallets return the 64-byte signature as base64 (NEP-413, Meteor, MyNearWallet). Accepts base64url
 * and `ed25519:<base58>` too, which some wallets and libraries use.
 */
export function decodeSignature(text: string): Uint8Array {
  const value = text.trim();
  let bytes: Uint8Array | null = null;
  try {
    if (value.startsWith('ed25519:')) {
      bytes = base58.decode(value.slice('ed25519:'.length));
    } else {
      const std = value.replace(/-/g, '+').replace(/_/g, '/');
      bytes = base64.decode(std.padEnd(Math.ceil(std.length / 4) * 4, '='));
    }
  } catch {
    bytes = null;
  }
  if (!bytes || bytes.length !== 64) throw new OwnerAuthError(400, 'bad_signature_encoding', 'The signature must be 64 bytes, base64 encoded');
  return bytes;
}

export function verifyNep413(publicKey: string, signature: string, payload: Nep413Payload): boolean {
  const key = parseEd25519PublicKey(publicKey);
  const sig = decodeSignature(signature);
  try {
    return ed25519.verify(sig, nep413Hash(payload), key);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------- Challenges

export const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_LIVE_CHALLENGES = 10_000;

export interface OwnerChallenge {
  /** base64url of the nonce. Also the challenge id. */
  id: string;
  nonce: Uint8Array;
  tokenId: string;
  registryId: string;
  network: NearNetwork;
  recipient: string;
  /** Where a redirecting wallet returns. MyNearWallet signs it into the payload; Meteor does not. */
  callbackUrl: string;
  message: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export function challengeMessage(tokenId: string, registryId: string, network: NearNetwork, issuedAtMs: number): string {
  return [
    'Incorpr owner room sign-in',
    `Token: ${tokenId}`,
    `Registry: ${registryId} (${network})`,
    `Issued: ${new Date(issuedAtMs).toISOString()}`,
    'Signing proves you control this account. It sends no transaction and moves no funds.',
  ].join('\n');
}

type Slot = { kind: 'live'; challenge: OwnerChallenge } | { kind: 'used'; expiresAtMs: number };

/** Single-use nonces. A consumed nonce stays as a tombstone until it would have expired. */
export class ChallengeStore {
  constructor(private readonly slots: Map<string, Slot> = new Map()) {}

  issue(
    input: { tokenId: string; registryId: string; network: NearNetwork; recipient: string; callbackUrl: string },
    now: number = Date.now(),
    nonce: Uint8Array = randomBytes(32),
  ): OwnerChallenge {
    this.sweep(now);
    if (this.slots.size >= MAX_LIVE_CHALLENGES) {
      throw new OwnerAuthError(429, 'too_many_challenges', 'Too many sign-ins are pending on this server. Try again in a few minutes.');
    }
    const id = base64urlnopad.encode(nonce);
    const challenge: OwnerChallenge = {
      id,
      nonce,
      ...input,
      message: challengeMessage(input.tokenId, input.registryId, input.network, now),
      issuedAtMs: now,
      expiresAtMs: now + CHALLENGE_TTL_MS,
    };
    this.slots.set(id, { kind: 'live', challenge });
    return challenge;
  }

  /** Returns the challenge and burns it. A second call with the same id is refused. */
  consume(id: string, now: number = Date.now()): OwnerChallenge {
    const slot = this.slots.get(id);
    if (!slot) throw new OwnerAuthError(401, 'challenge_unknown', 'This sign-in challenge was not issued by this server, or it expired. Start again.');
    if (slot.kind === 'used') throw new OwnerAuthError(401, 'challenge_used', 'This nonce was already used. Each signature signs in once; start again.');
    this.slots.set(id, { kind: 'used', expiresAtMs: slot.challenge.expiresAtMs });
    if (now > slot.challenge.expiresAtMs) {
      throw new OwnerAuthError(401, 'challenge_expired', 'The sign-in challenge expired. It is valid for 5 minutes; start again.');
    }
    return slot.challenge;
  }

  private sweep(now: number) {
    for (const [id, slot] of this.slots) {
      const expires = slot.kind === 'live' ? slot.challenge.expiresAtMs : slot.expiresAtMs;
      if (now > expires) this.slots.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------- Chain reads

export type KeyPermission = 'FullAccess' | { FunctionCall: { receiver_id: string; method_names: string[]; allowance?: string | null } };

export interface HolderRead {
  /** Null when the registry has no such token. */
  ownerId: string | null;
  blockHeight: number;
  blockHash: string;
}

export interface OwnerRpc {
  /** Null when the key is not on the account, or the account does not exist. */
  viewAccessKey(accountId: string, publicKey: string): Promise<KeyPermission | null>;
  nftOwner(registryId: string, tokenId: string): Promise<HolderRead>;
}

export class OwnerRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerRpcError';
  }
}

type RpcResult = Record<string, unknown> & { block_height?: number; block_hash?: string; error?: string; result?: number[] };

/** JSON-RPC `query` at `final`, moving to the next endpoint only on a transport failure. */
export function jsonRpcOwnerRpc(rpcUrls: string[] = getNetworkConfig().rpcUrls, fetchImpl: typeof fetch = fetch): OwnerRpc {
  async function query(params: Record<string, unknown>): Promise<RpcResult> {
    let last = 'no RPC endpoint configured';
    for (const url of rpcUrls) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'owner', method: 'query', params: { finality: 'final', ...params } }),
          cache: 'no-store',
          signal: AbortSignal.timeout(8_000),
        });
        if (res.status >= 500) {
          last = `${url} answered HTTP ${res.status}`;
          continue;
        }
        const body = (await res.json()) as { result?: RpcResult; error?: { message?: string; data?: unknown; cause?: { name?: string } } };
        if (body.error) {
          const detail = `${body.error.cause?.name ?? ''} ${body.error.message ?? ''} ${typeof body.error.data === 'string' ? body.error.data : JSON.stringify(body.error.data ?? '')}`;
          return { error: detail };
        }
        if (!body.result) throw new Error('empty result');
        return body.result;
      } catch (error) {
        last = `${url}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    throw new OwnerRpcError(`Could not read the chain: ${last}`);
  }

  return {
    async viewAccessKey(accountId, publicKey) {
      const result = await query({ request_type: 'view_access_key', account_id: accountId, public_key: publicKey });
      if (typeof result.error === 'string') {
        if (/does not exist|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/i.test(result.error)) return null;
        throw new OwnerRpcError(`view_access_key failed: ${result.error}`);
      }
      return (result.permission as KeyPermission | undefined) ?? null;
    },
    async nftOwner(registryId, tokenId) {
      const args = base64.encode(utf8.encode(JSON.stringify({ token_id: tokenId })));
      const result = await query({ request_type: 'call_function', account_id: registryId, method_name: 'nft_token', args_base64: args });
      if (typeof result.error === 'string' || !Array.isArray(result.result)) {
        throw new OwnerRpcError(`${registryId}.nft_token failed: ${result.error ?? 'no result bytes'}`);
      }
      const token = JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as { owner_id?: string } | null;
      return {
        ownerId: token?.owner_id ?? null,
        blockHeight: Number(result.block_height ?? 0),
        blockHash: String(result.block_hash ?? ''),
      };
    },
  };
}

// ---------------------------------------------------------------------------- Secrets

type Env = Record<string, string | undefined>;

const ephemeral = globalThis as typeof globalThis & { __incorprOwnerEphemeral?: Record<string, Uint8Array> };

function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}

function ephemeralBytes(name: string, length: number): Uint8Array {
  // On globalThis so a dev hot reload does not sign everyone out.
  ephemeral.__incorprOwnerEphemeral ??= {};
  let value = ephemeral.__incorprOwnerEphemeral[name];
  if (!value) {
    value = randomBytes(length);
    ephemeral.__incorprOwnerEphemeral[name] = value;
    console.warn(`[owner] ${name} is not set. Using a random value for this dev server; sessions and credentials end when it restarts.`);
  }
  return value;
}

/** HMAC key for session cookies. At least 32 characters. Refuses in production when unset. */
export function sessionSecret(env: Env = process.env): Uint8Array {
  const value = env.OWNER_SESSION_SECRET;
  if (value) {
    if (value.length < 32) throw new OwnerNotConfiguredError('OWNER_SESSION_SECRET (at least 32 characters)');
    return utf8.encode(value);
  }
  if (isProduction(env)) throw new OwnerNotConfiguredError('OWNER_SESSION_SECRET');
  return ephemeralBytes('OWNER_SESSION_SECRET', 32);
}

export interface CredentialKey {
  seed: Uint8Array;
  publicKey: string;
  ephemeral: boolean;
}

/**
 * OWNER_CREDENTIAL_KEY is a NEAR-format ed25519 secret key, `ed25519:<base58>` of the 64-byte
 * seed||public key (as near-cli and near-api-js write it) or of the 32-byte seed alone.
 */
export function credentialKey(env: Env = process.env): CredentialKey {
  const value = env.OWNER_CREDENTIAL_KEY;
  if (value) {
    const match = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(value.trim());
    let bytes: Uint8Array | null = null;
    try {
      bytes = match ? base58.decode(match[1] as string) : null;
    } catch {
      bytes = null;
    }
    if (!bytes || (bytes.length !== 32 && bytes.length !== 64)) throw new OwnerNotConfiguredError('OWNER_CREDENTIAL_KEY (ed25519:<base58 secret key>)');
    const seed = bytes.slice(0, 32);
    const pub = ed25519.getPublicKey(seed);
    if (bytes.length === 64 && base58.encode(bytes.slice(32)) !== base58.encode(pub)) {
      throw new OwnerNotConfiguredError('OWNER_CREDENTIAL_KEY (its public half does not match its seed)');
    }
    return { seed, publicKey: `ed25519:${base58.encode(pub)}`, ephemeral: false };
  }
  if (isProduction(env)) throw new OwnerNotConfiguredError('OWNER_CREDENTIAL_KEY');
  const seed = ephemeralBytes('OWNER_CREDENTIAL_KEY', 32);
  return { seed, publicKey: `ed25519:${base58.encode(ed25519.getPublicKey(seed))}`, ephemeral: true };
}

// ---------------------------------------------------------------------------- Sessions

export const SESSION_TTL_MS = 12 * 60 * 60_000;

export interface OwnerSession {
  v: 1;
  account_id: string;
  token_id: string;
  registry: string;
  network: NearNetwork;
  /** The full access key that signed in. */
  public_key: string;
  iat: number;
  exp: number;
}

/** One cookie per token, so a holder of several companies can be signed in to each. */
export function sessionCookieName(tokenId: string): string {
  return `incorpr_owner_${tokenId}`;
}

function mac(body: string, secret: Uint8Array): Uint8Array {
  return createHmac('sha256', secret).update(body).digest();
}

/** `base64url(json).base64url(hmac_sha256(secret, base64url(json)))`. */
export function signSession(session: OwnerSession, secret: Uint8Array): string {
  const body = base64urlnopad.encode(utf8.encode(JSON.stringify(session)));
  return `${body}.${base64urlnopad.encode(mac(body, secret))}`;
}

export type SessionCheck = { ok: true; session: OwnerSession } | { ok: false; reason: string };

export function readSession(
  token: string | undefined | null,
  secret: Uint8Array,
  expected: { tokenId: string; registryId: string; network: NearNetwork },
  now: number = Date.now(),
): SessionCheck {
  if (!token) return { ok: false, reason: 'No session cookie.' };
  const [body, tag, extra] = token.split('.');
  if (!body || !tag || extra !== undefined) return { ok: false, reason: 'The session cookie is malformed.' };
  let given: Uint8Array;
  try {
    given = base64urlnopad.decode(tag);
  } catch {
    return { ok: false, reason: 'The session cookie is malformed.' };
  }
  const want = mac(body, secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: 'The session signature does not verify.' };
  let session: OwnerSession;
  try {
    session = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(body))) as OwnerSession;
  } catch {
    return { ok: false, reason: 'The session cookie is malformed.' };
  }
  if (session.v !== 1) return { ok: false, reason: 'The session format is not supported.' };
  if (session.token_id !== expected.tokenId || session.registry !== expected.registryId || session.network !== expected.network) {
    return { ok: false, reason: 'The session is for a different token, registry or network.' };
  }
  if (!(session.exp > now) || session.exp - session.iat > SESSION_TTL_MS) return { ok: false, reason: 'The session expired. Sign in again.' };
  return { ok: true, session };
}

// ---------------------------------------------------------------------------- Sign-in

const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export interface SignInInput {
  challengeId: string;
  accountId: string;
  publicKey: string;
  signature: string;
}

export interface SignInDeps {
  store: ChallengeStore;
  rpc: OwnerRpc;
  /** Host of the request completing the sign-in. Must equal the challenge's recipient. */
  recipient: string;
  now?: number;
}

export interface SignInResult {
  session: OwnerSession;
  holder: HolderRead;
  /** Whether the wallet signed with the challenge's callbackUrl in the payload. */
  signedCallbackUrl: boolean;
}

/** Burns the challenge first, so a failed attempt cannot be retried with the same nonce. */
export async function completeSignIn(input: SignInInput, deps: SignInDeps): Promise<SignInResult> {
  const now = deps.now ?? Date.now();
  const challenge = deps.store.consume(input.challengeId, now);
  if (challenge.recipient !== deps.recipient) {
    throw new OwnerAuthError(400, 'recipient_mismatch', `The challenge was issued for ${challenge.recipient}, not ${deps.recipient}.`);
  }
  const accountId = input.accountId.trim();
  if (!ACCOUNT_ID.test(accountId)) throw new OwnerAuthError(400, 'bad_account_id', 'The wallet returned an invalid NEAR account id.');

  const base = { message: challenge.message, nonce: challenge.nonce, recipient: challenge.recipient };
  let signedCallbackUrl = false;
  if (!verifyNep413(input.publicKey, input.signature, { ...base, callbackUrl: null })) {
    if (!verifyNep413(input.publicKey, input.signature, { ...base, callbackUrl: challenge.callbackUrl })) {
      throw new OwnerAuthError(401, 'bad_signature', 'The signature does not verify for this message, nonce and recipient.');
    }
    signedCallbackUrl = true;
  }

  const permission = await deps.rpc.viewAccessKey(accountId, input.publicKey.trim());
  if (permission === null) {
    throw new OwnerAuthError(401, 'key_not_on_account', `${input.publicKey} is not an access key of ${accountId}.`);
  }
  if (permission !== 'FullAccess') {
    throw new OwnerAuthError(
      401,
      'not_full_access',
      `${input.publicKey} is a function-call key on ${accountId}. Sign-in needs a full access key, because a function-call key can be held by a dapp.`,
    );
  }

  const holder = await deps.rpc.nftOwner(challenge.registryId, challenge.tokenId);
  if (holder.ownerId === null) throw new OwnerAuthError(404, 'token_not_found', `${challenge.registryId} has no token ${challenge.tokenId}.`);
  if (holder.ownerId !== accountId) {
    throw new OwnerAuthError(
      403,
      'not_holder',
      `${accountId} does not hold token ${challenge.tokenId}: nft_token names ${holder.ownerId} at block ${holder.blockHeight}.`,
    );
  }

  return {
    session: {
      v: 1,
      account_id: accountId,
      token_id: challenge.tokenId,
      registry: challenge.registryId,
      network: challenge.network,
      public_key: input.publicKey.trim(),
      iat: now,
      exp: now + SESSION_TTL_MS,
    },
    holder,
    signedCallbackUrl,
  };
}

// ---------------------------------------------------------------------------- Access check

export type OwnerAccess =
  | { kind: 'holder'; session: OwnerSession; holder: HolderRead }
  | { kind: 'signed_out'; reason: string; holder: HolderRead }
  | { kind: 'not_holder'; session: OwnerSession; holder: HolderRead };

/**
 * Runs on every gated page render and API call. The session alone never grants access: nft_token
 * must name the session account, and the key that signed in must still be a full access key on it.
 * The second read means deleting a leaked key ends the session it opened at the next request.
 */
export async function checkOwnerAccess(input: {
  cookie: string | undefined | null;
  tokenId: string;
  registryId: string;
  network: NearNetwork;
  secret: Uint8Array;
  rpc: OwnerRpc;
  now?: number;
}): Promise<OwnerAccess> {
  const check = readSession(input.cookie, input.secret, input, input.now);
  const [holder, permission] = await Promise.all([
    input.rpc.nftOwner(input.registryId, input.tokenId),
    check.ok ? input.rpc.viewAccessKey(check.session.account_id, check.session.public_key) : Promise.resolve(null),
  ]);
  if (!check.ok) return { kind: 'signed_out', reason: check.reason, holder };
  if (permission !== 'FullAccess') {
    return {
      kind: 'signed_out',
      reason: `The key that signed in (${check.session.public_key}) is no longer a full access key on ${check.session.account_id}. Sign in again.`,
      holder,
    };
  }
  if (holder.ownerId !== check.session.account_id) return { kind: 'not_holder', session: check.session, holder };
  return { kind: 'holder', session: check.session, holder };
}

// ---------------------------------------------------------------------------- Holder credential

export const CREDENTIAL_TYPE = 'incorpr.holder-credential.v1';

export interface HolderCredential {
  type: typeof CREDENTIAL_TYPE;
  statement: string;
  account_id: string;
  token_id: string;
  registry: string;
  network: NearNetwork;
  block_height: number;
  block_hash: string;
  /** The full access key the holder signed in with. */
  signed_in_with: string;
  issued_at: string;
}

export interface SignedCredential {
  credential: HolderCredential;
  /** The exact bytes signed, as UTF-8 JSON. Verify against this string, not a re-serialization. */
  payload: string;
  /** base64 of the 64-byte ed25519 signature over UTF-8(payload). */
  signature: string;
  public_key: string;
  algorithm: 'ed25519';
  key_url: string;
}

export function credentialStatement(accountId: string, tokenId: string, blockHeight: number): string {
  return `${accountId} holds Incorpr token ${tokenId} as of block ${blockHeight}`;
}

export function issueCredential(
  input: { session: OwnerSession; holder: HolderRead; keyUrl: string; now?: number },
  key: CredentialKey,
): SignedCredential {
  const { session, holder } = input;
  if (holder.ownerId !== session.account_id) throw new OwnerAuthError(403, 'not_holder', 'The session account no longer holds this token.');
  const credential: HolderCredential = {
    type: CREDENTIAL_TYPE,
    statement: credentialStatement(session.account_id, session.token_id, holder.blockHeight),
    account_id: session.account_id,
    token_id: session.token_id,
    registry: session.registry,
    network: session.network,
    block_height: holder.blockHeight,
    block_hash: holder.blockHash,
    signed_in_with: session.public_key,
    issued_at: new Date(input.now ?? Date.now()).toISOString(),
  };
  const payload = JSON.stringify(credential);
  return {
    credential,
    payload,
    signature: base64.encode(ed25519.sign(utf8.encode(payload), key.seed)),
    public_key: key.publicKey,
    algorithm: 'ed25519',
    key_url: input.keyUrl,
  };
}

export type CredentialCheck =
  | { valid: true; credential: HolderCredential }
  | { valid: false; reason: string };

/** Checks the signature against `publicKey` (this server's key) and that `credential` matches `payload`. */
export function verifyCredential(doc: Pick<SignedCredential, 'payload' | 'signature'> & { credential?: unknown }, publicKey: string): CredentialCheck {
  let ok = false;
  try {
    ok = ed25519.verify(decodeSignature(doc.signature), utf8.encode(doc.payload), parseEd25519PublicKey(publicKey));
  } catch {
    ok = false;
  }
  if (!ok) return { valid: false, reason: 'The signature does not verify against this server key.' };
  let credential: HolderCredential;
  try {
    credential = JSON.parse(doc.payload) as HolderCredential;
  } catch {
    return { valid: false, reason: 'The payload is not JSON.' };
  }
  if (credential.type !== CREDENTIAL_TYPE) return { valid: false, reason: 'Not an Incorpr holder credential.' };
  if (doc.credential !== undefined && JSON.stringify(doc.credential) !== doc.payload) {
    return { valid: false, reason: 'The credential object differs from the signed payload.' };
  }
  return { valid: true, credential };
}

// ---------------------------------------------------------------------------- Request helpers

export function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name.endsWith('.localhost');
}

export interface SiteOrigin {
  /** `https://incorpr.example` */
  origin: string;
  /** `incorpr.example`, the NEP-413 recipient. */
  host: string;
  /** Whether the session cookie carries `Secure`. */
  secure: boolean;
  /** False for the localhost fallback of a dev server. */
  configured: boolean;
}

/**
 * The origin that the NEP-413 recipient, the wallet callback URL, the Origin check and the cookie's
 * Secure flag all come from. It is read from NEXT_PUBLIC_SITE_URL, never from Host or
 * X-Forwarded-Host: a caller chooses those headers, so a recipient built from them would let a
 * phishing site's backend request a challenge for its own domain and relay the signature here.
 *
 * Without NEXT_PUBLIC_SITE_URL, production refuses (503) and a dev server accepts a localhost Host
 * only. A dev server reached on localhost uses that origin even when the variable is set, so a
 * local run with the production URL in .env.local still signs in.
 */
export function siteOrigin(headers: Headers, env: Env = process.env): SiteOrigin {
  const host = (headers.get('host') ?? '').trim().toLowerCase();
  if (!isProduction(env) && isLocalHost(host)) {
    return { origin: `http://${host}`, host, secure: false, configured: false };
  }
  const raw = (env.NEXT_PUBLIC_SITE_URL ?? '').trim();
  if (!raw) {
    if (isProduction(env)) throw new OwnerNotConfiguredError('NEXT_PUBLIC_SITE_URL');
    throw new OwnerAuthError(
      400,
      'site_origin_not_configured',
      `NEXT_PUBLIC_SITE_URL is not set, so this dev server signs owners in on localhost only, not on ${host || 'a request with no Host'}.`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OwnerNotConfiguredError('NEXT_PUBLIC_SITE_URL (an absolute https:// origin)');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.host))) {
    throw new OwnerNotConfiguredError('NEXT_PUBLIC_SITE_URL (https:// outside localhost)');
  }
  return { origin: url.origin, host: url.host.toLowerCase(), secure: url.protocol === 'https:', configured: true };
}

/** Cookie attributes. `Secure` unless the site origin is plain-http localhost. */
export function sessionCookieOptions(site: Pick<SiteOrigin, 'secure'>, maxAgeSec: number) {
  return { httpOnly: true, secure: site.secure, sameSite: 'strict' as const, path: '/', maxAge: maxAgeSec };
}

/**
 * The process-wide challenge store. Only the Map lives on globalThis: Next dev compiles each route
 * separately, and a shared class instance would throw another bundle's OwnerAuthError.
 */
export function sharedChallengeStore(): ChallengeStore {
  const g = globalThis as typeof globalThis & { __incorprOwnerChallengeSlots?: Map<string, Slot> };
  g.__incorprOwnerChallengeSlots ??= new Map();
  return new ChallengeStore(g.__incorprOwnerChallengeSlots);
}
