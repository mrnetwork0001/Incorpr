// Log parser, normalizers and timeline builder, run on real mainnet data for token 1 (Ledgerline Audit,
// vault c-1.incorpr.near). TOKEN1_TXS at the bottom is every transaction FastNEAR listed for
// c-1.incorpr.near and incorpr.near on 2026-11-06 up to the treasury swap, captured from
// tx.main.fastnear.com/v0/transactions and normalized with fromFastnear. Kept: every receipt on the
// vault or registry, every receipt with a log or a failure, the arguments the builder reads. Dropped:
// NEP-141 logs, dip4 logs other than token_diff and public_key_added, gas and signatures. Log strings
// are verbatim. The cases under "constructed" are marked as such: no mainnet transaction exists for them.

import { describe, expect, it } from 'vitest';
import {
  buildHistory,
  clearHistoryCaches,
  errorCode,
  historyCacheSize,
  loadHistory,
  fromFastnear,
  fromRpc,
  parseEventLog,
  reconcile,
  type ChainReceipt,
  type ChainTx,
  type FastnearTx,
  type HistoryEntry,
  type RpcTxStatus,
} from '@/lib/history';

const FOUNDER = '717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BASE = { tokenId: '1', registryId: 'incorpr.near', vaultId: 'c-1.incorpr.near', intentsContract: 'intents.near', computeReserveBps: 2000, usdcToken: USDC };

/** Rows 20 to 37 of docs/evidence/mainnet.json with status "failure". */
const EVIDENCE_REFUSALS: [string, string][] = [
  ['2ZujvBZpKB5K6vrdnHj3hhHreuQ4xkwTqP3x5P4kTqSx', 'ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN'],
  ['DwLfeptiuLwzLMZwVLuUFqXsopso5PPM6wXP2ZHVxEXG', 'ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN'],
  ['4tg5N6kTxwSnVo18XmseDrGg1g2Youmo3sYZmGcLUpXB', 'ERR_TOKEN_ENCUMBERED'],
  ['Du7yUNyxL9HHXzDexUy9VMpvfiqjfFnEfsgToyMSSQbE', 'ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN'],
  ['CE7Yp11fZazGFWQWgbXxsCr2q4RQgLxJnyibbVJwgGRe', 'ERR_TOKEN_ENCUMBERED'],
  ['FtbSPNYgx16EHdvinmhdCSY3robWnviVCbRvvGwRhx6U', 'ERR_ONLY_CURRENT_SHAREHOLDER'],
  ['9yHuadXBoMuFqhBGeP8rK96xnggvZ8UPyPqDnWoS2AyL', 'ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION'],
  ['BqvJHjW5pHWS8Rj5PN2D4U4UhCkfNq39S5o2Nqstre5M', 'ERR_FIREWALL_PRICE_BELOW_FLOOR'],
  ['97HLn2o1Tcs1wnVG4NfLtkyPxrLxm4H9iRHDAvgdQQjq', 'ERR_TEE_SIGNATURE_UNTRUSTED'],
  ['4wbpoEEWMcZhDZfy8shDsdZdosX2evq6TJa4Epj6efhE', 'ERR_TEE_NOT_APPROVED'],
];

/** c-1.incorpr.near get_state, read from rpc.mainnet.fastnear.com after the swap in TOKEN1_TXS. */
const STATE_AFTER = {
  gross_revenue: '100000',
  related_party_revenue: '574999',
  api_calls_served: 1,
  dividends_paid: '40000',
  compute_paid: '0',
  deposited_to_intents: '500000',
  compute_reserve: '134999',
  retained_earnings: '0',
};

const of = <K extends HistoryEntry['kind']>(entries: HistoryEntry[], kind: K) =>
  entries.filter((e): e is Extract<HistoryEntry, { kind: K }> => e.kind === kind);

describe('parseEventLog, real mainnet logs', () => {
  it('reads a vault event', () => {
    const ev = parseEventLog(
      'EVENT_JSON:{"standard":"incorpr-vault","version":"1.0.0","event":"payment_received","data":[{"call_id":"59947944cbbeaede4506b792d669535f173f628ec4ea3dfc35880fc573d0e14d","payer":"demo-customer.incorpr.near","amount":"50000","related_party":false}]}',
    );
    expect(ev).toEqual({
      standard: 'incorpr-vault',
      version: '1.0.0',
      event: 'payment_received',
      data: [{ call_id: '59947944cbbeaede4506b792d669535f173f628ec4ea3dfc35880fc573d0e14d', payer: 'demo-customer.incorpr.near', amount: '50000', related_party: false }],
    });
  });

  it('reads registry and NEP-171 events', () => {
    const sale = parseEventLog(
      `EVENT_JSON:{"standard":"incorpr","version":"1.0.0","event":"company_acquired","data":[{"token_id":"1","buyer":"demo-buyer.incorpr.near","seller":"${FOUNDER}","price":"1000000","royalty":"50000"}]}`,
    );
    expect(sale?.event).toBe('company_acquired');
    expect(sale?.data[0]).toMatchObject({ token_id: '1', price: '1000000', royalty: '50000' });
    const transfer = parseEventLog(
      `EVENT_JSON:{"standard":"nep171","version":"1.0.0","event":"nft_transfer","data":[{"old_owner_id":"${FOUNDER}","new_owner_id":"demo-buyer.incorpr.near","token_ids":["1"],"memo":"acquisition"}]}`,
    );
    expect(transfer?.data[0]).toMatchObject({ new_owner_id: 'demo-buyer.incorpr.near', token_ids: ['1'], memo: 'acquisition' });
  });

  it('wraps an object `data`, as intents.near logs public_key_added', () => {
    const ev = parseEventLog(
      'EVENT_JSON:{"standard":"dip4","version":"0.4.3","event":"public_key_added","data":{"account_id":"c-1.incorpr.near","public_key":"ed25519:B6BrxvWsAqduvmCdx9Ygs4VLBZDdNayvrX68fdhCqqoa"}}',
    );
    expect(ev?.data).toEqual([{ account_id: 'c-1.incorpr.near', public_key: 'ed25519:B6BrxvWsAqduvmCdx9Ygs4VLBZDdNayvrX68fdhCqqoa' }]);
  });

  it('returns null for plain logs and broken JSON', () => {
    expect(parseEventLog('stale treasury key derivation ignored')).toBeNull();
    expect(parseEventLog('sign: predecessor=AccountId("c-1.incorpr.near"), request=SignRequestArgs { path: "incorpr-1-intents" }')).toBeNull();
    expect(parseEventLog('EVENT_JSON:{"standard":"incorpr"')).toBeNull();
    expect(parseEventLog('EVENT_JSON:{"version":"1.0.0","event":"x","data":[]}')).toBeNull();
  });

  it('extracts contract error codes', () => {
    expect(errorCode('Smart contract panicked: ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION')).toBe('ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION');
    expect(errorCode('Exceeded the prepaid gas.')).toBeNull();
    expect(errorCode(null)).toBeNull();
  });
});

describe('normalizers', () => {
  it('fromFastnear: a refused claim keeps the panic text and drops system refunds', () => {
    const tx = fromFastnear(RAW_FASTNEAR[0] as FastnearTx);
    expect(tx.hash).toBe('2ZujvBZpKB5K6vrdnHj3hhHreuQ4xkwTqP3x5P4kTqSx');
    expect(tx.signer).toBe(FOUNDER);
    expect(tx.receipts).toHaveLength(1);
    const r = tx.receipts[0] as ChainReceipt;
    expect(r).toMatchObject({ receiver: 'c-1.incorpr.near', ok: false, failure: 'Smart contract panicked: ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN' });
    expect(r.calls).toEqual([{ method: 'claim_dividends', args: { amount: '1' }, deposit: '1' }]);
    expect(new Date(tx.timestampMs).toISOString()).toBe('2026-11-06T16:16:17.282Z');
  });

  it('fromFastnear: a payment decodes ft_transfer_call args and keeps the vault log', () => {
    const tx = fromFastnear(RAW_FASTNEAR[1] as FastnearTx);
    const first = tx.receipts[0] as ChainReceipt;
    expect(first.calls[0]?.method).toBe('ft_transfer_call');
    expect(first.calls[0]?.args).toMatchObject({ receiver_id: 'c-1.incorpr.near', amount: '50000' });
    const vault = tx.receipts.find((r) => r.receiver === 'c-1.incorpr.near');
    expect(vault?.calls[0]?.method).toBe('ft_on_transfer');
    expect(vault?.logs[0]).toContain('"event":"payment_received"');
  });

  it('fromRpc gives the same receipts as fromFastnear for the same transaction', () => {
    const fast = fromFastnear(RAW_FASTNEAR[0] as FastnearTx);
    const rpc = fromRpc(RAW_RPC_2ZUJ, { blockHeight: fast.blockHeight, timestampMs: fast.timestampMs }, new Map());
    const strip = (t: ChainTx) => t.receipts.map(({ id, predecessor, receiver, calls, logs, ok, failure }) => ({ id, predecessor, receiver, calls, logs, ok, failure }));
    expect(strip(rpc)).toEqual(strip(fast));
    expect(rpc.signer).toBe(fast.signer);
  });
});

