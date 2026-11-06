// JSON-RPC client, key files and transaction sending for the deploy and demo scripts.
//
// Transactions are signed locally, hashed, broadcast with wait_until NONE and then polled by hash,
// so the hash is known (and recorded) whatever the RPC does afterwards. Private keys are read from
// key files and never printed.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, sleep } from './cli.mjs';
import { webImport } from './deps.mjs';

const near = await webImport('near-api-js');
export const { actions, KeyPair, KeyPairSigner, PublicKey } = near;

export class RpcError extends Error {
  constructor(method, error) {
    const cause = error?.cause?.name ?? error?.name ?? 'RPC_ERROR';
    super(`${method}: ${cause}: ${typeof error?.data === 'string' ? error.data : JSON.stringify(error?.data ?? error).slice(0, 600)}`);
    this.name = 'RpcError';
    this.cause = cause;
    this.rpcError = error;
  }
}

export class TxFailedError extends Error {
  constructor(result) {
    super(`transaction ${result.hash} failed: ${result.error}`);
    this.name = 'TxFailedError';
    this.result = result;
  }
}

/** The RPC refused the transaction before it reached a chunk, so there is no on-chain hash. */
export class TxRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TxRejectedError';
  }
}

const POLL_MS = 1_500;

/** First ERR_ code in a failure, else the panic text, else the raw JSON. */
export function failureReason(failure) {
  const text = JSON.stringify(failure);
  const code = /ERR_[A-Z0-9_]+/.exec(text);
  if (code) return code[0];
  const panic = /"(?:panic_msg|PanicMsg|ExecutionError)"\s*:\s*"([^"]{1,300})"/.exec(text);
  if (panic) return panic[1];
  return text.slice(0, 400);
}

export class Near {
  /**
   * @param {object} o
   * @param {string} o.network mainnet | testnet | sandbox
   * @param {string} o.rpcUrl
   * @param {string} o.credentialsDir
   * @param {string|null} o.explorerUrl base explorer URL, null when there is none (sandbox)
   * @param {import('./evidence.mjs').Evidence|null} o.evidence
   */
  constructor({ network, rpcUrl, credentialsDir, explorerUrl, evidence = null }) {
    this.network = network;
    this.rpcUrl = rpcUrl;
    this.credentialsDir = credentialsDir;
    this.explorerUrl = explorerUrl;
    this.evidence = evidence;
    this.nonces = new Map();
    this.rpcId = 0;
  }

  txUrl(hash) {
    return this.explorerUrl ? `${this.explorerUrl}/txns/${hash}` : null;
  }

  accountUrl(accountId) {
    return this.explorerUrl ? `${this.explorerUrl}/address/${accountId}` : null;
  }

