import 'server-only';

// Arguments for the attack transactions. Each one is built from the vault's live state so that it
// passes every check before the one the attempt is about; the vault then refuses it on-chain.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 as keccak } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { randomBytes } from 'node:crypto';
import type { SwapProposal, TeeProof, VaultState, WithdrawProposal } from '../contracts';
import { eip191Hash, sha256Hex } from '../nearAiTee';
import { epochCapRemaining, priceFloorMinBuy } from '../rebalance';

const BTC_TOKEN = /^nep141:btc(-[a-z0-9]+)?\.omft\.near$/;
const ONE_USDC = 1_000_000n;

export function randomNonceB64(): string {
  return randomBytes(32).toString('base64');
}

/** P2WPKH address for 20 random bytes. No one holds a key whose hash is these bytes. */
export function randomBtcAddress(hrp: string): string {
  return bech32.encode(hrp, [0, ...bech32.toWords(randomBytes(20))]);
}

export function btcToken(state: Pick<VaultState, 'policy'>): string {
  return state.policy.allowed_tokens.find((t) => BTC_TOKEN.test(t)) ?? 'nep141:btc.omft.near';
}

export function usdcToken(state: Pick<VaultState, 'usdc_token'>): string {
  return `nep141:${state.usdc_token}`;
}

function capOf(state: Pick<VaultState, 'policy'>, token: string): bigint {
  const entry = state.policy.epoch_caps.find(([t]) => t === token);
  return entry ? BigInt(entry[1]) : 0n;
}

/** The day's whole BTC allowance, so the destination is the only thing standing in the way. */
export function outsideWithdrawal(state: VaultState, destination: string): WithdrawProposal {
  const token = btcToken(state);
  const cap = capOf(state, token);
  return {
    token,
    amount: (cap > 0n ? cap : 100_000_000n).toString(),
    destination,
    chain: 'btc',
    nonce_b64: randomNonceB64(),
  };
}

/** Sells what is left of today's USDC cap for 1 base unit of BTC: far under any price floor. */
export function dumpSwap(state: VaultState, nowMs: number): SwapProposal {
  const sell = usdcToken(state);
  const left = epochCapRemaining(state, nowMs).get(sell) ?? 0n;
  const amount = left > 0n ? left : capOf(state, sell) || ONE_USDC;
  return { sell_token: sell, sell_amount: amount.toString(), buy_token: btcToken(state), min_buy_amount: '1', nonce_b64: randomNonceB64() };
}

/** A swap the firewall accepts: at most 1 USDC, within today's cap, at exactly the price floor. */
export function floorSwap(state: VaultState, nowMs: number): SwapProposal {
  const sell = usdcToken(state);
  const buy = btcToken(state);
  const left = epochCapRemaining(state, nowMs).get(sell) ?? 0n;
  const amount = left > 0n && left < ONE_USDC ? left : ONE_USDC;
  const minBuy = priceFloorMinBuy(state, sell, buy, amount) ?? 1n;
  return {
    sell_token: sell,
    sell_amount: amount.toString(),
    buy_token: buy,
    min_buy_amount: (minBuy > 0n ? minBuy : 1n).toString(),
    nonce_b64: randomNonceB64(),
  };
}

/**
 * A TEE proof that is right in every field the operator controls: the exact request body the vault
 * builds (read from its own `swap_tee_request` view), a reply of "APPROVE <proposal_hash>" dated now,
 * matching hashes, and a valid EIP-191 signature. The key is generated here and discarded, so it is
 * not one of the vault's attested TEE signers.
 */
export function forgeApproval(input: {
  model: string;
  systemPrompt: string;
  requestBody: string;
  proposalHash: string;
  nowSeconds: number;
}): { proof: TeeProof; forgerAddress: string } {
  const responseBody = JSON.stringify({
    id: `chatcmpl-forged-${bytesToHex(randomBytes(8))}`,
    object: 'chat.completion',
    created: input.nowSeconds,
    model: input.model,
    choices: [{ index: 0, message: { role: 'assistant', content: `APPROVE ${input.proposalHash}` }, finish_reason: 'stop' }],
  });
  const text = `${input.model}:${sha256Hex(input.requestBody)}:${sha256Hex(responseBody)}`;
  const secret = secp256k1.utils.randomSecretKey();
  const recovered = secp256k1.sign(eip191Hash(text), secret, { prehash: false, format: 'recovered' });
  // noble returns [recovery, r, s]; the vault reads r || s || v.
  const signature = new Uint8Array(65);
  signature.set(recovered.subarray(1, 65), 0);
  signature[64] = 27 + (recovered[0] as number);
  const publicKey = secp256k1.getPublicKey(secret, false);
  const forgerAddress = `0x${bytesToHex(keccak(publicKey.subarray(1)).slice(12))}`;
  return {
    proof: { text, signature_hex: bytesToHex(signature), response_body: responseBody, system_prompt: input.systemPrompt },
    forgerAddress,
  };
}

