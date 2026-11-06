// The operator's function-call key, end to end on a local near-sandbox (nearcore 2.14.0, protocol 87
// unless INCORPR_SANDBOX_PROTOCOL says otherwise), deployed with the real scripts: deploy.mjs,
// rob-setup.mjs and operator-key.mjs, all with --network sandbox.
//
// It checks that every transaction the app sends as the operator still works when
// NEAR_OPERATOR_PRIVATE_KEY is the function-call key, through the same operatorCall and /api/rob
// route the app uses, and that the chain refuses everything else signed with that key.
//
// SANDBOX LIMITS: the MPC signer, intents.near and USDC are the doubles in contracts/test-doubles.
// The TEE approval for agent_swap_intent is signed by a key generated here and listed in the
// vault's tee_signers by the shareholder; it exercises the vault's verifier, not a TEE. deploy.mjs
// reads a live NEAR AI Cloud attestation and live 1Click prices, so this file needs network access.
//
// OPERATOR_KEY_E2E_SANDBOX_HOME=<dir> reuses a sandbox home where deploy.mjs and rob-setup.mjs ran.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Account, KeyPair, KeyPairSigner, actions, baseDecode, createTransaction, type KeyPairString } from 'near-api-js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as attemptPost } from '@/app/api/rob/attempt/route';
import { VaultClient, usdcCalls, type ContractCall, type SignedIntent, type SwapProposal } from '@/lib/contracts';
import { getProvider, viewFunction } from '@/lib/near';
import { sha256Hex } from '@/lib/nearAiTee';
import { randomNonce } from '@/lib/nearIntents';
import { operatorCall } from '@/lib/operator';
import { REBALANCE_GAS_TGAS, TREASURY_SYSTEM_PROMPT, buildSwapTeeRequest } from '@/lib/rebalance';
import type { AttackKind, AttemptResult } from '@/lib/rob/attacks';
import { findSandboxBinary } from './sandboxHarness';

const REPO = path.resolve(__dirname, '../..');
const binary = findSandboxBinary();
const reuseHome = process.env.OPERATOR_KEY_E2E_SANDBOX_HOME;

const OPERATOR = 'operator.registry.test.near';
const REGISTRY = 'registry.test.near';
const VAULT = `c-1.${REGISTRY}`;
const USDC = 'usdc.test.near';
const CUSTOMER = 'fc-customer.test.near';
const SOL_ASSET = 'nep141:sol.omft.near';
/** What scripts/operator-key.mjs grants by default (OPERATOR_METHODS there; docs/OPERATOR_KEY.md section 1). */
const METHODS = ['record_service_call', 'setup_intents_key', 'agent_deposit_to_intents', 'agent_swap_intent', 'agent_withdraw_intent'];
const TGAS = 10n ** 12n;
const tgas = (n: number | bigint) => (BigInt(n) * TGAS).toString();

const ENV_NAMES = [
  'NEXT_PUBLIC_NEAR_NETWORK',
  'NEXT_PUBLIC_NEAR_RPC_URL',
  'NEXT_PUBLIC_REGISTRY_CONTRACT_ID',
  'NEXT_PUBLIC_MPC_CONTRACT_ID',
  'NEXT_PUBLIC_USDC_CONTRACT_ID',
  'NEXT_PUBLIC_INTENTS_CONTRACT_ID',
  'NEXT_PUBLIC_ROB_COMPANY_ID',
  'NEAR_OPERATOR_ACCOUNT_ID',
  'NEAR_OPERATOR_PRIVATE_KEY',
  'ROB_ACCOUNT_ID',
  'ROB_PRIVATE_KEY',
  'ROB_OWNER_ACCOUNT_ID',
  'ROB_OWNER_PRIVATE_KEY',
  'ROB_EVIDENCE_FILE',
  'ROB_MIN_BALANCE_NEAR',
  'NEAR_AI_API_KEY',
];
const savedEnv: Record<string, string | undefined> = {};

let home = '';
let startedHere = false;
let keyScriptOutput = '';

