// NEAR Intents for the scripts: the solver relay (quote, publish_intent, get_status) and reads of
// intents.near (keys, balances, salt). The request and answer formats, the nonce layout and the
// NEP-413 checks live in web/src/lib/rebalance.ts and are imported from there, so the app and the
// scripts cannot drift apart.
//
// Read-only except `publishIntent`, which hands a signed intent to the relay. It refuses to run
// unless the caller passes `network: 'mainnet'`, because the relay settles only on intents.near.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError, sleep } from './cli.mjs';
import { WEB_DIR } from './deps.mjs';

const RELAY_URL = () => process.env.NEAR_INTENTS_SOLVER_RPC_URL || 'https://solver-relay-v2.chaindefuser.com/rpc';

let rebalanceModule = null;

/** web/src/lib/rebalance.ts, loaded with Node's type stripping. */
export async function rebalanceLib() {
  if (rebalanceModule) return rebalanceModule;
  // web/package.json has no "type" field, so Node warns before parsing the file as ESM. Harmless.
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
    if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
    return emitWarning.call(process, warning, ...rest);
  };
  try {
    rebalanceModule = await import(pathToFileURL(join(WEB_DIR, 'src', 'lib', 'rebalance.ts')).href);
  } finally {
    process.emitWarning = emitWarning;
  }
  return rebalanceModule;
}

export class RelayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelayError';
  }
}

async function relay(method, params) {
  const headers = { 'content-type': 'application/json' };
  if (process.env.NEAR_INTENTS_RELAY_API_KEY) headers['x-api-key'] = process.env.NEAR_INTENTS_RELAY_API_KEY;
  let res;
  try {
    res = await fetch(RELAY_URL(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [params] }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new RelayError(`${method}: ${error.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new RelayError(`${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RelayError(`${method}: answer is not JSON: ${text.slice(0, 200)}`);
  }
  if (body.error) throw new RelayError(`${method}: ${body.error.message ?? 'error'} ${JSON.stringify(body.error.data ?? '').slice(0, 300)}`);
  return body.result;
}

/**
 * Best live offer for `exactAmountIn`, trying each `minDeadlineMs` in turn and retrying a null
 * answer, which the relay gives whenever no solver answers within its 3 s window.
 * Returns { quote, request, attempts }, with quote null when nobody quoted.
 */
export async function bestRelayQuote({ assetIn, assetOut, exactAmountIn, minDeadlines, tries = 3 }) {
  const lib = await rebalanceLib();
  minDeadlines ??= lib.SOLVER_MIN_DEADLINES_MS;
  const attempts = [];
  for (const minDeadlineMs of minDeadlines) {
    for (let i = 0; i < tries; i += 1) {
      const request = { assetIn, assetOut, exactAmountIn: String(exactAmountIn), minDeadlineMs };
      const result = await relay('quote', lib.solverQuoteParams(request));
      const quotes = lib.parseSolverQuotes(result, request, Date.now());
      attempts.push({ min_deadline_ms: minDeadlineMs, offers: quotes.length });
      const quote = lib.bestSolverQuote(quotes);
      if (quote) return { quote, request, attempts };
      await sleep(1_000);
    }
  }
  return { quote: null, request: null, attempts };
}

/** Sends a vault-signed intent to the relay. Mainnet only. */
export async function publishIntent({ network, signed, quoteHashes }) {
  if (network !== 'mainnet') throw new CliError('publish_intent settles on intents.near, which exists on mainnet only');
  const lib = await rebalanceLib();
  const params = lib.publishIntentParams(signed, quoteHashes);
  return { params, result: lib.parsePublishResult(await relay('publish_intent', params)) };
}

/** Polls get_status until SETTLED, NOT_FOUND_OR_NOT_VALID three times in a row, or the timeout. Prints each change. */
export async function waitForIntent(intentHash, { timeoutMs = 120_000, intervalMs = 2_000, onStatus = () => {} } = {}) {
  const lib = await rebalanceLib();
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let notFound = 0;
  while (Date.now() < deadline) {
    try {
      const status = lib.parseIntentStatus(await relay('get_status', { intent_hash: intentHash }));
      if (!last || last.status !== status.status) onStatus(status);
      last = status;
      // A read just after publish_intent can miss the intent; only a repeated answer is final.
      notFound = status.status === 'NOT_FOUND_OR_NOT_VALID' ? notFound + 1 : 0;
      if (status.status === 'SETTLED' || notFound >= 3) return status;
    } catch (error) {
      onStatus({ status: 'ERROR', status_details: error.message });
    }
    await sleep(intervalMs);
  }
  return last ?? { intent_hash: intentHash, status: 'PENDING', status_details: `no answer within ${timeoutMs / 1000}s`, tx_hash: null, filled_amounts: null };
}

/** V1 nonce for intents.near (current salt, deadline), or 32 random bytes for the sandbox stand-in, which has no salts. */
export async function intentNonce(near, intents, deadlineMs) {
  const lib = await rebalanceLib();
  const salt = await near.tryView(intents, 'current_salt');
  if (!salt.ok) return { nonce: randomBytes(32).toString('base64'), salt: null };
  return { nonce: lib.encodeIntentNonce(salt.value, deadlineMs, new Uint8Array(randomBytes(15))), salt: salt.value };
}

/** Whether intents.near lists the key for the account. `has_public_key` on intents.near, `public_keys_of` on the stand-in. */
export async function hasIntentsKey(near, intents, accountId, publicKey) {
  const direct = await near.tryView(intents, 'has_public_key', { account_id: accountId, public_key: publicKey });
  if (direct.ok) return direct.value === true;
  const keys = await near.view(intents, 'public_keys_of', { account_id: accountId });
  return Array.isArray(keys) && keys.includes(publicKey);
}

/** intents.near balances, one mt_balance_of per token (the stand-in has no batch method). */
export async function intentsBalances(near, intents, accountId, tokenIds) {
  const out = {};
  for (const id of tokenIds) out[id] = BigInt(await near.view(intents, 'mt_balance_of', { account_id: accountId, token_id: id }));
  return out;
}
