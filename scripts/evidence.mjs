#!/usr/bin/env node
// Re-checks an evidence file against the chain.
//
//   node scripts/evidence.mjs --network mainnet|testnet|sandbox [--file path] [--rpc url] [--out path]
//
// Reads docs/evidence/<network>.json (sandbox: <sandbox home>/evidence/sandbox.json, where
// scripts/deploy.mjs and scripts/demo.mjs keep it). The input is never modified. For every recorded
// NEAR transaction it asks RPC for the transaction, then compares what the chain says with what the
// file says: found, success or failure, the ERR_ code of a failure, signer, receiver, actions,
// attached deposit and gas burnt. It also reads the block each transaction was included in, checks
// the registry's code hash and the vault accounts, and checks broadcast Bitcoin txids on
// mempool.space. Results go to <same dir>/<network>.verified.json with `checkedAt`.
//
// Exit codes: 0 every check matched, 1 at least one mismatch or missing transaction, 2 usage error.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { CliError, parseCli, requireNetwork, runMain, sleep } from './lib/cli.mjs';
import { REPO_ROOT } from './lib/deps.mjs';
import { readSandboxState, sandboxHome } from './lib/sandbox.mjs';

const DEFAULT_RPC = {
  // The regular endpoints keep recent transactions; the archival ones answer for older ones.
  mainnet: ['https://rpc.mainnet.fastnear.com', 'https://archival-rpc.mainnet.fastnear.com'],
  testnet: ['https://test.rpc.fastnear.com', 'https://archival-rpc.testnet.fastnear.com'],
};
// BTC_ESPLORA_API overrides the Esplora endpoint (same API as mempool.space), for networks that block one of them.
const ESPLORA = { mainnet: process.env.BTC_ESPLORA_API || 'https://mempool.space/api', testnet: 'https://mempool.space/testnet4/api', sandbox: 'https://mempool.space/testnet4/api' };
const RPC_TIMEOUT_MS = 20_000;

// ------------------------------------------------------------------------------------------- RPC

class RpcClient {
  constructor(urls) {
    this.urls = urls;
    this.id = 0;
  }

  /** Tries each URL in order. A chain answer (an RPC error object) from one URL is final unless `next` allows the next URL. */
  async call(method, params, { nextOn = () => false } = {}) {
    let last;
    for (const url of this.urls) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await sleep(400 * 2 ** attempt);
        let body;
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
            signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
          });
          if (res.status === 429 || res.status >= 500) {
            last = { transport: `${url}: HTTP ${res.status}` };
            continue;
          }
          body = await res.json();
        } catch (error) {
          last = { transport: `${url}: ${error.message}` };
          continue;
        }
        if (body.error) {
          last = { error: body.error, url };
          break;
        }
        return { result: body.result, url };
      }
      if (last?.error && !nextOn(last.error)) return last;
    }
    return last ?? { transport: 'no RPC URL' };
  }
}

const errorName = (error) => error?.cause?.name ?? error?.name ?? 'RPC_ERROR';
const isUnknownTx = (error) => /UNKNOWN_TRANSACTION|TIMEOUT_ERROR|doesn't exist|does not exist/i.test(`${errorName(error)} ${JSON.stringify(error?.data ?? '')}`);

// ------------------------------------------------------------------------------- Outcome reading

/** Same rule as scripts/lib/near.mjs failureReason: first ERR_ code, else the panic text, else raw JSON. */
function failureReason(failure) {
  const text = JSON.stringify(failure);
  const code = /ERR_[A-Z0-9_]+/.exec(text);
  if (code) return code[0];
  const panic = /"(?:panic_msg|PanicMsg|ExecutionError)"\s*:\s*"([^"]{1,300})"/.exec(text);
  if (panic) return panic[1];
  return text.slice(0, 400);
}

/** "CreateAccount+Transfer+DeployContract+new": action kinds, with a function call named by its method. */
function actionLabel(actions) {
  return actions
    .map((action) => {
      if (typeof action === 'string') return action;
      const [kind, body] = Object.entries(action)[0] ?? ['?', {}];
      return kind === 'FunctionCall' ? body.method_name : kind;
    })
    .join('+');
}