describe('buildHistory on token 1, mainnet', () => {
  const built = buildHistory({ ...BASE, txs: TOKEN1_TXS });

  it('orders the company story and checks it against docs/evidence/mainnet.json', () => {
    const story = built.entries.filter((e) => e.kind !== 'refused').map((e) => `${e.kind}:${e.txHash.slice(0, 8)}`);
    expect(story).toEqual([
      'incorporated:2xPK7TCG', // 5 incorporate_company
      'treasury_addresses:EMDJGJn4', // 6 refresh_treasury_keys
      'payment:HovPj1W2', // 17 pay
      'service_call:3iLE29jP', // 18 serve
      'listed:4au7synM', // 19 list
      'sold:4Tu3Xabc', // 23 buy
      'offer_funded:7m656gNJ', // 25 lend
      'loan_opened:3gA99cMd', // 26 borrow
      'loan_repaid:69jjS9Ss', // 29 repay
      'dividends:5WW8cPNc', // 30 dividends
      'payment:2ZmwLs3V', // 42 pay-in through 1Click
      'intents_key:6riRRm81', // 44 rebalance:key
      'payment:G4ypF62j', // 46 rebalance:fund, paid by the shareholder
      'intents_deposit:856Sf7ui', // 47 rebalance:deposit
      'intent_signed:4AmTFGH5', // 48 rebalance:sign
      'intent_settled:6iuhhDuD', // intents.near execute_intents by a solver, not in the evidence file
    ]);
  });

  it('lists every refused attempt from the evidence file, with its code, and nothing else', () => {
    const refused = of(built.entries, 'refused').map((e) => [e.txHash, e.code]);
    expect(refused).toEqual(EVIDENCE_REFUSALS);
    const robbed = of(built.entries, 'refused').find((e) => e.code === 'ERR_ONLY_CURRENT_SHAREHOLDER');
    expect(robbed).toMatchObject({ target: 'vault', method: 'request_shareholder_signature', caller: 'rob.incorpr.near', group: 'refused' });
    expect(of(built.entries, 'refused').find((e) => e.txHash.startsWith('CE7Yp11f'))).toMatchObject({ target: 'registry', method: 'nft_transfer', caller: 'demo-buyer.incorpr.near' });
  });

  it('reads amounts and parties from the events', () => {
    expect(of(built.entries, 'payment').map((p) => [p.payer, p.amount, p.relatedParty])).toEqual([
      ['demo-customer.incorpr.near', '50000', false],
      ['demo-customer.incorpr.near', '50000', false],
      ['demo-buyer.incorpr.near', '574999', true],
    ]);
    expect(of(built.entries, 'sold')[0]).toMatchObject({
      buyer: 'demo-buyer.incorpr.near',
      seller: FOUNDER,
      price: '1000000',
      royalty: '50000',
      payouts: [
        { account: FOUNDER, amount: '50000', pending: false },
        { account: FOUNDER, amount: '950000', pending: false },
      ],
    });
    expect(of(built.entries, 'loan_opened')[0]).toMatchObject({ lender: 'demo-lender.incorpr.near', borrower: 'demo-buyer.incorpr.near', principal: '1000000', debt: '1010000', dueMs: 1794068514524 });
    expect(of(built.entries, 'loan_repaid')[0]?.payouts).toEqual([{ account: 'demo-lender.incorpr.near', amount: '1010000', pending: false }]);
    expect(of(built.entries, 'dividends')[0]).toMatchObject({ shareholder: 'demo-buyer.incorpr.near', amount: '40000', group: 'paid' });
    expect(of(built.entries, 'service_call')[0]).toMatchObject({ teeChatId: 'chatcmpl-3e29b917-c667-4191-b16c-f706743442a1' });
    expect(of(built.entries, 'intent_signed')[0]).toMatchObject({
      intent: 'token_diff',
      diff: { 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '-500000', 'nep141:sol.omft.near': '5545636' },
      deadline: '2026-11-06T18:05:31.973Z',
    });
    // The solver's own token_diff in the same execute_intents call is not the vault's.
    expect(of(built.entries, 'intent_settled')).toHaveLength(1);
  });

  it('lists the holders: the founder from the mint, then the buyer', () => {
    expect(built.holders.map((h) => [h.account, h.how, h.price, h.txHash.slice(0, 8)])).toEqual([
      [FOUNDER, 'minted', null, '2xPK7TCG'],
      ['demo-buyer.incorpr.near', 'bought', '1000000', '4Tu3Xabc'],
    ]);
    expect(built.holders[0]?.toMs).toBe(built.holders[1]?.fromMs);
    expect(built.holders[1]?.toMs).toBeNull();
  });

  it('sums to the vault get_state on every reconciled field', () => {
    expect(built.totals).toMatchObject({ payments: 3, relatedPayments: 1, gross: '100000', relatedParty: '574999', callsServed: 1, dividends: '40000', sales: 1, salesVolume: '1000000', royalties: '50000', refused: 10 });
    const rows = reconcile(built.totals, STATE_AFTER);
    expect(rows.filter((r) => !r.matches)).toEqual([]);
    expect(rows.map((r) => r.field)).toEqual([
      'gross_revenue',
      'related_party_revenue',
      'api_calls_served',
      'dividends_paid',
      'compute_paid',
      'deposited_to_intents',
      'compute_reserve',
      'retained_earnings',
    ]);
  });

  it('reports a field that does not reconcile', () => {
    const rows = reconcile(built.totals, { ...STATE_AFTER, retained_earnings: '1' });
    expect(rows.find((r) => r.field === 'retained_earnings')).toEqual({ field: 'retained_earnings', fromEvents: '0', fromView: '1', matches: false });
  });

  it('a history cut before the swap differs from the later view, as the panel says', () => {
    const early = buildHistory({ ...BASE, txs: TOKEN1_TXS.filter((t) => t.blockHeight < 223350270) });
    const wrong = reconcile(early.totals, STATE_AFTER).filter((r) => !r.matches).map((r) => r.field);
    expect(wrong).toEqual(['related_party_revenue', 'deposited_to_intents', 'compute_reserve', 'retained_earnings']);
  });

  it('gives token 2 nothing from token 1 transactions', () => {
    const other = buildHistory({ ...BASE, tokenId: '2', vaultId: 'c-2.incorpr.near', txs: TOKEN1_TXS });
    expect(other.entries).toEqual([]);
    expect(other.holders).toEqual([]);
    expect(other.untrusted).toBe(0);
  });
});

