// One NEAR AI Cloud chat with its signature checked, for demo.mjs's `serve` step. Same request
// shape, hosts and checks as web/src/lib/nearAiTee.ts (runInference, fetchChatSignature,
// checkChatSignature), reduced to what a script needs. Requires NEAR_AI_API_KEY.

import { createHash } from 'node:crypto';
import { attestedSigners, nearAiBaseUrl } from './attestation.mjs';
import { CliError, sleep } from './cli.mjs';
import { webImport } from './deps.mjs';

const { secp256k1 } = await webImport('@noble/curves/secp256k1.js');
const { keccak_256 } = await webImport('@noble/hashes/sha3.js');
const { bytesToHex, hexToBytes } = await webImport('@noble/hashes/utils.js');

/** Same map as KNOWN_DIRECT_ENDPOINTS in web/src/lib/nearAiTee.ts, extended by NEAR_AI_DIRECT_ENDPOINTS. */
const KNOWN_DIRECT_ENDPOINTS = { 'Qwen/Qwen3-VL-30B-A3B-Instruct': 'https://qwen3-vl-30b.completions.near.ai/v1' };

function directEndpointFor(model) {
  let extra = {};
  if (process.env.NEAR_AI_DIRECT_ENDPOINTS) extra = JSON.parse(process.env.NEAR_AI_DIRECT_ENDPOINTS);
  return ({ ...KNOWN_DIRECT_ENDPOINTS, ...extra })[model]?.replace(/\/$/, '') ?? null;
}

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

function recoverEip191(text, signatureHex) {
  const message = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const digest = keccak_256(new Uint8Array([...prefix, ...message]));
  const raw = hexToBytes(signatureHex.replace(/^0x/i, ''));
  if (raw.length !== 65) throw new Error(`expected a 65-byte signature, got ${raw.length}`);
  const v = raw[64] >= 27 ? raw[64] - 27 : raw[64];
  const point = secp256k1.Signature.fromBytes(raw.subarray(0, 64), 'compact').addRecoveryBit(v).recoverPublicKey(digest);
  return `0x${bytesToHex(keccak_256(point.toBytes(false).subarray(1)).slice(12))}`;
}

export function requireApiKey() {
  if (!process.env.NEAR_AI_API_KEY) {
    throw new CliError('NEAR_AI_API_KEY is not set (shell or web/.env.local). The serve step runs real NEAR AI Cloud inference and has no offline mode.');
  }
  return process.env.NEAR_AI_API_KEY;
}

/** Runs one non-streaming chat and verifies its TEE signature against a fresh attestation. */
export async function attestedChat({ model, system, user, maxTokens = 512 }) {
  const key = requireApiKey();
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    max_tokens: maxTokens,
  });
  const gateway = nearAiBaseUrl();
  const baseUrl = directEndpointFor(model) ?? gateway;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const responseBody = await res.text();
  if (!res.ok) throw new CliError(`inference on ${baseUrl} returned HTTP ${res.status}: ${responseBody.slice(0, 300)}`);
  const parsed = JSON.parse(responseBody);
  if (!parsed.id) throw new CliError('inference response has no chat id');

  const query = baseUrl === gateway ? `model=${encodeURIComponent(model)}&signing_algo=ecdsa` : 'signing_algo=ecdsa';
  let bundle = null;
  let lastError = '';
  for (let attempt = 0; attempt < 10 && !bundle; attempt += 1) {
    if (attempt) await sleep(750);
    const sig = await fetch(`${baseUrl}/signature/${encodeURIComponent(parsed.id)}?${query}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await sig.text();
    if (sig.ok) bundle = JSON.parse(text);
    else lastError = `HTTP ${sig.status}: ${text.slice(0, 200)}`;
  }
  if (!bundle) throw new CliError(`no signature for chat ${parsed.id}: ${lastError}`);

  const parts = String(bundle.text).split(':');
  const providerTee = parts.length === 3;
  const [signedModel, requestHash, responseHash] = providerTee ? parts : [null, parts[0], parts[1]];
  let recovered = null;
  try {
    recovered = recoverEip191(bundle.text, bundle.signature);
  } catch {
    recovered = null;
  }
  const signingAddress = String(bundle.signing_address).toLowerCase();
  const attestation = await attestedSigners(model, { allowUnverifiedQuote: true });
  const checks = {
    requestHashMatches: requestHash === sha256Hex(body),
    responseHashMatches: responseHash === sha256Hex(responseBody),
    signedModelMatches: providerTee ? signedModel === model : 'not run: gateway signature does not name the model',
    eip191RecoversSigningAddress: recovered === signingAddress,
    signingAddressInFreshAttestation: providerTee
      ? attestation.signers.includes(signingAddress)
      : 'not run: gateway signer is attested in gateway_attestation',
  };
  return {
    chatId: parsed.id,
    model,
    baseUrl,
    content: parsed.choices?.[0]?.message?.content ?? null,
    signingAddress,
    signedText: bundle.text,
    checks,
    failed: Object.entries(checks).filter(([, v]) => v === false).map(([k]) => k),
  };
}