function attachedDeposit(actions) {
  let total = 0n;
  for (const action of actions) {
    if (typeof action !== 'object' || action === null) continue;
    const [kind, body] = Object.entries(action)[0] ?? [];
    if ((kind === 'Transfer' || kind === 'FunctionCall') && body?.deposit !== undefined) total += BigInt(body.deposit);
  }
  return total;
}

function readOutcome(outcome) {
  const tx = outcome.transaction;
  let gasBurnt = BigInt(outcome.transaction_outcome?.outcome?.gas_burnt ?? 0);
  const receiptFailures = [];
  for (const receipt of outcome.receipts_outcome ?? []) {
    gasBurnt += BigInt(receipt.outcome.gas_burnt ?? 0);
    const failure = receipt.outcome.status?.Failure;
    if (failure) receiptFailures.push(`${receipt.outcome.executor_id}: ${failureReason(failure)}`);
  }
  const status = outcome.status;
  const failed = status && typeof status === 'object' && 'Failure' in status;
  const finished = failed || (status && typeof status === 'object' && 'SuccessValue' in status);
  return {
    status: !finished ? 'pending' : failed ? 'failure' : 'success',
    error: failed ? failureReason(status.Failure) : null,
    signer: tx.signer_id,
    receiver: tx.receiver_id,
    actions: actionLabel(tx.actions ?? []),
    deposit_yocto: attachedDeposit(tx.actions ?? []).toString(),
    gas_burnt: gasBurnt.toString(),
    receipt_failures: receiptFailures,
    block_hash: outcome.transaction_outcome?.block_hash ?? null,
    final_execution_status: outcome.final_execution_status ?? null,
  };
}

/** scripts/lib/near.mjs labels a transaction the same way, so the labels must be equal. */
function methodMatches(recorded, chainLabel) {
  // Labels may add detail in parentheses, e.g. AddKey(FunctionCall) for an AddKey action.
  return !recorded || recorded === chainLabel || recorded.replace(/\(.*\)$/, '') === chainLabel;
}

