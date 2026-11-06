#!/usr/bin/env node
// Moves the app server's operator signing to a function-call access key that can call only the
// operator methods of one company vault, with no deposit and a capped gas allowance.
//
//   node scripts/operator-key.mjs --network sandbox
//   node scripts/operator-key.mjs --network mainnet --dry-run
//   node scripts/operator-key.mjs --network mainnet --confirm-mainnet
//
// What a real run does, in order:
//   1. reads the vault's policy and checks that its operator is operator.<registry>;
//   2. writes a fresh ed25519 key to <credentials dir>/operator.<registry>.fc.json (mode 0600)
//      before any transaction, so the key cannot be lost between the transaction and the file;
//   3. one AddKey transaction, signed by the operator's full access key, adding the new key with
//      receiver_id = the vault, method_names = the operator methods, allowance = --allowance;
//   4. view_access_key: the key on chain must carry exactly that permission;
//   5. sandbox, or --probe elsewhere: signs four transactions with the new key that the chain must
//      refuse (a NEAR transfer, a call to another contract, a deposit, an unlisted method);
//   6. writes NEAR_OPERATOR_PRIVATE_KEY in the app env file to the new key.
//
// --replace tops the key up: the same transaction also deletes the previous function-call key, whose
// file is renamed, not deleted. NEAR cannot raise an allowance in place.
//
// The full access key file <credentials dir>/operator.<registry>.json is never changed or deleted,
// and the full access key is never deleted on chain. docs/OPERATOR_KEY.md explains the limits,
// the allowance and the remaining full access key.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, formatNear, heading, item, log, parseCli, parseNear, requireNetwork, runMain } from './lib/cli.mjs';
import { REPO_ROOT, webImport } from './lib/deps.mjs';
import { readEnvFile, mergeEnvFile } from './lib/envfile.mjs';
import { actions, KeyPair, KeyPairSigner, RpcError } from './lib/near.mjs';
import { networkContext } from './lib/network.mjs';

const nearApi = await webImport('near-api-js');

/**
 * Every method the app and scripts send as the operator today (docs/OPERATOR_KEY.md section 1).
 * All are on the vault, and none takes a deposit.
 */
export const OPERATOR_METHODS = [
  'record_service_call',
  'setup_intents_key',
  'agent_deposit_to_intents',
  'agent_swap_intent',
  'agent_withdraw_intent',
];

const OPTIONS = {
  network: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'confirm-mainnet': { type: 'boolean', default: false },
  vault: { type: 'string' },
  allowance: { type: 'string', default: '0.25' },
  methods: { type: 'string' },
  replace: { type: 'boolean', default: false },
  probe: { type: 'boolean', default: false },
  'no-probe': { type: 'boolean', default: false },
  'force-env': { type: 'boolean', default: false },
  deployer: { type: 'string' },
  registry: { type: 'string' },
  rpc: { type: 'string' },
  'credentials-dir': { type: 'string' },
  'env-file': { type: 'string' },
  help: { type: 'boolean', default: false },
};

const USAGE = `usage: node scripts/operator-key.mjs --network mainnet|testnet|sandbox [--dry-run]
  --confirm-mainnet   required for a mainnet run that sends a transaction
  --vault ID          receiver of the key (default c-1.<registry>)
  --allowance NEAR    gas allowance of the key (default 0.25)
  --methods a,b,c     default ${OPERATOR_METHODS.join(',')}
  --replace           top up or change the key: a fresh key with the new allowance and methods is added
                      and the previous function-call key is deleted, in one transaction. The previous
                      key file is renamed to operator.<registry>.fc.retired-<time>.json, not deleted
  --probe             also sign the four transactions the chain must refuse (default on a sandbox only)
  --no-probe          skip them on a sandbox
  --force-env         replace NEAR_OPERATOR_PRIVATE_KEY even when it holds a key this script does not know
  --registry ID       default incorpr.near on mainnet
  --deployer ID       testnet only, as in deploy.mjs
  --credentials-dir   default ~/.near-credentials/<network> (sandbox: <sandbox home>/credentials)
  --env-file PATH     default web/.env.local (sandbox: <sandbox home>/web.env.local)`;

const METHOD_NAME = /^[a-z_][a-z0-9_]{0,63}$/;
// nearcore's limits for a function-call permission (runtime config, protocol 87 and 88).
const MAX_METHOD_NAMES_BYTES = 2000;

