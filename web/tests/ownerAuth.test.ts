// Owner room auth: NEP-413 hashing and verification, single-use nonces, session cookies, the
// per-request holder check, and the holder credential. The chain is mocked through OwnerRpc; the
// signatures are real ed25519, produced by near-api-js's own NEP-413 signer.

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChallengeStore,
  checkOwnerAccess,
  completeSignIn,
  credentialKey,
  decodeSignature,
  issueCredential,
  jsonRpcOwnerRpc,
  NEP413_TAG,
  nep413Hash,
  OwnerAuthError,
  OwnerNotConfiguredError,
  readSession,
  serializeNep413,
  sessionCookieName,
  sessionSecret,
  SESSION_TTL_MS,
  sharedChallengeStore,
  signSession,
  siteOrigin,
  sessionCookieOptions,
  verifyCredential,
  verifyNep413,
  type HolderRead,
  type KeyPermission,
  type OwnerChallenge,
  type OwnerRpc,
  type OwnerSession,
} from '@/lib/ownerAuth';
import { assertSameOrigin, ownerErrorResponse, requireHolder } from '@/app/api/owner/_lib/http';
import { POST as challengePost } from '@/app/api/owner/challenge/route';

// ---------------------------------------------------------------------------- Fixtures

const SEED = new Uint8Array(32).map((_, i) => i + 1);
const PUB = ed25519.getPublicKey(SEED);
const SECRET64 = new Uint8Array([...SEED, ...PUB]);
const KEY_STRING = `ed25519:${base58.encode(SECRET64)}` as const;
const PUBLIC_KEY = `ed25519:${base58.encode(PUB)}`;
const NONCE = new Uint8Array(32).map((_, i) => 255 - i);
const MESSAGE = 'Incorpr owner room sign-in\nToken: 1';
const RECIPIENT = 'localhost:3010';
const CALLBACK = 'http://localhost:3010/company/1/owner';

// Produced by near-api-js 7.4.0 KeyPairSigner.signNep413Message('alice.near', ...) for the
// fixtures above. ed25519 is deterministic, so these are fixed known vectors.
const VECTOR_PUBLIC_KEY = 'ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj';
const VECTOR_SIG_NO_CALLBACK = '+eCh4cRuOFiiqkVZRDmI1tg7IZs0g98O1qxCBVXOASzp2wHEpUN/fFzdepfZZrqn4YErhDgTrUrYSq/UTLmFBw==';
const VECTOR_SIG_WITH_CALLBACK = 'vgHcvsDQOnfE/IzNRo5ess61h7aBAr5/AtDiObTCAc9HdFJdoenwoLpxE6qZySdRs3mjvg26XdEuX7sS/9SeCQ==';

const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret-0123');
const REGISTRY = 'incorpr.near';
const T0 = 1_793_000_000_000;

