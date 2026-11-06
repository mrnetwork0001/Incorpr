#!/usr/bin/env node
// Replaces the code of a live incorpr-registry in place: one DeployContract action signed by the
// registry's own key, no init or migration call. Use it only for changes that leave the borsh
// state layout and every storage key as they are (for example the charter renderer); the script
// proves that afterwards by comparing every stored key and value and every view.
//
//   node scripts/upgrade-registry.mjs --network mainnet --dry-run
//   node scripts/upgrade-registry.mjs --network mainnet --confirm-mainnet
//   node scripts/upgrade-registry.mjs --network sandbox
//
// The dry run reads chain state and local files only. It never reads the registry key file.
// The transaction is recorded under step "upgrade" in docs/evidence/<network>.json (sandbox: its
// home dir), and the deployment record's registry_code_hash moves to the new hash.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, relative, resolve } from 'node:path';
import { CliError, formatNear, heading, item, log, parseCli, runMain, sleep } from './lib/cli.mjs';
import { REPO_ROOT } from './lib/deps.mjs';
import { actions, codeHashOf } from './lib/near.mjs';
import { networkContext } from './lib/network.mjs';

const DEFAULT_WASM = join(REPO_ROOT, 'contracts', 'res', 'incorpr_registry.wasm');
const EMPTY_CODE_HASH = '11111111111111111111111111111111';
// The registry refuses list_company and acquire below this free balance (REGISTRY_RESERVE in
// contracts/incorpr-registry/src/lib.rs).
const REGISTRY_RESERVE = 5n * 10n ** 23n;
// Fixed markup the new charter renderer emits (charter.rs), and the old one does not.
const NEW_RENDERER_MARKER = '<clipPath id="f">';

const OPTIONS = {
  network: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'confirm-mainnet': { type: 'boolean', default: false },
  registry: { type: 'string' },
  rpc: { type: 'string' },
  wasm: { type: 'string' },
  'from-code-hash': { type: 'string' },
  'upgrade-tx': { type: 'string' },
  help: { type: 'boolean', default: false },
};

const USAGE = `usage: node scripts/upgrade-registry.mjs --network mainnet|sandbox [--dry-run] [--confirm-mainnet]
  --confirm-mainnet         required for a mainnet run that sends the transaction
  --registry ID             mainnet default incorpr.near; sandbox registry.test.near
  --wasm PATH               default contracts/res/incorpr_registry.wasm
  --from-code-hash HASH     code the registry must run now (default: registry_code_hash in the evidence file)
  --upgrade-tx HASH         repair only: the DeployContract tx of an upgrade the evidence file missed
  --rpc URL                 RPC endpoint override`;

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