function vaultAbiFunctions() {
  const abi = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'res', 'company_vault_abi.json'), 'utf8'));
  return new Map(abi.body.functions.map((f) => [f.name, f]));
}

/** Checks each method against the compiled vault ABI: it must exist, be a call, and not be payable. */
function checkMethods(methods) {
  if (methods.length === 0) throw new CliError('--methods must name at least one method. An empty list allows every method.', 2);
  if (new Set(methods).size !== methods.length) throw new CliError('--methods lists a method twice', 2);
  const abi = vaultAbiFunctions();
  for (const name of methods) {
    if (!METHOD_NAME.test(name)) throw new CliError(`not a method name: ${name}`, 2);
    const fn = abi.get(name);
    if (!fn) throw new CliError(`company-vault has no method ${name} (contracts/res/company_vault_abi.json)`, 2);
    if (fn.kind !== 'call') throw new CliError(`${name} is a view; a key is not needed for it`, 2);
    if ((fn.modifiers ?? []).includes('payable')) {
      throw new CliError(`${name} is payable, and a function-call key cannot attach a deposit`, 2);
    }
  }
  const bytes = methods.reduce((n, m) => n + Buffer.byteLength(m), 0);
  if (bytes > MAX_METHOD_NAMES_BYTES) throw new CliError(`method names total ${bytes} bytes, over ${MAX_METHOD_NAMES_BYTES}`, 2);
}

/**
 * view_access_key, or null when the key is not on the account. RPC nodes answer a missing key with
 * a result that carries an `error` string, not a JSON-RPC error, and Near.accessKey passes that
 * result through.
 */
async function viewKey(near, accountId, publicKey) {
  const view = await near.accessKey(accountId, publicKey);
  if (!view || typeof view.error === 'string') return null;
  return view;
}

/** The permission view_access_key reports for a key, or null for a full access key. */
function functionCallPermission(view) {
  if (!view || view.permission === 'FullAccess') return null;
  return view.permission?.FunctionCall ?? null;
}

/** Same receiver and method list, with an allowance field. The allowance itself falls as gas is burnt. */
function sameScope(fc, { vault, methods }) {
  if (!fc || fc.allowance === null || fc.allowance === undefined) return false;
  const listed = [...(fc.method_names ?? [])].sort().join(',');
  return fc.receiver_id === vault && listed === [...methods].sort().join(',');
}

/**
 * A transaction signed by a function-call key is refused with NotEnoughAllowance unless the key's
 * remaining allowance covers its prepaid gas at the pessimistic price, which on nearcore 2.14 is
 * 10x the gas price (measured on a sandbox: 250 TGas cost 0.25092 NEAR up front). Only the gas
 * actually burnt is then deducted. The largest prepaid gas the app sends as the operator is
 * 120 TGas (agent_deposit_to_intents, REBALANCE_GAS_TGAS.deposit in web/src/lib/rebalance.ts).
 */
const PESSIMISTIC_FACTOR = 10n;
const APP_MAX_PREPAID_TGAS = 120n;
/** The rest of the upfront cost: 300 TGas cost 0.300919 NEAR and 250 TGas 0.250919, so about 1 TGas more. */
const OVERHEAD_TGAS = 1n;
const TGAS = 10n ** 12n;
const upfrontCost = (prepaidTgas, gasPrice) => (prepaidTgas + OVERHEAD_TGAS) * TGAS * gasPrice * PESSIMISTIC_FACTOR;
const largestCallTgas = (allowanceLeft, gasPrice) => {
  const tgas = allowanceLeft / (gasPrice * PESSIMISTIC_FACTOR) / TGAS - OVERHEAD_TGAS;
  return tgas > 0n ? tgas : 0n;
};

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readFcKeyFile(path, accountId) {
  const file = JSON.parse(readFileSync(path, 'utf8'));
  if (file.account_id !== accountId) throw new CliError(`${path} is for ${file.account_id}, not ${accountId}`);
  const keyPair = KeyPair.fromString(file.private_key);
  if (keyPair.getPublicKey().toString() !== file.public_key) throw new CliError(`${path}: private_key does not match public_key`);
  return { file, keyPair };
}

