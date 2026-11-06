// Per-network accounts and endpoints. Mainnet values were checked by RPC on 2026-11-06.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './cli.mjs';
import { DOCS_DIR, Evidence } from './evidence.mjs';
import { Near } from './near.mjs';
import { runningSandbox, sandboxCredentialsDir, sandboxHome, SANDBOX_ROOT, startSandbox } from './sandbox.mjs';

export const MAINNET_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const MAINNET_DEPLOYER = '717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9';
export const BTC_ASSET = 'nep141:btc.omft.near';
export const SOL_ASSET = 'nep141:sol.omft.near';
export const MAINNET_USDC_ASSET = `nep141:${MAINNET_USDC}`;

const IMPLICIT = /^[0-9a-f]{64}$/;
export const isImplicit = (accountId) => IMPLICIT.test(accountId);

/**
 * @typedef {object} NetworkContext
 * @property {'mainnet'|'testnet'|'sandbox'} network
 * @property {Near} near
 * @property {Evidence} evidence
 * @property {string} deployer
 * @property {string} registry
 * @property {string} operator
 * @property {string} mpc
 * @property {string|null} intents
 * @property {string|null} usdc
 * @property {'bc'|'tb'} btcHrp
 * @property {string} btcApi Esplora base URL
 * @property {string} btcExplorer
 * @property {string} demoParent parent account for demo customer, buyer and lender
 * @property {string|null} envFile where deploy.mjs writes app settings
 */

/**
 * @param {object} o
 * @param {string} o.network
 * @param {string} [o.deployer]
 * @param {string} [o.registry]
 * @param {string} [o.rpc]
 * @param {string} [o.usdc]
 * @param {string} [o.intents]
 * @param {string} [o.credentialsDir]
 * @param {boolean} [o.startSandbox] start a sandbox node if none is running
 * @returns {Promise<NetworkContext>}
 */
export async function networkContext(o) {
  if (o.network === 'mainnet') {
    const deployer = o.deployer ?? MAINNET_DEPLOYER;
    const registry = o.registry ?? 'incorpr.near';
    const evidence = Evidence.forNetwork('mainnet', DOCS_DIR);
    const credentialsDir = o.credentialsDir ?? join(homedir(), '.near-credentials', 'mainnet');
    return {
      network: 'mainnet',
      near: new Near({ network: 'mainnet', rpcUrl: o.rpc ?? 'https://rpc.mainnet.fastnear.com', credentialsDir, explorerUrl: 'https://nearblocks.io', evidence }),
      evidence,
      deployer,
      registry,
      operator: `operator.${registry}`,
      mpc: 'v1.signer',
      intents: o.intents ?? 'intents.near',
      usdc: o.usdc ?? MAINNET_USDC,
      btcHrp: 'bc',
      btcApi: 'https://mempool.space/api',
      btcExplorer: 'https://mempool.space',
      demoParent: isImplicit(deployer) ? registry : deployer,
      envFile: join(DOCS_DIR, '..', 'web', '.env.local'),
    };
  }
  if (o.network === 'testnet') {
    if (!o.deployer) throw new CliError('--deployer <account.testnet> is required on testnet', 2);
    const registry = o.registry ?? `registry.${o.deployer}`;
    const evidence = Evidence.forNetwork('testnet', DOCS_DIR);
    const credentialsDir = o.credentialsDir ?? join(homedir(), '.near-credentials', 'testnet');
    return {
      network: 'testnet',
      near: new Near({ network: 'testnet', rpcUrl: o.rpc ?? 'https://test.rpc.fastnear.com', credentialsDir, explorerUrl: 'https://testnet.nearblocks.io', evidence }),
      evidence,
      deployer: o.deployer,
      registry,
      operator: `operator.${registry}`,
      mpc: 'v1.signer-prod.testnet',
      // intents.near has no testnet deployment. Agent intents cannot settle there in any case.
      intents: o.intents ?? null,
      // Test USDC (contracts/test-doubles/test-usdc), deployed by deploy.mjs when not given.
      usdc: o.usdc ?? `test-usdc.${o.deployer}`,
      btcHrp: 'tb',
      btcApi: 'https://mempool.space/testnet4/api',
      btcExplorer: 'https://mempool.space/testnet4',
      demoParent: isImplicit(o.deployer) ? registry : o.deployer,
      envFile: join(DOCS_DIR, '..', 'web', '.env.local'),
    };
  }
  if (o.network === 'sandbox') {
    const home = sandboxHome();
    const state = o.startSandbox ? await startSandbox({ home }) : await runningSandbox(home);
    if (!state) throw new CliError(`no sandbox running at ${home}. Start one: node scripts/lib/sandbox.mjs start`);
    const root = SANDBOX_ROOT;
    // Sandbox evidence stays in the sandbox home: its hashes exist only on this machine.
    const evidence = Evidence.forNetwork('sandbox', home);
    return {
      network: 'sandbox',
      near: new Near({ network: 'sandbox', rpcUrl: state.rpc_url, credentialsDir: sandboxCredentialsDir(home), explorerUrl: null, evidence }),
      evidence,
      deployer: root,
      registry: `registry.${root}`,
      operator: `operator.registry.${root}`,
      // SANDBOX ONLY doubles from contracts/test-doubles, deployed by deploy.mjs.
      mpc: `mpc.${root}`,
      intents: `intents.${root}`,
      usdc: `usdc.${root}`,
      btcHrp: 'tb',
      btcApi: 'https://mempool.space/testnet4/api',
      btcExplorer: 'https://mempool.space/testnet4',
      demoParent: root,
      envFile: join(home, 'web.env.local'),
      sandbox: state,
    };
  }
  throw new CliError('--network must be mainnet, testnet or sandbox', 2);
}

/** nep141 asset id for the network's USDC. Off mainnet, Test USDC is priced as USDC. */
export function usdcAsset(ctx) {
  return `nep141:${ctx.usdc}`;
}
