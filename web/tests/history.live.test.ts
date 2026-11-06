// Live: reads token 1's history from mainnet through both sources and checks it against
// docs/evidence/mainnet.json and the vault's own get_state. Read-only; sends no transaction.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as historyGet } from '@/app/api/history/route';
import { MAINNET_USDC } from '@/lib/near';
import { buildHistory, clearHistoryCaches, historyEndpoints, loadHistory, readTransactions, type HistoryReady, type SourceRead } from '@/lib/history';

const REGISTRY = 'incorpr.near';
const VAULT = 'c-1.incorpr.near';
const MAINNET = historyEndpoints('mainnet');

interface EvidenceTx {
  seq: number;
  method: string;
  receiver: string;
  tx_hash: string;
  status: string;
  error?: string | null;
}

const evidence = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/evidence/mainnet.json'), 'utf8')) as { transactions: EvidenceTx[] };
/** Evidence rows that reached the vault or the registry for token 1 (demo accounts and wNEAR setup excluded). */
const TOKEN1_ROWS = evidence.transactions.filter((t) => t.seq >= 5 && (t.receiver === VAULT || t.receiver === REGISTRY || t.method === 'ft_transfer_call') && t.method !== 'storage_deposit' && t.method !== 'Transfer' && t.method !== 'DeployContract');
const REFUSED_ROWS = evidence.transactions.filter((t) => t.status === 'failure');

const ENV = ['NEXT_PUBLIC_NEAR_NETWORK', 'NEXT_PUBLIC_REGISTRY_CONTRACT_ID', 'NEXT_PUBLIC_NEAR_RPC_URL'] as const;
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

beforeAll(() => {
  for (const key of ENV) saved[key] = process.env[key];
  process.env.NEXT_PUBLIC_NEAR_NETWORK = 'mainnet';
  process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID = REGISTRY;
  delete process.env.NEXT_PUBLIC_NEAR_RPC_URL;
});

afterAll(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function checkAgainstEvidence(read: SourceRead) {
  const hashes = new Set(read.txs.map((t) => t.hash));
  const missing = TOKEN1_ROWS.filter((row) => !hashes.has(row.tx_hash)).map((row) => `${row.seq} ${row.method}`);
  expect(missing).toEqual([]);
  const built = buildHistory({ tokenId: '1', registryId: REGISTRY, vaultId: VAULT, intentsContract: 'intents.near', computeReserveBps: 2000, usdcToken: MAINNET_USDC, txs: read.txs });
  const refused = new Map(built.entries.filter((e) => e.kind === 'refused').map((e) => [e.txHash, e.kind === 'refused' ? e.code : null]));
  for (const row of REFUSED_ROWS) expect(refused.get(row.tx_hash), `row ${row.seq}`).toBe(row.error);
  return built;
}

describe('mainnet token 1, live', () => {
  it('FastNEAR lists and returns every evidence transaction', async (ctx) => {
    let read: SourceRead;
    try {
      read = await readTransactions([VAULT, REGISTRY], { ...MAINNET, nearblocks: null });
    } catch (error) {
      // The public tier rate limits by IP. The fallback test below still runs.
      if (String(error).includes('HTTP 429')) return ctx.skip();
      throw error;
    }
    expect(read.name).toBe('FastNEAR transactions API');
    expect(read.missing).toBe(0);
    expect(read.scans.every((s) => s.complete)).toBe(true);
    const built = checkAgainstEvidence(read);
    // FastNEAR also indexes transactions that only name the vault in a log, such as an intents.near settlement.
    expect(built.entries.some((e) => e.kind === 'intent_settled')).toBe(true);
  });

  it('NearBlocks v3 plus archival RPC return the same evidence transactions', async () => {
    clearHistoryCaches();
    const read = await readTransactions([VAULT, REGISTRY], { ...MAINNET, fastnear: null });
    expect(read.name).toBe('NearBlocks v3 + archival RPC');
    expect(read.scans.every((s) => s.complete)).toBe(true);
    checkAgainstEvidence(read);
  });

  it('loadHistory reconciles with get_state and ends with the current owner', async () => {
    const result = await loadHistory('1', { fresh: true });
    expect(result.status).toBe('ok');
    const ready = result as HistoryReady;
    expect(ready.vaultId).toBe(VAULT);
    expect(ready.reconciliation.filter((r) => !r.matches)).toEqual([]);
    expect(ready.holders[0]?.how).toBe('minted');
    expect(ready.holders.at(-1)?.account).toBe(ready.currentOwner);
    expect(ready.untrustedLogs).toBe(0);
    expect(ready.totals.refused).toBeGreaterThanOrEqual(REFUSED_ROWS.length);
  });

  it('a token that does not exist is not_found', async () => {
    const result = await loadHistory('999999', { fresh: true });
    expect(result.status).toBe('not_found');
  });
});

describe('GET /api/history', () => {
  const get = (query: string) => historyGet(new Request(`http://localhost/api/history${query}`, { headers: { 'x-real-ip': `10.9.0.${Math.floor(Math.random() * 250)}` } }));

  it('400 on a missing or malformed token_id', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get('?token_id=1;drop')).status).toBe(400);
  });

  it('200 with the timeline for token 1', async () => {
    const res = await get('?token_id=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HistoryReady;
    expect(body.status).toBe('ok');
    expect(body.entries.length).toBeGreaterThan(20);
    expect(body.entries.every((e) => /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(e.txHash))).toBe(true);
  });
});
