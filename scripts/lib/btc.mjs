// Bitcoin P2WPKH spend from a vault's treasury address. The vault holds no key: each input's
// BIP-143 sighash is signed by v1.signer through vault.request_shareholder_signature, and this
// file turns the MPC response into a witness. UTXOs, fee rates and broadcast use an Esplora API
// (mempool.space).

import { CliError } from './cli.mjs';
import { webImport } from './deps.mjs';

const bitcoin = await webImport('bitcoinjs-lib');
const { secp256k1 } = await webImport('@noble/curves/secp256k1.js');
const { base58 } = await webImport('@scure/base');
const { bytesToHex, hexToBytes } = await webImport('@noble/hashes/utils.js');

const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DUST_P2WPKH = 294n;

export const btcNetwork = (hrp) => (hrp === 'bc' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet);

async function esplora(api, path, init) {
  const res = await fetch(`${api}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new CliError(`${api}${path} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

export async function fetchUtxos(api, address) {
  return JSON.parse(await esplora(api, `/address/${address}/utxo`));
}

export async function recommendedFeeRate(api) {
  const fees = JSON.parse(await esplora(api, '/v1/fees/recommended'));
  return BigInt(Math.max(1, Math.ceil(fees.halfHourFee ?? fees.hourFee ?? 1)));
}

export async function broadcast(api, hex) {
  return (await esplora(api, '/tx', { method: 'POST', body: hex, headers: { 'content-type': 'text/plain' } })).trim();
}

/** `secp256k1:<base58 x||y>` from the MPC signer, as the vault stores it, to a 33-byte key. */
export function compressedFromNearKey(key) {
  const raw = base58.decode(key.replace(/^secp256k1:/, ''));
  if (raw.length !== 64) throw new CliError(`expected a 64-byte secp256k1 key, got ${raw.length}`);
  const out = new Uint8Array(33);
  out[0] = (raw[63] & 1) === 1 ? 3 : 2;
  out.set(raw.subarray(0, 32), 1);
  return out;
}

/** vbytes for P2WPKH inputs and outputs. Rounded up. */
function estimateVsize(inputs, outputs) {
  return BigInt(Math.ceil(10.5 + 68 * inputs + 31 * outputs));
}

/**
 * Builds the unsigned transaction. `amountSats` null sweeps every confirmed UTXO to `to`.
 * Change, if above dust, returns to `from`.
 */
export function buildSpend({ utxos, from, to, amountSats, feeRate, hrp, pubkey }) {
  const network = btcNetwork(hrp);
  const confirmed = utxos.filter((u) => u.status?.confirmed);
  if (confirmed.length === 0) throw new CliError(`${from} has no confirmed UTXOs`);
  const payment = bitcoin.payments.p2wpkh({ pubkey, network });
  if (payment.address !== from) throw new CliError(`derived key gives ${payment.address}, not ${from}`);
  const scriptCode = bitcoin.payments.p2pkh({ hash: payment.hash, network }).output;
  const total = confirmed.reduce((sum, u) => sum + BigInt(u.value), 0n);

  const sweep = amountSats === null;
  const fee = estimateVsize(confirmed.length, sweep ? 1 : 2) * feeRate;
  const amount = sweep ? total - fee : BigInt(amountSats);
  if (amount < DUST_P2WPKH) throw new CliError(`amount ${amount} sats is below dust after a ${fee} sat fee (balance ${total})`);
  let change = total - amount - fee;
  if (change < 0n) throw new CliError(`balance ${total} sats does not cover ${amount} + fee ${fee}`);
  let actualFee = fee;
  if (!sweep && change < DUST_P2WPKH) {
    actualFee += change;
    change = 0n;
  }

  const tx = new bitcoin.Transaction();
  tx.version = 2;
  for (const u of confirmed) tx.addInput(hexToBytes(u.txid).reverse(), u.vout, 0xfffffffd);
  tx.addOutput(bitcoin.address.toOutputScript(to, network), amount);
  if (change > 0n) tx.addOutput(payment.output, change);
  const sighashes = confirmed.map((u, i) => tx.hashForWitnessV0(i, scriptCode, BigInt(u.value), bitcoin.Transaction.SIGHASH_ALL));
  return { tx, inputs: confirmed, sighashes, amount, change, fee: actualFee, total };
}

/** 64-byte low-S r||s from a v1.signer Secp256k1 response. */
export function signatureFromMpc(response) {
  const bigR = response?.big_r?.affine_point;
  const s = response?.s?.scalar;
  if (typeof bigR !== 'string' || typeof s !== 'string') throw new CliError(`unexpected signer response: ${JSON.stringify(response).slice(0, 300)}`);
  const r = BigInt(`0x${bigR.slice(2)}`);
  let sValue = BigInt(`0x${s}`);
  if (sValue > CURVE_N / 2n) sValue = CURVE_N - sValue;
  return hexToBytes(r.toString(16).padStart(64, '0') + sValue.toString(16).padStart(64, '0'));
}

export function verifySignature(signature, sighash, pubkey) {
  return secp256k1.verify(signature, sighash, pubkey, { prehash: false });
}

export function finalize(tx, signatures, pubkey) {
  signatures.forEach((sig, i) => {
    tx.setWitness(i, [bitcoin.script.signature.encode(sig, bitcoin.Transaction.SIGHASH_ALL), pubkey]);
  });
  return { hex: tx.toHex(), txid: tx.getId(), vsize: tx.virtualSize() };
}

export { bytesToHex };