interface FcPermission {
  FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] };
}
interface AccessKeyView {
  nonce: number;
  permission: 'FullAccess' | FcPermission;
}
interface TxOutcome {
  status: { SuccessValue?: string; Failure?: unknown };
  transaction: { signer_id: string; receiver_id: string; public_key: string };
  transaction_outcome: { outcome: { tokens_burnt: string } };
  receipts_outcome: { outcome: { tokens_burnt: string } }[];
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

function script(args: string[]): string {
  const run = spawnSync('node', args, { cwd: REPO, env: { ...process.env, INCORPR_SANDBOX_HOME: home }, encoding: 'utf8', timeout: 600_000 });
  const output = `${run.stdout}${run.stderr}`;
  if (run.status !== 0) throw new Error(`node ${args.join(' ')} exited ${run.status}:\n${output.slice(-3000)}`);
  return output;
}

/** Like script(), but returns the exit status instead of throwing. */
function scriptStatus(args: string[]): { status: number | null; output: string } {
  const run = spawnSync('node', args, { cwd: REPO, env: { ...process.env, INCORPR_SANDBOX_HOME: home }, encoding: 'utf8', timeout: 600_000 });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) values[match[1] as string] = (match[2] as string).trim();
  }
  return values;
}

function loadEnv(): void {
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, readEnvFile(path.join(home, 'web.env.local')));
  process.env.ROB_EVIDENCE_FILE = path.join(home, 'evidence', 'sandbox.json');
  process.env.NEXT_PUBLIC_ROB_COMPANY_ID = '1';
}

const credentials = (name: string) => path.join(home, 'credentials', name);
const keyFile = (name: string) => JSON.parse(readFileSync(credentials(name), 'utf8')) as { public_key: string; private_key: KeyPairString };
const fcKey = () => keyFile(`${OPERATOR}.fc.json`);
const fullKey = () => keyFile(`${OPERATOR}.json`);
const envPublicKey = () => KeyPair.fromString(process.env.NEAR_OPERATOR_PRIVATE_KEY as KeyPairString).getPublicKey().toString();

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(process.env.NEXT_PUBLIC_NEAR_RPC_URL as string, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result as T;
}

async function accessKey(publicKey: string): Promise<AccessKeyView | null> {
  const view = await rpc<AccessKeyView & { error?: string }>('query', {
    request_type: 'view_access_key',
    finality: 'optimistic',
    account_id: OPERATOR,
    public_key: publicKey,
  });
  return typeof view.error === 'string' ? null : view;
}

async function allowanceOf(publicKey: string): Promise<bigint> {
  const view = await accessKey(publicKey);
  if (!view || view.permission === 'FullAccess') throw new Error(`${publicKey} is not a function-call key`);
  return BigInt(view.permission.FunctionCall.allowance as string);
}

const txStatus = (txHash: string, signer = OPERATOR) =>
  getProvider().viewTransactionStatus({ txHash, accountId: signer, waitUntil: 'FINAL' }) as unknown as Promise<TxOutcome>;

const burnt = (o: TxOutcome) => o.receipts_outcome.reduce((n, r) => n + BigInt(r.outcome.tokens_burnt), BigInt(o.transaction_outcome.outcome.tokens_burnt));

/** Signs with `privateKey` and submits; returns the node's refusal as JSON text, or throws if it was accepted. */
async function refusal(privateKey: KeyPairString, receiverId: string, txActions: ReturnType<typeof actions.transfer>[]): Promise<string> {
  const keyPair = KeyPair.fromString(privateKey);
  const view = await accessKey(keyPair.getPublicKey().toString());
  if (!view) throw new Error('key not on chain');
  const block = await rpc<{ header: { hash: string } }>('block', { finality: 'final' });
  const tx = createTransaction(OPERATOR, keyPair.getPublicKey(), receiverId, BigInt(view.nonce) + 1n, txActions, baseDecode(block.header.hash));
  const { signedTransaction } = await new KeyPairSigner(keyPair).signTransaction(tx);
  try {
    await rpc('send_tx', { signed_tx_base64: Buffer.from(signedTransaction.encode()).toString('base64'), wait_until: 'INCLUDED' });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`the chain accepted a transaction to ${receiverId} that it should have refused`);
}

function asTestNear(): Account {
  return new Account('test.near', getProvider(), keyFile('test.near.json').private_key);
}

async function sendAs(account: Account, call: ContractCall) {
  return account.signAndSendTransaction({
    receiverId: call.contractId,
    actions: [actions.functionCall(call.methodName, call.args, BigInt(call.gas), BigInt(call.deposit))],
    waitUntil: 'FINAL',
  });
}

