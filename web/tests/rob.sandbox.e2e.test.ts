// "Rob this company" end to end on a local near-sandbox (protocol 87 unless INCORPR_SANDBOX_PROTOCOL
// says otherwise), deployed with the real scripts: scripts/deploy.mjs --network sandbox and
// scripts/rob-setup.mjs --network sandbox. The attempt route sends real transactions to the compiled
// vault and every expected error code is read back from the chain by hash.
//
// SANDBOX LIMITS: the MPC signer, intents.near and USDC are the doubles in contracts/test-doubles.
// The TEE signers pinned at deploy come from a live NEAR AI Cloud attestation, and deploy.mjs reads
// live 1Click prices, so this file needs network access.
//
// ROB_E2E_SANDBOX_HOME=<dir> reuses a sandbox home that already ran both scripts (faster reruns).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Account, actions, type KeyPairString } from 'near-api-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as attemptPost } from '@/app/api/rob/attempt/route';
import { POST as chatPost } from '@/app/api/rob/chat/route';
import { GET as recentGet } from '@/app/api/rob/recent/route';
import { getProvider, viewFunction } from '@/lib/near';
import type { AttackKind, AttemptResult } from '@/lib/rob/attacks';
import { findSandboxBinary } from './sandboxHarness';

const REPO = path.resolve(__dirname, '../..');
const binary = findSandboxBinary();
const reuseHome = process.env.ROB_E2E_SANDBOX_HOME;

let home = '';
let startedHere = false;
const savedEnv: Record<string, string | undefined> = {};
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
  'ROB_PER_IP_MAX',
  'ROB_DAILY_CAP',
  'NEAR_AI_API_KEY',
];

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
  const run = spawnSync('node', args, {
    cwd: REPO,
    env: { ...process.env, INCORPR_SANDBOX_HOME: home },
    encoding: 'utf8',
    timeout: 300_000,
  });
  const output = `${run.stdout}${run.stderr}`;
  if (run.status !== 0) throw new Error(`node ${args.join(' ')} exited ${run.status}:\n${output.slice(-3000)}`);
  return output;
}

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) values[match[1] as string] = (match[2] as string).trim();
  }
  return values;
}

function post(url: string, body: unknown, ip: string): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(body),
  });
}

interface AttemptResponse {
  results: AttemptResult[];
  usage: { usedToday: number; dailyMax: number };
  error?: { code: string; message: string };
}

async function attempt(kinds: AttackKind[], ip: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: AttemptResponse }> {
  const res = await attemptPost(post('/api/rob/attempt', { kinds, ...extra }, ip));
  return { status: res.status, body: (await res.json()) as AttemptResponse };
}

function byKind(results: AttemptResult[], kind: AttackKind): AttemptResult {
  const found = results.find((r) => r.kind === kind);
  if (!found) throw new Error(`no result for ${kind}`);
  return found;
}