function checkImports(file) {
  const result = spawnSync('python3', [join(REPO_ROOT, 'scripts', 'check-wasm-imports.py'), file], { encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.status !== 0) throw new CliError(`wasm import check failed (exit ${result.status}):\n${output}`);
  return output;
}

async function listAllCompanies(near, registry) {
  const out = [];
  for (let from = 0; ; from += 50) {
    const page = await near.view(registry, 'list_companies', { from, limit: 50 }, 'final');
    out.push(...page);
    if (page.length < 50) return out;
  }
}

/** The SVG inside a token's `media` and whether `media_hash` is its base64 sha256. */
function charterOf(token) {
  const prefix = 'data:image/svg+xml;base64,';
  const media = token?.metadata?.media ?? '';
  if (!media.startsWith(prefix)) return { svg: null, hashMatches: false };
  const svg = Buffer.from(media.slice(prefix.length), 'base64');
  return { svg: svg.toString('utf8'), hashMatches: createHash('sha256').update(svg).digest('base64') === token.metadata.media_hash };
}

/** Every view the upgrade must leave unchanged, read at final finality. */
async function snapshot(near, registry) {
  // A view that panics (nft_payout on an encumbered token) is recorded by its error, which the
  // new code must reproduce too.
  const view = (method, args = {}) =>
    near.view(registry, method, args, 'final').catch((error) => ({ view_error: error.message.replace(/^.*?: /, '') }));
  const companies = await listAllCompanies(near, registry);
  const perToken = {};
  for (const c of companies) {
    const id = c.token_id;
    const token = await view('nft_token', { token_id: id });
    const { media: _media, media_hash: _hash, ...metadata } = token?.metadata ?? {};
    perToken[id] = {
      owner_id: token?.owner_id,
      approved_account_ids: token?.approved_account_ids,
      metadata_without_media: metadata,
      get_company: await view('get_company', { token_id: id }),
      get_listing: await view('get_listing', { token_id: id }),
      get_loan: await view('get_loan', { token_id: id }),
      get_offers: await view('get_offers', { token_id: id }),
      nft_payout: await view('nft_payout', { token_id: id, balance: '1000000', max_len_payout: 10 }),
    };
  }
  return {
    views: {
      nft_total_supply: await view('nft_total_supply'),
      nft_metadata: await view('nft_metadata'),
      incorporation_cost: await view('incorporation_cost'),
      offer_storage_cost: await view('offer_storage_cost'),
      storage_balance_bounds: await view('storage_balance_bounds'),
      list_companies: companies,
      tokens: perToken,
    },
    state: await rawState(near, registry),
  };
}

/** sha256 of every stored value, by base64 key. Null when the RPC will not serve the state. */
async function rawState(near, registry) {
  try {
    const result = await near.rpc('query', { request_type: 'view_state', finality: 'final', account_id: registry, prefix_base64: '' });
    return Object.fromEntries(result.values.map((v) => [v.key, sha256Hex(Buffer.from(v.value, 'base64'))]));
  } catch (error) {
    return { unavailable: error.message.slice(0, 200) };
  }
}

function diffKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).map((k) => Buffer.from(k, 'base64').toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
}

