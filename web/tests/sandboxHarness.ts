// Local near-sandbox node for the e2e tests, running the compiled contracts in contracts/res.
// Not a test file: imported by sandbox.e2e.test.ts and sandbox.actions.e2e.test.ts.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Account, KeyPair, actions, type KeyPairString } from 'near-api-js';
import type { TxSender } from '@/lib/actions';
import type { ContractCall } from '@/lib/contracts';
import { getProvider } from '@/lib/near';
import { parseOutcome } from '@/lib/txOutcome';

export const CONTRACTS = path.resolve(__dirname, '../../contracts');

/**
 * The nearcore release mainnet runs, and the protocol version the sandbox is pinned to. 87 matches
 * contracts/integration-tests (MAINNET_PROTOCOL in sandbox.rs) and scripts/lib/sandbox.mjs, so the
 * web suite and the contract suite test the same runtime. Mainnet itself moved from 87 to 88 on
 * 2026-11-06 (universal_accounts on). INCORPR_SANDBOX_PROTOCOL=88 runs this suite at 88 instead.
 */
export const MAINNET_NEARCORE = '2.14.0';
export const SANDBOX_PROTOCOL = Number(process.env.INCORPR_SANDBOX_PROTOCOL || 87);

/**
 * The binary `cargo test` in contracts/ downloaded, at the mainnet nearcore release. Other versions
 * may sit in the same build directory; picking by directory order would run whichever sorts first.
 */
export function findSandboxBinary(): string | null {
  const build = path.join(CONTRACTS, 'target/debug/build');
  if (!existsSync(build)) return null;
  for (const dir of readdirSync(build).filter((d) => d.startsWith('near-sandbox-'))) {
    const binary = path.join(build, dir, 'out/.near', `near-sandbox-${MAINNET_NEARCORE}`, 'near-sandbox');
    if (existsSync(binary)) return binary;
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface Sandbox {
  rpcUrl: string;
  /** The validator key. Every test account is created with it. */
  key: KeyPairString;
  stop(): void;
}

/** Starts a node, pinned to SANDBOX_PROTOCOL, and waits until it produces blocks. */
export async function startSandbox(binary: string): Promise<Sandbox> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'incorpr-sandbox-'));
  const init = spawnSync(binary, ['--home', home, 'init'], { stdio: 'pipe' });
  if (init.status !== 0) throw new Error(`near-sandbox init failed: ${init.stderr.toString().slice(-500)}`);
  // Pinned rather than left to the binary's default, so a nearcore upgrade cannot change the
  // runtime these contracts are tested under without this file changing too.
  const genesisPath = path.join(home, 'genesis.json');
  const genesis = JSON.parse(readFileSync(genesisPath, 'utf8')) as { protocol_version: number };
  genesis.protocol_version = SANDBOX_PROTOCOL;
  writeFileSync(genesisPath, JSON.stringify(genesis));

  const rpcPort = await freePort();
  const netPort = await freePort();
  const child: ChildProcess = spawn(
    binary,
    ['--home', home, 'run', '--rpc-addr', `127.0.0.1:${rpcPort}`, '--network-addr', `127.0.0.1:${netPort}`],
    { stdio: 'ignore' },
  );
  const stop = () => {
    child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  };
  const validator = JSON.parse(readFileSync(path.join(home, 'validator_key.json'), 'utf8')) as { secret_key: KeyPairString };
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const status = await getProvider(rpcUrl).viewNodeStatus();
      if (status.sync_info.latest_block_height > 1) {
        if (status.protocol_version !== SANDBOX_PROTOCOL) {
          stop();
          throw new Error(`sandbox runs protocol ${status.protocol_version}, want ${SANDBOX_PROTOCOL}`);
        }
        break;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('sandbox runs protocol')) throw error;
      if (Date.now() > deadline) {
        stop();
        throw new Error('near-sandbox did not start');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { rpcUrl, key: validator.secret_key, stop };
}

/** Accounts and transactions on a sandbox. Every account shares the validator key. */
export function chain(sandbox: Sandbox) {
  const account = (id: string) => new Account(id, getProvider(sandbox.rpcUrl), sandbox.key);
  const action = (call: ContractCall) =>
    actions.functionCall(call.methodName, call.args, BigInt(call.gas), BigInt(call.deposit));

  // FINAL, because the clients read at `final` finality by default, and on this node a block that
  // executed optimistically is about two blocks from final.
  const send = (signer: string, call: ContractCall) =>
    account(signer).signAndSendTransaction({ receiverId: call.contractId, actions: [action(call)], waitUntil: 'FINAL' });

  const raw = (contractId: string, methodName: string, args: Record<string, unknown>, deposit = '0'): ContractCall => ({
    contractId,
    methodName,
    args,
    gas: '300000000000000',
    deposit,
  });

  const createAccount = async (id: string, near: bigint, wasm?: string) => {
    await account('test.near').createAccount({
      newAccountId: id,
      publicKey: KeyPair.fromString(sandbox.key).getPublicKey(),
      nearToTransfer: near * 10n ** 24n,
    });
    if (wasm) await account(id).deployContract(readFileSync(path.join(CONTRACTS, 'res', wasm)));
  };

  /**
   * What the browser wallet does, with a local key: one transaction per call, in order, each
   * awaited to FINAL and parsed by the same `parseOutcome` the wallet path uses.
   */
  const sender = (accountId: string): TxSender => ({
    accountId,
    async send(calls) {
      const results = [];
      for (const call of calls) {
        const outcome = await account(accountId).signAndSendTransaction({
          receiverId: call.contractId,
          actions: [action(call)],
          waitUntil: 'FINAL',
          throwOnFailure: false,
        });
        results.push(parseOutcome(outcome as Parameters<typeof parseOutcome>[0]));
      }
      return results;
    },
  });

  return { account, send, raw, createAccount, sender };
}