// Constructed transactions below. Event shapes follow the emit calls in contracts/*/src/lib.rs.
function receipt(receiver: string, predecessor: string, method: string, args: unknown, logs: string[], failure: string | null = null): ChainReceipt {
  return { id: `${receiver}:${method}:${logs.length}:${predecessor}`, predecessor, receiver, blockHeight: 0, timestampMs: 0, calls: [{ method, args, deposit: '0' }], logs, ok: failure === null, failure };
}
function tx(hash: string, height: number, signer: string, receipts: ChainReceipt[]): ChainTx {
  return { hash, signer, receiver: receipts[0]?.receiver ?? '', blockHeight: height, timestampMs: 1_800_000_000_000 + height, receipts };
}
const ev = (standard: string, event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event, data: [data] })}`;

describe('constructed: trust and edge cases', () => {
  it('ignores Incorpr events logged by any other contract and counts them', () => {
    const forged = tx('forged', 1, 'evil.near', [
      receipt('evil.near', 'evil.near', 'fake', {}, [
        ev('incorpr-vault', 'payment_received', { call_id: 'x', payer: 'evil.near', amount: '999000000', related_party: false }),
        ev('incorpr', 'company_acquired', { token_id: '1', buyer: 'evil.near', seller: FOUNDER, price: '1', royalty: '0' }),
        ev('nep171', 'nft_transfer', { old_owner_id: FOUNDER, new_owner_id: 'evil.near', token_ids: ['1'] }),
      ]),
    ]);
    const sibling = tx('sibling', 2, 'someone.near', [
      receipt('c-2.incorpr.near', 'someone.near', 'record_service_call', {}, [ev('incorpr-vault', 'service_call_recorded', { call_id: 'y', tee_chat_id: 'z' })]),
    ]);
    const built = buildHistory({ ...BASE, txs: [forged, sibling] });
    expect(built.entries).toEqual([]);
    expect(built.holders).toEqual([]);
    expect(built.untrusted).toBe(2);
    expect(built.totals.gross).toBe('0');
  });

  it('records refunds: an unbooked vault payment and a registry ft_on_transfer that logs its reason', () => {
    const unbooked = tx('unbooked', 1, 'cheap.near', [
      receipt('c-1.incorpr.near', USDC, 'ft_on_transfer', { sender_id: 'cheap.near', amount: '10', msg: '{"call_id":"a"}' }, []),
    ]);
    const stale = tx('stale', 2, 'late-buyer.near', [
      receipt('incorpr.near', USDC, 'ft_on_transfer', { sender_id: 'late-buyer.near', amount: '1000000', msg: '{"action":"acquire","token_id":"1","expected_sync_nonce":1}' }, ['ERR_LISTING_CHANGED']),
    ]);
    const built = buildHistory({ ...BASE, txs: [unbooked, stale] });
    expect(built.entries.map((e) => e.kind)).toEqual(['payment_refunded', 'refused']);
    expect(of(built.entries, 'payment_refunded')[0]).toMatchObject({ payer: 'cheap.near', amount: '10' });
    expect(of(built.entries, 'refused')[0]).toMatchObject({ target: 'registry', caller: 'late-buyer.near', code: 'ERR_LISTING_CHANGED' });
    expect(built.totals.refundedPayments).toBe(1);
  });

  it('ignores ft_on_transfer called directly by an account that is not the USDC contract (constructed)', () => {
    // Anyone can call the hook with any sender_id and amount. The vault returns `amount` and logs
    // nothing; the registry does the same. No token moved, so nothing may be booked or shown as refunded.
    const forged = tx('forged-hook', 1, 'mallory.near', [
      receipt('c-1.incorpr.near', 'mallory.near', 'ft_on_transfer', { sender_id: 'whale.near', amount: '999000000', msg: '{"call_id":"x"}' }, []),
      receipt('incorpr.near', 'mallory.near', 'ft_on_transfer', { sender_id: 'whale.near', amount: '5', msg: '{"action":"acquire","token_id":"1","expected_sync_nonce":1}' }, ['ERR_LISTING_CHANGED']),
    ]);
    const built = buildHistory({ ...BASE, txs: [forged] });
    expect(built.entries).toEqual([]);
    expect(built.totals.refundedPayments).toBe(0);
  });

  it('follows a gift, a default auction and a claimed collateral through the holder list', () => {
    const nft = (from: string, to: string) => ev('nep171', 'nft_transfer', { old_owner_id: from, new_owner_id: to, token_ids: ['1'] });
    const txs = [
      tx('mint', 1, FOUNDER, [receipt('incorpr.near', 'incorpr.near', 'on_company_created', {}, [ev('nep171', 'nft_mint', { owner_id: FOUNDER, token_ids: ['1'] }), ev('incorpr', 'company_incorporated', { token_id: '1', vault: 'c-1.incorpr.near', founder: FOUNDER })])]),
      tx('gift', 2, FOUNDER, [receipt('incorpr.near', 'incorpr.near', 'on_vault_synced', {}, [nft(FOUNDER, 'friend.near')])]),
      tx('auction', 3, 'bidder.near', [
        receipt('incorpr.near', 'incorpr.near', 'on_bid_settled', {}, [
          nft('friend.near', 'bidder.near'),
          ev('incorpr', 'auction_settled', { token_id: '1', bidder: 'bidder.near', price: '1500000', to_lender: '1010000', royalty: '24500' }),
          ev('incorpr', 'payout_pending', { account: 'friend.near', amount: '465500' }),
        ]),
      ]),
      tx('claim', 4, 'lender.near', [receipt('incorpr.near', 'incorpr.near', 'on_claim_settled', {}, [nft('bidder.near', 'lender.near'), ev('incorpr', 'collateral_claimed', { token_id: '1', lender: 'lender.near' })])]),
    ];
    const built = buildHistory({ ...BASE, txs });
    expect(built.holders.map((h) => [h.account, h.how, h.price])).toEqual([
      [FOUNDER, 'minted', null],
      ['friend.near', 'transfer', null],
      ['bidder.near', 'auction', '1500000'],
      ['lender.near', 'collateral', null],
    ]);
    expect(built.entries.map((e) => e.kind)).toEqual(['incorporated', 'transferred', 'auction_settled', 'collateral_claimed']);
    expect(of(built.entries, 'auction_settled')[0]?.payouts).toEqual([{ account: 'friend.near', amount: '465500', pending: true }]);
    expect(built.totals.royalties).toBe('24500');
  });
});

// ---------------------------------------------------------------------------- Captured data

/** tx.main.fastnear.com/v0/transactions, unread fields removed: 2ZujvBZp (refused claim), HovPj1W2 (first payment). */
const RAW_FASTNEAR: FastnearTx[] = [
  {"transaction":{"hash":"2ZujvBZpKB5K6vrdnHj3hhHreuQ4xkwTqP3x5P4kTqSx","signer_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver_id":"c-1.incorpr.near"},"execution_outcome":{"block_height":223339312,"block_timestamp":1793981777282993400},"receipts":[{"receipt":{"receipt_id":"AxG3ccKTPwmADSxxQq1XPg65r6pfpwPw87BaWNZiTFAS","predecessor_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver_id":"c-1.incorpr.near","block_height":223339313,"block_timestamp":1793981777897502500,"receipt":{"Action":{"actions":[{"FunctionCall":{"method_name":"claim_dividends","args":"eyJhbW91bnQiOiIxIn0=","deposit":"1"}}]}}},"execution_outcome":{"outcome":{"logs":[],"status":{"Failure":{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN"}}}}},"executor_id":"c-1.incorpr.near"}}},{"receipt":{"receipt_id":"HoTs6MuctZGj1UBX8xXU9c2rWF542Wwc7aW8ZigWPRjb","predecessor_id":"system","receiver_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","block_height":223339314,"block_timestamp":1793981778518696400,"receipt":{"Action":{"actions":[{"Transfer":{"deposit":"1"}}]}}},"execution_outcome":{"outcome":{"logs":[],"status":{"SuccessValue":""},"executor_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9"}}},{"receipt":{"receipt_id":"zCcAbriCqu1aUUWpKB6QKF4oUmDegmd5QTm88eM3deo","predecessor_id":"system","receiver_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","block_height":223339314,"block_timestamp":1793981778518696400,"receipt":{"Action":{"actions":[{"Transfer":{"deposit":"100735441097041900000000"}}]}}},"execution_outcome":{"outcome":{"logs":[],"status":{"SuccessValue":""},"executor_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9"}}}]},
  {"transaction":{"hash":"HovPj1W2PKv9XH6HvRj6TweQ83rdhHiw9KqD2CrFXLfb","signer_id":"demo-customer.incorpr.near","receiver_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"},"execution_outcome":{"block_height":223339282,"block_timestamp":1793981760319447800},"receipts":[{"receipt":{"receipt_id":"JCpE6qBKmbJHTneUbba7T8H69f7z6BY5vyALcBCmJkaS","predecessor_id":"demo-customer.incorpr.near","receiver_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","block_height":223339283,"block_timestamp":1793981760826853600,"receipt":{"Action":{"actions":[{"FunctionCall":{"method_name":"ft_transfer_call","args":"eyJyZWNlaXZlcl9pZCI6ImMtMS5pbmNvcnByLm5lYXIiLCJhbW91bnQiOiI1MDAwMCIsIm1zZyI6IntcImNhbGxfaWRcIjpcIjU5OTQ3OTQ0Y2JiZWFlZGU0NTA2Yjc5MmQ2Njk1MzVmMTczZjYyOGVjNGVhM2RmYzM1ODgwZmM1NzNkMGUxNGRcIn0ifQ==","deposit":"1"}}]}}},"execution_outcome":{"outcome":{"logs":["EVENT_JSON:{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_transfer\",\"data\":[{\"old_owner_id\":\"demo-customer.incorpr.near\",\"new_owner_id\":\"c-1.incorpr.near\",\"amount\":\"50000\"}]}"],"status":{"SuccessReceiptId":"EiYSzcFh8h2aJPUTNnD5knsrPCDbK4gEp8EerGS56C3g"},"executor_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"}}},{"receipt":{"receipt_id":"B4YJ6WSB89nQknt6xHM9aehF3NRLEhVa7odVcewx1Tyt","predecessor_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","receiver_id":"c-1.incorpr.near","block_height":223339284,"block_timestamp":1793981761484240600,"receipt":{"Action":{"actions":[{"FunctionCall":{"method_name":"ft_on_transfer","args":"eyJzZW5kZXJfaWQiOiJkZW1vLWN1c3RvbWVyLmluY29ycHIubmVhciIsImFtb3VudCI6IjUwMDAwIiwibXNnIjoie1wiY2FsbF9pZFwiOlwiNTk5NDc5NDRjYmJlYWVkZTQ1MDZiNzkyZDY2OTUzNWYxNzNmNjI4ZWM0ZWEzZGZjMzU4ODBmYzU3M2QwZTE0ZFwifSJ9","deposit":"0"}}]}}},"execution_outcome":{"outcome":{"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"payment_received\",\"data\":[{\"call_id\":\"59947944cbbeaede4506b792d669535f173f628ec4ea3dfc35880fc573d0e14d\",\"payer\":\"demo-customer.incorpr.near\",\"amount\":\"50000\",\"related_party\":false}]}"],"status":{"SuccessValue":"IjAi"},"executor_id":"c-1.incorpr.near"}}},{"receipt":{"receipt_id":"57fVKnAdS9PZNs2EcsK5stBHFgtbneQsurHc7pQRRzk7","predecessor_id":"system","receiver_id":"demo-customer.incorpr.near","block_height":223339284,"block_timestamp":1793981761484240600,"receipt":{"Action":{"actions":[{"Transfer":{"deposit":"2799647289811800000000"}}]}}},"execution_outcome":{"outcome":{"logs":[],"status":{"SuccessValue":""},"executor_id":"demo-customer.incorpr.near"}}},{"receipt":{"receipt_id":"EiYSzcFh8h2aJPUTNnD5knsrPCDbK4gEp8EerGS56C3g","predecessor_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","receiver_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","block_height":223339284,"block_timestamp":1793981761484240600,"receipt":{"Action":{"actions":[{"FunctionCall":{"method_name":"ft_resolve_transfer","args":"eyJzZW5kZXJfaWQiOiJkZW1vLWN1c3RvbWVyLmluY29ycHIubmVhciIsInJlY2VpdmVyX2lkIjoiYy0xLmluY29ycHIubmVhciIsImFtb3VudCI6IjUwMDAwIn0=","deposit":"0"}}]}}},"execution_outcome":{"outcome":{"logs":[],"status":{"SuccessValue":"IjUwMDAwIg=="},"executor_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"}}},{"receipt":{"receipt_id":"2jbTinwsxJJGxQMFHJL5du7PmhzvVd8Z2uKMoAfcfjHX","predecessor_id":"system","receiver_id":"demo-customer.incorpr.near","block_height":223339285,"block_timestamp":1793981761991045400,"receipt":{"Action":{"actions":[{"Transfer":{"deposit":"272226323147890800000000"}}]}}},"execution_outcome":{"outcome":{"logs":[],"status":{"SuccessValue":""},"executor_id":"demo-customer.incorpr.near"}}},{"receipt":{"receipt_id":"7NnoZ5mb1wujRNGxqqDHyXntiic51Wrruz1CciLdJ7e8","predecessor_id":"c-1.incorpr.near","receiver_id":"incorpr.near","block_height":223339285,"block_timestamp":1793981761991045400,"receipt":{"Action":{"actions":[{"FunctionCall":{"method_name":"report_metrics","args":"eyJ0b2tlbl9pZCI6IjEiLCJncm9zcyI6IjUwMDAwIiwicmV0YWluZWQiOiI0MDAwMCIsInJldmVudWVfMzBkIjoiNTAwMDAiLCJjYWxscyI6MH0=","deposit":"0"}}]}}},"execution_outcome":{"outcome":{"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"metrics_reported\",\"data\":[{\"token_id\":\"1\",\"gross\":\"50000\",\"retained\":\"40000\",\"revenue_30d\":\"50000\",\"calls\":0}]}"],"status":{"SuccessValue":""},"executor_id":"incorpr.near"}}},{"receipt":{"receipt_id":"E7R4JtCcLLLC5g79rwhe5cooGg8oSycQoZMnX89FaNhh","predecessor_id":"system","receiver_id":"demo-customer.incorpr.near","block_height":223339286,"block_timestamp":1793981762600738000,"receipt":{"Action":{"actions":[{"Transfer":{"deposit":"16205411507177900000000"}}]}}},"execution_outcome":{"outcome":{"logs":[],"status":{"SuccessValue":""},"executor_id":"demo-customer.incorpr.near"}}},{"receipt":{"receipt_id":"G14WH2u2HWRY2AcxjJgoWY8CFjBfkwjHBtXf2kfoBdoM","predecessor_id":"system","receiver_id":"demo-customer.incorpr.near","block_height":223339286,"block_timestamp":1793981762600738000,"receipt":{"Action":{"actions":[{"Transfer":{"deposit":"8629908229317100000000"}}]}}},"execution_outcome":{"outcome":{"logs":[],"status":{"SuccessValue":""},"executor_id":"demo-customer.incorpr.near"}}}]},
];

/** archival-rpc.mainnet.fastnear.com EXPERIMENTAL_tx_status for 2ZujvBZp, unread fields removed. */
const RAW_RPC_2ZUJ: RpcTxStatus = {"transaction":{"hash":"2ZujvBZpKB5K6vrdnHj3hhHreuQ4xkwTqP3x5P4kTqSx","signer_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver_id":"c-1.incorpr.near"},"receipts":[{"receipt_id":"AxG3ccKTPwmADSxxQq1XPg65r6pfpwPw87BaWNZiTFAS","predecessor_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver_id":"c-1.incorpr.near","receipt":{"Action":{"actions":[{"FunctionCall":{"method_name":"claim_dividends","args":"eyJhbW91bnQiOiIxIn0=","deposit":"1"}}]}}},{"receipt_id":"HoTs6MuctZGj1UBX8xXU9c2rWF542Wwc7aW8ZigWPRjb","predecessor_id":"system","receiver_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receipt":{"Action":{"actions":[{"Transfer":{"deposit":"1"}}]}}},{"receipt_id":"zCcAbriCqu1aUUWpKB6QKF4oUmDegmd5QTm88eM3deo","predecessor_id":"system","receiver_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receipt":{"Action":{"actions":[{"Transfer":{"deposit":"100735441097041900000000"}}]}}}],"receipts_outcome":[{"id":"AxG3ccKTPwmADSxxQq1XPg65r6pfpwPw87BaWNZiTFAS","outcome":{"logs":[],"status":{"Failure":{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN"}}}}},"executor_id":"c-1.incorpr.near"}},{"id":"HoTs6MuctZGj1UBX8xXU9c2rWF542Wwc7aW8ZigWPRjb","outcome":{"logs":[],"status":{"SuccessValue":""},"executor_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9"}},{"id":"zCcAbriCqu1aUUWpKB6QKF4oUmDegmd5QTm88eM3deo","outcome":{"logs":[],"status":{"SuccessValue":""},"executor_id":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9"}}]};

const TOKEN1_TXS: ChainTx[] = [
  {"hash":"EBhT38orfeEVsSgMyehiCNVF29SDaYm1tXkp38dW2ipB","signer":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"near","blockHeight":223333914,"timestampMs":1793978624031,"receipts":[{"id":"6kEAeTtharXvB1nxhWRQzfiMcADN7vu9XMrnPqyZgPN1","predecessor":"near","receiver":"incorpr.near","blockHeight":223333916,"timestampMs":1793978625271,"calls":[],"logs":[],"ok":true,"failure":null}]},
  {"hash":"GyajZTeRLuz4CVGtJgSNEQvvZGCLxxT2rpFHpm5mN8Bx","signer":"incorpr.near","receiver":"operator.incorpr.near","blockHeight":223333920,"timestampMs":1793978627700,"receipts":[]},
  {"hash":"4EQMs6xTpTt8kmGAwX8JBSfGoMa37D4a5rKwXfks6hbH","signer":"incorpr.near","receiver":"incorpr.near","blockHeight":223333932,"timestampMs":1793978634323,"receipts":[{"id":"XB8pTbSJNv9fMzBR1eZtAC334HWdXZjSnyiEMK1YmLP","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223333932,"timestampMs":1793978634323,"calls":[{"method":"new","args":{},"deposit":"0"}],"logs":[],"ok":true,"failure":null}]},
  {"hash":"2xPK7TCGCM2q6ZrxH8FK1uwfcS4KaDFs6N4vPg2oTJHX","signer":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"incorpr.near","blockHeight":223333936,"timestampMs":1793978636783,"receipts":[{"id":"CBcZyDNbqJJGnBNaY4kRzBkqfb1zDby8Pg5pKJxEjuxb","predecessor":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"incorpr.near","blockHeight":223333937,"timestampMs":1793978637340,"calls":[{"method":"incorporate_company","args":{},"deposit":"4594540000000000000000000"}],"logs":[],"ok":true,"failure":null},{"id":"DTaDLofWnvBLhRSVQw2j83PtEJ3DxHhq8UPqXbwy1ut8","predecessor":"incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223333938,"timestampMs":1793978637883,"calls":[{"method":"new","args":null,"deposit":"0"}],"logs":[],"ok":true,"failure":null},{"id":"A3thNUBrpMkSapwBiFZhdejUeptxBeqky1Kh4x7KqpDR","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223333938,"timestampMs":1793978637883,"calls":[{"method":"on_company_created","args":{"token_id":"1"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"nep171\",\"version\":\"1.0.0\",\"event\":\"nft_mint\",\"data\":[{\"owner_id\":\"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9\",\"token_ids\":[\"1\"]}]}","EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"company_incorporated\",\"data\":[{\"token_id\":\"1\",\"vault\":\"c-1.incorpr.near\",\"founder\":\"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9\"}]}"],"ok":true,"failure":null}]},
  {"hash":"EMDJGJn41TvGWnoZtQ7vtrmTPVHBZr6ywyLDZCaXjfcZ","signer":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"c-1.incorpr.near","blockHeight":223333944,"timestampMs":1793978641236,"receipts":[{"id":"BBwriemEBEFsKtPvXLBuUvYYLjfMiGf1StUNj4DQuWb4","predecessor":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"c-1.incorpr.near","blockHeight":223333945,"timestampMs":1793978641851,"calls":[{"method":"refresh_treasury_keys","args":null,"deposit":"0"}],"logs":[],"ok":true,"failure":null},{"id":"AogZpP1114cX1CgkzLE1E8bD7jazBRmkMceE1FYSNeHK","predecessor":"c-1.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223333946,"timestampMs":1793978642427,"calls":[{"method":"on_treasury_keys","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"treasury_addresses_set\",\"data\":[{\"epoch\":0,\"btc\":\"bc1q46d395d4m3s209vl7vpgmdenqynnhge8ccscs0\",\"evm\":\"0x1dd34b5a17de3620383926289b4e73b50c8e97b8\",\"sol\":\"G2Zjrg1XCeaCVz85PTHqEZvTjGj4YRCCA7Q8W51dYNGn\",\"secp256k1_key\":\"secp256k1:5tepkX855buXLcczWQeLuBiMwWEAVoWMRY2i6W7MCkvyfX9RfaWDsK9CDV2RaB9FszEL5A8dE5PaifiVns4GW9Uj\",\"ed25519_key\":\"ed25519:G2Zjrg1XCeaCVz85PTHqEZvTjGj4YRCCA7Q8W51dYNGn\"}]}"],"ok":true,"failure":null}]},
  {"hash":"2cGrTiHRiCoA3jVb5f3JMzE2QAwrBptWxKcw4R5XHpiB","signer":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"incorpr.near","blockHeight":223334032,"timestampMs":1793978690166,"receipts":[{"id":"9pweKR7pwf4A2CK1b97Ki3J3cg7psacvZMmyQpdqhmn8","predecessor":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"incorpr.near","blockHeight":223334033,"timestampMs":1793978690717,"calls":[],"logs":[],"ok":true,"failure":null}]},
  {"hash":"Btw1vsApHrs44AtEjgNBBoAtBYCxCFc9i5rMRPGBHsXs","signer":"incorpr.near","receiver":"demo-customer.incorpr.near","blockHeight":223334036,"timestampMs":1793978692540,"receipts":[]},
  {"hash":"53NcX8J7d3oBjCT7rKVxYpgd6aGPSUgWYzZp2dnTYrDp","signer":"incorpr.near","receiver":"demo-buyer.incorpr.near","blockHeight":223334040,"timestampMs":1793978694840,"receipts":[]},
  {"hash":"82Mmq5vaLYPkk2ys1dvuiKWvSVdAUbaidrqsiUZvNw76","signer":"incorpr.near","receiver":"demo-lender.incorpr.near","blockHeight":223334044,"timestampMs":1793978697231,"receipts":[]},
  {"hash":"HovPj1W2PKv9XH6HvRj6TweQ83rdhHiw9KqD2CrFXLfb","signer":"demo-customer.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339282,"timestampMs":1793981760319,"receipts":[{"id":"JCpE6qBKmbJHTneUbba7T8H69f7z6BY5vyALcBCmJkaS","predecessor":"demo-customer.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339283,"timestampMs":1793981760826,"calls":[{"method":"ft_transfer_call","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"B4YJ6WSB89nQknt6xHM9aehF3NRLEhVa7odVcewx1Tyt","predecessor":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","receiver":"c-1.incorpr.near","blockHeight":223339284,"timestampMs":1793981761484,"calls":[{"method":"ft_on_transfer","args":{"sender_id":"demo-customer.incorpr.near","amount":"50000","msg":"{\"call_id\":\"59947944cbbeaede4506b792d669535f173f628ec4ea3dfc35880fc573d0e14d\"}"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"payment_received\",\"data\":[{\"call_id\":\"59947944cbbeaede4506b792d669535f173f628ec4ea3dfc35880fc573d0e14d\",\"payer\":\"demo-customer.incorpr.near\",\"amount\":\"50000\",\"related_party\":false}]}"],"ok":true,"failure":null},{"id":"7NnoZ5mb1wujRNGxqqDHyXntiic51Wrruz1CciLdJ7e8","predecessor":"c-1.incorpr.near","receiver":"incorpr.near","blockHeight":223339285,"timestampMs":1793981761991,"calls":[{"method":"report_metrics","args":{"token_id":"1"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"metrics_reported\",\"data\":[{\"token_id\":\"1\",\"gross\":\"50000\",\"retained\":\"40000\",\"revenue_30d\":\"50000\",\"calls\":0}]}"],"ok":true,"failure":null}]},
  {"hash":"3iLE29jPqeiLjqxHzpU1bG2YX6tLRv5u73tMUCKroLbz","signer":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339300,"timestampMs":1793981770420,"receipts":[{"id":"B1Ya7e4AHbBtSHsrzhEJ7QVxbip7TNa4HcMhxGHcqNG9","predecessor":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339301,"timestampMs":1793981771008,"calls":[{"method":"record_service_call","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"service_call_recorded\",\"data\":[{\"call_id\":\"59947944cbbeaede4506b792d669535f173f628ec4ea3dfc35880fc573d0e14d\",\"tee_chat_id\":\"chatcmpl-3e29b917-c667-4191-b16c-f706743442a1\"}]}"],"ok":true,"failure":null},{"id":"G1QzSvCgarY2DMXkS81d6GvHUhMgQTJz6UtgzeSKVRep","predecessor":"c-1.incorpr.near","receiver":"incorpr.near","blockHeight":223339302,"timestampMs":1793981771609,"calls":[{"method":"report_metrics","args":{"token_id":"1"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"metrics_reported\",\"data\":[{\"token_id\":\"1\",\"gross\":\"50000\",\"retained\":\"40000\",\"revenue_30d\":\"50000\",\"calls\":1}]}"],"ok":true,"failure":null}]},
  {"hash":"4au7synMju7cwkrDPqYRpiDQp2ffa96aV7mF4HTfAiKz","signer":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"incorpr.near","blockHeight":223339305,"timestampMs":1793981773375,"receipts":[{"id":"4YCGiw2jBDux3qvAKsJrrAW22mGVnQDVSN6EjFvaf2wY","predecessor":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"incorpr.near","blockHeight":223339306,"timestampMs":1793981773735,"calls":[{"method":"list_company","args":{"token_id":"1"},"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"3ow8HsKNMUXLZFASJTD8as6Ao3buQ4YYHxFNaFNfuqwg","predecessor":"incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339307,"timestampMs":1793981774321,"calls":[{"method":"apply_encumbrance","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"encumbrance_applied\",\"data\":[{\"shareholder\":\"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9\",\"state\":{\"Listed\":{\"ask\":\"1000000\"}},\"sync_nonce\":1}]}"],"ok":true,"failure":null},{"id":"24T23yP4XT2dkF6wS7soofwh12xzAuNPxA2AzPPLS8PU","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339307,"timestampMs":1793981774321,"calls":[{"method":"on_listing_frozen","args":{"token_id":"1"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"company_listed\",\"data\":[{\"token_id\":\"1\",\"ask\":\"1000000\"}]}"],"ok":true,"failure":null},{"id":"HEJKMooPERSENTwbYpWfiVhiPw61HQXu78UNVedvbYmv","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339307,"timestampMs":1793981774321,"calls":[{"method":"on_settlement_checked","args":{"token_id":"1","offer_id":null},"deposit":"0"}],"logs":[],"ok":true,"failure":null}]},
  {"hash":"2ZujvBZpKB5K6vrdnHj3hhHreuQ4xkwTqP3x5P4kTqSx","signer":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"c-1.incorpr.near","blockHeight":223339312,"timestampMs":1793981777282,"receipts":[{"id":"AxG3ccKTPwmADSxxQq1XPg65r6pfpwPw87BaWNZiTFAS","predecessor":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"c-1.incorpr.near","blockHeight":223339313,"timestampMs":1793981777897,"calls":[{"method":"claim_dividends","args":null,"deposit":"1"}],"logs":[],"ok":false,"failure":"Smart contract panicked: ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN"}]},
  {"hash":"DwLfeptiuLwzLMZwVLuUFqXsopso5PPM6wXP2ZHVxEXG","signer":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"c-1.incorpr.near","blockHeight":223339317,"timestampMs":1793981780328,"receipts":[{"id":"9QvNiBz3PDBQdXs3sYVhx3uh5vRLqTb7KzRvEPKTATpz","predecessor":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"c-1.incorpr.near","blockHeight":223339318,"timestampMs":1793981780825,"calls":[{"method":"request_shareholder_signature","args":null,"deposit":"1"}],"logs":[],"ok":false,"failure":"Smart contract panicked: ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN"}]},
  {"hash":"4tg5N6kTxwSnVo18XmseDrGg1g2Youmo3sYZmGcLUpXB","signer":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"incorpr.near","blockHeight":223339322,"timestampMs":1793981783270,"receipts":[{"id":"CwKUYT9QzURJDtBcA5pF5EKaCjvvBTqfkCoPJtP8Y9bV","predecessor":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"incorpr.near","blockHeight":223339323,"timestampMs":1793981783768,"calls":[{"method":"nft_transfer","args":{"token_id":"1","receiver_id":"demo-customer.incorpr.near"},"deposit":"1"}],"logs":[],"ok":false,"failure":"Smart contract panicked: ERR_TOKEN_ENCUMBERED"}]},
  {"hash":"4Tu3Xabccsft9qvowKovMZ4oeqW99urm9CcYS8xCkcKZ","signer":"demo-buyer.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339327,"timestampMs":1793981786512,"receipts":[{"id":"4DoMy5gfmMB26zC68vzdqQM5cTgdPZgNEF3grWMmKNTJ","predecessor":"demo-buyer.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339328,"timestampMs":1793981786880,"calls":[{"method":"ft_transfer_call","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"7RhCNUEaLV1sFveCupnPGZGsWE1fvB6QEeDpLYkLz7N2","predecessor":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","receiver":"incorpr.near","blockHeight":223339329,"timestampMs":1793981787411,"calls":[{"method":"ft_on_transfer","args":{"msg":"{\"action\":\"acquire\",\"token_id\":\"1\",\"expected_sync_nonce\":1}","sender_id":"demo-buyer.incorpr.near","amount":"1000000"},"deposit":"0"}],"logs":[],"ok":true,"failure":null},{"id":"4H4MBNvEQ1xqxiPmT1JHHEo5zNH248PYfzR9JgCALcMz","predecessor":"incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339330,"timestampMs":1793981788028,"calls":[{"method":"begin_transit","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"transit_begun\",\"data\":[{\"sync_nonce\":2}]}"],"ok":true,"failure":null},{"id":"54dGWjBidUx3RpQph6VK4xdQnpZpyzVHUWkEJ9U4fUJ3","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339330,"timestampMs":1793981788028,"calls":[{"method":"on_acquire_settled","args":{"token_id":"1","amount":"1000000"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"nep171\",\"version\":\"1.0.0\",\"event\":\"nft_transfer\",\"data\":[{\"old_owner_id\":\"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9\",\"new_owner_id\":\"demo-buyer.incorpr.near\",\"token_ids\":[\"1\"],\"memo\":\"acquisition\"}]}","EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"company_acquired\",\"data\":[{\"token_id\":\"1\",\"buyer\":\"demo-buyer.incorpr.near\",\"seller\":\"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9\",\"price\":\"1000000\",\"royalty\":\"50000\"}]}"],"ok":true,"failure":null},{"id":"6G79PQF8Wzn9kr8sxxqsbQTwVd7787LXMYHWmXPqGaKB","predecessor":"incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339332,"timestampMs":1793981789123,"calls":[{"method":"ft_transfer","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"EcLDefqEyx7rs9Pwzbyw2RWqcfuSAGJskrf6XPP4ZMPe","predecessor":"incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339332,"timestampMs":1793981789123,"calls":[{"method":"ft_transfer","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"C5eMGAo9fjfERPsWnZuFqqRsGNPKsmM1jjgpJAm97s96","predecessor":"incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339332,"timestampMs":1793981789123,"calls":[{"method":"apply_encumbrance","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"encumbrance_applied\",\"data\":[{\"shareholder\":\"demo-buyer.incorpr.near\",\"state\":\"Free\",\"sync_nonce\":3}]}"],"ok":true,"failure":null},{"id":"8kAHQQiMGbBFzci8zBq8znPMyXEocv1jtPVh7g8zKaPp","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339330,"timestampMs":1793981788028,"calls":[{"method":"on_ft_settlement_checked","args":{"token_id":"1","amount":"1000000"},"deposit":"0"}],"logs":[],"ok":true,"failure":null},{"id":"4RASTUnidV7etR6hXyzsRtaicSxfwm4xct384DMPdx8D","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339332,"timestampMs":1793981789123,"calls":[{"method":"on_payout","args":{"amount":"50000"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"payout_paid\",\"data\":[{\"account\":\"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9\",\"amount\":\"50000\"}]}"],"ok":true,"failure":null},{"id":"3CsxdmK6f1T7ZeCdzjqwYVBJ58fcGKEA9QgT23Mk2kva","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339332,"timestampMs":1793981789123,"calls":[{"method":"on_payout","args":{"amount":"950000"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"payout_paid\",\"data\":[{\"account\":\"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9\",\"amount\":\"950000\"}]}"],"ok":true,"failure":null},{"id":"3Qnf36fbjkEJjRCWiErtu5SWrbh18XFH2C9fuECoLWNg","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339332,"timestampMs":1793981789123,"calls":[{"method":"on_vault_finished","args":{"token_id":"1"},"deposit":"0"}],"logs":[],"ok":true,"failure":null}]},
  {"hash":"HYn9vNApaAPSSu1RmZgXQphm3uYBkYzCNM9bNsqRPWgP","signer":"demo-lender.incorpr.near","receiver":"incorpr.near","blockHeight":223339337,"timestampMs":1793981792221,"receipts":[{"id":"AyC4iqUqetvs296KQcZd8xVGPxNBCZrEHvuDr13vYhUn","predecessor":"demo-lender.incorpr.near","receiver":"incorpr.near","blockHeight":223339338,"timestampMs":1793981792866,"calls":[{"method":"storage_deposit","args":{},"deposit":"12240000000000000000000"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"storage_deposit\",\"data\":[{\"account\":\"demo-lender.incorpr.near\",\"amount\":\"12240000000000000000000\"}]}"],"ok":true,"failure":null}]},
  {"hash":"7m656gNJoB4hEF5QT53mAAwtDJTp9vE4CdSxgLP5PWdR","signer":"demo-lender.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339902,"timestampMs":1793982109979,"receipts":[{"id":"DEwBZSBaGNkTZbx7ekjJQFWLqr1673NKhZg5z1TZDXuh","predecessor":"demo-lender.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339903,"timestampMs":1793982110560,"calls":[{"method":"ft_transfer_call","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"3bh3TzCp3j95Urj9Vji7HEbhW7EYNRThSfmDgUNdFaVX","predecessor":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","receiver":"incorpr.near","blockHeight":223339904,"timestampMs":1793982111250,"calls":[{"method":"ft_on_transfer","args":{"msg":"{\"action\":\"fund_offer\",\"token_id\":\"1\",\"repay_amount\":\"1010000\",\"term_ms\":86400000}","sender_id":"demo-lender.incorpr.near","amount":"1000000"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"offer_funded\",\"data\":[{\"offer_id\":1,\"token_id\":\"1\",\"lender\":\"demo-lender.incorpr.near\",\"principal\":\"1000000\",\"repay_amount\":\"1010000\",\"term_ms\":86400000}]}"],"ok":true,"failure":null}]},
  {"hash":"3gA99cMdWigv4RGgopmXnNZK7C7QWqS5VAT5XCvQB5fj","signer":"demo-buyer.incorpr.near","receiver":"incorpr.near","blockHeight":223339909,"timestampMs":1793982113996,"receipts":[{"id":"Esnx9DPWuMRuHAecSjCwGU6GmatBcLmX2A844Fh53F45","predecessor":"demo-buyer.incorpr.near","receiver":"incorpr.near","blockHeight":223339910,"timestampMs":1793982114524,"calls":[{"method":"accept_offer","args":{"offer_id":1},"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"TpQpQsF5WuAZDZCLFy2F64FBGCKNaZwb2RRpdK8ok2G","predecessor":"incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339911,"timestampMs":1793982115124,"calls":[{"method":"apply_encumbrance","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"encumbrance_applied\",\"data\":[{\"shareholder\":\"demo-buyer.incorpr.near\",\"state\":{\"Pledged\":{\"lender\":\"demo-lender.incorpr.near\",\"debt\":\"1010000\",\"due_ms\":1794068514524}},\"sync_nonce\":4}]}"],"ok":true,"failure":null},{"id":"9BvA4vygiWSc4ZDJPBWHW8M1tfbEvHk9U23NVqz6zE3N","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339911,"timestampMs":1793982115124,"calls":[{"method":"on_pledge_frozen","args":{"offer_id":1},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"loan_opened\",\"data\":[{\"token_id\":\"1\",\"lender\":\"demo-lender.incorpr.near\",\"borrower\":\"demo-buyer.incorpr.near\",\"principal\":\"1000000\",\"debt\":\"1010000\",\"due_ms\":1794068514524}]}"],"ok":true,"failure":null},{"id":"H7LmFxQGB2RCYy4TaPAMsisS2PR4D9io3c48sJg4vcgy","predecessor":"incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339913,"timestampMs":1793982116305,"calls":[{"method":"ft_transfer","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"4sdxuV8SKP2Nsmffr9LsdaChdEuNMVjL2mqZPw9Yi4ah","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339911,"timestampMs":1793982115124,"calls":[{"method":"on_settlement_checked","args":{"token_id":"1","offer_id":1},"deposit":"0"}],"logs":[],"ok":true,"failure":null},{"id":"3qbNd7rZWU7bTT1ZMWz579kWPf2QMVP1noY4oVa1JXmv","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339913,"timestampMs":1793982116305,"calls":[{"method":"on_payout","args":{"amount":"1000000"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"payout_paid\",\"data\":[{\"account\":\"demo-buyer.incorpr.near\",\"amount\":\"1000000\"}]}"],"ok":true,"failure":null}]},
  {"hash":"Du7yUNyxL9HHXzDexUy9VMpvfiqjfFnEfsgToyMSSQbE","signer":"demo-buyer.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339918,"timestampMs":1793982119339,"receipts":[{"id":"DdrmH2JJFR7wRiyEvVvwovS2RkM5h4dr8RKMpa5CbptM","predecessor":"demo-buyer.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339919,"timestampMs":1793982119955,"calls":[{"method":"claim_dividends","args":null,"deposit":"1"}],"logs":[],"ok":false,"failure":"Smart contract panicked: ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN"}]},
  {"hash":"CE7Yp11fZazGFWQWgbXxsCr2q4RQgLxJnyibbVJwgGRe","signer":"demo-buyer.incorpr.near","receiver":"incorpr.near","blockHeight":223339923,"timestampMs":1793982122327,"receipts":[{"id":"AkUhYXRY5WtxZzwPRThAnfK5AHRBC81JN1joSmD3ScUE","predecessor":"demo-buyer.incorpr.near","receiver":"incorpr.near","blockHeight":223339924,"timestampMs":1793982123048,"calls":[{"method":"nft_transfer","args":{"token_id":"1","receiver_id":"demo-customer.incorpr.near"},"deposit":"1"}],"logs":[],"ok":false,"failure":"Smart contract panicked: ERR_TOKEN_ENCUMBERED"}]},
  {"hash":"69jjS9SsTgYKZnTM57QUUGr822pRYLfDECcbeafeVMcY","signer":"demo-buyer.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339929,"timestampMs":1793982125793,"receipts":[{"id":"8dHAJ4i3PqcT8KtGKC7AbHzpbMv9eHS9XzGXEctidHZk","predecessor":"demo-buyer.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339930,"timestampMs":1793982126334,"calls":[{"method":"ft_transfer_call","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"G7rgGGfqd6LfM5XBVbRJpKNnRAMJnJjskYnhad86gkB1","predecessor":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","receiver":"incorpr.near","blockHeight":223339931,"timestampMs":1793982126824,"calls":[{"method":"ft_on_transfer","args":{"msg":"{\"action\":\"repay\",\"token_id\":\"1\"}","sender_id":"demo-buyer.incorpr.near","amount":"1010000"},"deposit":"0"}],"logs":[],"ok":true,"failure":null},{"id":"8etArBuT69qKQ5wKUE1ZQRhyQjKTkzYMTCK2y8LsGyrD","predecessor":"incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339932,"timestampMs":1793982127432,"calls":[{"method":"begin_transit","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"transit_begun\",\"data\":[{\"sync_nonce\":5}]}"],"ok":true,"failure":null},{"id":"Em3BK5hoYBB5JDC7CTfjtEhZixzfZ2WvzhaF9sW2efjF","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339932,"timestampMs":1793982127432,"calls":[{"method":"on_repay_settled","args":{"token_id":"1","amount":"1010000"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"loan_repaid\",\"data\":[{\"token_id\":\"1\",\"payer\":\"demo-buyer.incorpr.near\",\"debt\":\"1010000\"}]}"],"ok":true,"failure":null},{"id":"DYTWCafcAbidi8AeziQNgqT1PsQURQA9Ga8PQ8s4JBLQ","predecessor":"incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339934,"timestampMs":1793982128588,"calls":[{"method":"ft_transfer","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"5MatX9Vqikc55WNjcXXvgZtFiZbUrNs1diPPGMu6BMWN","predecessor":"incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339934,"timestampMs":1793982128588,"calls":[{"method":"apply_encumbrance","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"encumbrance_applied\",\"data\":[{\"shareholder\":\"demo-buyer.incorpr.near\",\"state\":\"Free\",\"sync_nonce\":6}]}"],"ok":true,"failure":null},{"id":"CjxBpGfok4S5LYeb7oSjHmBwQoidR5jNtnWS29yJbTr8","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339932,"timestampMs":1793982127432,"calls":[{"method":"on_ft_settlement_checked","args":{"token_id":"1","amount":"1010000"},"deposit":"0"}],"logs":[],"ok":true,"failure":null},{"id":"BP7mVgUp6hn337kG1FWnRujWc2n6zArVVHbTnUTdqkXw","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339934,"timestampMs":1793982128588,"calls":[{"method":"on_payout","args":{"amount":"1010000"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"payout_paid\",\"data\":[{\"account\":\"demo-lender.incorpr.near\",\"amount\":\"1010000\"}]}"],"ok":true,"failure":null},{"id":"3b6mvydt6D28eSLAbLXjnBHzYA1wq5QAHDnDAdiUTjCj","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223339934,"timestampMs":1793982128588,"calls":[{"method":"on_vault_finished","args":{"token_id":"1"},"deposit":"0"}],"logs":[],"ok":true,"failure":null}]},
  {"hash":"5WW8cPNcN2CwtHm82sFE49LRPNTfb8J8Tz5Gky54nCgn","signer":"demo-buyer.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339945,"timestampMs":1793982134885,"receipts":[{"id":"5ttNWashjvopmoyMgdtxEx8e1TQwE6NFv41WvMrK95fA","predecessor":"demo-buyer.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339946,"timestampMs":1793982135548,"calls":[{"method":"claim_dividends","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"3VdJf2uFJa4BWcShqgcNsaNZ69ybg276ekfzVkMnkqcz","predecessor":"c-1.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223339947,"timestampMs":1793982136209,"calls":[{"method":"ft_transfer","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"7WkpFZMFG715wg1hZxQ1msvCKAStwzMy6XhM6fPysnMf","predecessor":"c-1.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223339947,"timestampMs":1793982136209,"calls":[{"method":"on_dividends_paid","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"dividends_claimed\",\"data\":[{\"shareholder\":\"demo-buyer.incorpr.near\",\"amount\":\"40000\"}]}"],"ok":true,"failure":null},{"id":"HW5BKyVykMhsMBv15c4crH3ce6VXxPAa2iJXYxPKjkzh","predecessor":"c-1.incorpr.near","receiver":"incorpr.near","blockHeight":223339949,"timestampMs":1793982137232,"calls":[{"method":"report_metrics","args":{"token_id":"1"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"metrics_reported\",\"data\":[{\"token_id\":\"1\",\"gross\":\"50000\",\"retained\":\"0\",\"revenue_30d\":\"50000\",\"calls\":1}]}"],"ok":true,"failure":null}]},
  {"hash":"3mU3pfKL77poconJJnxr9R2jiwrpW6ASUUP3Ez6midju","signer":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"incorpr.near","blockHeight":223340006,"timestampMs":1793982169847,"receipts":[{"id":"CyBh8Rc3bmEukqwf9THnZK285ctnejm9U5seH1EYUhDT","predecessor":"717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9","receiver":"incorpr.near","blockHeight":223340007,"timestampMs":1793982170337,"calls":[],"logs":[],"ok":true,"failure":null}]},
  {"hash":"GrmkbseV2nASWQ4L4h2jNKbLhxNtABDKtmMN8V2ER8tD","signer":"incorpr.near","receiver":"rob.incorpr.near","blockHeight":223340012,"timestampMs":1793982172890,"receipts":[]},
  {"hash":"FtbSPNYgx16EHdvinmhdCSY3robWnviVCbRvvGwRhx6U","signer":"rob.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223340095,"timestampMs":1793982219580,"receipts":[{"id":"GZw11S9wGkRXzUFrejzKAQ7ZaJN4nvXteicbEAvHPFRP","predecessor":"rob.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223340096,"timestampMs":1793982220113,"calls":[{"method":"request_shareholder_signature","args":null,"deposit":"1"}],"logs":[],"ok":false,"failure":"Smart contract panicked: ERR_ONLY_CURRENT_SHAREHOLDER"}]},
  {"hash":"9yHuadXBoMuFqhBGeP8rK96xnggvZ8UPyPqDnWoS2AyL","signer":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223340100,"timestampMs":1793982222358,"receipts":[{"id":"ANrq5Y4Y4pnnxxhNaZnBkb5zANRA2UvkfrWeVw2NRaHx","predecessor":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223340101,"timestampMs":1793982222882,"calls":[{"method":"agent_withdraw_intent","args":null,"deposit":"0"}],"logs":[],"ok":false,"failure":"Smart contract panicked: ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION"}]},
  {"hash":"BqvJHjW5pHWS8Rj5PN2D4U4UhCkfNq39S5o2Nqstre5M","signer":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223340104,"timestampMs":1793982224381,"receipts":[{"id":"9g7TvhxnQ67sjyv3CYMBuBgQaDMgefGqPjZNawPPBCNA","predecessor":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223340105,"timestampMs":1793982224873,"calls":[{"method":"agent_swap_intent","args":null,"deposit":"0"}],"logs":[],"ok":false,"failure":"Smart contract panicked: ERR_FIREWALL_PRICE_BELOW_FLOOR"}]},
  {"hash":"97HLn2o1Tcs1wnVG4NfLtkyPxrLxm4H9iRHDAvgdQQjq","signer":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223340108,"timestampMs":1793982226694,"receipts":[{"id":"7gRcdv9CdAa8hrxPjHYMFbd4XqzAWBSPyVvCQew5RP5G","predecessor":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223340109,"timestampMs":1793982227313,"calls":[{"method":"agent_swap_intent","args":null,"deposit":"0"}],"logs":[],"ok":false,"failure":"Smart contract panicked: ERR_TEE_SIGNATURE_UNTRUSTED"}]},
  {"hash":"4wbpoEEWMcZhDZfy8shDsdZdosX2evq6TJa4Epj6efhE","signer":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223340172,"timestampMs":1793982262827,"receipts":[{"id":"DkCDnqzGa9EQYoGGF25ekf3f6AcEboDrJ5FfcTjA1dzV","predecessor":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223340173,"timestampMs":1793982263423,"calls":[{"method":"agent_swap_intent","args":null,"deposit":"0"}],"logs":[],"ok":false,"failure":"Smart contract panicked: ERR_TEE_NOT_APPROVED"}]},
  {"hash":"2ZmwLs3VzYexjJCkEY77Tcvm5bK3UAvegSypMvfiokqx","signer":"demo-customer.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223341794,"timestampMs":1793983180622,"receipts":[{"id":"8xgwwFRbZwrqyYimTGbtPtXJeq5UKgRmFT3LFtDuPnyv","predecessor":"demo-customer.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223341795,"timestampMs":1793983181256,"calls":[{"method":"ft_transfer_call","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"5jV1qPa6dJXSGZQB7Tbz5BbSpk8yuJgPj3g7uB1NpPJj","predecessor":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","receiver":"c-1.incorpr.near","blockHeight":223341796,"timestampMs":1793983181839,"calls":[{"method":"ft_on_transfer","args":{"sender_id":"demo-customer.incorpr.near","amount":"50000","msg":"{\"call_id\":\"b65458a6e0414081fb88455c7adf49470ef149494330fe320850df42e7a6e87a\"}"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"payment_received\",\"data\":[{\"call_id\":\"b65458a6e0414081fb88455c7adf49470ef149494330fe320850df42e7a6e87a\",\"payer\":\"demo-customer.incorpr.near\",\"amount\":\"50000\",\"related_party\":false}]}"],"ok":true,"failure":null},{"id":"Bd3a1hUkmnsSMw3rWBF7mnHHctkhMiFHeKH6XsMuWMRd","predecessor":"c-1.incorpr.near","receiver":"incorpr.near","blockHeight":223341797,"timestampMs":1793983182404,"calls":[{"method":"report_metrics","args":{"token_id":"1"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"metrics_reported\",\"data\":[{\"token_id\":\"1\",\"gross\":\"100000\",\"retained\":\"40000\",\"revenue_30d\":\"100000\",\"calls\":1}]}"],"ok":true,"failure":null}]},
  {"hash":"Azkez5n9kU6qTyGS2R6UC2edFLFwFkMUdnxPfdXWFBfx","signer":"incorpr.near","receiver":"incorpr.near","blockHeight":223350204,"timestampMs":1793987977351,"receipts":[{"id":"94jbvG6ZmtMF92pq2z3xcPwpgkrJ8xtmojMAm3xmGb9U","predecessor":"incorpr.near","receiver":"incorpr.near","blockHeight":223350204,"timestampMs":1793987977351,"calls":[],"logs":[],"ok":true,"failure":null}]},
  {"hash":"6riRRm81h8Ptzqd9YtU4z9AA6gVRKZjN8jv94G6wmFkQ","signer":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223350260,"timestampMs":1793988009334,"receipts":[{"id":"6n32PAMRbuRZ1oxVpFzHVWStDhGA57SUMHiPzptEZZQv","predecessor":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223350261,"timestampMs":1793988009910,"calls":[{"method":"setup_intents_key","args":null,"deposit":"0"}],"logs":[],"ok":true,"failure":null},{"id":"65Qex9UbpZxpGTBkxUYmDhsPz2Qg5CYvLW8cWCj125uf","predecessor":"c-1.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223350262,"timestampMs":1793988010474,"calls":[{"method":"on_intents_key_derived","args":null,"deposit":"0"}],"logs":[],"ok":true,"failure":null},{"id":"83Up4pyX7TcxDpouXMxMnakUMW31cbdzJopbfAf2QaYG","predecessor":"c-1.incorpr.near","receiver":"intents.near","blockHeight":223350264,"timestampMs":1793988011488,"calls":[{"method":"add_public_key","args":null,"deposit":"1"}],"logs":["EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"public_key_added\",\"data\":{\"account_id\":\"c-1.incorpr.near\",\"public_key\":\"ed25519:B6BrxvWsAqduvmCdx9Ygs4VLBZDdNayvrX68fdhCqqoa\"}}"],"ok":true,"failure":null},{"id":"8oW4v297x18BFvopJgFZgizZW4Wos4bxEG2qj2TJ8HcP","predecessor":"c-1.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223350264,"timestampMs":1793988011488,"calls":[{"method":"on_intents_key_added","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"intents_key_registered\",\"data\":[{\"public_key\":\"ed25519:B6BrxvWsAqduvmCdx9Ygs4VLBZDdNayvrX68fdhCqqoa\"}]}"],"ok":true,"failure":null}]},
  {"hash":"G4ypF62jpoeNcacqwGLpcmMoDmQBwh82M7RxVrELCdiQ","signer":"demo-buyer.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223350276,"timestampMs":1793988018001,"receipts":[{"id":"E4ksvfYf2oFYV8RimR84TZ4JrjRUEJrCG1YTicuLWV9o","predecessor":"demo-buyer.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223350277,"timestampMs":1793988018545,"calls":[{"method":"ft_transfer_call","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"A5dqLzS4FjLZkN7b7j24y8qDgNhdC6TxS1Fi8t5Fr27Z","predecessor":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","receiver":"c-1.incorpr.near","blockHeight":223350278,"timestampMs":1793988019007,"calls":[{"method":"ft_on_transfer","args":{"sender_id":"demo-buyer.incorpr.near","amount":"574999","msg":"{\"call_id\":\"71149d8da1bcb7be1276d646456119c4f11d0721a328ad3d5929566b5e826930\"}"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"payment_received\",\"data\":[{\"call_id\":\"71149d8da1bcb7be1276d646456119c4f11d0721a328ad3d5929566b5e826930\",\"payer\":\"demo-buyer.incorpr.near\",\"amount\":\"574999\",\"related_party\":true}]}"],"ok":true,"failure":null},{"id":"HUrNunYG3PeNoNrHhCZjuvBuDkYbq6ktSE9J4s8gF9sL","predecessor":"c-1.incorpr.near","receiver":"incorpr.near","blockHeight":223350279,"timestampMs":1793988019603,"calls":[{"method":"report_metrics","args":{"token_id":"1"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"metrics_reported\",\"data\":[{\"token_id\":\"1\",\"gross\":\"100000\",\"retained\":\"500000\",\"revenue_30d\":\"100000\",\"calls\":1}]}"],"ok":true,"failure":null}]},
  {"hash":"856Sf7uijk8wz7odxtET1L594cp5Ph6hsWupjVRatFCM","signer":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223350283,"timestampMs":1793988021811,"receipts":[{"id":"5ezyeEc2ZEfDbEsuybdqSNrEh5514RpsBn5FNzA4vzyd","predecessor":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223350284,"timestampMs":1793988022433,"calls":[{"method":"agent_deposit_to_intents","args":null,"deposit":"0"}],"logs":[],"ok":true,"failure":null},{"id":"F8k3Etr2VtkMGu5XkYCFByzxtsN9ehiFkNn2LojJymZV","predecessor":"c-1.incorpr.near","receiver":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","blockHeight":223350285,"timestampMs":1793988022874,"calls":[{"method":"ft_transfer_call","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"BVJgZcWRm3bDgLxnbUpwEd9Fd78sZ8UTGv6nu5aaZTPH","predecessor":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","receiver":"intents.near","blockHeight":223350286,"timestampMs":1793988023436,"calls":[{"method":"ft_on_transfer","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_mint\",\"data\":[{\"owner_id\":\"c-1.incorpr.near\",\"token_ids\":[\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\"],\"amounts\":[\"500000\"],\"memo\":\"deposit\"}]}"],"ok":true,"failure":null},{"id":"71pZCDhpe7Z7vupNoEDg8JZFUgygYrzQ4m4bWYVVyPXy","predecessor":"c-1.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223350285,"timestampMs":1793988022874,"calls":[{"method":"on_intents_deposit","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"intents_deposit\",\"data\":[{\"used\":\"500000\",\"restored\":\"0\"}]}"],"ok":true,"failure":null},{"id":"HcsvJC3U5X6hKuYjfahYxYH41xa9vf4anyW3tZ4FQodu","predecessor":"c-1.incorpr.near","receiver":"incorpr.near","blockHeight":223350289,"timestampMs":1793988025173,"calls":[{"method":"report_metrics","args":{"token_id":"1"},"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr\",\"version\":\"1.0.0\",\"event\":\"metrics_reported\",\"data\":[{\"token_id\":\"1\",\"gross\":\"100000\",\"retained\":\"0\",\"revenue_30d\":\"100000\",\"calls\":1}]}"],"ok":true,"failure":null}]},
  {"hash":"4AmTFGH5Lb7KSki1zQeVf65owD2zDTZwCpg4uf9XAkvi","signer":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223350300,"timestampMs":1793988031366,"receipts":[{"id":"XymWsCh9K24CVU742dAGFucE2gW6oMZzv2WD9KZGkRX","predecessor":"operator.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223350301,"timestampMs":1793988031973,"calls":[{"method":"agent_swap_intent","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"incorpr-vault\",\"version\":\"1.0.0\",\"event\":\"intent_requested\",\"data\":[{\"message\":\"{\\\"signer_id\\\":\\\"c-1.incorpr.near\\\",\\\"deadline\\\":\\\"2026-11-06T18:05:31.973Z\\\",\\\"intents\\\":[{\\\"intent\\\":\\\"token_diff\\\",\\\"diff\\\":{\\\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\\\":\\\"-500000\\\",\\\"nep141:sol.omft.near\\\":\\\"5545636\\\"}}]}\",\"nonce\":\"Vij2xgAlKBKzQLGhGm2H5RgxSkg4oX0KxnAiOrW7530=\"}]}"],"ok":true,"failure":null},{"id":"H4SrYqyT1d99FWAoQVEuGvML9fVEQ39nSEnX9vYjeYas","predecessor":"c-1.incorpr.near","receiver":"v1.signer","blockHeight":223350302,"timestampMs":1793988032576,"calls":[{"method":"sign","args":null,"deposit":"1"}],"logs":[],"ok":true,"failure":null},{"id":"8A1EQrrBKFt8eCrRJY4KCqqK7MpTnmsRUhqkrResrM3B","predecessor":"c-1.incorpr.near","receiver":"c-1.incorpr.near","blockHeight":223350302,"timestampMs":1793988032576,"calls":[{"method":"on_intent_signed","args":null,"deposit":"0"}],"logs":[],"ok":true,"failure":null}]},
  {"hash":"6iuhhDuDJ2z3pSzKyuhQNzWX2pxKxyM7itBtL73EwUZP","signer":"intents.near","receiver":"intents.near","blockHeight":223350313,"timestampMs":1793988038553,"receipts":[{"id":"B4PLnvpTVcDkDGmjJEXD6q7Ni9ERKrevxqrErFTmuSpw","predecessor":"intents.near","receiver":"intents.near","blockHeight":223350313,"timestampMs":1793988038553,"calls":[{"method":"execute_intents","args":null,"deposit":"0"}],"logs":["EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"token_diff\",\"data\":[{\"intent_hash\":\"Dn88zwthQXfvSJkm8ac4uwtPnMhHKKQ2e9FwWLkMeMTj\",\"account_id\":\"intentfolio-vault.near\",\"diff\":{\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\":\"499999\",\"nep141:sol.omft.near\":\"-5545642\"},\"fees_collected\":{\"nep141:sol.omft.near\":\"6\"}}]}","EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"token_diff\",\"data\":[{\"intent_hash\":\"3D6TdJdL4cWB6QzUGGnNwyYDsymZfaZmMJPMPj4vVDjS\",\"account_id\":\"c-1.incorpr.near\",\"diff\":{\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\":\"-500000\",\"nep141:sol.omft.near\":\"5545636\"},\"fees_collected\":{\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\":\"1\"}}]}","EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"c-1.incorpr.near\",\"new_owner_id\":\"intentfolio-ops.near\",\"token_ids\":[\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\"],\"amounts\":[\"875\"]},{\"old_owner_id\":\"c-1.incorpr.near\",\"new_owner_id\":\"7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05\",\"token_ids\":[\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\"],\"amounts\":[\"1\"]},{\"old_owner_id\":\"c-1.incorpr.near\",\"new_owner_id\":\"intentfolio-vault.near\",\"token_ids\":[\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\"],\"amounts\":[\"499124\"]},{\"old_owner_id\":\"intentfolio-vault.near\",\"new_owner_id\":\"7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05\",\"token_ids\":[\"nep141:sol.omft.near\"],\"amounts\":[\"6\"]},{\"old_owner_id\":\"intentfolio-vault.near\",\"new_owner_id\":\"c-1.incorpr.near\",\"token_ids\":[\"nep141:sol.omft.near\"],\"amounts\":[\"5545636\"]}]}"],"ok":true,"failure":null}]},
];

describe('results cache', () => {
  it('stays bounded when a client asks for many distinct token ids', async () => {
    clearHistoryCaches();
    // No endpoints: each call answers "unavailable" without any network read, and is still cached.
    const endpoints = { fastnear: null, nearblocks: null, archivalRpc: null };
    for (let i = 0; i < 1200; i += 1) await loadHistory(String(1000 + i), { registryId: 'incorpr.near', endpoints });
    expect(historyCacheSize()).toBeLessThanOrEqual(500);
    expect(historyCacheSize()).toBeGreaterThan(0);
    clearHistoryCaches();
  });
});
