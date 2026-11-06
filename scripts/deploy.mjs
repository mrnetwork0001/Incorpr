#!/usr/bin/env node
// Deploys Incorpr: registry account, operator account, incorpr-registry wasm and its `new` call,
// USDC storage registrations, and N incorporated companies with derived treasury addresses.
//
//   node scripts/deploy.mjs --network mainnet --dry-run
//   node scripts/deploy.mjs --network mainnet --confirm-mainnet
//   node scripts/deploy.mjs --network testnet --deployer you.testnet
//   node scripts/deploy.mjs --network sandbox
//
// Every step first reads chain state and skips work that is already done, so a failed run can be
// rerun. Every transaction is recorded in docs/evidence/<network>.json (sandbox: its home dir).
// Runbook: docs/DEPLOY.md.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { attestedSigners, checkModelLive } from './lib/attestation.mjs';
import { CliError, formatNear, heading, item, log, MILLI_NEAR, ONE_NEAR, parseCli, parseNear, requireNetwork, runMain, tgas } from './lib/cli.mjs';
import { loadTreasuryPrompt, REPO_ROOT } from './lib/deps.mjs';
import { loadAppEnv, mergeEnvFile } from './lib/envfile.mjs';
import { actions, codeHashOf } from './lib/near.mjs';
import { networkContext } from './lib/network.mjs';
import { COMPANIES, derivePolicy } from './lib/plan.mjs';

const RES = join(REPO_ROOT, 'contracts', 'res');
const wasmPath = (name) => join(RES, `${name}.wasm`);

const DEFAULT_MODEL = 'Qwen/Qwen3-VL-30B-A3B-Instruct';
// Registry constants (contracts/incorpr-registry/src/lib.rs), used only for the dry-run estimate
// before the registry exists. Once deployed, incorporation_cost() is read from the contract.
const VAULT_STATE_BYTES = 64_000n;
const VAULT_OPERATING_BALANCE = 500n * MILLI_NEAR;
const TOKEN_STORAGE_ESTIMATE = 50n * MILLI_NEAR;
const FT_REGISTRATION = 1_250n * 10n ** 18n;
const REGISTRY_RESERVE = 500n * MILLI_NEAR;
const REGISTRY_STATE_ESTIMATE = 2_000n;

const OPTIONS = {
  network: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'confirm-mainnet': { type: 'boolean', default: false },
  companies: { type: 'string', default: '3' },
  deployer: { type: 'string' },
  registry: { type: 'string' },
  rpc: { type: 'string' },
  usdc: { type: 'string' },
  intents: { type: 'string' },
  'credentials-dir': { type: 'string' },
  'tee-model': { type: 'string' },
  'compute-payee': { type: 'string' },
  'registry-funding': { type: 'string' },
  'operator-funding': { type: 'string', default: '0.3' },
  'cap-usd': { type: 'string', default: '25' },
  'floor-haircut-bps': { type: 'string', default: '1000' },
  'auction-ms': { type: 'string' },
  'allow-unverified-quote': { type: 'boolean', default: false },
  'env-file': { type: 'string' },
  help: { type: 'boolean', default: false },
};

const USAGE = `usage: node scripts/deploy.mjs --network mainnet|testnet|sandbox [--dry-run] [--companies N]
  --confirm-mainnet         required for a mainnet run that sends transactions
  --deployer ID             mainnet default ${'717260ae…65b9'} (implicit); required on testnet
  --registry ID             mainnet default incorpr.near; testnet registry.<deployer>
  --tee-model ID            NEAR AI Cloud model pinned in tee_models (default NEAR_AI_DEFAULT_MODEL or ${DEFAULT_MODEL})
  --compute-payee ID        default: the operator account
  --registry-funding NEAR   default: storage for the wasm + 0.5 reserve + operator funding + 0.3 margin
  --operator-funding NEAR   default 0.3
  --cap-usd N               per-token agent spend cap per 24 h, in USD at the live price (default 25)
  --floor-haircut-bps N     price floors sit this far below the live cross rate (default 1000 = 10%)
  --intents ID              testnet only: account named as intents_contract (no testnet deployment exists)
  --allow-unverified-quote  accept a TDX quote whose Intel collateral could not be fetched
  --env-file PATH           default web/.env.local (sandbox: <sandbox home>/web.env.local)`;

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readWasm(name) {
  const path = wasmPath(name);
  if (!existsSync(path)) throw new CliError(`${relative(REPO_ROOT, path)} is missing. Run scripts/build-contracts.sh`);
  return readFileSync(path);
}

