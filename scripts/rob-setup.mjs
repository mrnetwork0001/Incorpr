#!/usr/bin/env node
// Creates the "rob" account for the /rob page: an account that owns nothing and holds a little NEAR
// for gas, so the page can show a stranger's transactions being refused by a company vault.
//
//   node scripts/rob-setup.mjs --network sandbox
//   node scripts/rob-setup.mjs --network testnet --deployer you.testnet
//   node scripts/rob-setup.mjs --network mainnet --dry-run
//   node scripts/rob-setup.mjs --network mainnet --confirm-mainnet
//
// The account is rob.<registry>, created by the registry account (which deploy.mjs created and holds
// a key for). When the deployer is not the registry, the deployer first sends the funding to the
// registry, so creating the account never draws on the registry's settlement reserve.
// A fresh ed25519 key is written to the network's key directory (~/.near-credentials/<network>/, or
// the sandbox home's credentials/ on a sandbox) before the transaction is sent. ROB_ACCOUNT_ID and
// ROB_PRIVATE_KEY are merged into the app env file; other keys in that file are kept.

import { CliError, formatNear, heading, item, log, MILLI_NEAR, ONE_NEAR, parseCli, parseNear, requireNetwork, runMain } from './lib/cli.mjs';
import { mergeEnvFile } from './lib/envfile.mjs';
import { actions } from './lib/near.mjs';
import { networkContext } from './lib/network.mjs';

const OPTIONS = {
  network: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'confirm-mainnet': { type: 'boolean', default: false },
  deployer: { type: 'string' },
  registry: { type: 'string' },
  account: { type: 'string' },
  funding: { type: 'string' },
  token: { type: 'string' },
  rpc: { type: 'string' },
  'credentials-dir': { type: 'string' },
  'env-file': { type: 'string' },
  help: { type: 'boolean', default: false },
};

const USAGE = `usage: node scripts/rob-setup.mjs --network mainnet|testnet|sandbox [--dry-run]
  --confirm-mainnet   required for a mainnet run that sends transactions
  --deployer ID       pays the funding (defaults as in deploy.mjs; required on testnet)
  --registry ID       parent of the rob account (defaults as in deploy.mjs)
  --account ID        default rob.<registry>
  --funding NEAR      default 0.2 on mainnet, 1 on testnet, 5 on a sandbox
  --token ID          also write NEXT_PUBLIC_ROB_COMPANY_ID (the page defaults to token 1)
  --env-file PATH     default web/.env.local (sandbox: <sandbox home>/web.env.local)`;

