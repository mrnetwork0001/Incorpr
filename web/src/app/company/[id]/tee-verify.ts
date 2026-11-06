// In-browser checks of a NEAR AI Cloud chat signature. The server route already ran the same checks;
// these run again here on the bytes the browser received, so the result does not rest on the
// server's word. Hardware evidence (Intel TDX quote, NVIDIA NRAS) comes from /api/attestation,
// which fetches a fresh report with a new nonce.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/** true: passed. false: ran and failed. string: did not run, and why. */
export type CheckResult = boolean | string;

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

/** EIP-191 personal_sign hash of `text`. */
export function eip191Hash(text: string): Uint8Array {
  const message = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const joined = new Uint8Array(prefix.length + message.length);
  joined.set(prefix);
  joined.set(message, prefix.length);
  return keccak_256(joined);
}

/** Recovers the lowercase `0x` address that signed `text`. Throws on a malformed signature. */
export function recoverSigner(text: string, signatureHex: string): string {
  const raw = hexToBytes(signatureHex.replace(/^0x/i, ''));
  if (raw.length !== 65) throw new Error(`expected a 65-byte signature, got ${raw.length}`);
  const v = raw[64] as number;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error(`invalid recovery id ${v}`);
  const point = secp256k1.Signature.fromBytes(raw.subarray(0, 64), 'compact')
    .addRecoveryBit(recovery)
    .recoverPublicKey(eip191Hash(text));
  return `0x${bytesToHex(keccak_256(point.toBytes(false).subarray(1)).slice(12))}`;
}

export interface SignedText {
  model: string | null;
  requestHash: string;
  responseHash: string;
}

const HASH = /^[0-9a-f]{64}$/i;

/** `{model}:{request sha256}:{response sha256}` from a model TEE, or `{request}:{response}` from the gateway. */
export function parseSignedText(text: string): SignedText | null {
  const parts = text.split(':');
  const [a, b, c] = parts;
  if (parts.length === 3 && a && b && c && HASH.test(b) && HASH.test(c)) {
    return { model: a, requestHash: b.toLowerCase(), responseHash: c.toLowerCase() };
  }
  if (parts.length === 2 && a && b && HASH.test(a) && HASH.test(b)) {
    return { model: null, requestHash: a.toLowerCase(), responseHash: b.toLowerCase() };
  }
  return null;
}

/**
 * The request body /api/run-service sends: the company's charter prompt as the system message and
 * the customer's input as the user message, keys in this order. Mirrors `buildChatBody` in
 * lib/nearAiTee.ts with the route's 1024-token cap. If the route changes either, this check fails
 * rather than passes.
 */
export function serviceRequestBody(model: string, system: string, user: string, maxTokens = 1024): string {
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    max_tokens: maxTokens,
  });
}

export interface BrowserChecks {
  recovered: string | null;
  signatureRecoversSigningAddress: CheckResult;
  signedTextParsed: CheckResult;
  signedModelMatches: CheckResult;
  requestHashMatchesYourInput: CheckResult;
  responseHashMatches: CheckResult;
}

export function runBrowserChecks(input: {
  signedText: string;
  signature: string;
  signingAddress: string;
  model: string;
  system: string;
  userInput: string;
  /** Exact bytes, when the route returns them. */
  requestBody?: string | null;
  responseBody?: string | null;
}): BrowserChecks {
  let recovered: string | null = null;
  let recovers: CheckResult;
  try {
    recovered = recoverSigner(input.signedText, input.signature);
    recovers = recovered === input.signingAddress.toLowerCase();
  } catch {
    // A malformed signature recovers no address, which is a failed check.
    recovers = false;
  }
  const parsed = parseSignedText(input.signedText);
  const notParsed = 'not run: the signed text did not parse';
  const request = input.requestBody ?? serviceRequestBody(input.model, input.system, input.userInput);
  return {
    recovered,
    signatureRecoversSigningAddress: recovers,
    signedTextParsed: parsed !== null,
    signedModelMatches: !parsed ? notParsed : parsed.model === null ? 'not run: a gateway signature does not name the model' : parsed.model === input.model,
    requestHashMatchesYourInput: parsed ? parsed.requestHash === sha256Hex(request) : notParsed,
    responseHashMatches: !parsed
      ? notParsed
      : input.responseBody
        ? parsed.responseHash === sha256Hex(input.responseBody)
        : 'not run here: the route returns the answer text, not the raw response bytes. The server checked this hash.',
  };
}

/** Pass when every check that ran passed and at least one did; fail when any ran and failed. */
export function verdict(checks: CheckResult[]): 'pass' | 'fail' | 'incomplete' {
  if (checks.some((c) => c === false)) return 'fail';
  return checks.every((c) => c === true) ? 'pass' : 'incomplete';
}