async function main() {
  const args = parseCli(OPTIONS);
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const network = args.network;
  if (network !== 'mainnet' && network !== 'sandbox') throw new CliError('--network must be mainnet or sandbox', 2);
  const dryRun = args['dry-run'];
  if (network === 'mainnet' && !dryRun && !args['confirm-mainnet']) {
    throw new CliError('a mainnet run sends a real transaction. Run with --dry-run first, then add --confirm-mainnet.', 2);
  }

  const ctx = await networkContext({ network, registry: args.registry, rpc: args.rpc, startSandbox: false });
  const { near } = ctx;
  const registry = ctx.registry;

  heading(`Registry upgrade: ${network}${dryRun ? ' (dry run: no key read, no transaction)' : ''}`);
  const status = await near.status();
  const config = await near.protocolConfig();
  const gasPrice = await near.gasPrice();
  item('RPC', near.rpcUrl);
  item('protocol_version', String(status.protocol_version));
  item('registry', registry);

  // ------------------------------------------------------------ local code
  heading('New code');
  const wasmPath = resolve(args.wasm ?? DEFAULT_WASM);
  if (!existsSync(wasmPath)) throw new CliError(`${wasmPath} is missing. Run scripts/build-contracts.sh`);
  const wasm = readFileSync(wasmPath);
  for (const line of checkImports(wasmPath).split('\n')) log(`   ${line}`);
  const newHash = codeHashOf(wasm);
  item('file', relative(REPO_ROOT, wasmPath) || wasmPath);
  item('size', `${wasm.length} bytes`);
  item('code hash', `${newHash} (sha256 ${sha256Hex(wasm)})`);

  // ------------------------------------------------------------ chain
  heading('On chain now');
  const account = await near.viewAccount(registry);
  if (!account) throw new CliError(`${registry} does not exist on ${network}`);
  if (account.code_hash === EMPTY_CODE_HASH) throw new CliError(`${registry} holds no contract. Deploy it with scripts/deploy.mjs`);
  const fromHash = args['from-code-hash'] ?? ctx.evidence.data.deployment?.registry_code_hash ?? null;
  item('code hash', account.code_hash);
  item('expected old hash', fromHash ? `${fromHash} (${args['from-code-hash'] ? '--from-code-hash' : 'evidence registry_code_hash'})` : 'none recorded');
  const alreadyNew = account.code_hash === newHash;
  if (!alreadyNew) {
    if (!fromHash) throw new CliError('no expected old code hash: pass --from-code-hash');
    if (account.code_hash !== fromHash) {
      throw new CliError(`${registry} runs ${account.code_hash}, which is neither the expected old code ${fromHash} nor the new code ${newHash}`);
    }
  }
  item('status', alreadyNew ? 'already runs the new code; nothing to send' : 'runs the expected old code');
  const supply = await near.tryView(registry, 'nft_total_supply');
  if (!supply.ok) throw new CliError(`${registry}.nft_total_supply failed before the upgrade: ${supply.error}`);
  item('nft_total_supply', supply.value);

  // Storage and gas. The account pays for the code bytes it stores.
  const perByte = BigInt(config.runtime_config.storage_amount_per_byte);
  const fees = config.runtime_config.transaction_costs.action_creation_config;
  // Signer and receiver are the same account, so the send fee is the sir one.
  const sum = (f) => BigInt(f.send_sir) + BigInt(f.execution);
  const deployGas = sum(fees.deploy_contract_cost) + sum(fees.deploy_contract_cost_per_byte) * BigInt(wasm.length);
  const codeDelta = alreadyNew ? 0n : BigInt(wasm.length) - BigInt(await onChainCodeSize(near, registry));
  const free = BigInt(account.amount) - BigInt(account.storage_usage) * perByte;
  const freeAfter = free - (codeDelta > 0n ? codeDelta * perByte : 0n) - deployGas * gasPrice;
  item('code size change', `${codeDelta >= 0n ? '+' : ''}${codeDelta} bytes (${formatNear(codeDelta * perByte)} of storage)`);
  item('deploy gas', `${deployGas / 10n ** 12n} TGas, about ${formatNear(deployGas * gasPrice)} at ${gasPrice} yocto/gas`);
  item('free balance', `${formatNear(free)} now, about ${formatNear(freeAfter)} after`);
  // NEAR rejects a transaction before inclusion unless the signer can cover its gas at the
  // pessimistic price, about 10x the current one.
  if (!alreadyNew && free < deployGas * gasPrice * 10n + codeDelta * perByte) {
    throw new CliError(`${registry} holds ${formatNear(free)} free; the RPC would refuse the deploy below ${formatNear(deployGas * gasPrice * 10n + codeDelta * perByte)}`);
  }
  if (!alreadyNew && freeAfter < REGISTRY_RESERVE) {
    throw new CliError(`${registry} would keep ${formatNear(freeAfter)} free, below the 0.5 NEAR reserve list_company and acquire need. Top it up first.`);
  }

  // Signing key: never read in a dry run.
  const keyPath = near.credentialPath(registry);
  const fullKeys = (await near.accessKeyList(registry)).filter((k) => k.access_key.permission === 'FullAccess').map((k) => k.public_key);
  item('full access keys', `${fullKeys.length} on chain`);
  item('key file', `${keyPath}${dryRun ? ' (not read in a dry run)' : ''}`);

  heading('Snapshot before');
  const before = await snapshot(near, registry);
  const tokenIds = Object.keys(before.views.tokens);
  item('companies', tokenIds.length ? tokenIds.join(', ') : 'none');
  item('stored keys', before.state.unavailable ? `unavailable: ${before.state.unavailable}` : String(Object.keys(before.state).length));

  if (dryRun) {
    if (alreadyNew) {
      const recorded = ctx.evidence.data.deployment?.registry_code_hash;
      log(`\nDry run: ${registry} already runs the new code; nothing to send.${recorded === newHash ? '' : ` The evidence still records ${recorded}; a run without --dry-run repairs it.`}`);
    } else {
      log(`\nDry run: would send one DeployContract (${wasm.length} bytes) from ${registry} to itself. No transaction sent.`);
    }
    return 0;
  }

  // ------------------------------------------------------------ send
  let upgradeIndex = -1;
  // A repair runs both snapshots on the new code, so it cannot show that the upgrade kept state.
  let repaired = false;
  if (!alreadyNew) {
    heading('Send');
    if (!fullKeys.includes(near.publicKeyOf(registry))) {
      throw new CliError(`${keyPath} is not a full access key of ${registry}`);
    }
    const tx = await near.send({
      signerId: registry,
      receiverId: registry,
      actions: [actions.deployContract(wasm)],
      label: { step: 'upgrade', purpose: `replace registry code ${account.code_hash} with ${newHash} (no init call; state kept)`, method: 'DeployContract' },
    });
    // Recorded before any verification read, so a failed read cannot leave the evidence on the old hash.
    upgradeIndex = recordUpgrade(ctx.evidence, { from: account.code_hash, to: newHash, bytes: wasm.length, hash: tx.hash, explorerUrl: tx.explorerUrl });
  } else if (ctx.evidence.data.deployment?.registry_code_hash !== newHash) {
    // An earlier run landed the upgrade but stopped before writing the deployment record.
    upgradeIndex = await recoverUpgradeRecord(ctx, near, registry, { from: fromHash, to: newHash, bytes: wasm.length, txHash: args['upgrade-tx'] });
    repaired = true;
  }

  // ------------------------------------------------------------ verify
  heading('Verify');
  // The snapshot reads at final finality, so wait until the final block has the new code.
  let afterAccount = null;
  for (let i = 0; i < 30; i += 1) {
    afterAccount = await near.rpc('query', { request_type: 'view_account', finality: 'final', account_id: registry });
    if (afterAccount.code_hash === newHash) break;
    await sleep(1_000);
  }
  if (afterAccount.code_hash !== newHash) throw new CliError(`${registry} runs ${afterAccount.code_hash} at final finality, not ${newHash}`);
  item('code hash', `${afterAccount.code_hash} (new)`);
  const after = await snapshot(near, registry);
  const problems = [];
  const charterProblems = [];
  if (!isDeepStrictEqual(after.views, before.views)) {
    for (const key of Object.keys(before.views)) {
      if (!isDeepStrictEqual(after.views[key], before.views[key])) problems.push(`view ${key} changed`);
    }
  }
  if (before.state.unavailable || after.state.unavailable) {
    item('stored bytes', 'not compared: the RPC did not serve view_state');
  } else {
    const changed = diffKeys(before.state, after.state);
    if (changed.length) problems.push(`stored values changed under keys: ${changed.join(', ')}`);
    else item('stored bytes', `${Object.keys(after.state).length} keys, every value identical`);
  }
  item('views', problems.some((p) => p.startsWith('view')) ? 'CHANGED' : `${Object.keys(before.views).length} views identical`);
  for (const id of tokenIds) {
    const token = await near.view(registry, 'nft_token', { token_id: id }, 'final');
    const { svg, hashMatches } = charterOf(token);
    // Fixed markup only the new renderer emits; user text (name, service) can contain anything.
    const isNew = Boolean(svg && svg.includes(NEW_RENDERER_MARKER));
    item(`charter ${id}`, `${isNew ? 'new renderer' : 'OLD RENDERER'}, media_hash ${hashMatches ? 'matches' : 'DOES NOT MATCH'} its sha256`);
    if (!isNew) charterProblems.push(`token ${id} does not render the new charter`);
    if (!hashMatches) charterProblems.push(`token ${id} media_hash does not match`);
  }

  if (upgradeIndex >= 0) {
    const upgrades = [...ctx.evidence.data.deployment.registry_upgrades];
    upgrades[upgradeIndex] = repaired
      ? { ...upgrades[upgradeIndex], state_unchanged: null, recorded_after_the_fact: true, charter_checks_passed: charterProblems.length === 0, verified_at: new Date().toISOString() }
      : { ...upgrades[upgradeIndex], state_unchanged: problems.length === 0, charter_checks_passed: charterProblems.length === 0, verified_at: new Date().toISOString() };
    ctx.evidence.setDeployment({ registry_upgrades: upgrades });
    heading('Evidence');
    item('json', ctx.evidence.jsonPath);
  }

  const failed = [...problems, ...charterProblems];
  if (failed.length) {
    // Between the two snapshots another transaction may have changed state; the list says where.
    throw new CliError(`the registry runs the new code, but checks failed:\n   ${failed.join('\n   ')}`);
  }
  log('\nUpgrade verified: same state, same views, new charter.');
  return 0;
}