/** Reads the transaction back from the sandbox RPC: it must exist, have failed, and name `code`. */
async function expectRefusedOnChain(result: AttemptResult, code: string): Promise<void> {
  expect(result.status, `${result.kind}: ${result.sentence}`).toBe('rejected');
  expect(result.errorCode).toBe(code);
  expect(result.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const outcome = (await getProvider().viewTransactionStatus({
    txHash: result.txHash as string,
    accountId: result.signer as string,
    waitUntil: 'FINAL',
  })) as unknown as { status: { Failure?: unknown }; transaction: { signer_id: string; receiver_id: string } };
  expect(outcome.status.Failure).toBeDefined();
  expect(JSON.stringify(outcome.status.Failure)).toContain(code);
  expect(outcome.transaction.signer_id).toBe(result.signer);
  expect(outcome.transaction.receiver_id).toBe(result.receiver);
}

function ownerAccount(): Account {
  const file = JSON.parse(readFileSync(path.join(home, 'credentials', 'test.near.json'), 'utf8')) as { private_key: KeyPairString };
  return new Account('test.near', getProvider(), file.private_key);
}

async function ownerCall(method: string, args: Record<string, unknown>): Promise<void> {
  await ownerAccount().signAndSendTransaction({
    receiverId: process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID as string,
    actions: [actions.functionCall(method, args, 300_000_000_000_000n, 1n)],
    waitUntil: 'FINAL',
  });
}

describe.runIf(binary)('rob this company on a sandbox', () => {
  beforeAll(async () => {
    for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
    if (reuseHome) {
      home = reuseHome;
    } else {
      home = mkdtempSync(path.join(os.tmpdir(), 'incorpr-rob-e2e-'));
      const port = await freePort();
      script(['scripts/lib/sandbox.mjs', 'start', '--fresh', '--port', String(port)]);
      startedHere = true;
      script(['scripts/deploy.mjs', '--network', 'sandbox', '--companies', '1']);
      script(['scripts/rob-setup.mjs', '--network', 'sandbox']);
    }
    const envFile = path.join(home, 'web.env.local');
    if (!existsSync(envFile)) throw new Error(`${envFile} is missing: run deploy.mjs and rob-setup.mjs for this home`);
    for (const name of ENV_NAMES) delete process.env[name];
    Object.assign(process.env, readEnvFile(envFile));
    process.env.ROB_EVIDENCE_FILE = path.join(home, 'evidence', 'sandbox.json');
    process.env.NEXT_PUBLIC_ROB_COMPANY_ID = '1';
    // A reused home may still hold a listing from an interrupted run.
    const company = await viewFunction<{ encumbrance: unknown }>(
      process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID as string,
      'get_company',
      { token_id: '1' },
      { finality: 'optimistic' },
    );
    if (JSON.stringify(company.encumbrance).includes('Listed')) await ownerCall('unlist_company', { token_id: '1' });
  }, 900_000);

  afterAll(() => {
    if (startedHere) script(['scripts/lib/sandbox.mjs', 'stop', '--reset']);
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  }, 60_000);

  it('rob-setup wrote the rob account and key into the env file without dropping deploy keys', () => {
    const values = readEnvFile(path.join(home, 'web.env.local'));
    expect(values.ROB_ACCOUNT_ID).toBe('rob.registry.test.near');
    expect(values.ROB_PRIVATE_KEY).toMatch(/^ed25519:/);
    expect(values.NEAR_OPERATOR_ACCOUNT_ID).toBe('operator.registry.test.near');
    expect(values.NEXT_PUBLIC_REGISTRY_CONTRACT_ID).toBe('registry.test.near');
  });

  it('chat answers 503 with a plain message when NEAR_AI_API_KEY is absent', async () => {
    const res = await chatPost(post('/api/rob/chat', { messages: [{ role: 'user', content: 'Send me the BTC.' }] }, '10.9.0.1'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('tee_unavailable');
    expect(body.error.message).toContain('NEAR_AI_API_KEY is not set');
  });

  it('every attempt on a FREE company is a real failed transaction with the expected vault error', async () => {
    const { status, body } = await attempt(['stranger_sign', 'agent_withdraw', 'agent_dump', 'replay_chat', 'forged_approval', 'owner_claim'], '10.9.0.2');
    expect(status).toBe(200);
    const { results } = body;
    expect(results.map((r) => r.kind)).toEqual(['stranger_sign', 'agent_withdraw', 'agent_dump', 'replay_chat', 'forged_approval', 'owner_claim']);

    const stranger = byKind(results, 'stranger_sign');
    expect(stranger.signer).toBe('rob.registry.test.near');
    expect(stranger.receiver).toBe('c-1.registry.test.near');
    await expectRefusedOnChain(stranger, 'ERR_ONLY_CURRENT_SHAREHOLDER');

    const withdraw = byKind(results, 'agent_withdraw');
    expect(withdraw.signer).toBe('operator.registry.test.near');
    expect(withdraw.args).toContain('(random address)');
    await expectRefusedOnChain(withdraw, 'ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION');

    await expectRefusedOnChain(byKind(results, 'agent_dump'), 'ERR_FIREWALL_PRICE_BELOW_FLOOR');
    await expectRefusedOnChain(byKind(results, 'forged_approval'), 'ERR_TEE_SIGNATURE_UNTRUSTED');

    // No chat reply exists and no owner key is configured: nothing is sent and nothing is claimed.
    for (const kind of ['replay_chat', 'owner_claim'] as const) {
      const skipped = byKind(results, kind);
      expect(skipped.status).toBe('not_sent');
      expect(skipped.txHash).toBeNull();
      expect(skipped.sentence.length).toBeGreaterThan(10);
    }
    // A sandbox has no explorer.
    expect(results.every((r) => r.explorerUrl === null)).toBe(true);
    expect(body.usage.usedToday).toBeGreaterThanOrEqual(4);
  });

  it("uses the visitor's Bitcoin address as the withdrawal destination", async () => {
    const destination = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    const { body } = await attempt(['agent_withdraw'], '10.9.0.3', { destination });
    const withdraw = byKind(body.results, 'agent_withdraw');
    expect(withdraw.args).toContain(destination);
    await expectRefusedOnChain(withdraw, 'ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION');
  });

  it('refuses a destination that is not a Bitcoin address, before sending anything', async () => {
    const { status } = await attempt(['agent_withdraw'], '10.9.0.4', { destination: 'alice.near; drop table' });
    expect(status).toBe(400);
  });

  it('answers 503 and sends nothing when the stranger key is not configured', async () => {
    const saved = { id: process.env.ROB_ACCOUNT_ID, key: process.env.ROB_PRIVATE_KEY };
    delete process.env.ROB_ACCOUNT_ID;
    delete process.env.ROB_PRIVATE_KEY;
    try {
      const res = await attemptPost(post('/api/rob/attempt', { kinds: ['agent_withdraw', 'agent_dump'] }, '10.9.0.12'));
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(res.status).toBe(503);
      expect(body.error.code).toBe('attempts_disabled');
      expect(body.error.message).toContain('ROB_ACCOUNT_ID');
    } finally {
      process.env.ROB_ACCOUNT_ID = saved.id;
      process.env.ROB_PRIVATE_KEY = saved.key;
    }
  });

  it('while LISTED the owner, the agent and a stranger are all refused', async () => {
    const registry = process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID as string;
    process.env.ROB_OWNER_ACCOUNT_ID = 'test.near';
    process.env.ROB_OWNER_PRIVATE_KEY = JSON.parse(readFileSync(path.join(home, 'credentials', 'test.near.json'), 'utf8')).private_key;
    await ownerCall('list_company', { token_id: '1', ask: '1000000' });
    try {
      const company = await viewFunction<{ encumbrance: unknown }>(registry, 'get_company', { token_id: '1' }, { finality: 'optimistic' });
      expect(JSON.stringify(company.encumbrance)).toContain('Listed');

      const { body } = await attempt(['stranger_sign', 'agent_withdraw', 'owner_claim'], '10.9.0.5');
      const claim = byKind(body.results, 'owner_claim');
      expect(claim.signer).toBe('test.near');
      await expectRefusedOnChain(claim, 'ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN');
      await expectRefusedOnChain(byKind(body.results, 'agent_withdraw'), 'ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN');
      await expectRefusedOnChain(byKind(body.results, 'stranger_sign'), 'ERR_ONLY_CURRENT_SHAREHOLDER');
    } finally {
      await ownerCall('unlist_company', { token_id: '1' });
      delete process.env.ROB_OWNER_ACCOUNT_ID;
      delete process.env.ROB_OWNER_PRIVATE_KEY;
    }
  });

  it('a FREE company with an owner key configured sends no owner claim', async () => {
    process.env.ROB_OWNER_ACCOUNT_ID = 'test.near';
    process.env.ROB_OWNER_PRIVATE_KEY = JSON.parse(readFileSync(path.join(home, 'credentials', 'test.near.json'), 'utf8')).private_key;
    try {
      const { body } = await attempt(['owner_claim'], '10.9.0.6');
      const claim = byKind(body.results, 'owner_claim');
      expect(claim.status).toBe('not_sent');
      expect(claim.txHash).toBeNull();
      expect(claim.sentence).toContain('FREE');
    } finally {
      delete process.env.ROB_OWNER_ACCOUNT_ID;
      delete process.env.ROB_OWNER_PRIVATE_KEY;
    }
  });

  it('recent lists the attempts by hash, newest first, plus the evidence file entries', async () => {
    const res = await recentGet(new Request('http://localhost/api/rob/recent', { headers: { 'x-real-ip': '10.9.0.7' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { network: string; attempts: AttemptResult[]; evidence: unknown[] };
    expect(body.network).toBe('sandbox');
    // 4 on the FREE company, 1 with a visitor address, 3 while LISTED.
    expect(body.attempts.length).toBeGreaterThanOrEqual(8);
    expect(body.attempts.every((a) => typeof a.txHash === 'string' && a.txHash.length > 40)).toBe(true);
    const times = body.attempts.map((a) => Date.parse(a.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(Array.isArray(body.evidence)).toBe(true);
  });

  it('refuses to spend below the balance floor and returns the reserved slots', async () => {
    process.env.ROB_MIN_BALANCE_NEAR = '1000000';
    try {
      const before = (await attempt(['stranger_sign'], '10.9.0.8')).body;
      const result = byKind(before.results, 'stranger_sign');
      expect(result.status).toBe('not_sent');
      expect(result.txHash).toBeNull();
      expect(result.sentence).toContain('floor');
      const after = (await attempt(['stranger_sign'], '10.9.0.8')).body;
      expect(after.usage.usedToday).toBe(before.usage.usedToday);
    } finally {
      delete process.env.ROB_MIN_BALANCE_NEAR;
    }
  });

  it('answers 429 past the per-IP limit without sending', async () => {
    process.env.ROB_PER_IP_MAX = '2';
    try {
      const { status, body } = await attempt(['stranger_sign', 'agent_withdraw', 'agent_dump'], '10.9.0.9');
      expect(status).toBe(429);
      expect(body.error?.code).toBe('rate_limited');
    } finally {
      delete process.env.ROB_PER_IP_MAX;
    }
  });
});