  async rpc(method, params) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await sleep(500 * 2 ** attempt);
      let res;
      try {
        res = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        lastError = new Error(`${method}: ${error.message}`);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${method}: HTTP ${res.status}`);
        continue;
      }
      const body = await res.json();
      if (body.error) throw new RpcError(method, body.error);
      return body.result;
    }
    throw lastError;
  }

  async status() {
    return this.rpc('status', []);
  }

  async protocolConfig() {
    return this.rpc('EXPERIMENTAL_protocol_config', { finality: 'final' });
  }

  async gasPrice() {
    return BigInt((await this.rpc('gas_price', [null])).gas_price);
  }

  async viewAccount(accountId) {
    try {
      return await this.rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId });
    } catch (error) {
      if (error instanceof RpcError && error.cause === 'UNKNOWN_ACCOUNT') return null;
      throw error;
    }
  }

  async accessKey(accountId, publicKey) {
    try {
      return await this.rpc('query', {
        request_type: 'view_access_key',
        finality: 'optimistic',
        account_id: accountId,
        public_key: publicKey,
      });
    } catch (error) {
      if (error instanceof RpcError && ['UNKNOWN_ACCESS_KEY', 'UNKNOWN_ACCOUNT'].includes(error.cause)) return null;
      throw error;
    }
  }

  async accessKeyList(accountId) {
    return (await this.rpc('query', { request_type: 'view_access_key_list', finality: 'optimistic', account_id: accountId })).keys;
  }

  /** Free balance: amount minus what storage locks. */
  async freeBalance(accountId, config) {
    const account = await this.viewAccount(accountId);
    if (!account) return null;
    const perByte = BigInt(config.runtime_config.storage_amount_per_byte);
    return BigInt(account.amount) - BigInt(account.storage_usage) * perByte;
  }

  /** Read-only contract call. Throws an Error whose message carries the contract panic text. */
  async view(contractId, method, args = {}, finality = 'optimistic') {
    const result = await this.rpc('query', {
      request_type: 'call_function',
      finality,
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    if (result.error) throw new Error(`${contractId}.${method}: ${result.error}`);
    const text = Buffer.from(result.result).toString();
    return text ? JSON.parse(text) : null;
  }

  async tryView(contractId, method, args = {}) {
    try {
      return { ok: true, value: await this.view(contractId, method, args) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // ------------------------------------------------------------------ key files

  credentialPath(accountId) {
    return join(this.credentialsDir, `${accountId}.json`);
  }

  hasCredentials(accountId) {
    return existsSync(this.credentialPath(accountId));
  }

  /** Reads `<credentialsDir>/<account>.json` (near-cli format). The key never leaves this process. */
  loadKeyPair(accountId) {
    const path = this.credentialPath(accountId);
    if (!existsSync(path)) throw new CliError(`no key file for ${accountId}: expected ${path}`);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    const secret = file.private_key ?? file.secret_key;
    if (!secret) throw new CliError(`${path} has no private_key`);
    const keyPair = KeyPair.fromString(secret);
    if (file.public_key && keyPair.getPublicKey().toString() !== file.public_key) {
      throw new CliError(`${path}: private_key does not match public_key`);
    }
    return keyPair;
  }

  publicKeyOf(accountId) {
    return this.loadKeyPair(accountId).getPublicKey().toString();
  }

  /** Writes a fresh ed25519 key for `accountId` with mode 0600. Refuses to overwrite a key file. */
  createKeyFile(accountId) {
    const path = this.credentialPath(accountId);
    if (existsSync(path)) throw new CliError(`refusing to overwrite existing key file ${path}`);
    mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
    const keyPair = KeyPair.fromRandom('ed25519');
    writeFileSync(
      path,
      `${JSON.stringify({ account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() })}\n`,
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
    return keyPair;
  }

  /** The key file for `accountId`, created if absent. */
  keyFileFor(accountId) {
    return this.hasCredentials(accountId) ? this.loadKeyPair(accountId) : this.createKeyFile(accountId);
  }

  /** True when the account exists and the local key file's key is a full access key on it. */
  async controls(accountId) {
    if (!this.hasCredentials(accountId)) return false;
    const key = await this.accessKey(accountId, this.publicKeyOf(accountId));
    return Boolean(key && key.permission === 'FullAccess');
  }

  // ------------------------------------------------------------------ transactions

  async nextNonce(accountId, publicKey) {
    const key = await this.accessKey(accountId, publicKey);
    if (!key) throw new CliError(`${publicKey} is not an access key of ${accountId} on ${this.network}`);
    const cacheKey = `${accountId}:${publicKey}`;
    const next = BigInt(Math.max(Number(key.nonce), Number(this.nonces.get(cacheKey) ?? 0n))) + 1n;
    this.nonces.set(cacheKey, next);
    return next;
  }

  /**
   * Signs and sends one transaction, waits for every receipt, and records it as evidence.
   * A failed transaction is recorded too. It throws TxFailedError unless `expectFailure` is set.
   *
   * @param {object} o
   * @param {string} o.signerId
   * @param {string} o.receiverId
   * @param {any[]} o.actions near-api-js actions
   * @param {{ step: string, purpose: string, method: string, deposit?: bigint, gas?: bigint }} o.label
   * @param {boolean} [o.expectFailure]
   */
  async send({ signerId, receiverId, actions: txActions, label, expectFailure = false, timeoutMs = 240_000 }) {
    const keyPair = this.loadKeyPair(signerId);
    const publicKey = keyPair.getPublicKey();
    const signer = new KeyPairSigner(keyPair);

    let hash;
    for (let attempt = 0; ; attempt += 1) {
      const nonce = await this.nextNonce(signerId, publicKey.toString());
      const block = await this.rpc('block', { finality: 'final' });
      const tx = near.createTransaction(signerId, publicKey, receiverId, nonce, txActions, near.baseDecode(block.header.hash));
      const { txHash, signedTransaction } = await signer.signTransaction(tx);
      hash = near.baseEncode(txHash);
      try {
        await this.rpc('send_tx', {
          signed_tx_base64: Buffer.from(signedTransaction.encode()).toString('base64'),
          wait_until: 'NONE',
        });
        break;
      } catch (error) {
        const text = error.message ?? String(error);
        if (/InvalidNonce/.test(text) && attempt < 4) {
          await sleep(POLL_MS);
          continue;
        }
        throw new TxRejectedError(`${label.method} from ${signerId} was rejected by the RPC before inclusion: ${text}`);
      }
    }

    const outcome = await this.waitFor(hash, signerId, timeoutMs);
    const result = summarizeOutcome(hash, outcome);
    result.explorerUrl = this.txUrl(hash);

    this.evidence?.addTransaction({
      step: label.step,
      purpose: label.purpose,
      method: label.method,
      signer: signerId,
      receiver: receiverId,
      deposit_yocto: label.deposit === undefined ? null : label.deposit.toString(),
      gas: label.gas === undefined ? null : label.gas.toString(),
      tx_hash: hash,
      explorer_url: result.explorerUrl,
      status: result.ok ? 'success' : 'failure',
      expected_failure: expectFailure,
      error: result.error,
      receipt_failures: result.receiptFailures,
      gas_burnt: result.gasBurnt.toString(),
      tokens_burnt_yocto: result.tokensBurnt.toString(),
    });

    const marker = result.ok ? 'ok' : expectFailure ? 'rejected as expected' : 'FAILED';
    console.log(`   ${marker.padEnd(20)} ${label.method} ${signerId} -> ${receiverId}`);
    console.log(`   ${''.padEnd(20)} tx ${hash}${result.explorerUrl ? `  ${result.explorerUrl}` : ''}`);
    if (!result.ok) console.log(`   ${''.padEnd(20)} error ${result.error}`);
    else if (result.receiptFailures.length) console.log(`   ${''.padEnd(20)} receipt failures: ${result.receiptFailures.join('; ')}`);

    if (!result.ok && !expectFailure) throw new TxFailedError(result);
    if (result.ok && expectFailure) {
      throw new CliError(`${label.method} succeeded but was expected to fail. tx ${hash}`);
    }
    return result;
  }

  async waitFor(hash, signerId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      let result;
      try {
        result = await this.rpc('tx', { tx_hash: hash, sender_account_id: signerId, wait_until: 'EXECUTED_OPTIMISTIC' });
      } catch {
        // Not seen yet, or the node's own wait timed out. A later poll resolves either.
        continue;
      }
      const status = result?.status;
      if (status && typeof status === 'object' && ('SuccessValue' in status || 'Failure' in status)) {
        return result;
      }
    }
    throw new CliError(`transaction ${hash} was sent but did not finish within ${timeoutMs / 1000}s. Check ${this.txUrl(hash) ?? hash}`);
  }

  /** One function call. Deposit and gas are bigint yocto and gas units. */
  call(signerId, receiverId, method, args, { gas, deposit = 0n, step, purpose, expectFailure = false } = {}) {
    return this.send({
      signerId,
      receiverId,
      actions: [actions.functionCall(method, args, gas, deposit)],
      label: { step, purpose, method, deposit, gas },
      expectFailure,
    });
  }
}

function summarizeOutcome(hash, outcome) {
  const status = outcome.status;
  const receiptFailures = [];
  const logs = [];
  let gasBurnt = BigInt(outcome.transaction_outcome?.outcome?.gas_burnt ?? 0);
  let tokensBurnt = BigInt(outcome.transaction_outcome?.outcome?.tokens_burnt ?? 0);
  for (const receipt of outcome.receipts_outcome ?? []) {
    gasBurnt += BigInt(receipt.outcome.gas_burnt ?? 0);
    tokensBurnt += BigInt(receipt.outcome.tokens_burnt ?? 0);
    logs.push(...(receipt.outcome.logs ?? []));
    const failure = receipt.outcome.status?.Failure;
    if (failure) receiptFailures.push(`${receipt.outcome.executor_id}: ${failureReason(failure)}`);
  }
  if ('Failure' in status) {
    return { hash, ok: false, value: null, error: failureReason(status.Failure), receiptFailures, logs, gasBurnt, tokensBurnt };
  }
  const raw = status.SuccessValue ? Buffer.from(status.SuccessValue, 'base64').toString() : '';
  let value = null;
  if (raw) {
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
  }
  return { hash, ok: true, value, error: null, receiptFailures, logs, gasBurnt, tokensBurnt };
}

/** NEP-297 events from logs, filtered by event name. */
export function eventsOf(result, eventName) {
  return result.logs
    .filter((line) => line.startsWith('EVENT_JSON:'))
    .map((line) => {
      try {
        return JSON.parse(line.slice('EVENT_JSON:'.length));
      } catch {
        return null;
      }
    })
    .filter((event) => event && (!eventName || event.event === eventName));
}

/** The code_hash view_account reports: base58 of sha256 of the wasm. */
export function codeHashOf(wasm) {
  return near.baseEncode(new Uint8Array(createHash('sha256').update(wasm).digest()));
}