function signer(key: string = KEY_STRING) {
  return new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`));
}

async function walletSign(challenge: OwnerChallenge, opts: { key?: string; callbackUrl?: string; recipient?: string; nonce?: Uint8Array } = {}) {
  const signed = await signer(opts.key).signNep413Message('alice.near', {
    message: challenge.message,
    recipient: opts.recipient ?? challenge.recipient,
    nonce: opts.nonce ?? challenge.nonce,
    callbackUrl: opts.callbackUrl,
  });
  return { publicKey: signed.publicKey.toString(), signature: base64.encode(signed.signature) };
}

/** Mock chain: the key table and the current NFT owner can change between calls. */
class MockChain implements OwnerRpc {
  keys = new Map<string, KeyPermission>();
  owner: string | null = 'alice.near';
  height = 223_350_515;
  calls = 0;
  async viewAccessKey(accountId: string, publicKey: string) {
    return this.keys.get(`${accountId}/${publicKey}`) ?? null;
  }
  async nftOwner(): Promise<HolderRead> {
    this.calls += 1;
    return { ownerId: this.owner, blockHeight: this.height, blockHash: '4pVv7BF7JjvkoXJjBniNubnpfrjtpYjLW3aL1xXb4Yhm' };
  }
}

function issue(store: ChallengeStore, now = T0, nonce?: Uint8Array) {
  return store.issue({ tokenId: '1', registryId: REGISTRY, network: 'mainnet', recipient: RECIPIENT, callbackUrl: CALLBACK }, now, nonce);
}

function session(overrides: Partial<OwnerSession> = {}): OwnerSession {
  return {
    v: 1,
    account_id: 'alice.near',
    token_id: '1',
    registry: REGISTRY,
    network: 'mainnet',
    public_key: PUBLIC_KEY,
    iat: T0,
    exp: T0 + SESSION_TTL_MS,
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<OwnerAuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OwnerAuthError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

// ---------------------------------------------------------------------------- NEP-413

describe('NEP-413 payload', () => {
  it('starts with the borsh u32 tag 2^31 + 413, little endian', () => {
    expect(NEP413_TAG).toBe(2147484061);
    const bytes = serializeNep413({ message: MESSAGE, nonce: NONCE, recipient: RECIPIENT });
    expect(bytesToHex(bytes.slice(0, 4))).toBe('9d010080');
  });

  it('lays out message, nonce, recipient and callback_url as borsh', () => {
    const bytes = serializeNep413({ message: 'hi', nonce: NONCE, recipient: 'a.near' });
    // tag(4) + len(4) "hi"(2) + nonce(32) + len(4) "a.near"(6) + None(1)
    expect(bytes.length).toBe(4 + 4 + 2 + 32 + 4 + 6 + 1);
    expect(bytesToHex(bytes.slice(4, 10))).toBe('020000006869');
    expect(bytes.slice(10, 42)).toEqual(NONCE);
    expect(bytesToHex(bytes.slice(42, 52))).toBe('06000000612e6e656172');
    expect(bytes[52]).toBe(0);
    const withCallback = serializeNep413({ message: 'hi', nonce: NONCE, recipient: 'a.near', callbackUrl: 'x' });
    expect(bytesToHex(withCallback.slice(52))).toBe('010100000078');
  });

  it('hashes with sha256 over the serialized payload', () => {
    const payload = { message: MESSAGE, nonce: NONCE, recipient: RECIPIENT };
    expect(nep413Hash(payload)).toEqual(sha256(serializeNep413(payload)));
  });

  it('refuses a nonce that is not 32 bytes', () => {
    expect(() => serializeNep413({ message: 'm', nonce: new Uint8Array(31), recipient: 'r' })).toThrow(OwnerAuthError);
  });

  it('verifies the near-api-js known vectors, with and without callback_url', () => {
    expect(PUBLIC_KEY).toBe(VECTOR_PUBLIC_KEY);
    expect(verifyNep413(VECTOR_PUBLIC_KEY, VECTOR_SIG_NO_CALLBACK, { message: MESSAGE, nonce: NONCE, recipient: RECIPIENT })).toBe(true);
    expect(verifyNep413(VECTOR_PUBLIC_KEY, VECTOR_SIG_WITH_CALLBACK, { message: MESSAGE, nonce: NONCE, recipient: RECIPIENT, callbackUrl: CALLBACK })).toBe(true);
    // Each signature covers its own callback_url choice only.
    expect(verifyNep413(VECTOR_PUBLIC_KEY, VECTOR_SIG_WITH_CALLBACK, { message: MESSAGE, nonce: NONCE, recipient: RECIPIENT })).toBe(false);
  });

  it('verifies a fresh near-api-js signature and refuses any changed field', async () => {
    const signed = await signer().signNep413Message('alice.near', { message: MESSAGE, recipient: RECIPIENT, nonce: NONCE });
    const sig = base64.encode(signed.signature);
    const base = { message: MESSAGE, nonce: NONCE, recipient: RECIPIENT };
    expect(verifyNep413(signed.publicKey.toString(), sig, base)).toBe(true);
    expect(verifyNep413(PUBLIC_KEY, sig, { ...base, message: `${MESSAGE} ` })).toBe(false);
    expect(verifyNep413(PUBLIC_KEY, sig, { ...base, recipient: 'evil.example' })).toBe(false);
    expect(verifyNep413(PUBLIC_KEY, sig, { ...base, nonce: new Uint8Array(32) })).toBe(false);
    const other = KeyPair.fromRandom('ed25519').getPublicKey().toString();
    expect(verifyNep413(other, sig, base)).toBe(false);
  });

  it('decodes base64, base64url and ed25519:base58 signatures to the same bytes', () => {
    const bytes = base64.decode(VECTOR_SIG_NO_CALLBACK);
    const url = VECTOR_SIG_NO_CALLBACK.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeSignature(VECTOR_SIG_NO_CALLBACK)).toEqual(bytes);
    expect(decodeSignature(url)).toEqual(bytes);
    expect(decodeSignature(`ed25519:${base58.encode(bytes)}`)).toEqual(bytes);
    expect(() => decodeSignature('AAAA')).toThrow(OwnerAuthError);
  });

  it('refuses non-ed25519 public keys', () => {
    expect(() => verifyNep413('secp256k1:abc', VECTOR_SIG_NO_CALLBACK, { message: MESSAGE, nonce: NONCE, recipient: RECIPIENT })).toThrow(OwnerAuthError);
  });
});

// ---------------------------------------------------------------------------- Challenges

describe('challenge store', () => {
  it('issues 32-byte nonces naming the token, registry and network', () => {
    const store = new ChallengeStore();
    const c = issue(store);
    expect(c.nonce.length).toBe(32);
    expect(c.message).toContain('Token: 1');
    expect(c.message).toContain('Registry: incorpr.near (mainnet)');
    expect(c.expiresAtMs - c.issuedAtMs).toBe(5 * 60_000);
    expect(issue(store).id).not.toBe(c.id);
  });

  it('refuses a replayed nonce', () => {
    const store = new ChallengeStore();
    const c = issue(store);
    expect(store.consume(c.id, T0 + 1000).id).toBe(c.id);
    expect(() => store.consume(c.id, T0 + 2000)).toThrow(expect.objectContaining({ code: 'challenge_used' }));
  });

  it('refuses an expired nonce and burns it', () => {
    const store = new ChallengeStore();
    const c = issue(store);
    expect(() => store.consume(c.id, c.expiresAtMs + 1)).toThrow(expect.objectContaining({ code: 'challenge_expired' }));
    expect(() => store.consume(c.id, c.expiresAtMs + 2)).toThrow(expect.objectContaining({ code: 'challenge_used' }));
  });

  it('refuses a nonce it never issued', () => {
    expect(() => new ChallengeStore().consume('AAAA', T0)).toThrow(expect.objectContaining({ code: 'challenge_unknown' }));
  });

  it('shares nonces across route handlers in one process, and replay stays refused', () => {
    const c = issue(sharedChallengeStore(), Date.now());
    expect(sharedChallengeStore().consume(c.id).id).toBe(c.id);
    expect(() => sharedChallengeStore().consume(c.id)).toThrow(OwnerAuthError);
  });
});

// ---------------------------------------------------------------------------- Sign-in

describe('completeSignIn', () => {
  let store: ChallengeStore;
  let chain: MockChain;
  beforeEach(() => {
    store = new ChallengeStore();
    chain = new MockChain();
    chain.keys.set(`alice.near/${PUBLIC_KEY}`, 'FullAccess');
  });

  it('signs in the holder with a full access key', async () => {
    const c = issue(store);
    const signed = await walletSign(c);
    const result = await completeSignIn({ challengeId: c.id, accountId: 'alice.near', ...signed }, { store, rpc: chain, recipient: RECIPIENT, now: T0 + 1000 });
    expect(result.session).toMatchObject({ account_id: 'alice.near', token_id: '1', registry: REGISTRY, network: 'mainnet', public_key: PUBLIC_KEY });
    expect(result.session.exp - result.session.iat).toBe(SESSION_TTL_MS);
    expect(result.signedCallbackUrl).toBe(false);
  });

  it('accepts a wallet that signed the callback_url into the payload (MyNearWallet)', async () => {
    const c = issue(store);
    const signed = await walletSign(c, { callbackUrl: CALLBACK });
    const result = await completeSignIn({ challengeId: c.id, accountId: 'alice.near', ...signed }, { store, rpc: chain, recipient: RECIPIENT, now: T0 + 1000 });
    expect(result.signedCallbackUrl).toBe(true);
  });

  it('refuses the same signature twice (nonce replay)', async () => {
    const c = issue(store);
    const signed = await walletSign(c);
    const input = { challengeId: c.id, accountId: 'alice.near', ...signed };
    await completeSignIn(input, { store, rpc: chain, recipient: RECIPIENT, now: T0 + 1000 });
    const err = await refusal(completeSignIn(input, { store, rpc: chain, recipient: RECIPIENT, now: T0 + 2000 }));
    expect(err.code).toBe('challenge_used');
    expect(err.status).toBe(401);
  });

  it('refuses a signature made for another nonce, and burns the challenge anyway', async () => {
    const c = issue(store);
    const signed = await walletSign(c, { nonce: new Uint8Array(32).fill(7) });
    const err = await refusal(completeSignIn({ challengeId: c.id, accountId: 'alice.near', ...signed }, { store, rpc: chain, recipient: RECIPIENT, now: T0 + 1000 }));
    expect(err.code).toBe('bad_signature');
    const good = await walletSign(c);
    const again = await refusal(completeSignIn({ challengeId: c.id, accountId: 'alice.near', ...good }, { store, rpc: chain, recipient: RECIPIENT, now: T0 + 2000 }));
    expect(again.code).toBe('challenge_used');
  });

  it('refuses a signature for another recipient', async () => {
    const c = issue(store);
    const signed = await walletSign(c, { recipient: 'phish.example' });
    const err = await refusal(completeSignIn({ challengeId: c.id, accountId: 'alice.near', ...signed }, { store, rpc: chain, recipient: RECIPIENT, now: T0 + 1000 }));
    expect(err.code).toBe('bad_signature');
  });

  it('refuses completion on a host other than the challenge recipient', async () => {
    const c = issue(store);
    const signed = await walletSign(c);
    const err = await refusal(completeSignIn({ challengeId: c.id, accountId: 'alice.near', ...signed }, { store, rpc: chain, recipient: 'other.host', now: T0 + 1000 }));
    expect(err.code).toBe('recipient_mismatch');
  });

  it('refuses an expired challenge', async () => {
    const c = issue(store);
    const signed = await walletSign(c);
    const err = await refusal(completeSignIn({ challengeId: c.id, accountId: 'alice.near', ...signed }, { store, rpc: chain, recipient: RECIPIENT, now: c.expiresAtMs + 1 }));
    expect(err.code).toBe('challenge_expired');
  });

  it('refuses a function-call access key', async () => {
    chain.keys.set(`alice.near/${PUBLIC_KEY}`, { FunctionCall: { receiver_id: 'incorpr.near', method_names: [], allowance: null } });
    const c = issue(store);
    const err = await refusal(completeSignIn({ challengeId: c.id, accountId: 'alice.near', ...(await walletSign(c)) }, { store, rpc: chain, recipient: RECIPIENT, now: T0 + 1000 }));
    expect(err.code).toBe('not_full_access');
  });

  it('refuses a key that is not on the claimed account', async () => {
    const c = issue(store);
    const err = await refusal(completeSignIn({ challengeId: c.id, accountId: 'bob.near', ...(await walletSign(c)) }, { store, rpc: chain, recipient: RECIPIENT, now: T0 + 1000 }));
    expect(err.code).toBe('key_not_on_account');
  });

  it('refuses an account that does not hold the token', async () => {
    chain.owner = 'bob.near';
    const c = issue(store);
    const err = await refusal(completeSignIn({ challengeId: c.id, accountId: 'alice.near', ...(await walletSign(c)) }, { store, rpc: chain, recipient: RECIPIENT, now: T0 + 1000 }));
    expect(err.code).toBe('not_holder');
    expect(err.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------- Sessions

describe('session cookie', () => {
  const expected = { tokenId: '1', registryId: REGISTRY, network: 'mainnet' as const };

  it('round-trips', () => {
    const check = readSession(signSession(session(), SECRET), SECRET, expected, T0 + 1000);
    expect(check).toEqual({ ok: true, session: session() });
  });

  it('refuses a tampered body: another account with the original MAC', () => {
    const token = signSession(session(), SECRET);
    const [, tag] = token.split('.');
    const forgedBody = signSession(session({ account_id: 'mallory.near' }), SECRET).split('.')[0];
    const check = readSession(`${forgedBody}.${tag}`, SECRET, expected, T0 + 1000);
    expect(check).toEqual({ ok: false, reason: 'The session signature does not verify.' });
  });

  it('refuses a tampered MAC, a wrong secret and garbage', () => {
    const token = signSession(session(), SECRET);
    const flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'AB' : 'AA');
    expect(readSession(flipped, SECRET, expected, T0).ok).toBe(false);
    expect(readSession(token, new TextEncoder().encode('another-secret-another-secret-0000'), expected, T0).ok).toBe(false);
    expect(readSession('nope', SECRET, expected, T0).ok).toBe(false);
    expect(readSession(`${token}.x`, SECRET, expected, T0).ok).toBe(false);
    expect(readSession(undefined, SECRET, expected, T0).ok).toBe(false);
  });

  it('refuses an expired session and one claiming more than 12 hours', () => {
    expect(readSession(signSession(session(), SECRET), SECRET, expected, T0 + SESSION_TTL_MS + 1).ok).toBe(false);
    expect(readSession(signSession(session({ exp: T0 + SESSION_TTL_MS + 60_000 }), SECRET), SECRET, expected, T0 + 1000).ok).toBe(false);
  });

  it('refuses a session for another token, registry or network', () => {
    const token = signSession(session(), SECRET);
    expect(readSession(token, SECRET, { ...expected, tokenId: '2' }, T0).ok).toBe(false);
    expect(readSession(token, SECRET, { ...expected, registryId: 'other.near' }, T0).ok).toBe(false);
    expect(readSession(token, SECRET, { ...expected, network: 'testnet' }, T0).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------- Holder check

describe('checkOwnerAccess', () => {
  function holderChain() {
    const chain = new MockChain();
    chain.keys.set(`alice.near/${PUBLIC_KEY}`, 'FullAccess');
    return chain;
  }

  it('opens for the holder and refuses the same cookie once nft_token names someone else', async () => {
    const chain = holderChain();
    const cookie = signSession(session(), SECRET);
    const input = { cookie, tokenId: '1', registryId: REGISTRY, network: 'mainnet' as const, secret: SECRET, rpc: chain, now: T0 + 1000 };

    const before = await checkOwnerAccess(input);
    expect(before.kind).toBe('holder');

    // The company sells: the registry now names the buyer. Nothing about the cookie changed.
    chain.owner = 'buyer.near';
    chain.height += 10;
    const after = await checkOwnerAccess(input);
    expect(after).toMatchObject({ kind: 'not_holder', session: { account_id: 'alice.near' }, holder: { ownerId: 'buyer.near', blockHeight: 223_350_525 } });
    expect(chain.calls).toBe(2);
  });

  it('ends the session once the key that signed in is deleted or downgraded, while the account still holds the token', async () => {
    const chain = holderChain();
    const input = { cookie: signSession(session(), SECRET), tokenId: '1', registryId: REGISTRY, network: 'mainnet' as const, secret: SECRET, rpc: chain, now: T0 + 1000 };
    expect((await checkOwnerAccess(input)).kind).toBe('holder');

    // The holder deletes a leaked full access key. nft_token still names alice.near.
    chain.keys.delete(`alice.near/${PUBLIC_KEY}`);
    const revoked = await checkOwnerAccess(input);
    expect(revoked.kind).toBe('signed_out');
    expect(revoked.kind === 'signed_out' && revoked.reason).toContain('no longer a full access key');
    expect(revoked.holder.ownerId).toBe('alice.near');

    chain.keys.set(`alice.near/${PUBLIC_KEY}`, { FunctionCall: { receiver_id: 'x.near', method_names: [] } });
    expect((await checkOwnerAccess(input)).kind).toBe('signed_out');
  });

  it('reports signed_out with the reason when there is no valid cookie, and still reads the holder', async () => {
    const chain = new MockChain();
    const result = await checkOwnerAccess({ cookie: 'x.y', tokenId: '1', registryId: REGISTRY, network: 'mainnet', secret: SECRET, rpc: chain, now: T0 });
    expect(result.kind).toBe('signed_out');
    expect(result.holder.ownerId).toBe('alice.near');
  });
});

describe('requireHolder (route gate)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.NEXT_PUBLIC_NEAR_NETWORK = 'mainnet';
    process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID = REGISTRY;
    process.env.OWNER_SESSION_SECRET = new TextDecoder().decode(SECRET);
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  function request(cookie?: string) {
    return new NextRequest('http://localhost:3010/api/owner/room?token_id=1', {
      headers: cookie ? { cookie: `${sessionCookieName('1')}=${cookie}` } : {},
    });
  }

  it('answers 401 without a cookie, 403 after a sale, and passes the holder', async () => {
    const chain = new MockChain();
    chain.keys.set(`alice.near/${PUBLIC_KEY}`, 'FullAccess');
    const now = Date.now();
    const cookie = signSession(session({ iat: now, exp: now + SESSION_TTL_MS }), SECRET);

    const signedOut = ownerErrorResponse(await refusal(requireHolder(request(), '1', chain)));
    expect(signedOut.status).toBe(401);

    const gate = await requireHolder(request(cookie), '1', chain);
    expect(gate.access.session.account_id).toBe('alice.near');

    chain.owner = 'buyer.near';
    const sold = ownerErrorResponse(await refusal(requireHolder(request(cookie), '1', chain)));
    expect(sold.status).toBe(403);
    expect(((await sold.json()) as { error: { code: string } }).error.code).toBe('not_holder');
  });
});

// ---------------------------------------------------------------------------- Site origin

describe('site origin (NEP-413 recipient)', () => {
  const PHISH = { host: 'phish.example', 'x-forwarded-host': 'phish.example', origin: 'https://phish.example' };

  it('takes the recipient from NEXT_PUBLIC_SITE_URL, never from Host or X-Forwarded-Host', () => {
    const env = { NODE_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'https://incorpr.example/some/path' };
    expect(siteOrigin(new Headers(PHISH), env)).toEqual({ origin: 'https://incorpr.example', host: 'incorpr.example', secure: true, configured: true });
    // Production never takes the localhost shortcut either.
    expect(siteOrigin(new Headers({ host: 'localhost:3010' }), env).host).toBe('incorpr.example');
  });

  it('refuses in production without NEXT_PUBLIC_SITE_URL, and refuses plain http outside localhost', () => {
    expect(() => siteOrigin(new Headers({ host: 'incorpr.example' }), { NODE_ENV: 'production' })).toThrow(OwnerNotConfiguredError);
    expect(() => siteOrigin(new Headers({ host: 'x' }), { NODE_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'http://incorpr.example' })).toThrow(OwnerNotConfiguredError);
    expect(() => siteOrigin(new Headers({ host: 'x' }), { NODE_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'not a url' })).toThrow(OwnerNotConfiguredError);
  });

  it('on a dev server, accepts a localhost Host only', () => {
    expect(siteOrigin(new Headers({ host: 'localhost:3010', 'x-forwarded-host': 'phish.example' }), { NODE_ENV: 'development' })).toEqual({
      origin: 'http://localhost:3010',
      host: 'localhost:3010',
      secure: false,
      configured: false,
    });
    let error: unknown;
    try {
      siteOrigin(new Headers(PHISH), { NODE_ENV: 'development' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OwnerAuthError);
    expect((error as OwnerAuthError).code).toBe('site_origin_not_configured');
  });

  it('sets Secure from the site origin, not from the request host', () => {
    expect(sessionCookieOptions({ secure: true }, 60).secure).toBe(true);
    expect(sessionCookieOptions({ secure: false }, 60).secure).toBe(false);
  });

  describe('routes', () => {
    const saved = { ...process.env };
    beforeEach(() => {
      process.env.NEXT_PUBLIC_NEAR_NETWORK = 'mainnet';
      process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID = REGISTRY;
      process.env.OWNER_SESSION_SECRET = new TextDecoder().decode(SECRET);
      process.env.NEXT_PUBLIC_SITE_URL = 'https://incorpr.example';
    });
    afterEach(() => {
      process.env = { ...saved };
    });

    it('refuses an Origin that matches only the spoofed Host', () => {
      const request = new Request('https://phish.example/api/owner/challenge', { method: 'POST', headers: PHISH });
      expect(() => assertSameOrigin(request)).toThrow(OwnerAuthError);
      const ok = new Request('https://incorpr.example/api/owner/challenge', { method: 'POST', headers: { host: 'phish.example', origin: 'https://incorpr.example' } });
      expect(() => assertSameOrigin(ok)).not.toThrow();
    });

    it('issues a challenge for the configured host when a relay sends X-Forwarded-Host: phish.example', async () => {
      const response = await challengePost(
        new NextRequest('https://incorpr.example/api/owner/challenge', {
          method: 'POST',
          headers: { host: 'phish.example', 'x-forwarded-host': 'phish.example', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
          body: JSON.stringify({ token_id: '1' }),
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { recipient: string; callback_url: string };
      expect(body.recipient).toBe('incorpr.example');
      expect(body.callback_url).toBe('https://incorpr.example/company/1/owner');
    });
  });
});

// ---------------------------------------------------------------------------- Secrets

describe('server secrets', () => {
  it('refuses to run without OWNER_SESSION_SECRET in production', () => {
    expect(() => sessionSecret({ NODE_ENV: 'production' })).toThrow(OwnerNotConfiguredError);
    expect(() => sessionSecret({ NODE_ENV: 'production', OWNER_SESSION_SECRET: 'short' })).toThrow(OwnerNotConfiguredError);
    expect(ownerErrorResponse(new OwnerNotConfiguredError('OWNER_SESSION_SECRET')).status).toBe(503);
  });

  it('maps an OwnerAuthError from another bundle copy of the class to its status', () => {
    const foreign = Object.assign(new Error('This nonce was already used.'), { name: 'OwnerAuthError', status: 401, code: 'challenge_used' });
    expect(ownerErrorResponse(foreign).status).toBe(401);
  });

  it('uses one random secret per dev process when unset', () => {
    const a = sessionSecret({ NODE_ENV: 'development' });
    expect(a.length).toBe(32);
    expect(sessionSecret({ NODE_ENV: 'development' })).toBe(a);
  });

  it('reads OWNER_CREDENTIAL_KEY in NEAR format, 64 or 32 bytes', () => {
    expect(credentialKey({ OWNER_CREDENTIAL_KEY: KEY_STRING })).toMatchObject({ publicKey: PUBLIC_KEY, ephemeral: false });
    expect(credentialKey({ OWNER_CREDENTIAL_KEY: `ed25519:${base58.encode(SEED)}` }).publicKey).toBe(PUBLIC_KEY);
    const mismatched = new Uint8Array([...SEED, ...ed25519.getPublicKey(new Uint8Array(32).fill(9))]);
    expect(() => credentialKey({ OWNER_CREDENTIAL_KEY: `ed25519:${base58.encode(mismatched)}` })).toThrow(OwnerNotConfiguredError);
    expect(() => credentialKey({ NODE_ENV: 'production' })).toThrow(OwnerNotConfiguredError);
    expect(credentialKey({ NODE_ENV: 'development' }).ephemeral).toBe(true);
  });
});

// ---------------------------------------------------------------------------- Credential

describe('holder credential', () => {
  const key = credentialKey({ OWNER_CREDENTIAL_KEY: KEY_STRING });
  const holder: HolderRead = { ownerId: 'alice.near', blockHeight: 223_350_515, blockHash: '4pVv7BF7JjvkoXJjBniNubnpfrjtpYjLW3aL1xXb4Yhm' };

  it('signs the statement and verifies against the published key', () => {
    const doc = issueCredential({ session: session(), holder, keyUrl: 'http://localhost:3010/api/owner/credential-key', now: T0 }, key);
    expect(doc.credential.statement).toBe('alice.near holds Incorpr token 1 as of block 223350515');
    expect(doc.public_key).toBe(PUBLIC_KEY);
    expect(ed25519.verify(base64.decode(doc.signature), new TextEncoder().encode(doc.payload), PUB)).toBe(true);
    expect(verifyCredential(doc, PUBLIC_KEY)).toMatchObject({ valid: true });
  });

  it('fails verification when the payload, the credential object or the key differ', () => {
    const doc = issueCredential({ session: session(), holder, keyUrl: 'k', now: T0 }, key);
    expect(verifyCredential({ ...doc, payload: doc.payload.replace('alice.near', 'mallory.near') }, PUBLIC_KEY).valid).toBe(false);
    expect(verifyCredential({ ...doc, credential: { ...doc.credential, account_id: 'mallory.near' } }, PUBLIC_KEY).valid).toBe(false);
    expect(verifyCredential(doc, KeyPair.fromRandom('ed25519').getPublicKey().toString()).valid).toBe(false);
  });

  it('refuses to issue when the holder read names another account', () => {
    expect(() => issueCredential({ session: session(), holder: { ...holder, ownerId: 'buyer.near' }, keyUrl: 'k' }, key)).toThrow(OwnerAuthError);
  });
});

// ---------------------------------------------------------------------------- JSON-RPC client

describe('jsonRpcOwnerRpc', () => {
  function rpcReply(result: unknown, status = 200) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'owner', result }), { status, headers: { 'content-type': 'application/json' } });
  }

  it('reads nft_token owner and block, moving past an endpoint that answers 503', async () => {
    const seen: string[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      if (String(url).includes('down')) return new Response('', { status: 503 });
      const body = JSON.parse(String(init?.body)) as { params: Record<string, unknown> };
      expect(body.params).toMatchObject({ request_type: 'call_function', account_id: REGISTRY, method_name: 'nft_token', finality: 'final' });
      const bytes = Array.from(new TextEncoder().encode(JSON.stringify({ token_id: '1', owner_id: 'demo-buyer.incorpr.near' })));
      return rpcReply({ result: bytes, logs: [], block_height: 223350515, block_hash: 'H' });
    }) as typeof fetch;
    const rpc = jsonRpcOwnerRpc(['https://down.example', 'https://up.example'], fetchMock);
    expect(await rpc.nftOwner(REGISTRY, '1')).toEqual({ ownerId: 'demo-buyer.incorpr.near', blockHeight: 223350515, blockHash: 'H' });
    expect(seen).toEqual(['https://down.example', 'https://up.example']);
  });

  it('reads a missing token as ownerId null', async () => {
    const fetchMock = (async () => rpcReply({ result: Array.from(new TextEncoder().encode('null')), block_height: 1, block_hash: 'H' })) as typeof fetch;
    expect((await jsonRpcOwnerRpc(['https://x'], fetchMock).nftOwner(REGISTRY, '99')).ownerId).toBeNull();
  });

  it('maps view_access_key to FullAccess, FunctionCall or null', async () => {
    const replies = [
      { nonce: 1, permission: 'FullAccess', block_height: 1, block_hash: 'H' },
      { nonce: 1, permission: { FunctionCall: { receiver_id: 'x.near', method_names: [], allowance: null } }, block_height: 1, block_hash: 'H' },
      { error: 'access key ed25519:111 does not exist while viewing', logs: [], block_height: 1, block_hash: 'H' },
    ];
    let i = 0;
    const fetchMock = (async () => rpcReply(replies[i++])) as typeof fetch;
    const rpc = jsonRpcOwnerRpc(['https://x'], fetchMock);
    expect(await rpc.viewAccessKey('a.near', PUBLIC_KEY)).toBe('FullAccess');
    expect(await rpc.viewAccessKey('a.near', PUBLIC_KEY)).toEqual({ FunctionCall: { receiver_id: 'x.near', method_names: [], allowance: null } });
    expect(await rpc.viewAccessKey('a.near', PUBLIC_KEY)).toBeNull();
  });
});