/**
 * Moves the deployment record to the new code and appends the upgrade. Returns the entry's index;
 * state_unchanged stays null until the post-upgrade comparison finishes.
 */
function recordUpgrade(evidence, { from, to, bytes, hash, explorerUrl }) {
  const upgrades = evidence.data.deployment.registry_upgrades ?? [];
  const existing = upgrades.findIndex((u) => u.tx_hash === hash);
  if (existing >= 0) return existing;
  evidence.setDeployment({
    registry_code_hash: to,
    registry_wasm_bytes: bytes,
    registry_upgrades: [...upgrades, { from_code_hash: from, to_code_hash: to, tx_hash: hash, explorer_url: explorerUrl, at: new Date().toISOString(), state_unchanged: null }],
  });
  return upgrades.length;
}

/**
 * The registry already runs the new code but the evidence still names another hash: find the
 * DeployContract transaction (in the evidence log, or --upgrade-tx), check it on chain, record it.
 */
async function recoverUpgradeRecord(ctx, near, registry, { from, to, bytes, txHash }) {
  heading('Evidence repair');
  const logged = [...ctx.evidence.data.transactions].reverse().find((t) => t.step === 'upgrade' && t.status === 'success' && t.signer === registry);
  const hash = txHash ?? logged?.tx_hash;
  if (!hash) {
    throw new CliError(
      `${registry} runs ${to} but the evidence records ${ctx.evidence.data.deployment?.registry_code_hash} and no upgrade transaction. ` +
        'Find the DeployContract transaction on the explorer and rerun with --upgrade-tx <hash>.',
    );
  }
  let outcome;
  try {
    outcome = await near.rpc('tx', { tx_hash: hash, sender_account_id: registry, wait_until: 'FINAL' });
  } catch (error) {
    // A regular RPC node drops transactions after a few epochs (mainnet: about 2.5 days).
    throw new CliError(`cannot read transaction ${hash} sent by ${registry}: ${error.message}. For an older transaction pass --rpc with an archival endpoint.`);
  }
  const t = outcome.transaction;
  const deploys = t.actions.filter((a) => a && typeof a === 'object' && 'DeployContract' in a);
  const ok = outcome.status && 'SuccessValue' in outcome.status;
  if (t.signer_id !== registry || t.receiver_id !== registry || deploys.length !== 1 || !ok) {
    throw new CliError(`transaction ${hash} is not a successful DeployContract from ${registry} to itself`);
  }
  item('upgrade tx', `${hash} (${logged && !txHash ? 'from the evidence log' : '--upgrade-tx'}, checked on chain)`);
  return recordUpgrade(ctx.evidence, { from: from ?? 'unknown', to, bytes, hash, explorerUrl: near.txUrl(hash) });
}

/** Bytes of the code the account runs now, from view_code. */
async function onChainCodeSize(near, accountId) {
  const result = await near.rpc('query', { request_type: 'view_code', finality: 'final', account_id: accountId });
  return Buffer.from(result.code_base64, 'base64').length;
}

runMain(main);