/** operatorCall, then the transaction read back by hash: it must be signed by the key in NEAR_OPERATOR_PRIVATE_KEY. */
async function asOperator<T>(call: ContractCall) {
  const result = await operatorCall<T>(call);
  const outcome = await txStatus(result.txHash);
  expect(outcome.transaction.signer_id).toBe(OPERATOR);
  expect(outcome.transaction.public_key).toBe(envPublicKey());
  expect(outcome.transaction.receiver_id).toBe(VAULT);
  return { ...result, outcome };
}

describe.runIf(binary)('operator function-call key on a sandbox', () => {
  beforeAll(async () => {
    for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
    if (reuseHome) {
      home = reuseHome;
    } else {
      home = mkdtempSync(path.join(os.tmpdir(), 'incorpr-opkey-e2e-'));
      const port = await freePort();
      script(['scripts/lib/sandbox.mjs', 'start', '--fresh', '--port', String(port)]);
      startedHere = true;
      script(['scripts/deploy.mjs', '--network', 'sandbox', '--companies', '1']);
      script(['scripts/rob-setup.mjs', '--network', 'sandbox']);
    }
    keyScriptOutput = script(['scripts/operator-key.mjs', '--network', 'sandbox']);
    loadEnv();
  }, 900_000);

  afterAll(() => {
    if (startedHere) script(['scripts/lib/sandbox.mjs', 'stop', '--reset']);
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  }, 60_000);

  it('the script added a function-call key for one vault and the operator methods, and the app env uses it', async () => {
    expect(envPublicKey()).toBe(fcKey().public_key);
    const view = await accessKey(fcKey().public_key);
    expect(view).not.toBeNull();
    const permission = (view as AccessKeyView).permission as FcPermission;
    expect(permission.FunctionCall.receiver_id).toBe(VAULT);
    expect([...permission.FunctionCall.method_names].sort()).toEqual([...METHODS].sort());
    expect(BigInt(permission.FunctionCall.allowance as string)).toBeGreaterThan(0n);
    expect(BigInt(permission.FunctionCall.allowance as string)).toBeLessThanOrEqual(250_000_000_000_000_000_000_000n);
    // The full access key is still on the account and its file is unchanged.
    expect((await accessKey(fullKey().public_key))?.permission).toBe('FullAccess');
    for (const refused of ['RequiresFullAccess', 'ReceiverMismatch', 'DepositWithFunctionCall', 'MethodNameMismatch']) {
      expect(keyScriptOutput).toContain(refused);
    }
  });

  it('record_service_call: a paid call is marked served by the function-call key', async () => {
    const testNear = asTestNear();
    if (!(await getProvider().viewAccount({ accountId: CUSTOMER, blockQuery: { finality: 'optimistic' } }).catch(() => null))) {
      await testNear.createAccount({ newAccountId: CUSTOMER, publicKey: KeyPair.fromString(keyFile('test.near.json').private_key).getPublicKey(), nearToTransfer: 5n * 10n ** 24n });
      await sendAs(testNear, { contractId: USDC, methodName: 'storage_deposit', args: { account_id: CUSTOMER }, gas: tgas(30), deposit: '1250000000000000000000' });
    }
    const customer = new Account(CUSTOMER, getProvider(), keyFile('test.near.json').private_key);
    await sendAs(customer, { contractId: USDC, methodName: 'mint', args: { account_id: CUSTOMER, amount: '2000000' }, gas: tgas(30), deposit: '0' });
    const callId = `fc-${Date.now()}`;
    await sendAs(customer, usdcCalls.payForService(USDC, VAULT, '2000000', callId));
    const vault = new VaultClient(VAULT, { finality: 'optimistic' });
    expect((await vault.getPayment(callId))?.served).toBe(false);

    // The same call /api/run-service makes after inference.
    await asOperator(vault.recordServiceCall(callId, 'sandbox-chat'));
    expect(await vault.getPayment(callId)).toMatchObject({ served: true, tee_chat_id: 'sandbox-chat' });
  });

  it('setup_intents_key and agent_deposit_to_intents, with the gas the rebalance route sends', async () => {
    const vault = new VaultClient(VAULT, { finality: 'optimistic' });
    await asOperator({ ...vault.setupIntentsKey(), gas: tgas(REBALANCE_GAS_TGAS.setupIntentsKey) });
    const state = await vault.getState();
    expect(state.intents_key_registered).toBe(true);
    // deploy.mjs does not register the intents double on Test USDC; without it the transfer is refunded.
    const intents = state.intents_contract;
    const registered = await viewFunction<unknown>(USDC, 'storage_balance_of', { account_id: intents }, { finality: 'optimistic' });
    if (!registered) {
      await sendAs(asTestNear(), { contractId: USDC, methodName: 'storage_deposit', args: { account_id: intents }, gas: tgas(30), deposit: '1250000000000000000000' });
    }
    const before = BigInt(state.deposited_to_intents);
    await asOperator({ ...vault.agentDepositToIntents('500000'), gas: tgas(REBALANCE_GAS_TGAS.deposit) });
    expect(BigInt((await vault.getState()).deposited_to_intents)).toBe(before + 500_000n);
  });

  it('/api/rob/attempt: the operator attempts are signed by the function-call key and refused by the vault, not the key', async () => {
    const res = await attemptPost(
      new Request('http://localhost/api/rob/attempt', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': `10.77.${Date.now() % 250}.1` },
        body: JSON.stringify({ kinds: ['stranger_sign', 'agent_withdraw', 'agent_dump', 'forged_approval'] satisfies AttackKind[] }),
      }),
    );
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: AttemptResult[] };
    const expected: Record<string, string> = {
      stranger_sign: 'ERR_ONLY_CURRENT_SHAREHOLDER',
      agent_withdraw: 'ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION',
      agent_dump: 'ERR_FIREWALL_PRICE_BELOW_FLOOR',
      forged_approval: 'ERR_TEE_SIGNATURE_UNTRUSTED',
    };
    for (const r of results) {
      expect(r.status, `${r.kind}: ${r.sentence}`).toBe('rejected');
      expect(r.errorCode).toBe(expected[r.kind]);
      const outcome = await txStatus(r.txHash as string, r.signer as string);
      expect(JSON.stringify(outcome.status.Failure)).toContain(expected[r.kind]);
      if (r.kind !== 'stranger_sign') expect(outcome.transaction.public_key).toBe(fcKey().public_key);
    }
  });

  it('agent_swap_intent: the vault signs a swap intent for the function-call key once the approval verifies', async () => {
    const vault = new VaultClient(VAULT, { finality: 'optimistic' });
    let state = await vault.getState();
    const tee = privateKeyToAccount(generatePrivateKey());
    // The shareholder (test.near on this sandbox) lists a signer generated here. Free state only.
    await sendAs(asTestNear(), vault.setTeeSigners([...state.policy.tee_signers, tee.address.toLowerCase()]));
    state = await vault.getState();
    const usdcAsset = `nep141:${USDC}`;
    const floor = state.policy.price_floors.find((f) => f.sell_token === usdcAsset && f.buy_token === SOL_ASSET);
    expect(floor).toBeDefined();
    const sell = 100_000n;
    const minBuy = (sell * BigInt(floor!.min_buy) + BigInt(floor!.per_sell) - 1n) / BigInt(floor!.per_sell);
    const proposal: SwapProposal = { sell_token: usdcAsset, sell_amount: sell.toString(), buy_token: SOL_ASSET, min_buy_amount: minBuy.toString(), nonce_b64: randomNonce() };
    const model = state.policy.tee_models[0] as string;
    const request = buildSwapTeeRequest(
      { vaultAccount: VAULT, treasuryEpoch: state.treasury_epoch, ownerGeneration: state.owner_generation },
      proposal,
      model,
      TREASURY_SYSTEM_PROMPT,
    );
    expect(request).toEqual(await vault.swapTeeRequest(proposal, model, TREASURY_SYSTEM_PROMPT));
    const responseBody = JSON.stringify({ id: 'sandbox', created: Math.floor(Date.now() / 1000), choices: [{ message: { content: `APPROVE ${request.proposal_hash}` } }] });
    const text = `${model}:${sha256Hex(request.body)}:${sha256Hex(responseBody)}`;
    const signature = await tee.signMessage({ message: text });
    const { value } = await asOperator<SignedIntent>({
      ...vault.agentSwapIntent(proposal, { text, signature_hex: signature.slice(2), response_body: responseBody, system_prompt: TREASURY_SYSTEM_PROMPT }),
      gas: tgas(REBALANCE_GAS_TGAS.swap),
    });
    expect(value?.standard).toBe('nep413');
    expect(value?.public_key).toBe(state.intents_key);
  });

  it('the chain refuses a NEAR transfer, AddKey, DeleteKey, another contract, a deposit and an unlisted method', async () => {
    const key = process.env.NEAR_OPERATOR_PRIVATE_KEY as KeyPairString;
    const call = (method: string, args: object, deposit = 0n) => actions.functionCall(method, args, 30n * TGAS, deposit);
    expect(await refusal(key, 'rob.registry.test.near', [actions.transfer(10n ** 23n)])).toContain('RequiresFullAccess');
    expect(await refusal(key, OPERATOR, [actions.addFullAccessKey(KeyPair.fromRandom('ed25519').getPublicKey())])).toContain('RequiresFullAccess');
    expect(await refusal(key, OPERATOR, [actions.deleteKey(KeyPair.fromString(fullKey().private_key).getPublicKey())])).toContain('RequiresFullAccess');
    expect(await refusal(key, OPERATOR, [actions.deleteAccount('rob.registry.test.near')])).toContain('RequiresFullAccess');
    // Two calls in one transaction: a function-call key signs exactly one FunctionCall action.
    expect(await refusal(key, VAULT, [call('setup_intents_key', {}), call('setup_intents_key', {})])).toContain('RequiresFullAccess');
    expect(await refusal(key, REGISTRY, [call('nft_token', { token_id: '1' })])).toContain('ReceiverMismatch');
    // NEP-141 transfers need 1 yocto, so taking the operator's USDC is refused before the receiver is checked.
    expect(await refusal(key, USDC, [call('ft_transfer', { receiver_id: 'rob.registry.test.near', amount: '1' }, 1n)])).toContain('DepositWithFunctionCall');
    expect(await refusal(key, VAULT, [call('record_service_call', { call_id: 'x', tee_chat_id: 'x' }, 1n)])).toContain('DepositWithFunctionCall');
    expect(await refusal(key, VAULT, [call('pay_compute_bill', { amount: '1' })])).toContain('MethodNameMismatch');
    expect(await refusal(key, VAULT, [call('refresh_metrics', {})])).toContain('MethodNameMismatch');
  });

  it('allowance: only burnt gas is deducted, and a call is refused when the allowance cannot cover its prepaid gas', async () => {
    const vault = new VaultClient(VAULT, { finality: 'optimistic' });
    const publicKey = fcKey().public_key;
    const before = await allowanceOf(publicKey);
    const { outcome } = await asOperator({ ...vault.setupIntentsKey(), gas: tgas(80) });
    const after = await allowanceOf(publicKey);
    expect(before - after).toBe(burnt(outcome));
    expect(before - after).toBeLessThan(80n * TGAS * 100_000_000n);

    // Up front the key must cover prepaid gas at 10x the gas price. Ask for 5 TGas more than it covers.
    const price = BigInt((await rpc<{ gas_price: string }>('gas_price', [null])).gas_price);
    const covered = after / (price * 10n) / TGAS;
    const balance = BigInt((await getProvider().viewAccount({ accountId: OPERATOR, blockQuery: { finality: 'optimistic' } })).amount);
    expect(balance, 'the account balance must exceed the allowance so the allowance check is the one that fails').toBeGreaterThan(after + 10n * TGAS * price * 10n);
    // Sent with wait_until INCLUDED so the refusal is returned. operatorCall sends with NONE, where
    // the RPC answers {"final_execution_status":"NONE"} for this transaction too (docs/OPERATOR_KEY.md section 5).
    const refused = await refusal(process.env.NEAR_OPERATOR_PRIVATE_KEY as KeyPairString, VAULT, [
      actions.functionCall('setup_intents_key', {}, (covered + 5n) * TGAS, 0n),
    ]);
    expect(refused).toContain('NotEnoughAllowance');
    // A call it can cover still goes through.
    expect(covered).toBeGreaterThan(BigInt(REBALANCE_GAS_TGAS.deposit));
    await asOperator({ ...vault.setupIntentsKey(), gas: tgas(covered - 5n) });
    expect(await allowanceOf(publicKey)).toBeLessThan(after);
  });

  it('--replace tops the key up: a new key, the old one deleted in the same transaction, the old file kept', async () => {
    const previous = fcKey();
    const out = script(['scripts/operator-key.mjs', '--network', 'sandbox', '--replace', '--allowance', '0.2', '--no-probe']);
    expect(out).toContain('AddKey(FunctionCall)+DeleteKey');
    loadEnv();
    const current = fcKey();
    expect(current.public_key).not.toBe(previous.public_key);
    expect(envPublicKey()).toBe(current.public_key);
    expect(await accessKey(previous.public_key)).toBeNull();
    expect(await allowanceOf(current.public_key)).toBe(200_000_000_000_000_000_000_000n);
    expect((await accessKey(fullKey().public_key))?.permission).toBe('FullAccess');
    const retired = readdirSync(path.join(home, 'credentials')).filter((f) => f.startsWith(`${OPERATOR}.fc.retired-`));
    const kept = retired.map((f) => JSON.parse(readFileSync(credentials(f), 'utf8')).public_key as string);
    expect(kept).toContain(previous.public_key);
    expect(existsSync(credentials(`${OPERATOR}.json`))).toBe(true);

    // The app keeps working with the new key.
    await asOperator({ ...new VaultClient(VAULT).setupIntentsKey(), gas: tgas(REBALANCE_GAS_TGAS.setupIntentsKey) });
  });

  it('--replace that stops before its transaction leaves the key files matching the chain, and a rerun still deletes the old key', async () => {
    const envFile = path.join(home, 'web.env.local');
    const original = readFileSync(envFile, 'utf8');
    const previous = fcKey();
    // An env file holding some other operator key makes the run stop at its env check, after it has
    // generated the new key but before any transaction.
    const stranger = KeyPair.fromRandom('ed25519').toString();
    writeFileSync(envFile, original.replace(/^NEAR_OPERATOR_PRIVATE_KEY=.*$/m, `NEAR_OPERATOR_PRIVATE_KEY=${stranger}`), { mode: 0o600 });
    try {
      const stopped = scriptStatus(['scripts/operator-key.mjs', '--network', 'sandbox', '--replace', '--allowance', '0.2', '--no-probe']);
      expect(stopped.status, stopped.output).not.toBe(0);
      expect(stopped.output).toContain('--force-env');
      // Nothing was renamed, the chain still has the previous key, and the new one waits in the pending file.
      expect(fcKey().public_key).toBe(previous.public_key);
      expect((await accessKey(previous.public_key))?.permission).toMatchObject({ FunctionCall: { receiver_id: VAULT } });
      expect(existsSync(credentials(`${OPERATOR}.fc.pending.json`))).toBe(true);
    } finally {
      writeFileSync(envFile, original, { mode: 0o600 });
    }

    // The rerun finds fc.json naming the key on chain, so it deletes it in the same transaction.
    const out = script(['scripts/operator-key.mjs', '--network', 'sandbox', '--replace', '--allowance', '0.2', '--no-probe']);
    expect(out).toContain('AddKey(FunctionCall)+DeleteKey');
    expect(out).toContain('unused pending key file');
    loadEnv();
    const current = fcKey();
    expect(current.public_key).not.toBe(previous.public_key);
    expect(envPublicKey()).toBe(current.public_key);
    expect(await accessKey(previous.public_key)).toBeNull();
    expect(existsSync(credentials(`${OPERATOR}.fc.pending.json`))).toBe(false);
    const fcKeysOnChain = await Promise.all(
      readdirSync(path.join(home, 'credentials'))
        .filter((f) => f.startsWith(`${OPERATOR}.fc.`))
        .map(async (f) => ({ f, onChain: (await accessKey(JSON.parse(readFileSync(credentials(f), 'utf8')).public_key as string)) !== null })),
    );
    // Of every function-call key file this test produced, only the current one is still on chain.
    expect(fcKeysOnChain.filter((k) => k.onChain).map((k) => k.f)).toEqual([`${OPERATOR}.fc.json`]);
    await asOperator({ ...new VaultClient(VAULT).setupIntentsKey(), gas: tgas(REBALANCE_GAS_TGAS.setupIntentsKey) });
  });
});