function checkImports(files) {
  const result = spawnSync('python3', [join(REPO_ROOT, 'scripts', 'check-wasm-imports.py'), ...files], { encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.status !== 0) throw new CliError(`wasm import check failed (exit ${result.status}):\n${output}`);
  return output;
}

/** Looks through every value of a nested object for a key, for protocol config fields whose nesting varies by release. */
function findKey(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  if (key in object) return object[key];
  for (const value of Object.values(object)) {
    const found = findKey(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function listAllCompanies(near, registry) {
  const out = [];
  for (let from = 0; ; from += 50) {
    const page = await near.view(registry, 'list_companies', { from, limit: 50 });
    out.push(...page);
    if (page.length < 50) return out;
  }
}

async function main() {
  const args = parseCli(OPTIONS);
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const network = requireNetwork(args.network);
  const dryRun = args['dry-run'];
  if (network === 'mainnet' && !dryRun && !args['confirm-mainnet']) {
    throw new CliError('a mainnet run sends real transactions. Run with --dry-run first, then add --confirm-mainnet.', 2);
  }
  const companyCount = Number(args.companies);
  if (!Number.isInteger(companyCount) || companyCount < 0 || companyCount > COMPANIES.length) {
    throw new CliError(`--companies must be 0..${COMPANIES.length}`, 2);
  }

  const ctx = await networkContext({
    network,
    deployer: args.deployer,
    registry: args.registry,
    rpc: args.rpc,
    usdc: args.usdc,
    intents: args.intents,
    credentialsDir: args['credentials-dir'],
    startSandbox: network === 'sandbox' && !dryRun,
  });
  const { near } = ctx;
  if (network === 'testnet' && !ctx.intents) {
    throw new CliError('testnet has no intents.near. Pass --intents <account> to name the account the registry records as intents_contract.', 2);
  }
  const envFile = args['env-file'] ?? ctx.envFile;
  loadAppEnv(join(REPO_ROOT, 'web', '.env.local'));
  const computePayee = args['compute-payee'] ?? ctx.operator;
  const model = args['tee-model'] ?? process.env.NEAR_AI_DEFAULT_MODEL ?? DEFAULT_MODEL;
  const auctionMs = BigInt(args['auction-ms'] ?? (network === 'sandbox' ? 120_000 : 86_400_000));
  const sandboxDoubles = network === 'sandbox';
  const deployTestUsdc = network === 'testnet' && !args.usdc;

  heading(`Incorpr deploy: ${network}${dryRun ? ' (dry run: no transactions)' : ''}`);
  const status = await near.status();
  const config = await near.protocolConfig();
  const perByte = BigInt(config.runtime_config.storage_amount_per_byte);
  const gasPrice = await near.gasPrice();
  item('RPC', near.rpcUrl);
  item('protocol_version', `${status.protocol_version} (node ${status.version?.version ?? '?'})`);
  item('universal_accounts', String(findKey(config.runtime_config, 'universal_accounts') ?? 'not reported'));
  item('storage per byte', `${perByte} yocto`);
  item('gas price', `${gasPrice} yocto/gas`);
  item('deployer', ctx.deployer);
  item('registry', ctx.registry);
  item('operator', ctx.operator);
  item('compute payee', computePayee);
  item('USDC', `${ctx.usdc}${network === 'mainnet' ? ' (native USDC)' : ' (Test USDC, no value)'}`);
  item('MPC signer', `${ctx.mpc}${sandboxDoubles ? ' (SANDBOX ONLY double)' : ''}`);
  item('intents', `${ctx.intents}${sandboxDoubles ? ' (SANDBOX ONLY double)' : ''}`);
  item('key files', near.credentialsDir);

  // ------------------------------------------------------------ preflight
  heading('Preflight');
  const registryWasm = readWasm('incorpr_registry');
  const vaultWasm = readWasm('company_vault');
  const importFiles = [wasmPath('incorpr_registry'), wasmPath('company_vault')];
  if (sandboxDoubles) importFiles.push(wasmPath('test_usdc'), wasmPath('mpc_signer_double'), wasmPath('intents_double'));
  if (deployTestUsdc) importFiles.push(wasmPath('test_usdc'));
  for (const line of checkImports(importFiles).split('\n')) log(`   ${line}`);
  const registryCodeHash = codeHashOf(registryWasm);
  item('incorpr_registry.wasm', `${registryWasm.length} bytes, code hash ${registryCodeHash}`);
  item('company_vault.wasm', `${vaultWasm.length} bytes, sha256 ${sha256Hex(vaultWasm)}`);

  const operatorFunding = parseNear(args['operator-funding']);
  const registryFunding = args['registry-funding']
    ? parseNear(args['registry-funding'])
    : (() => {
        const raw = perByte * (BigInt(registryWasm.length) + REGISTRY_STATE_ESTIMATE) + REGISTRY_RESERVE + FT_REGISTRATION + operatorFunding + 300n * MILLI_NEAR;
        const step = 100n * MILLI_NEAR;
        return ((raw + step - 1n) / step) * step;
      })();
  const estimatedIncorporation = perByte * (BigInt(vaultWasm.length) + VAULT_STATE_BYTES) + VAULT_OPERATING_BALANCE + TOKEN_STORAGE_ESTIMATE + FT_REGISTRATION;

  // ------------------------------------------------------------ plan
  /** @type {{ id: string, title: string, payer: string, deposit: bigint, gas: bigint, extraGas?: bigint, done: () => Promise<boolean|string>, run: () => Promise<void> }[]} */
  const steps = [];
  const ftRegistrationCost = async () => {
    const bounds = await near.tryView(ctx.usdc, 'storage_balance_bounds');
    return bounds.ok ? BigInt(bounds.value.min) : FT_REGISTRATION;
  };
  const deployCostGas = (bytes) => {
    const fees = config.runtime_config.transaction_costs.action_creation_config;
    const base = fees.deploy_contract_cost;
    const per = fees.deploy_contract_cost_per_byte;
    const sum = (f) => BigInt(f.send_not_sir) + BigInt(f.execution);
    return sum(base) + sum(per) * BigInt(bytes);
  };

  /** Keyless account with a contract, for sandbox doubles and Test USDC. */
  const keylessContract = (accountId, wasmName, funding, label) => {
    const wasm = readWasm(wasmName);
    steps.push({
      id: `contract:${accountId}`,
      title: `create ${accountId}, deploy ${wasmName}.wasm, call new() (${label})`,
      payer: ctx.deployer,
      deposit: funding,
      gas: tgas(30),
      extraGas: deployCostGas(wasm.length),
      done: async () => {
        const account = await near.viewAccount(accountId);
        if (!account) return false;
        if (account.code_hash !== codeHashOf(wasm)) throw new CliError(`${accountId} exists with other code (${account.code_hash})`);
        return true;
      },
      run: async () => {
        await near.send({
          signerId: ctx.deployer,
          receiverId: accountId,
          actions: [actions.createAccount(), actions.transfer(funding), actions.deployContract(wasm), actions.functionCall('new', {}, tgas(30), 0n)],
          label: { step: 'deploy', purpose: `${label}: create, fund, deploy ${wasmName}, init`, method: 'CreateAccount+Transfer+DeployContract+new', deposit: funding, gas: tgas(30) },
        });
      },
    });
  };
  if (sandboxDoubles) {
    keylessContract(ctx.usdc, 'test_usdc', 30n * ONE_NEAR, 'SANDBOX ONLY Test USDC');
    keylessContract(ctx.mpc, 'mpc_signer_double', 30n * ONE_NEAR, 'SANDBOX ONLY stand-in for v1.signer');
    keylessContract(ctx.intents, 'intents_double', 30n * ONE_NEAR, 'SANDBOX ONLY stand-in for intents.near');
  }
  if (deployTestUsdc) keylessContract(ctx.usdc, 'test_usdc', 3n * ONE_NEAR, 'Test USDC (testnet, no value)');

  // Registry account. A fresh key is written to the key file before the transaction is sent.
  steps.push({
    id: 'account:registry',
    title:
      network === 'mainnet'
        ? `near.create_account(${ctx.registry}) from ${ctx.deployer}, funded with ${formatNear(registryFunding)}`
        : `create ${ctx.registry} as a sub-account of ${ctx.deployer}, funded with ${formatNear(registryFunding)}`,
    payer: ctx.deployer,
    deposit: registryFunding,
    gas: network === 'mainnet' ? tgas(100) : 0n,
    extraGas: tgas(5),
    done: async () => {
      const account = await near.viewAccount(ctx.registry);
      if (!account) return false;
      if (!(await near.controls(ctx.registry))) {
        throw new CliError(`${ctx.registry} exists but ${near.credentialPath(ctx.registry)} holds no full access key for it`);
      }
      return true;
    },
    run: async () => {
      const key = near.keyFileFor(ctx.registry);
      if (network === 'mainnet') {
        await near.call(ctx.deployer, 'near', 'create_account', { new_account_id: ctx.registry, new_public_key: key.getPublicKey().toString() }, {
          gas: tgas(100),
          deposit: registryFunding,
          step: 'deploy',
          purpose: `create ${ctx.registry} (registry account)`,
        });
      } else {
        await near.send({
          signerId: ctx.deployer,
          receiverId: ctx.registry,
          actions: [actions.createAccount(), actions.transfer(registryFunding), actions.addFullAccessKey(key.getPublicKey())],
          label: { step: 'deploy', purpose: `create ${ctx.registry} (registry account)`, method: 'CreateAccount+Transfer+AddKey', deposit: registryFunding },
        });
      }
      if (!(await near.controls(ctx.registry))) throw new CliError(`${ctx.registry} was not created with the new key; see the transaction above`);
    },
  });

  steps.push({
    id: 'account:operator',
    title: `create ${ctx.operator} with a fresh key, funded with ${formatNear(operatorFunding)} (paid from the registry account)`,
    payer: ctx.registry,
    deposit: operatorFunding,
    gas: 0n,
    extraGas: tgas(5),
    done: async () => {
      const account = await near.viewAccount(ctx.operator);
      if (!account) return false;
      if (!(await near.controls(ctx.operator))) {
        throw new CliError(`${ctx.operator} exists but ${near.credentialPath(ctx.operator)} holds no full access key for it`);
      }
      return true;
    },
    run: async () => {
      const key = near.keyFileFor(ctx.operator);
      await near.send({
        signerId: ctx.registry,
        receiverId: ctx.operator,
        actions: [actions.createAccount(), actions.transfer(operatorFunding), actions.addFullAccessKey(key.getPublicKey())],
        label: { step: 'deploy', purpose: `create ${ctx.operator} (operator: records service calls)`, method: 'CreateAccount+Transfer+AddKey', deposit: operatorFunding },
      });
    },
  });

  // USDC registrations: the founder receives royalties and sale proceeds, the payee compute bills.
  for (const [who, why] of [
    [ctx.deployer, 'founder: royalties and sale proceeds'],
    [computePayee, 'compute payee: pay_compute_bill target'],
  ]) {
    if (steps.some((s) => s.id === `ft:${who}`)) continue;
    steps.push({
      id: `ft:${who}`,
      title: `USDC storage_deposit for ${who} (${why})`,
      payer: ctx.deployer,
      deposit: FT_REGISTRATION,
      gas: tgas(10),
      done: async () => {
        const balance = await near.tryView(ctx.usdc, 'storage_balance_of', { account_id: who });
        return balance.ok && balance.value !== null;
      },
      run: async () => {
        const cost = await ftRegistrationCost();
        await near.call(ctx.deployer, ctx.usdc, 'storage_deposit', { account_id: who, registration_only: true }, {
          gas: tgas(10),
          deposit: cost,
          step: 'deploy',
          purpose: `register ${who} on USDC (${why})`,
        });
      },
    });
  }

  // TEE policy: fetched live for the dry run too, so a broken attestation shows before funding.
  heading('TEE policy');
  const prompt = await loadTreasuryPrompt();
  item('model', model);
  item('tee_prompt_hash', `${prompt.hash} (sha256 of TREASURY_SYSTEM_PROMPT, web/src/lib/rebalance.ts)`);
  let tee = null;
  const registryInitialized = async () => (await near.tryView(ctx.registry, 'nft_total_supply')).ok;
  const registryLive = (await near.viewAccount(ctx.registry))?.code_hash === registryCodeHash && (await registryInitialized());
  if (registryLive) {
    item('signers', 'registry already initialized; policy not re-read from attestation');
  } else {
    await checkModelLive(model);
    tee = await attestedSigners(model, { allowUnverifiedQuote: args['allow-unverified-quote'] });
    for (const node of tee.nodes) {
      item('signer', `${node.signing_address} (TDX ${node.intel_tcb_status}; ${Object.entries(node.checks).filter(([, v]) => v === true).length} checks passed)`);
    }
  }

  heading('Default policy');
  let policy = null;
  if (registryLive) {
    item('policy', 'registry already initialized; read it with get_company / vault get_state');
  } else {
    policy = await derivePolicy(ctx, { capUsd: Number(args['cap-usd']), haircutBps: Number(args['floor-haircut-bps']) });
    for (const [asset, p] of Object.entries(policy.prices)) item('1Click price', `${asset} ${p.usd} USD (${p.updated_at})`);
    for (const [asset, cap] of policy.epochCaps) item('epoch cap', `${asset} ${cap}`);
    for (const f of policy.priceFloors) item('price floor', `${f.sell_token} -> ${f.buy_token}: >= ${f.min_buy} per ${f.per_sell}`);
  }

  const newArgs = () => ({
    args: {
      owner: ctx.registry,
      usdc_token: ctx.usdc,
      mpc_contract: ctx.mpc,
      intents_contract: ctx.intents,
      btc_hrp: ctx.btcHrp,
      default_operator: ctx.operator,
      compute_payee: computePayee,
      allowed_tokens: policy.allowedTokens,
      epoch_caps: policy.epochCaps,
      tee_signers: tee.signers,
      tee_models: [model],
      tee_prompt_hash: prompt.hash,
      price_floors: policy.priceFloors,
      auction_duration_ms: Number(auctionMs),
    },
  });

  // Deploy and init in one transaction: `new` is not private, so a separate call could be front-run.
  steps.push({
    id: 'contract:registry',
    title: `deploy incorpr_registry.wasm (${registryWasm.length} bytes) to ${ctx.registry} and call new() in the same transaction`,
    payer: ctx.registry,
    deposit: 0n,
    gas: tgas(100),
    extraGas: deployCostGas(registryWasm.length),
    done: async () => {
      const account = await near.viewAccount(ctx.registry);
      if (!account || account.code_hash === '11111111111111111111111111111111') return false;
      if (account.code_hash !== registryCodeHash) {
        throw new CliError(`${ctx.registry} runs code ${account.code_hash}, not ${registryCodeHash}. This script does not upgrade a live registry.`);
      }
      if (!(await registryInitialized())) throw new CliError(`${ctx.registry} has the registry code but is not initialized. Call new() by hand after checking who can.`);
      return true;
    },
    run: async () => {
      await near.send({
        signerId: ctx.registry,
        receiverId: ctx.registry,
        actions: [actions.deployContract(registryWasm), actions.functionCall('new', newArgs(), tgas(100), 0n)],
        label: { step: 'deploy', purpose: `deploy incorpr-registry and initialize it (${network} policy)`, method: 'DeployContract+new', gas: tgas(100) },
      });
      const free = await near.freeBalance(ctx.registry, config);
      log(`   registry free balance after deploy: ${formatNear(free)}`);
      if (free < REGISTRY_RESERVE) log(`   warning: below the 0.5 NEAR REGISTRY_RESERVE; list_company and acquire refuse until topped up`);
    },
  });

  const plannedCompanies = COMPANIES.slice(0, companyCount);
  for (const plan of plannedCompanies) {
    const findCompany = async () => {
      if (!(await registryInitialized())) return null;
      return (await listAllCompanies(near, ctx.registry)).find((c) => c.name === plan.name && c.founder === ctx.deployer) ?? null;
    };
    steps.push({
      id: `company:${plan.name}`,
      title: `incorporate_company "${plan.name}" at ${Number(plan.price_micro_usdc) / 1e6} USDC per call (founder ${ctx.deployer})`,
      payer: ctx.deployer,
      deposit: estimatedIncorporation,
      gas: tgas(300),
      done: async () => Boolean(await findCompany()),
      run: async () => {
        const cost = BigInt(await near.view(ctx.registry, 'incorporation_cost'));
        const { sample_input: _sample, ...incorporate } = plan;
        await near.call(ctx.deployer, ctx.registry, 'incorporate_company', { args: incorporate }, {
          gas: tgas(300),
          deposit: cost,
          step: 'deploy',
          purpose: `incorporate "${plan.name}": create keyless vault sub-account and mint the NFT`,
        });
        const company = await findCompany();
        if (!company) throw new CliError(`incorporate_company for "${plan.name}" did not mint; see the receipt failures above`);
        log(`   minted token ${company.token_id}, vault ${company.vault}`);
      },
    });
    steps.push({
      id: `keys:${plan.name}`,
      title: `refresh_treasury_keys on the "${plan.name}" vault: derive its BTC, EVM and SOL addresses from ${ctx.mpc}`,
      payer: ctx.deployer,
      deposit: 0n,
      gas: tgas(150),
      done: async () => {
        const company = await findCompany();
        if (!company) return false;
        return (await near.view(company.vault, 'treasury_addresses')) !== null;
      },
      run: async () => {
        const company = await findCompany();
        await near.call(ctx.deployer, company.vault, 'refresh_treasury_keys', {}, {
          gas: tgas(150),
          step: 'deploy',
          purpose: `derive treasury addresses for token ${company.token_id} on-chain`,
        });
        const addresses = await near.view(company.vault, 'treasury_addresses');
        if (!addresses) throw new CliError(`${company.vault} stored no treasury addresses`);
        log(`   BTC ${addresses.btc}  EVM ${addresses.evm}  SOL ${addresses.sol}`);
      },
    });
  }

  // ------------------------------------------------------------ status of each step
  heading('Plan');
  const pending = [];
  for (const step of steps) {
    const done = await step.done();
    log(`   [${done ? 'done' : 'todo'}] ${step.title}`);
    if (!done) {
      pending.push(step);
      const gasCost = (step.gas + (step.extraGas ?? 0n)) * gasPrice;
      log(`          payer ${step.payer}, deposit ${formatNear(step.deposit)}, gas up to ${formatNear(gasCost)}`);
    }
  }

  const byPayer = new Map();
  for (const step of pending) {
    const gasCost = (step.gas + (step.extraGas ?? 0n)) * gasPrice;
    byPayer.set(step.payer, (byPayer.get(step.payer) ?? 0n) + step.deposit + gasCost);
  }
  heading('Cost');
  item('registry funding', `${formatNear(registryFunding)} (storage ${formatNear(perByte * (BigInt(registryWasm.length) + REGISTRY_STATE_ESTIMATE))} + 0.5 reserve + operator + margin)`);
  item('per company', `${formatNear(estimatedIncorporation)} attached; the registry refunds about 0.03 NEAR`);
  const deployerNeeds = byPayer.get(ctx.deployer) ?? 0n;
  item('deployer pays', `${formatNear(deployerNeeds)} (deposits + gas upper bound at ${gasPrice} yocto/gas)`);
  if (byPayer.has(ctx.registry)) {
    item('registry account pays', `${formatNear(byPayer.get(ctx.registry))} out of the registry funding above`);
  }
  const deployerBalance = await near.freeBalance(ctx.deployer, config);
  item('deployer balance', deployerBalance === null ? `account ${ctx.deployer} does not exist yet (0 NEAR)` : formatNear(deployerBalance));
  const shortBy = deployerNeeds - (deployerBalance ?? 0n);
  if (shortBy > 0n) item('short by', `${formatNear(shortBy)}: fund ${ctx.deployer} with at least this much before a real run`);
  else item('balance check', 'covers the plan');

  if (dryRun) {
    log('\nDry run: no transactions sent, no key files written, no env file changed.');
    return 0;
  }
  if (shortBy > 0n) throw new CliError(`${ctx.deployer} cannot cover the plan`);
  if (!near.hasCredentials(ctx.deployer)) throw new CliError(`no key file for the deployer: ${near.credentialPath(ctx.deployer)}`);

  // ------------------------------------------------------------ run
  ctx.evidence.setDeployment({
    network,
    deployer: ctx.deployer,
    registry: ctx.registry,
    operator: ctx.operator,
    compute_payee: computePayee,
    usdc_token: ctx.usdc,
    mpc_contract: ctx.mpc,
    intents_contract: ctx.intents,
    explorer_url: near.explorerUrl,
    rpc_url: network === 'sandbox' ? near.rpcUrl : undefined,
    protocol_version: status.protocol_version,
    registry_code_hash: registryCodeHash,
    registry_wasm_bytes: registryWasm.length,
    vault_wasm_sha256: sha256Hex(vaultWasm),
    ...(tee
      ? {
          tee: { model, prompt_hash: prompt.hash, nonce: tee.nonce, attestation_url: tee.url, signers: tee.signers, nodes: tee.nodes },
          policy: { allowed_tokens: policy.allowedTokens, epoch_caps: policy.epochCaps, price_floors: policy.priceFloors, prices: policy.prices },
        }
      : {}),
  });

  heading('Run');
  for (const step of steps) {
    if (await step.done()) {
      log(`   skip  ${step.title}`);
      continue;
    }
    log(`   start ${step.title}`);
    await step.run();
    if (!(await step.done())) throw new CliError(`step did not take effect: ${step.title}`);
  }

  // ------------------------------------------------------------ record and configure the app
  const cost = await near.view(ctx.registry, 'incorporation_cost');
  ctx.evidence.setDeployment({ incorporation_cost_yocto: cost });
  for (const company of await listAllCompanies(near, ctx.registry)) {
    const addresses = await near.view(company.vault, 'treasury_addresses');
    ctx.evidence.upsertCompany({
      token_id: company.token_id,
      name: company.name,
      vault: company.vault,
      owner: company.owner_id,
      price_micro_usdc: company.price_micro_usdc,
      service_template: company.service_template,
      btc: addresses?.btc ?? null,
      evm: addresses?.evm ?? null,
      sol: addresses?.sol ?? null,
    });
  }

  const operatorKey = near.loadKeyPair(ctx.operator);
  const env = {
    NEXT_PUBLIC_NEAR_NETWORK: network,
    NEXT_PUBLIC_REGISTRY_CONTRACT_ID: ctx.registry,
    NEXT_PUBLIC_MPC_CONTRACT_ID: ctx.mpc,
    NEXT_PUBLIC_USDC_CONTRACT_ID: ctx.usdc,
    NEXT_PUBLIC_INTENTS_CONTRACT_ID: ctx.intents ?? '',
    NEAR_OPERATOR_ACCOUNT_ID: ctx.operator,
    NEAR_OPERATOR_PRIVATE_KEY: operatorKey.toString(),
  };
  if (network === 'sandbox') env.NEXT_PUBLIC_NEAR_RPC_URL = near.rpcUrl;
  const changed = mergeEnvFile(envFile, env);
  heading('App settings');
  item('env file', `${envFile} (mode 0600)`);
  item('keys written', changed.length ? changed.join(', ') : 'none changed');
  if (network !== 'sandbox') log('   Rebuild the web app (next build) for NEXT_PUBLIC_ values to take effect.');
  heading('Evidence');
  item('json', ctx.evidence.jsonPath);
  item('markdown', ctx.evidence.markdownPath);
  return 0;
}

runMain(main);