function writeFcKeyFile(path, accountId, keyPair, permission) {
  if (existsSync(path)) throw new CliError(`refusing to overwrite existing key file ${path}`);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const body = {
    account_id: accountId,
    public_key: keyPair.getPublicKey().toString(),
    private_key: keyPair.toString(),
    permission: {
      receiver_id: permission.vault,
      method_names: permission.methods,
      allowance_yocto: permission.allowance.toString(),
    },
    created_at: new Date().toISOString(),
    note: 'Function-call access key written by scripts/operator-key.mjs. See docs/OPERATOR_KEY.md.',
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Signs one transaction with `keyPair` and submits it, expecting the node to refuse it before
 * inclusion. Returns the refusal text. A refused transaction is never in a chunk, so it costs
 * nothing and has no on-chain hash.
 */
async function expectRefusal(near, signerId, keyPair, receiverId, txActions, expected) {
  const publicKey = keyPair.getPublicKey();
  const key = await viewKey(near, signerId, publicKey.toString());
  if (!key) throw new CliError(`${publicKey} is not a key of ${signerId}`);
  const block = await near.rpc('block', { finality: 'final' });
  const tx = nearApi.createTransaction(signerId, publicKey, receiverId, BigInt(key.nonce) + 1n, txActions, nearApi.baseDecode(block.header.hash));
  const { txHash, signedTransaction } = await new KeyPairSigner(keyPair).signTransaction(tx);
  const hash = nearApi.baseEncode(txHash);
  try {
    await near.rpc('send_tx', { signed_tx_base64: Buffer.from(signedTransaction.encode()).toString('base64'), wait_until: 'INCLUDED' });
  } catch (error) {
    const text = error instanceof RpcError ? JSON.stringify(error.rpcError) : String(error?.message ?? error);
    if (!text.includes(expected)) throw new CliError(`expected ${expected}, the node answered: ${text.slice(0, 400)}`);
    return { hash, refusal: expected, detail: text.slice(0, 300) };
  }
  throw new CliError(`the chain accepted transaction ${hash}, which should have been refused with ${expected}`);
}

async function main() {
  const args = parseCli(OPTIONS);
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const network = requireNetwork(args.network);
  const dryRun = args['dry-run'];
  // Checked before anything reads a key file or the network.
  if (network === 'mainnet' && !dryRun && !args['confirm-mainnet']) {
    throw new CliError('a mainnet run sends a real transaction. Run with --dry-run first, then add --confirm-mainnet.', 2);
  }
  const allowance = parseNear(args.allowance);
  if (allowance === 0n) throw new CliError('--allowance must be above 0. A key with no allowance field has no gas cap, and this script does not create one.', 2);
  const methods = args.methods ? args.methods.split(',').map((m) => m.trim()).filter(Boolean) : [...OPERATOR_METHODS];
  checkMethods(methods);
  const probe = network === 'sandbox' ? !args['no-probe'] : args.probe;

  const ctx = await networkContext({
    network,
    deployer: args.deployer,
    registry: args.registry,
    rpc: args.rpc,
    credentialsDir: args['credentials-dir'],
    startSandbox: false,
  });
  const { near } = ctx;
  const operator = ctx.operator;
  const vault = args.vault ?? `c-1.${ctx.registry}`;
  // Vaults are direct sub-accounts c-<id>.<registry>; anything deeper or elsewhere is not a vault.
  const vaultMatch = /^c-\d{1,20}\.(.+)$/.exec(vault);
  if (!vaultMatch || vaultMatch[1] !== ctx.registry) {
    throw new CliError(`--vault must be a company vault of ${ctx.registry} (c-<id>.${ctx.registry}), got ${vault}`, 2);
  }
  const envFile = args['env-file'] ?? ctx.envFile;
  const fullKeyPath = near.credentialPath(operator);
  const fcKeyPath = join(near.credentialsDir, `${operator}.fc.json`);
  const permission = { vault, methods, allowance };

  heading(`Incorpr operator key: ${network}${dryRun ? ' (dry run: no transactions)' : ''}`);
  item('RPC', near.rpcUrl);
  item('operator account', operator);
  item('receiver (vault)', vault);
  item('methods', methods.join(', '));
  item('allowance', `${formatNear(allowance)} of gas, deposit always 0`);
  item('full access key file', `${fullKeyPath} (kept as is)`);
  item('new key file', fcKeyPath);
  item('env file', envFile);

  // ---------------------------------------------------------------- chain state (public)
  const account = await near.viewAccount(operator);
  if (!account) throw new CliError(`${operator} does not exist on ${network}. Run scripts/deploy.mjs first.`);
  let state;
  try {
    state = await near.view(vault, 'get_state', {});
  } catch (error) {
    throw new CliError(`${vault} has no readable company-vault state: ${error.message}`);
  }
  if (state.policy?.operator !== operator) {
    throw new CliError(`${vault}'s operator is ${state.policy?.operator}, not ${operator}. A key on ${operator} could not act for it.`);
  }
  const keys = await near.accessKeyList(operator);
  const gasPrice = await near.gasPrice();
  item('operator balance', formatNear(BigInt(account.amount)));
  item('gas price', `${gasPrice} yocto/gas`);
  item('keys on chain', String(keys.length));
  for (const k of keys) {
    const fc = functionCallPermission(k.access_key);
    item('', fc
      ? `${k.public_key}  function call: ${fc.receiver_id} [${(fc.method_names ?? []).join(', ') || 'any method'}], allowance ${fc.allowance === null ? 'none' : `${formatNear(BigInt(fc.allowance))} (largest call it can send: ${largestCallTgas(BigInt(fc.allowance), gasPrice)} TGas)`}`
      : `${k.public_key}  full access`);
  }
  const matching = keys.filter((k) => sameScope(functionCallPermission(k.access_key), permission));
  const needed = upfrontCost(APP_MAX_PREPAID_TGAS, gasPrice);
  if (allowance < needed) {
    throw new CliError(
      `--allowance ${formatNear(allowance)} cannot send the app's ${APP_MAX_PREPAID_TGAS} TGas agent_deposit_to_intents at this gas price: it needs ${formatNear(needed)} up front`,
      2,
    );
  }
  item('usable allowance', `${formatNear(allowance - needed)} before calls of ${APP_MAX_PREPAID_TGAS} TGas are refused (${formatNear(needed)} must stay unspent)`);

  heading('Plan');
  // The new key file is only looked at in a real run; a dry run opens no key file.
  const haveFcFile = !dryRun && existsSync(fcKeyPath);
  if (matching.length) log(`   [note] ${matching.length} key(s) on chain already have this receiver and method list`);
  if (args.replace) {
    log(`   [todo] write a fresh key to ${operator}.fc.pending.json (or reuse one an unfinished run already added)`);
    log(`   [todo] ${operator} sends one transaction: AddKey(new key) and DeleteKey(previous function-call key)`);
    log(`   [todo] once the chain shows both: rename ${fcKeyPath} to ${operator}.fc.retired-<time>.json and the pending file to ${fcKeyPath}`);
  } else {
    log(`   [todo] write a fresh ed25519 key to ${fcKeyPath}, unless that file exists (then its key is reused)`);
  }
  log(`   [todo] ${operator} adds it unless it is on chain: AddKey, FunctionCall { receiver_id: ${vault}, method_names: [${methods.join(', ')}], allowance: ${allowance} }`);
  log('   [todo] view_access_key: the key must report that receiver and method list, and the allowance when just added');
  if (probe) log('   [todo] sign a transfer, a call to another contract, a 1 yocto deposit and an unlisted method with it: each must be refused');
  log(`   [todo] set NEAR_OPERATOR_PRIVATE_KEY in ${envFile} to the new key`);

  if (dryRun) {
    log('\nDry run: no transactions sent, no key file opened or written, no env file changed.');
    return 0;
  }

  // ---------------------------------------------------------------- key file
  // With --replace, nothing is renamed until the chain shows the new key added and the previous one
  // deleted. The new key waits in <operator>.fc.pending.json, so a run that stops halfway (an RPC
  // timeout, a failed check) leaves <operator>.fc.json naming the key still on chain, and a rerun
  // deletes it in the same way.
  const pendingPath = join(near.credentialsDir, `${operator}.fc.pending.json`);
  let keyPair;
  /** The previous function-call key, deleted in the same transaction that adds the new one. */
  let retiredPublicKey = null;
  /** The key in <operator>.fc.json before this run, on chain or not. The env file may still hold it. */
  let previousPublicKey = null;
  if (haveFcFile && args.replace) {
    const previous = readFcKeyFile(fcKeyPath, operator).keyPair.getPublicKey().toString();
    previousPublicKey = previous;
    const previousOnChain = await viewKey(near, operator, previous);
    if (previousOnChain && !functionCallPermission(previousOnChain)) {
      throw new CliError(`${fcKeyPath} holds ${previous}, which is a full access key on chain. Refusing to delete it.`);
    }
    retiredPublicKey = previousOnChain ? previous : null;
  }
  if (args.replace) {
    if (existsSync(pendingPath)) {
      const pending = readFcKeyFile(pendingPath, operator).keyPair;
      if (await viewKey(near, operator, pending.getPublicKey().toString())) {
        keyPair = pending;
        log(`   [reuse] ${pendingPath} (${pending.getPublicKey()}), added by an earlier run that did not finish`);
      } else {
        // Never added: keep the file aside rather than delete a private key, and start clean.
        const abandoned = join(near.credentialsDir, `${operator}.fc.abandoned-${stamp()}.json`);
        renameSync(pendingPath, abandoned);
        log(`   [moved] unused pending key file from an earlier run to ${abandoned}`);
      }
    }
    if (!keyPair) {
      keyPair = KeyPair.fromRandom('ed25519');
      writeFcKeyFile(pendingPath, operator, keyPair, permission);
      log(`   [wrote] ${pendingPath} (mode 0600); it becomes ${fcKeyPath} once the chain shows the swap`);
    }
  } else if (haveFcFile) {
    keyPair = readFcKeyFile(fcKeyPath, operator).keyPair;
    log(`   [reuse] ${fcKeyPath} (${keyPair.getPublicKey()})`);
  } else {
    keyPair = KeyPair.fromRandom('ed25519');
    writeFcKeyFile(fcKeyPath, operator, keyPair, permission);
    log(`   [wrote] ${fcKeyPath} (mode 0600)`);
  }
  const publicKey = keyPair.getPublicKey().toString();
  const onChain = await viewKey(near, operator, publicKey);
  if (onChain && !sameScope(functionCallPermission(onChain), permission)) {
    throw new CliError(
      `${publicKey} is already on ${operator} with another permission: ${JSON.stringify(onChain.permission)}. Pass --replace to swap it for a new key.`,
    );
  }

  // The env file must hold the full access key, the new key, or nothing. Anything else is a key
  // this script would make unreachable by overwriting it.
  const env = readEnvFile(envFile);
  if (env.NEAR_OPERATOR_ACCOUNT_ID && env.NEAR_OPERATOR_ACCOUNT_ID !== operator) {
    throw new CliError(`${envFile} sets NEAR_OPERATOR_ACCOUNT_ID=${env.NEAR_OPERATOR_ACCOUNT_ID}, not ${operator}`);
  }
  if (!(await near.controls(operator))) {
    throw new CliError(`${fullKeyPath} holds no full access key of ${operator}; that key must sign the AddKey`);
  }
  const fullPublicKey = near.publicKeyOf(operator);
  if (env.NEAR_OPERATOR_PRIVATE_KEY && !args['force-env']) {
    let envPublic;
    try {
      envPublic = KeyPair.fromString(env.NEAR_OPERATOR_PRIVATE_KEY).getPublicKey().toString();
    } catch {
      throw new CliError(`${envFile}: NEAR_OPERATOR_PRIVATE_KEY is not a key. Fix it or pass --force-env.`);
    }
    if (envPublic !== fullPublicKey && envPublic !== publicKey && envPublic !== previousPublicKey) {
      throw new CliError(
        `${envFile} holds operator key ${envPublic}, which is neither ${fullKeyPath} (${fullPublicKey}) nor the new key. Save it, then pass --force-env.`,
      );
    }
  }

  // ---------------------------------------------------------------- AddKey
  heading('Run');
  if (onChain) log(`   [done] ${publicKey} is on ${operator} with this receiver and method list`);
  const txActions = [];
  if (!onChain) txActions.push(actions.addFunctionCallAccessKey(nearApi.PublicKey.from(publicKey), vault, methods, allowance));
  if (retiredPublicKey) txActions.push(actions.deleteKey(nearApi.PublicKey.from(retiredPublicKey)));
  if (txActions.length) {
    await near.send({
      signerId: operator,
      receiverId: operator,
      actions: txActions,
      label: {
        step: 'operator-key',
        purpose: [
          onChain ? null : `add a function-call key to ${operator}: receiver ${vault}, methods ${methods.join(', ')}, allowance ${formatNear(allowance)}`,
          retiredPublicKey ? `delete the previous function-call key ${retiredPublicKey}` : null,
        ]
          .filter(Boolean)
          .join('; '),
        method: [onChain ? null : 'AddKey(FunctionCall)', retiredPublicKey ? 'DeleteKey' : null].filter(Boolean).join('+'),
        deposit: 0n,
      },
    });
  }

  // ---------------------------------------------------------------- verify
  const verified = await viewKey(near, operator, publicKey);
  const fc = functionCallPermission(verified);
  if (!sameScope(fc, permission)) {
    throw new CliError(`view_access_key for ${publicKey} reports ${JSON.stringify(verified?.permission ?? null)}, not the requested permission`);
  }
  if (!onChain && BigInt(fc.allowance) !== allowance) {
    throw new CliError(`view_access_key reports allowance ${fc.allowance}, not ${allowance}`);
  }
  if (retiredPublicKey && (await viewKey(near, operator, retiredPublicKey))) {
    throw new CliError(`the previous key ${retiredPublicKey} is still on ${operator}`);
  }
  if (args.replace) {
    // The chain now has the new key and not the previous one: move the files to match.
    if (existsSync(fcKeyPath)) {
      const retiredPath = join(near.credentialsDir, `${operator}.fc.retired-${stamp()}.json`);
      renameSync(fcKeyPath, retiredPath);
      log(`   [moved] previous key file to ${retiredPath}`);
    }
    renameSync(pendingPath, fcKeyPath);
    log(`   [moved] ${pendingPath} to ${fcKeyPath}`);
  }
  const left = BigInt(fc.allowance);
  heading('view_access_key');
  item('public key', publicKey);
  item('receiver_id', fc.receiver_id);
  item('method_names', fc.method_names.join(', '));
  item('allowance', `${fc.allowance} yocto (${formatNear(left)}), largest call it can send now: ${largestCallTgas(left, gasPrice)} TGas`);
  item('nonce', String(verified.nonce));
  if (retiredPublicKey) item('deleted', `${retiredPublicKey} (previous function-call key)`);
  if (left < needed) log(`   warning: under ${formatNear(needed)} left, so agent_deposit_to_intents (${APP_MAX_PREPAID_TGAS} TGas) is refused. Run again with --replace.`);

  // ---------------------------------------------------------------- refusals
  if (probe) {
    heading('Transactions the chain must refuse (signed with the new key)');
    const probes = [
      { what: 'NEAR transfer of 1 yocto', receiver: ctx.registry, actions: [actions.transfer(1n)], expected: 'RequiresFullAccess' },
      {
        what: `call to another contract (${ctx.registry}.nft_token)`,
        receiver: ctx.registry,
        actions: [actions.functionCall('nft_token', { token_id: '1' }, 10n ** 13n, 0n)],
        expected: 'ReceiverMismatch',
      },
      {
        what: `record_service_call with 1 yocto attached`,
        receiver: vault,
        actions: [actions.functionCall('record_service_call', { call_id: 'probe', tee_chat_id: 'probe' }, 10n ** 13n, 1n)],
        expected: 'DepositWithFunctionCall',
      },
      {
        what: 'unlisted vault method refresh_metrics',
        receiver: vault,
        actions: [actions.functionCall('refresh_metrics', {}, 10n ** 13n, 0n)],
        expected: 'MethodNameMismatch',
      },
    ];
    for (const p of probes) {
      const out = await expectRefusal(near, operator, keyPair, p.receiver, p.actions, p.expected);
      item(p.expected, `${p.what}: refused before inclusion (unsent hash ${out.hash})`);
    }
  }

  // ---------------------------------------------------------------- env
  const changed = mergeEnvFile(envFile, { NEAR_OPERATOR_ACCOUNT_ID: operator, NEAR_OPERATOR_PRIVATE_KEY: keyPair.toString() });
  heading('Done');
  item('operator key in env', `${publicKey} (function call)`);
  item('env file', `${envFile} (mode 0600), ${changed.length ? `changed: ${changed.join(', ')}` : 'already set'}`);
  item('full access key', `${fullPublicKey} stays on ${operator} and in ${fullKeyPath}`);
  if (network !== 'sandbox') log('   Restart the web server so it reads the new key.');
  log('   scripts/demo.mjs and scripts/rebalance.mjs still sign with the full access key file.');
  return 0;
}

runMain(main);