const DEFAULT_FUNDING = { mainnet: '0.2', testnet: '1', sandbox: '5' };
/** Gas for the two transactions, with room to spare. */
const GAS_MARGIN = 10n * MILLI_NEAR;

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
    throw new CliError('a mainnet run sends real transactions. Run with --dry-run first, then add --confirm-mainnet.', 2);
  }
  if (args.token !== undefined && !/^\d{1,20}$/.test(args.token)) throw new CliError('--token must be a decimal token id', 2);

  const ctx = await networkContext({
    network,
    deployer: args.deployer,
    registry: args.registry,
    rpc: args.rpc,
    credentialsDir: args['credentials-dir'],
    startSandbox: false,
  });
  const { near } = ctx;
  const robId = args.account ?? `rob.${ctx.registry}`;
  if (!robId.endsWith(`.${ctx.registry}`)) throw new CliError(`--account must be a sub-account of ${ctx.registry}`, 2);
  const funding = parseNear(args.funding ?? DEFAULT_FUNDING[network]);
  if (funding < 50n * MILLI_NEAR) throw new CliError('--funding must be at least 0.05 NEAR: each attempt prepays 300 TGas', 2);
  const envFile = args['env-file'] ?? ctx.envFile;

  heading(`Incorpr rob account: ${network}${dryRun ? ' (dry run: no transactions)' : ''}`);
  item('RPC', near.rpcUrl);
  item('registry (parent)', ctx.registry);
  item('deployer (payer)', ctx.deployer);
  item('rob account', robId);
  item('funding', formatNear(funding));
  item('key file', near.credentialPath(robId));
  item('env file', envFile);

  const registry = await near.viewAccount(ctx.registry);
  if (!registry) throw new CliError(`${ctx.registry} does not exist on ${network}. Run scripts/deploy.mjs first.`);
  const existing = await near.viewAccount(robId);

  heading('Plan');
  if (existing) {
    log(`   [done] ${robId} exists (${formatNear(BigInt(existing.amount))})`);
  } else {
    if (ctx.deployer !== ctx.registry) log(`   [todo] transfer ${formatNear(funding + GAS_MARGIN)} from ${ctx.deployer} to ${ctx.registry}`);
    log(`   [todo] ${ctx.registry} creates ${robId} with ${formatNear(funding)} and a fresh full access key`);
  }
  log(`   [todo] merge ROB_ACCOUNT_ID${args.token ? ', NEXT_PUBLIC_ROB_COMPANY_ID' : ''} and ROB_PRIVATE_KEY into ${envFile}`);

  if (dryRun) {
    if (!existing) {
      const config = await near.protocolConfig();
      const balance = await near.freeBalance(ctx.deployer, config);
      item('deployer balance', balance === null ? `${ctx.deployer} does not exist (0 NEAR)` : formatNear(balance));
      const needs = funding + GAS_MARGIN * 2n;
      if ((balance ?? 0n) < needs) item('short by', formatNear(needs - (balance ?? 0n)));
    }
    log('\nDry run: no transactions sent, no key files written, no env file changed.');
    return 0;
  }

  if (existing) {
    if (!(await near.controls(robId))) {
      throw new CliError(`${robId} exists but ${near.credentialPath(robId)} holds no full access key for it`);
    }
  } else {
    if (!(await near.controls(ctx.registry))) {
      throw new CliError(`no full access key for ${ctx.registry} in ${near.credentialPath(ctx.registry)}; it must sign the account creation`);
    }
    const config = await near.protocolConfig();
    if (ctx.deployer !== ctx.registry) {
      const balance = await near.freeBalance(ctx.deployer, config);
      if ((balance ?? 0n) < funding + GAS_MARGIN * 2n) {
        throw new CliError(`${ctx.deployer} holds ${formatNear(balance ?? 0n)}; it needs ${formatNear(funding + GAS_MARGIN * 2n)}`);
      }
      heading('Run');
      await near.send({
        signerId: ctx.deployer,
        receiverId: ctx.registry,
        actions: [actions.transfer(funding + GAS_MARGIN)],
        label: { step: 'rob-setup', purpose: `top up ${ctx.registry} to create ${robId}`, method: 'Transfer', deposit: funding + GAS_MARGIN },
      });
    } else {
      heading('Run');
    }
    const key = near.keyFileFor(robId);
    await near.send({
      signerId: ctx.registry,
      receiverId: robId,
      actions: [actions.createAccount(), actions.transfer(funding), actions.addFullAccessKey(key.getPublicKey())],
      label: {
        step: 'rob-setup',
        purpose: `create ${robId}: an account that owns nothing, for the /rob page's stranger attempts`,
        method: 'CreateAccount+Transfer+AddKey',
        deposit: funding,
      },
    });
    if (!(await near.controls(robId))) throw new CliError(`${robId} was not created with the new key; see the transaction above`);
  }

  const keyPair = near.loadKeyPair(robId);
  const env = { ROB_ACCOUNT_ID: robId, ROB_PRIVATE_KEY: keyPair.toString() };
  if (args.token) env.NEXT_PUBLIC_ROB_COMPANY_ID = args.token;
  const changed = mergeEnvFile(envFile, env);
  const account = await near.viewAccount(robId);

  heading('Done');
  item('rob account', `${robId} (${formatNear(BigInt(account.amount))})`);
  item('public key', keyPair.getPublicKey().toString());
  item('env file', `${envFile} (mode 0600)`);
  item('keys written', changed.length ? changed.join(', ') : 'none changed');
  if (network !== 'sandbox') log('   Restart the web server so it reads the new keys.');
  if (BigInt(account.amount) < ONE_NEAR / 10n) log('   warning: under 0.1 NEAR; the /rob route refuses attempts below ROB_MIN_BALANCE_NEAR (default 0.1).');
  return 0;
}

runMain(main);