// ----------------------------------------------------------------------------------- base58, hex

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58ToHex(text) {
  let value = 0n;
  for (const char of text) {
    const digit = B58.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  let hex = value === 0n ? '' : value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const leading = /^1*/.exec(text)[0].length;
  return '00'.repeat(leading) + hex;
}
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

// ----------------------------------------------------------------------------------- Checks

async function checkTransaction(rpc, entry, blocks, earliestHeight) {
  const recorded = {
    status: entry.status,
    error: entry.error ?? null,
    signer: entry.signer,
    receiver: entry.receiver,
    method: entry.method,
    deposit_yocto: entry.deposit_yocto ?? null,
    gas_burnt: entry.gas_burnt ?? null,
    expected_failure: Boolean(entry.expected_failure),
  };
  const row = { seq: entry.seq, step: entry.step, purpose: entry.purpose, tx_hash: entry.tx_hash, recorded, chain: null, block: null, checks: {}, mismatches: [] };

  if (!TX_HASH.test(entry.tx_hash ?? '')) {
    row.mismatches.push(`not a NEAR transaction hash: ${entry.tx_hash}`);
    return row;
  }
  const answer = await rpc.call(
    'tx',
    { tx_hash: entry.tx_hash, sender_account_id: entry.signer, wait_until: 'FINAL' },
    { nextOn: isUnknownTx },
  );
  if (!answer.result) {
    row.checks.found = false;
    const gcHint = earliestHeight ? ` (this RPC keeps blocks from height ${earliestHeight}; an older transaction needs an archival RPC, --rpc)` : '';
    row.mismatches.push(answer.error ? `RPC ${errorName(answer.error)}: transaction not found${gcHint}` : `RPC unreachable: ${answer.transport}`);
    row.rpc_error = answer.error ?? answer.transport;
    return row;
  }
  row.checks.found = true;
  row.rpc_url = answer.url;
  const chain = readOutcome(answer.result);
  row.chain = chain;

  const compare = (name, ok, detail) => {
    row.checks[name] = ok;
    if (!ok) row.mismatches.push(detail);
  };
  compare('status', chain.status === recorded.status, `status: file says ${recorded.status}, chain says ${chain.status}`);
  if (recorded.status === 'failure' || chain.status === 'failure') {
    compare('error', chain.error === recorded.error, `error: file says ${recorded.error}, chain says ${chain.error}`);
  }
  compare('signer', chain.signer === recorded.signer, `signer: file says ${recorded.signer}, chain says ${chain.signer}`);
  compare('receiver', chain.receiver === recorded.receiver, `receiver: file says ${recorded.receiver}, chain says ${chain.receiver}`);
  compare('actions', methodMatches(recorded.method, chain.actions), `actions: file says ${recorded.method}, chain says ${chain.actions}`);
  if (recorded.deposit_yocto !== null) {
    compare('deposit', chain.deposit_yocto === String(recorded.deposit_yocto), `deposit: file says ${recorded.deposit_yocto}, chain says ${chain.deposit_yocto}`);
  }
  // The scripts record gas when the transaction first executes, before later receipts (callbacks, gas
  // refunds) run, so the final total is usually higher. Report it; a difference is not a mismatch.
  if (recorded.gas_burnt !== null) {
    row.gas_note = chain.gas_burnt === String(recorded.gas_burnt) ? null : `recorded ${recorded.gas_burnt} at first execution; final ${chain.gas_burnt}`;
  }
  if (recorded.expected_failure) {
    compare('refused_as_expected', chain.status === 'failure', 'marked as an expected refusal, but the chain shows it succeeded');
  }

  if (chain.block_hash) {
    if (!blocks.has(chain.block_hash)) {
      blocks.set(chain.block_hash, rpc.call('block', { block_id: chain.block_hash }, { nextOn: () => true }));
    }
    const block = await blocks.get(chain.block_hash);
    if (block.result) {
      const header = block.result.header;
      row.block = {
        hash: chain.block_hash,
        height: header.height,
        timestamp: new Date(Number(BigInt(header.timestamp_nanosec) / 1_000_000n)).toISOString(),
      };
    } else {
      row.block = { hash: chain.block_hash, height: null, timestamp: null, error: block.error ? errorName(block.error) : block.transport };
    }
  }
  return row;
}

async function viewAccount(rpc, accountId) {
  return rpc.call('query', { request_type: 'view_account', finality: 'final', account_id: accountId }, { nextOn: () => false });
}

async function checkAccounts(rpc, data) {
  const rows = [];
  const d = data.deployment ?? {};
  if (d.registry) {
    const answer = await viewAccount(rpc, d.registry);
    const row = { role: 'registry', account: d.registry, checks: {}, mismatches: [] };
    if (!answer.result) {
      row.checks.exists = false;
      row.mismatches.push(`registry ${d.registry} not found: ${answer.error ? errorName(answer.error) : answer.transport}`);
    } else {
      row.checks.exists = true;
      row.code_hash = answer.result.code_hash;
      if (d.registry_code_hash) {
        row.checks.code_hash = answer.result.code_hash === d.registry_code_hash;
        if (!row.checks.code_hash) row.mismatches.push(`registry code hash: file says ${d.registry_code_hash}, chain says ${answer.result.code_hash}`);
      }
    }
    rows.push(row);
  }
  for (const company of data.companies ?? []) {
    if (!company.vault) continue;
    const answer = await viewAccount(rpc, company.vault);
    const row = { role: `vault of token ${company.token_id}`, account: company.vault, checks: {}, mismatches: [] };
    if (!answer.result) {
      row.checks.exists = false;
      row.mismatches.push(`vault ${company.vault} not found: ${answer.error ? errorName(answer.error) : answer.transport}`);
    } else {
      row.checks.exists = true;
      row.code_hash = answer.result.code_hash;
      if (d.vault_wasm_sha256) {
        // view_account reports base58(sha256(code)); the file records the vault wasm's sha256 in hex.
        const hex = base58ToHex(answer.result.code_hash);
        row.checks.code_hash = hex === d.vault_wasm_sha256;
        if (!row.checks.code_hash) row.mismatches.push(`vault code sha256: file says ${d.vault_wasm_sha256}, chain says ${hex}`);
      }
    }
    rows.push(row);
  }
  return rows;
}

async function checkBitcoin(network, data, txRows) {
  const rows = [];
  const known = new Set(txRows.filter((r) => r.checks.found).map((r) => r.tx_hash));
  for (const entry of data.bitcoin ?? []) {
    const row = { txid: entry.txid, broadcast: Boolean(entry.broadcast), checks: {}, mismatches: [] };
    const missing = (entry.near_signature_txs ?? []).filter((hash) => !known.has(hash));
    row.checks.signature_txs_on_chain = missing.length === 0;
    if (missing.length) row.mismatches.push(`NEAR signature transactions not in the verified list: ${missing.join(', ')}`);
    if (entry.broadcast && network !== 'sandbox') {
      try {
        const res = await fetch(`${ESPLORA[network]}/tx/${entry.txid}/status`, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
        if (res.status === 404 || res.status === 400) {
          row.checks.found = false;
          row.mismatches.push(`Bitcoin tx ${entry.txid} not found on ${ESPLORA[network]}`);
        } else if (!res.ok) {
          row.checks.found = false;
          row.mismatches.push(`${ESPLORA[network]} answered HTTP ${res.status} for ${entry.txid}`);
        } else {
          const status = await res.json();
          row.checks.found = true;
          row.confirmed = Boolean(status.confirmed);
          row.block_height = status.block_height ?? null;
          row.block_time = status.block_time ? new Date(status.block_time * 1000).toISOString() : null;
        }
      } catch (error) {
        row.checks.found = false;
        row.mismatches.push(`${ESPLORA[network]} unreachable: ${error.message}`);
      }
    }
    rows.push(row);
  }
  return rows;
}

// ----------------------------------------------------------------------------------- Output

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const short = (hash) => (hash && hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-6)}` : (hash ?? ''));
const clip = (text, n) => {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function printTable(rows) {
  const head = ['#', 'step', 'method', 'file', 'chain', 'block', 'tx', 'check'];
  const lines = rows.map((r) => [
    String(r.seq ?? ''),
    clip(r.step, 12),
    clip(r.recorded.method, 30),
    clip(r.recorded.status === 'failure' ? r.recorded.error : r.recorded.status, 38),
    clip(!r.chain ? 'not found' : r.chain.status === 'failure' ? r.chain.error : r.chain.status, 38),
    r.block?.height != null ? String(r.block.height) : '',
    short(r.tx_hash),
    r.mismatches.length ? 'MISMATCH' : 'ok',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const l of lines) console.log(fmt(l));
}

// ----------------------------------------------------------------------------------- Main

function evidencePath(network) {
  if (network === 'sandbox') return join(sandboxHome(), 'evidence', 'sandbox.json');
  return join(REPO_ROOT, 'docs', 'evidence', `${network}.json`);
}

function rpcUrls(network, data, override) {
  if (override) return [override];
  if (network !== 'sandbox') return DEFAULT_RPC[network];
  const state = readSandboxState();
  const urls = [state?.rpc_url, data.deployment?.rpc_url].filter(Boolean);
  if (urls.length === 0) throw new CliError('no sandbox RPC URL: start the sandbox (node scripts/lib/sandbox.mjs start) or pass --rpc', 2);
  return [...new Set(urls)];
}

async function main() {
  const args = parseCli({
    network: { type: 'string' },
    file: { type: 'string' },
    rpc: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', default: false },
  });
  if (args.help) {
    console.log('usage: node scripts/evidence.mjs --network mainnet|testnet|sandbox [--file evidence.json] [--rpc url] [--out verified.json]');
    return 0;
  }
  const network = requireNetwork(args.network);
  const input = args.file ?? evidencePath(network);
  if (!existsSync(input)) throw new CliError(`no evidence file at ${input}. Run scripts/deploy.mjs --network ${network} first.`, 2);
  const raw = readFileSync(input);
  const data = JSON.parse(raw.toString('utf8'));
  if (data.network && data.network !== network) throw new CliError(`${input} records network ${data.network}, not ${network}`, 2);
  const output = args.out ?? join(dirname(input), `${network}.verified.json`);

  const rpc = new RpcClient(rpcUrls(network, data, args.rpc));
  const status = await rpc.call('status', [], { nextOn: () => true });
  if (!status.result) throw new CliError(`RPC unreachable: ${status.transport ?? errorName(status.error)} (${rpc.urls.join(', ')})`);

  console.log(`Checking ${relative(process.cwd(), input) || input}`);
  console.log(`RPC ${rpc.urls.join(', ')}  chain ${status.result.chain_id}  protocol ${status.result.protocol_version}  height ${status.result.sync_info.latest_block_height}\n`);

  const blocks = new Map();
  const transactions = [];
  // A few at a time: public RPCs rate-limit bursts.
  const queue = [...(data.transactions ?? [])];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      transactions.push(await checkTransaction(rpc, entry, blocks, status.result.sync_info.earliest_block_height));
    }
  });
  await Promise.all(workers);
  transactions.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  const accounts = await checkAccounts(rpc, data);
  const bitcoin = await checkBitcoin(network, data, transactions);

  printTable(transactions);
  for (const a of accounts) console.log(`${a.mismatches.length ? 'MISMATCH' : 'ok      '}  ${a.role.padEnd(18)} ${a.account}${a.code_hash ? `  code ${a.code_hash}` : ''}`);
  for (const b of bitcoin) console.log(`${b.mismatches.length ? 'MISMATCH' : 'ok      '}  bitcoin ${b.txid}${b.confirmed !== undefined ? (b.confirmed ? `  confirmed at ${b.block_height}` : '  unconfirmed') : ''}`);

  const mismatches = [
    ...transactions.flatMap((r) => r.mismatches.map((m) => `tx #${r.seq} ${r.tx_hash}: ${m}`)),
    ...accounts.flatMap((r) => r.mismatches.map((m) => `${r.role}: ${m}`)),
    ...bitcoin.flatMap((r) => r.mismatches.map((m) => `bitcoin ${r.txid}: ${m}`)),
  ];
  const summary = {
    transactions: transactions.length,
    matched: transactions.filter((r) => r.mismatches.length === 0).length,
    not_found: transactions.filter((r) => r.checks.found === false).length,
    mismatched: transactions.filter((r) => r.mismatches.length > 0).length,
    expected_refusals_confirmed: transactions.filter((r) => r.recorded.expected_failure && r.checks.refused_as_expected).length,
    accounts: accounts.length,
    bitcoin: bitcoin.length,
    ok: mismatches.length === 0,
  };

  const verified = {
    network,
    note: 'Generated by scripts/evidence.mjs. Each row is what RPC returned for a transaction listed in the source file, compared with what that file says.',
    checkedAt: new Date().toISOString(),
    source: relative(REPO_ROOT, input).startsWith('..') ? input : relative(REPO_ROOT, input),
    source_sha256: createHash('sha256').update(raw).digest('hex'),
    rpc_urls: rpc.urls,
    chain: {
      chain_id: status.result.chain_id,
      protocol_version: status.result.protocol_version,
      latest_block_height: status.result.sync_info.latest_block_height,
    },
    summary,
    mismatches,
    transactions,
    accounts,
    bitcoin,
    not_checked: [
      'tee_calls: NEAR AI Cloud chat signatures are not re-fetched here; the app verifies them per call.',
      'quotes: 1Click dry quotes are point-in-time prices and cannot be replayed.',
    ],
  };
  writeAtomic(output, `${JSON.stringify(verified, null, 2)}\n`);

  console.log(
    `\n${summary.matched}/${summary.transactions} transactions match the chain` +
      `, ${summary.expected_refusals_confirmed} expected refusals confirmed` +
      `, ${accounts.filter((a) => !a.mismatches.length).length}/${accounts.length} accounts match.`,
  );
  if (mismatches.length) {
    console.log('\nMismatches:');
    for (const m of mismatches) console.log(`  ${m}`);
  }
  console.log(`\nWrote ${relative(process.cwd(), output) || output}`);
  return mismatches.length ? 1 : 0;
}

runMain(main);
