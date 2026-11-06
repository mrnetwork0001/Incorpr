// Per-token history rebuilt from chain data: what a company earned, what it paid out, who held it,
// and every call the vault or registry refused.
//
// Sources. Discovery lists the transactions that touched the vault `c-<id>.<registry>` and the
// registry; each transaction's receipts, logs and outcomes are then read in full:
//   1. FastNEAR transactions API (tx.<net>.fastnear.com): `/v0/account` for discovery, `/v0/transactions`
//      for receipts and logs. Also lists transactions that only name the vault in an event log, which
//      is how intents.near settlements appear.
//   2. Fallback: NearBlocks v3 `/accounts/<id>/receipts` for discovery, archival RPC
//      `EXPERIMENTAL_tx_status` for receipts and logs.
// When neither answers, the result says so. Nothing is filled in.
//
// Trust. Any contract can log `EVENT_JSON:{"standard":"incorpr",...}`. An event counts only when the
// receipt that logged it was executed by the account that owns the standard: `incorpr` and `nep171`
// from the registry, `incorpr-vault` from this token's vault, `dip4` from the intents contract.

import { getNetworkConfig, type NearNetwork } from './near';
import { RegistryClient, VaultClient, type CompanyView, type VaultState } from './contracts';

// ---------------------------------------------------------------------------- Normalized chain data

export interface ChainCall {
  method: string;
  /** Parsed JSON arguments, or null when they are not JSON. */
  args: unknown;
  deposit: string;
}

export interface ChainReceipt {
  id: string;
  predecessor: string;
  /** The account that executed the receipt. */
  receiver: string;
  blockHeight: number;
  timestampMs: number;
  calls: ChainCall[];
  logs: string[];
  ok: boolean;
  /** Execution error text, e.g. `Smart contract panicked: ERR_TOKEN_ENCUMBERED`. Null on success. */
  failure: string | null;
}

export interface ChainTx {
  hash: string;
  signer: string;
  receiver: string;
  blockHeight: number;
  timestampMs: number;
  /** Action receipts in execution order. Gas refunds from `system` are dropped. */
  receipts: ChainReceipt[];
}

const ERR_CODE = /\bERR_[A-Z0-9_]+\b/;

/** `ERR_TOKEN_ENCUMBERED` from a panic message, or null when the text carries no contract code. */
export function errorCode(text: string | null | undefined): string | null {
  return text ? (ERR_CODE.exec(text)?.[0] ?? null) : null;
}

function decodeArgs(b64: unknown): unknown {
  if (typeof b64 !== 'string') return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function failureText(status: unknown): string | null {
  if (!status || typeof status !== 'object' || !('Failure' in status)) return null;
  const failure = (status as { Failure: unknown }).Failure;
  const exec = (failure as { ActionError?: { kind?: { FunctionCallError?: { ExecutionError?: unknown } } } })?.ActionError?.kind
    ?.FunctionCallError?.ExecutionError;
  return typeof exec === 'string' ? exec : JSON.stringify(failure);
}

function callsOf(actions: unknown): ChainCall[] {
  if (!Array.isArray(actions)) return [];
  const calls: ChainCall[] = [];
  for (const action of actions) {
    const fc = (action as { FunctionCall?: { method_name?: unknown; args?: unknown; deposit?: unknown } } | null)?.FunctionCall;
    if (fc && typeof fc.method_name === 'string') {
      calls.push({ method: fc.method_name, args: decodeArgs(fc.args), deposit: String(fc.deposit ?? '0') });
    }
  }
  return calls;
}

const nsToMs = (ns: unknown): number => Math.floor(Number(ns) / 1e6);

/** One entry of FastNEAR `/v0/transactions`. Only the fields read here are typed. */
export interface FastnearTx {
  transaction: { hash: string; signer_id: string; receiver_id: string };
  execution_outcome: { block_height: number; block_timestamp: number | string };
  receipts: {
    receipt: {
      receipt_id: string;
      predecessor_id: string;
      receiver_id: string;
      block_height: number;
      block_timestamp: number | string;
      receipt: { Action?: { actions?: unknown } } & Record<string, unknown>;
    };
    execution_outcome: { outcome: { logs: string[]; status: unknown; executor_id: string } };
  }[];
}

export function fromFastnear(raw: FastnearTx): ChainTx {
  const receipts: ChainReceipt[] = [];
  for (const r of raw.receipts) {
    if (r.receipt.predecessor_id === 'system' || !r.receipt.receipt.Action) continue;
    const failure = failureText(r.execution_outcome.outcome.status);
    receipts.push({
      id: r.receipt.receipt_id,
      predecessor: r.receipt.predecessor_id,
      receiver: r.execution_outcome.outcome.executor_id || r.receipt.receiver_id,
      blockHeight: r.receipt.block_height,
      timestampMs: nsToMs(r.receipt.block_timestamp),
      calls: callsOf(r.receipt.receipt.Action.actions),
      logs: r.execution_outcome.outcome.logs ?? [],
      ok: failure === null,
      failure,
    });
  }
  return {
    hash: raw.transaction.hash,
    signer: raw.transaction.signer_id,
    receiver: raw.transaction.receiver_id,
    blockHeight: raw.execution_outcome.block_height,
    timestampMs: nsToMs(raw.execution_outcome.block_timestamp),
    receipts,
  };
}

/** `EXPERIMENTAL_tx_status` result. RPC outcomes carry block hashes, not times, so times come from discovery. */
export interface RpcTxStatus {
  transaction: { hash: string; signer_id: string; receiver_id: string };
  receipts: { receipt_id: string; predecessor_id: string; receiver_id: string; receipt: { Action?: { actions?: unknown } } }[];
  receipts_outcome: { id: string; outcome: { logs: string[]; status: unknown; executor_id: string } }[];
}

export function fromRpc(raw: RpcTxStatus, at: { blockHeight: number; timestampMs: number }, receiptTimes: Map<string, number>): ChainTx {
  const byId = new Map(raw.receipts.map((r) => [r.receipt_id, r]));
  const receipts: ChainReceipt[] = [];
  for (const o of raw.receipts_outcome) {
    const r = byId.get(o.id);
    if (!r || r.predecessor_id === 'system' || !r.receipt.Action) continue;
    const failure = failureText(o.outcome.status);
    receipts.push({
      id: o.id,
      predecessor: r.predecessor_id,
      receiver: o.outcome.executor_id || r.receiver_id,
      blockHeight: at.blockHeight,
      timestampMs: receiptTimes.get(o.id) ?? at.timestampMs,
      calls: callsOf(r.receipt.Action.actions),
      logs: o.outcome.logs ?? [],
      ok: failure === null,
      failure,
    });
  }
  return {
    hash: raw.transaction.hash,
    signer: raw.transaction.signer_id,
    receiver: raw.transaction.receiver_id,
    blockHeight: at.blockHeight,
    timestampMs: at.timestampMs,
    receipts,
  };
}

// ---------------------------------------------------------------------------- NEP-297 events

export interface NepEvent {
  standard: string;
  version: string;
  event: string;
  /** Always an array. dip4 logs some events with an object here; it is wrapped. */
  data: Record<string, unknown>[];
}

export function parseEventLog(log: string): NepEvent | null {
  if (!log.startsWith('EVENT_JSON:')) return null;
  let value: unknown;
  try {
    value = JSON.parse(log.slice('EVENT_JSON:'.length));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.standard !== 'string' || typeof v.event !== 'string') return null;
  const raw = Array.isArray(v.data) ? v.data : v.data && typeof v.data === 'object' ? [v.data] : [];
  const data = raw.filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === 'object' && !Array.isArray(d));
  return { standard: v.standard, version: typeof v.version === 'string' ? v.version : '', event: v.event, data };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const amt = (v: unknown): string => {
  const s = str(v);
  return s !== null && /^\d+$/.test(s) ? s : '0';
};
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

// ---------------------------------------------------------------------------- Timeline

export type HistoryGroup = 'earned' | 'paid' | 'market' | 'credit' | 'treasury' | 'refused' | 'admin';

export interface Payout {
  account: string;
  amount: string;
  /** Credited to `pending_withdrawals` because the transfer failed. */
  pending: boolean;
}

export type HistoryEvent =
  | { kind: 'incorporated'; founder: string; vault: string }
  | { kind: 'payment'; payer: string; amount: string; callId: string; relatedParty: boolean }
  | { kind: 'payment_refunded'; payer: string; amount: string }
  | { kind: 'service_call'; callId: string; teeChatId: string }
  | { kind: 'compute_paid'; payee: string; amount: string }
  | { kind: 'compute_failed'; amount: string }
  | { kind: 'dividends'; shareholder: string; amount: string }
  | { kind: 'dividends_failed'; shareholder: string; amount: string }
  | { kind: 'listed'; ask: string; seller: string }
  | { kind: 'unlisted'; seller: string }
  | { kind: 'sold'; buyer: string; seller: string; price: string; royalty: string; payouts: Payout[] }
  | { kind: 'offer_funded'; offerId: number; lender: string; principal: string; repayAmount: string; termMs: number }
  | { kind: 'offer_closed'; offerId: number; reason: 'cancelled' | 'evicted' }
  | { kind: 'loan_opened'; lender: string; borrower: string; principal: string; debt: string; dueMs: number; payouts: Payout[] }
  | { kind: 'loan_repaid'; payer: string; debt: string; payouts: Payout[] }
  | { kind: 'auction_started'; startMs: number }
  | { kind: 'auction_settled'; bidder: string; price: string; toLender: string; royalty: string; payouts: Payout[] }
  | { kind: 'collateral_claimed'; lender: string }
  | { kind: 'settlement_failed'; event: string; account: string | null }
  | { kind: 'transferred'; from: string; to: string; memo: string | null }
  | { kind: 'resync'; event: string }
  | { kind: 'treasury_addresses'; epoch: number; btc: string; evm: string; sol: string }
  | { kind: 'epoch_rotated'; epoch: number }
  | { kind: 'intents_key'; publicKey: string }
  | { kind: 'intents_deposit'; used: string; restored: string }
  | { kind: 'intent_signed'; intent: string; diff: Record<string, string> | null; token: string | null; amount: string | null; destination: string | null; deadline: string | null }
  | { kind: 'intent_settled'; intentHash: string; diff: Record<string, string> }
  | { kind: 'raw_signature'; epoch: number; domainId: number; subpath: string; legacy: boolean }
  | { kind: 'policy'; event: string }
  | { kind: 'approval'; event: string; account: string | null }
  | { kind: 'refused'; target: 'vault' | 'registry'; method: string; caller: string; code: string | null; message: string };

export type HistoryKind = HistoryEvent['kind'];

export type HistoryEntry = HistoryEvent & {
  id: string;
  group: HistoryGroup;
  txHash: string;
  receiptId: string;
  blockHeight: number;
  timestampMs: number;
  /** The transaction's signer. */
  signer: string;
};

const GROUP: Record<HistoryKind, HistoryGroup> = {
  incorporated: 'market',
  payment: 'earned',
  payment_refunded: 'refused',
  service_call: 'earned',
  compute_paid: 'paid',
  compute_failed: 'paid',
  dividends: 'paid',
  dividends_failed: 'paid',
  listed: 'market',
  unlisted: 'market',
  sold: 'market',
  offer_funded: 'credit',
  offer_closed: 'credit',
  loan_opened: 'credit',
  loan_repaid: 'credit',
  auction_started: 'credit',
  auction_settled: 'credit',
  collateral_claimed: 'credit',
  settlement_failed: 'refused',
  transferred: 'market',
  resync: 'admin',
  treasury_addresses: 'treasury',
  epoch_rotated: 'treasury',
  intents_key: 'treasury',
  intents_deposit: 'treasury',
  intent_signed: 'treasury',
  intent_settled: 'treasury',
  raw_signature: 'treasury',
  policy: 'admin',
  approval: 'admin',
  refused: 'refused',
};

export interface Holder {
  account: string;
  fromMs: number;
  /** Null for the current holder. */
  toMs: number | null;
  how: 'minted' | 'bought' | 'auction' | 'collateral' | 'transfer';
  /** Sale or winning bid in micro-USDC, when bought. */
  price: string | null;
  memo: string | null;
  txHash: string;
}

export interface EventTotals {
  payments: number;
  /** Of `payments`, those the shareholder made. */
  relatedPayments: number;
  /** Payments from accounts other than the shareholder. Matches `gross_revenue`. */
  gross: string;
  relatedParty: string;
  refundedPayments: number;
  callsServed: number;
  dividends: string;
  computePaid: string;
  depositedToIntents: string;
  /** Sum over payments of `amount * bps / 10000`, the vault's split. Needs `compute_reserve_bps`. */
  reserveBooked: string;
  retainedBooked: string;
  sales: number;
  salesVolume: string;
  royalties: string;
  refused: number;
}

export interface BuildInput {
  tokenId: string;
  registryId: string;
  vaultId: string;
  intentsContract: string | null;
  computeReserveBps: number;
  /**
   * The vault's USDC contract (get_state.usdc_token). A NEP-141 hook's sender_id and amount are
   * the token contract's word only when that contract made the call: anyone can call
   * ft_on_transfer directly with any arguments, and the vault then returns `amount` with no log.
   */
  usdcToken: string;
  txs: ChainTx[];
}

export interface BuiltHistory {
  entries: HistoryEntry[];
  holders: Holder[];
  totals: EventTotals;
  /** `incorpr` or `incorpr-vault` event logs skipped because a contract other than the registry or a vault logged them. */
  untrusted: number;
}

const VAULT_STANDARD = 'incorpr-vault';
const REGISTRY_STANDARD = 'incorpr';

function argTokenId(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const direct = str(a.token_id);
  if (direct !== null) return direct;
  if (typeof a.msg === 'string') {
    try {
      return str((JSON.parse(a.msg) as Record<string, unknown> | null)?.token_id);
    } catch {
      return null;
    }
  }
  return null;
}

function argOfferId(args: unknown): number | null {
  return args && typeof args === 'object' ? int((args as Record<string, unknown>).offer_id) : null;
}

/** Turns the transactions of one token into a timeline, a holder list and totals. Pure. */
export function buildHistory(input: BuildInput): BuiltHistory {
  const { tokenId, registryId, vaultId, intentsContract, usdcToken } = input;
  const txs = [...input.txs].sort((a, b) => a.blockHeight - b.blockHeight || a.timestampMs - b.timestampMs);
  const entries: HistoryEntry[] = [];
  const holders: Holder[] = [];
  const offers = new Set<number>();
  let untrusted = 0;
  let gross = 0n;
  let related = 0n;
  let reserve = 0n;
  let retained = 0n;
  let dividends = 0n;
  let compute = 0n;
  let deposited = 0n;
  let salesVolume = 0n;
  let royalties = 0n;
  let payments = 0;
  let relatedPayments = 0;
  let refunded = 0;
  let calls = 0;
  let sales = 0;
  const bps = BigInt(input.computeReserveBps);
  const siblingVault = new RegExp(`^c-\\d+\\.${registryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

  for (const tx of txs) {
    const add = (r: ChainReceipt, index: number, event: HistoryEvent) => {
      entries.push({ ...event, id: `${r.id}:${index}`, group: GROUP[event.kind], txHash: tx.hash, receiptId: r.id, blockHeight: r.blockHeight || tx.blockHeight, timestampMs: r.timestampMs || tx.timestampMs, signer: tx.signer });
    };
    const payouts: Payout[] = [];
    let payoutTarget: { payouts: Payout[] } | null = null;
    const transfers: { r: ChainReceipt; i: number; from: string; to: string; memo: string | null }[] = [];
    let mint: { r: ChainReceipt; owner: string } | null = null;
    let market: { how: Holder['how']; price: string | null } | null = null;
    let relevant = false;

    for (const r of tx.receipts) {
      const call = r.calls[0];
      // Arguments name the token on registry calls: token_id, an offer of this token, or msg.token_id.
      if (r.receiver === registryId && call) {
        const offerId = argOfferId(call.args);
        if (argTokenId(call.args) === tokenId || (offerId !== null && offers.has(offerId))) relevant = true;
      }
      if (r.receiver === vaultId) relevant = true;

      r.logs.forEach((log, i) => {
        const ev = parseEventLog(log);
        if (!ev) return;
        const d = ev.data[0] ?? {};
        if (ev.standard === VAULT_STANDARD && r.receiver !== vaultId) {
          // Another company's vault is legitimate but not this token's; anything else is a forgery.
          if (!siblingVault.test(r.receiver)) untrusted += 1;
          return;
        }
        if (ev.standard === REGISTRY_STANDARD && r.receiver !== registryId) {
          untrusted += 1;
          return;
        }
        if (ev.standard === 'nep171' && r.receiver !== registryId) return;
        if (ev.standard === VAULT_STANDARD) {
          relevant = true;
          switch (ev.event) {
            case 'payment_received': {
              const amount = amt(d.amount);
              const relatedParty = d.related_party === true;
              payments += 1;
              const cut = (BigInt(amount) * bps) / 10_000n;
              reserve += cut;
              retained += BigInt(amount) - cut;
              if (relatedParty) {
                related += BigInt(amount);
                relatedPayments += 1;
              }
              if (!relatedParty) gross += BigInt(amount);
              add(r, i, { kind: 'payment', payer: str(d.payer) ?? '', amount, callId: str(d.call_id) ?? '', relatedParty });
              return;
            }
            case 'service_call_recorded':
              calls += 1;
              add(r, i, { kind: 'service_call', callId: str(d.call_id) ?? '', teeChatId: str(d.tee_chat_id) ?? '' });
              return;
            case 'compute_bill_paid':
              compute += BigInt(amt(d.amount));
              add(r, i, { kind: 'compute_paid', payee: str(d.payee) ?? '', amount: amt(d.amount) });
              return;
            case 'compute_bill_failed':
              add(r, i, { kind: 'compute_failed', amount: amt(d.amount) });
              return;
            case 'dividends_claimed':
              dividends += BigInt(amt(d.amount));
              add(r, i, { kind: 'dividends', shareholder: str(d.shareholder) ?? '', amount: amt(d.amount) });
              return;
            case 'dividends_failed':
              add(r, i, { kind: 'dividends_failed', shareholder: str(d.shareholder) ?? '', amount: amt(d.amount) });
              return;
            case 'intents_deposit':
              deposited += BigInt(amt(d.used));
              add(r, i, { kind: 'intents_deposit', used: amt(d.used), restored: amt(d.restored) });
              return;
            case 'intent_requested':
              add(r, i, intentSigned(str(d.message)));
              return;
            case 'treasury_addresses_set':
              add(r, i, { kind: 'treasury_addresses', epoch: int(d.epoch) ?? 0, btc: str(d.btc) ?? '', evm: str(d.evm) ?? '', sol: str(d.sol) ?? '' });
              return;
            case 'treasury_epoch_rotated':
              add(r, i, { kind: 'epoch_rotated', epoch: int(d.epoch) ?? 0 });
              return;
            case 'intents_key_registered':
              add(r, i, { kind: 'intents_key', publicKey: str(d.public_key) ?? '' });
              return;
            case 'raw_signature_requested':
            case 'legacy_signature_requested':
              add(r, i, { kind: 'raw_signature', epoch: int(d.epoch) ?? 0, domainId: int(d.domain_id) ?? 0, subpath: str(d.subpath) ?? '', legacy: ev.event === 'legacy_signature_requested' });
              return;
            case 'operator_set':
            case 'tee_signers_set':
            case 'policy_set':
            case 'tee_policy_set':
            case 'price_floors_set':
              add(r, i, { kind: 'policy', event: ev.event });
              return;
            default:
              // transit_begun, encumbrance_applied, owner_synced: settlement steps that the registry
              // events of the same transaction describe.
              return;
          }
        }
        if (ev.standard === 'nep171') {
          const ids = Array.isArray(d.token_ids) ? d.token_ids.map(String) : [];
          if (!ids.includes(tokenId)) return;
          relevant = true;
          if (ev.event === 'nft_mint') mint = { r, owner: str(d.owner_id) ?? '' };
          if (ev.event === 'nft_transfer') transfers.push({ r, i, from: str(d.old_owner_id) ?? '', to: str(d.new_owner_id) ?? '', memo: str(d.memo) });
          return;
        }
        if (ev.standard === REGISTRY_STANDARD) {
          if (ev.event === 'payout_paid' || ev.event === 'payout_pending') {
            payouts.push({ account: str(d.account) ?? '', amount: amt(d.amount), pending: ev.event === 'payout_pending' });
            return;
          }
          if (str(d.token_id) !== tokenId) return;
          relevant = true;
          switch (ev.event) {
            case 'company_incorporated':
              add(r, i, { kind: 'incorporated', founder: str(d.founder) ?? '', vault: str(d.vault) ?? '' });
              return;
            case 'company_listed':
              add(r, i, { kind: 'listed', ask: amt(d.ask), seller: tx.signer });
              return;
            case 'company_unlisted':
              add(r, i, { kind: 'unlisted', seller: tx.signer });
              return;
            case 'company_acquired': {
              const event = { kind: 'sold' as const, buyer: str(d.buyer) ?? '', seller: str(d.seller) ?? '', price: amt(d.price), royalty: amt(d.royalty), payouts: [] as Payout[] };
              sales += 1;
              salesVolume += BigInt(event.price);
              royalties += BigInt(event.royalty);
              market = { how: 'bought', price: event.price };
              payoutTarget = event;
              add(r, i, event);
              return;
            }
            case 'offer_funded': {
              const offerId = int(d.offer_id) ?? -1;
              offers.add(offerId);
              add(r, i, { kind: 'offer_funded', offerId, lender: str(d.lender) ?? '', principal: amt(d.principal), repayAmount: amt(d.repay_amount), termMs: int(d.term_ms) ?? 0 });
              return;
            }
            case 'offer_cancelled':
            case 'offer_evicted':
              add(r, i, { kind: 'offer_closed', offerId: int(d.offer_id) ?? -1, reason: ev.event === 'offer_cancelled' ? 'cancelled' : 'evicted' });
              return;
            case 'loan_opened': {
              const event = { kind: 'loan_opened' as const, lender: str(d.lender) ?? '', borrower: str(d.borrower) ?? '', principal: amt(d.principal), debt: amt(d.debt), dueMs: int(d.due_ms) ?? 0, payouts: [] as Payout[] };
              payoutTarget = event;
              add(r, i, event);
              return;
            }
            case 'loan_repaid': {
              const event = { kind: 'loan_repaid' as const, payer: str(d.payer) ?? '', debt: amt(d.debt), payouts: [] as Payout[] };
              payoutTarget = event;
              add(r, i, event);
              return;
            }
            case 'auction_started':
              add(r, i, { kind: 'auction_started', startMs: int(d.start_ms) ?? 0 });
              return;
            case 'auction_settled': {
              const event = { kind: 'auction_settled' as const, bidder: str(d.bidder) ?? '', price: amt(d.price), toLender: amt(d.to_lender), royalty: amt(d.royalty), payouts: [] as Payout[] };
              royalties += BigInt(event.royalty);
              market = { how: 'auction', price: event.price };
              payoutTarget = event;
              add(r, i, event);
              return;
            }
            case 'collateral_claimed':
              market = { how: 'collateral', price: null };
              add(r, i, { kind: 'collateral_claimed', lender: str(d.lender) ?? '' });
              return;
            case 'listing_failed':
            case 'acquisition_failed':
            case 'pledge_failed':
            case 'repay_failed':
            case 'bid_failed':
              add(r, i, { kind: 'settlement_failed', event: ev.event, account: str(d.buyer) ?? str(d.payer) ?? str(d.bidder) ?? null });
              return;
            case 'vault_resync_required':
            case 'vault_resynced':
              add(r, i, { kind: 'resync', event: ev.event });
              return;
            case 'approval_set':
            case 'approval_revoked':
            case 'approvals_revoked':
              add(r, i, { kind: 'approval', event: ev.event, account: str(d.account_id) });
              return;
            default:
              return;
          }
        }
        if (ev.standard === 'dip4' && intentsContract && r.receiver === intentsContract && ev.event === 'token_diff') {
          for (const item of ev.data) {
            if (item.account_id !== vaultId || !item.diff || typeof item.diff !== 'object') continue;
            const diff = Object.fromEntries(Object.entries(item.diff as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
            relevant = true;
            add(r, i, { kind: 'intent_settled', intentHash: str(item.intent_hash) ?? '', diff });
          }
        }
      });
    }

    if (!relevant) continue;

    // Refusals: a failed receipt on the vault, or on the registry in a transaction about this token.
    for (const r of tx.receipts) {
      const call = r.calls[0];
      const onVault = r.receiver === vaultId;
      if (!onVault && r.receiver !== registryId) continue;
      if (!r.ok) {
        add(r, 900, { kind: 'refused', target: onVault ? 'vault' : 'registry', method: call?.method ?? 'unknown', caller: r.predecessor, code: errorCode(r.failure), message: r.failure ?? '' });
        continue;
      }
      // A NEP-141 hook called by anything but the USDC contract moved no tokens, and its sender_id and
      // amount are the caller's own words. Both contracts return early for it; it is not a payment.
      if (call?.method === 'ft_on_transfer' && r.predecessor !== usdcToken) continue;
      // A registry NEP-141 hook that refunds logs its reason as plain text and succeeds.
      if (!onVault && call?.method === 'ft_on_transfer' && argTokenId(call.args) === tokenId) {
        const reason = r.logs.find((l) => !l.startsWith('EVENT_JSON:') && errorCode(l));
        if (reason) {
          const args = call.args as Record<string, unknown>;
          add(r, 900, { kind: 'refused', target: 'registry', method: 'ft_on_transfer', caller: str(args.sender_id) ?? r.predecessor, code: errorCode(reason), message: reason });
        }
      }
      // The vault returns the whole amount for a payment it does not book (below price, bad msg, reused call id).
      if (onVault && call?.method === 'ft_on_transfer' && !r.logs.some((l) => l.includes('"payment_received"'))) {
        const args = (call.args ?? {}) as Record<string, unknown>;
        refunded += 1;
        add(r, 901, { kind: 'payment_refunded', payer: str(args.sender_id) ?? '', amount: amt(args.amount) });
      }
    }

    if (payoutTarget) (payoutTarget as { payouts: Payout[] }).payouts.push(...payouts);

    const minted = mint as { r: ChainReceipt; owner: string } | null;
    if (minted) {
      holders.push({ account: minted.owner, fromMs: minted.r.timestampMs || tx.timestampMs, toMs: null, how: 'minted', price: null, memo: null, txHash: tx.hash });
    }
    const sale = market as { how: Holder['how']; price: string | null } | null;
    for (const t of transfers) {
      const at = t.r.timestampMs || tx.timestampMs;
      const last = holders[holders.length - 1];
      if (last && last.toMs === null) last.toMs = at;
      holders.push({ account: t.to, fromMs: at, toMs: null, how: sale?.how ?? 'transfer', price: sale?.price ?? null, memo: t.memo, txHash: tx.hash });
      // A plain transfer has no market event that already describes it.
      if (!sale) add(t.r, t.i, { kind: 'transferred', from: t.from, to: t.to, memo: t.memo });
    }
  }

  entries.sort((a, b) => a.blockHeight - b.blockHeight || a.timestampMs - b.timestampMs);
  return {
    entries,
    holders,
    untrusted,
    totals: {
      payments,
      relatedPayments,
      gross: gross.toString(),
      relatedParty: related.toString(),
      refundedPayments: refunded,
      callsServed: calls,
      dividends: dividends.toString(),
      computePaid: compute.toString(),
      depositedToIntents: deposited.toString(),
      reserveBooked: reserve.toString(),
      retainedBooked: retained.toString(),
      sales,
      salesVolume: salesVolume.toString(),
      royalties: royalties.toString(),
      refused: entries.filter((e) => e.kind === 'refused').length,
    },
  };
}

function intentSigned(message: string | null): HistoryEvent {
  const base = { kind: 'intent_signed' as const, intent: 'unknown', diff: null, token: null, amount: null, destination: null, deadline: null };
  if (!message) return base;
  try {
    const m = JSON.parse(message) as { deadline?: unknown; intents?: Record<string, unknown>[] };
    const first = m.intents?.[0] ?? {};
    const diff = first.diff && typeof first.diff === 'object' ? Object.fromEntries(Object.entries(first.diff as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : null;
    const memo = str(first.memo);
    return {
      ...base,
      intent: str(first.intent) ?? 'unknown',
      diff,
      token: str(first.token),
      amount: str(first.amount),
      destination: memo?.startsWith('WITHDRAW_TO:') ? memo.slice('WITHDRAW_TO:'.length) : null,
      deadline: str(m.deadline),
    };
  } catch {
    return base;
  }
}

// ---------------------------------------------------------------------------- Reconciliation

export interface ReconcileRow {
  field: string;
  /** What the events add up to. */
  fromEvents: string;
  /** What the vault view says now. */
  fromView: string;
  matches: boolean;
}

export type ReconcileView = Pick<
  VaultState,
  'gross_revenue' | 'related_party_revenue' | 'api_calls_served' | 'dividends_paid' | 'compute_paid' | 'deposited_to_intents' | 'compute_reserve' | 'retained_earnings'
>;

/**
 * Compares event sums with `get_state`. `compute_reserve` and `retained_earnings` are rebuilt from the
 * vault's split (`amount * compute_reserve_bps / 10000` to the reserve) minus what left each bucket.
 */
export function reconcile(totals: EventTotals, view: ReconcileView): ReconcileRow[] {
  const reserve = BigInt(totals.reserveBooked) - BigInt(totals.computePaid);
  const retained = BigInt(totals.retainedBooked) - BigInt(totals.dividends) - BigInt(totals.depositedToIntents);
  const rows: [string, string, string][] = [
    ['gross_revenue', totals.gross, view.gross_revenue],
    ['related_party_revenue', totals.relatedParty, view.related_party_revenue],
    ['api_calls_served', String(totals.callsServed), String(view.api_calls_served)],
    ['dividends_paid', totals.dividends, view.dividends_paid],
    ['compute_paid', totals.computePaid, view.compute_paid],
    ['deposited_to_intents', totals.depositedToIntents, view.deposited_to_intents],
    ['compute_reserve', reserve.toString(), view.compute_reserve],
    ['retained_earnings', retained.toString(), view.retained_earnings],
  ];
  return rows.map(([field, fromEvents, fromView]) => ({ field, fromEvents, fromView, matches: BigInt(fromEvents) === BigInt(fromView) }));
}

// ---------------------------------------------------------------------------- Fetching

export interface HistoryEndpoints {
  fastnear: string | null;
  nearblocks: string | null;
  archivalRpc: string | null;
}

export function historyEndpoints(network: NearNetwork): HistoryEndpoints {
  if (network === 'mainnet') {
    return { fastnear: 'https://tx.main.fastnear.com', nearblocks: 'https://api.nearblocks.io', archivalRpc: 'https://archival-rpc.mainnet.fastnear.com' };
  }
  if (network === 'testnet') {
    return { fastnear: 'https://tx.test.fastnear.com', nearblocks: 'https://api-testnet.nearblocks.io', archivalRpc: 'https://archival-rpc.testnet.fastnear.com' };
  }
  // No public indexer reads a local sandbox.
  return { fastnear: null, nearblocks: null, archivalRpc: null };
}

export class HistorySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistorySourceError';
  }
}

interface Discovered {
  hash: string;
  account: string;
  blockHeight: number;
  timestampMs: number;
  /** NearBlocks receipts only: receipt id to block time. */
  receiptTimes?: Map<string, number>;
}

export interface AccountScan {
  account: string;
  transactions: number;
  /** False when the page cap stopped the scan before the oldest transaction. */
  complete: boolean;
}

/** Per account. 200 per page on FastNEAR, 100 on NearBlocks. */
const MAX_PAGES = 10;
const TIMEOUT_MS = 12_000;

/** Optional. The public FastNEAR tier answers HTTP 429 under load; a key raises the limit. */
function fastnearHeaders(url: string): Record<string, string> {
  const key = process.env.FASTNEAR_API_KEY;
  return key && url.includes('fastnear.com/v0/') ? { authorization: `Bearer ${key}` } : {};
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...fastnearHeaders(url) },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // One retry after a rate limit, then the caller falls back to the next source.
    if (res.status === 429 && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      continue;
    }
    if (!res.ok) throw new HistorySourceError(`${new URL(url).host} answered HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new HistorySourceError(`${new URL(url).host} answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

/** Final transactions do not change, so their bodies are kept for the life of the process. */
const txCache = new Map<string, ChainTx>();
const TX_CACHE_MAX = 5_000;

/** Empties both caches, so a test can read each source from the network. */
export function clearHistoryCaches(): void {
  txCache.clear();
  results.clear();
}

function remember(tx: ChainTx): ChainTx {
  txCache.set(tx.hash, tx);
  if (txCache.size > TX_CACHE_MAX) {
    const oldest = txCache.keys().next().value;
    if (oldest !== undefined) txCache.delete(oldest);
  }
  return tx;
}

interface FastnearAccountPage {
  account_txs?: { transaction_hash: string; tx_block_height: number; tx_block_timestamp: string }[];
  resume_token?: string | null;
}

async function fastnearDiscover(base: string, account: string): Promise<{ found: Discovered[]; scan: AccountScan }> {
  const found: Discovered[] = [];
  let resume: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: FastnearAccountPage = await postJson<FastnearAccountPage>(`${base}/v0/account`, { account_id: account, limit: 200, ...(resume ? { resume_token: resume } : {}) });
    if (!Array.isArray(body.account_txs)) throw new HistorySourceError('FastNEAR returned no account_txs');
    for (const t of body.account_txs) found.push({ hash: t.transaction_hash, account, blockHeight: t.tx_block_height, timestampMs: nsToMs(t.tx_block_timestamp) });
    resume = body.resume_token ?? null;
    if (!resume) return { found, scan: { account, transactions: found.length, complete: true } };
  }
  return { found, scan: { account, transactions: found.length, complete: false } };
}

async function fastnearDetails(base: string, hashes: string[]): Promise<ChainTx[]> {
  const missing = hashes.filter((h) => !txCache.has(h));
  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += 20) batches.push(missing.slice(i, i + 20));
  await mapLimit(batches, 3, async (batch) => {
    const body = await postJson<{ transactions?: FastnearTx[] }>(`${base}/v0/transactions`, { tx_hashes: batch });
    if (!Array.isArray(body.transactions)) throw new HistorySourceError('FastNEAR returned no transactions');
    for (const raw of body.transactions) remember(fromFastnear(raw));
  });
  return hashes.map((h) => txCache.get(h)).filter((t): t is ChainTx => t !== undefined);
}

interface NearblocksReceiptPage {
  data?: { transaction_hash: string; receipt_id: string; block: { block_height: string | number; block_timestamp: string } }[];
  meta?: { next_page?: string | null };
}

async function nearblocksDiscover(base: string, account: string): Promise<{ found: Discovered[]; scan: AccountScan }> {
  const byHash = new Map<string, Discovered>();
  let next: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${base}/v3/accounts/${encodeURIComponent(account)}/receipts?limit=100${next ? `&next=${encodeURIComponent(next)}` : ''}`;
    const body: NearblocksReceiptPage = await getJson<NearblocksReceiptPage>(url);
    if (!Array.isArray(body.data)) throw new HistorySourceError('NearBlocks returned no data');
    for (const r of body.data) {
      const ts = nsToMs(r.block.block_timestamp);
      const height = Number(r.block.block_height);
      const entry = byHash.get(r.transaction_hash) ?? { hash: r.transaction_hash, account, blockHeight: height, timestampMs: ts, receiptTimes: new Map() };
      if (height < entry.blockHeight) {
        entry.blockHeight = height;
        entry.timestampMs = ts;
      }
      entry.receiptTimes?.set(r.receipt_id, ts);
      byHash.set(r.transaction_hash, entry);
    }
    next = body.meta?.next_page ?? null;
    if (!next) return { found: [...byHash.values()], scan: { account, transactions: byHash.size, complete: true } };
  }
  return { found: [...byHash.values()], scan: { account, transactions: byHash.size, complete: false } };
}

async function rpcDetails(rpcUrl: string, found: Discovered[]): Promise<ChainTx[]> {
  return mapLimit(found, 4, async (d) => {
    const cached = txCache.get(d.hash);
    if (cached) return cached;
    // The archival node routes by hash; sender_account_id only has to be an account in the transaction.
    const body = await postJson<{ result?: RpcTxStatus; error?: { message?: string } }>(rpcUrl, {
      jsonrpc: '2.0',
      id: 'history',
      method: 'EXPERIMENTAL_tx_status',
      params: { tx_hash: d.hash, sender_account_id: d.account, wait_until: 'NONE' },
    });
    if (!body.result) throw new HistorySourceError(`archival RPC: ${body.error?.message ?? 'no result'} for ${d.hash}`);
    return remember(fromRpc(body.result, d, d.receiptTimes ?? new Map()));
  });
}

export interface SourceRead {
  name: 'FastNEAR transactions API' | 'NearBlocks v3 + archival RPC';
  hosts: string[];
  scans: AccountScan[];
  txs: ChainTx[];
  /** Listed by discovery but not returned in full, e.g. not indexed yet. */
  missing: number;
  /** Why the first source was skipped, when the fallback answered. */
  fallbackReason: string | null;
}

/** Reads every transaction that touched `accounts`, from FastNEAR or else NearBlocks plus archival RPC. */
export async function readTransactions(accounts: string[], endpoints: HistoryEndpoints): Promise<SourceRead> {
  let fallbackReason: string | null = null;
  if (endpoints.fastnear) {
    try {
      const scans = await Promise.all(accounts.map((a) => fastnearDiscover(endpoints.fastnear as string, a)));
      const hashes = [...new Set(scans.flatMap((s) => s.found.map((f) => f.hash)))];
      const txs = await fastnearDetails(endpoints.fastnear, hashes);
      return {
        name: 'FastNEAR transactions API',
        hosts: [new URL(endpoints.fastnear).host],
        scans: scans.map((s) => s.scan),
        txs,
        missing: hashes.length - txs.length,
        fallbackReason: null,
      };
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
    }
  }
  if (endpoints.nearblocks && endpoints.archivalRpc) {
    const scans = [];
    // NearBlocks' public tier is rate limited; one account at a time.
    for (const a of accounts) scans.push(await nearblocksDiscover(endpoints.nearblocks, a));
    const byHash = new Map<string, Discovered>();
    for (const s of scans) for (const f of s.found) if (!byHash.has(f.hash)) byHash.set(f.hash, f);
    const txs = await rpcDetails(endpoints.archivalRpc, [...byHash.values()]);
    return {
      name: 'NearBlocks v3 + archival RPC',
      hosts: [new URL(endpoints.nearblocks).host, new URL(endpoints.archivalRpc).host],
      scans: scans.map((s) => s.scan),
      txs,
      missing: 0,
      fallbackReason,
    };
  }
  throw new HistorySourceError(fallbackReason ?? 'No transaction index is configured for this network');
}

// ---------------------------------------------------------------------------- Loading, with a cache

export interface HistoryReady {
  status: 'ok';
  network: NearNetwork;
  tokenId: string;
  registryId: string;
  vaultId: string;
  source: Omit<SourceRead, 'txs'> & { transactions: number };
  entries: HistoryEntry[];
  holders: Holder[];
  totals: EventTotals;
  reconciliation: ReconcileRow[];
  /** `nft_token` owner now, for comparison with the last holder from events. */
  currentOwner: string;
  untrustedLogs: number;
  /** True when every account scan reached its oldest transaction and every body was read. */
  complete: boolean;
  readAtMs: number;
}

export interface HistoryUnavailable {
  status: 'unavailable';
  network: NearNetwork;
  tokenId: string;
  reason: string;
  readAtMs: number;
}

export interface HistoryNotFound {
  status: 'not_found';
  network: NearNetwork;
  tokenId: string;
  registryId: string;
  readAtMs: number;
}

export type HistoryResult = HistoryReady | HistoryUnavailable | HistoryNotFound;

export interface LoadOptions {
  registryId?: string;
  endpoints?: HistoryEndpoints;
  /** Skip the cache, e.g. in tests. */
  fresh?: boolean;
}

const TTL_MS = 60_000;
const ERROR_TTL_MS = 15_000;
const RESULTS_MAX = 500;
const results = new Map<string, { at: number; ttl: number; value: Promise<HistoryResult> }>();

/** Drops expired results, then the oldest ones past RESULTS_MAX, so random token ids cannot grow the map. */
function pruneResults(now: number) {
  for (const [key, entry] of results) if (now - entry.at >= entry.ttl) results.delete(key);
  while (results.size >= RESULTS_MAX) {
    const oldest = results.keys().next().value;
    if (oldest === undefined) break;
    results.delete(oldest);
  }
}

/** Number of cached results. For tests. */
export function historyCacheSize(): number {
  return results.size;
}

export function loadHistory(tokenId: string, options: LoadOptions = {}): Promise<HistoryResult> {
  const config = getNetworkConfig();
  const network = config.network;
  const registryId = options.registryId ?? config.registryId;
  const key = `${network}:${registryId}:${tokenId}`;
  const hit = results.get(key);
  if (!options.fresh && hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = readHistory(tokenId, network, registryId, options.endpoints ?? historyEndpoints(network), config.intentsContract);
  const entry = { at: Date.now(), ttl: TTL_MS, value };
  results.delete(key);
  pruneResults(entry.at);
  results.set(key, entry);
  void value.then((r) => {
    if (r.status !== 'ok') entry.ttl = ERROR_TTL_MS;
  });
  return value;
}

async function readHistory(
  tokenId: string,
  network: NearNetwork,
  registryId: string | null,
  endpoints: HistoryEndpoints,
  intentsContract: string | null,
): Promise<HistoryResult> {
  const readAtMs = Date.now();
  if (!registryId) return { status: 'unavailable', network, tokenId, reason: 'No registry is configured (NEXT_PUBLIC_REGISTRY_CONTRACT_ID).', readAtMs };
  if (!endpoints.fastnear && !endpoints.nearblocks) {
    return { status: 'unavailable', network, tokenId, reason: `No public transaction index covers the ${network} network.`, readAtMs };
  }
  let company: CompanyView | null;
  let state: VaultState;
  try {
    company = await new RegistryClient(registryId).getCompany(tokenId);
    if (!company) return { status: 'not_found', network, tokenId, registryId, readAtMs };
    state = await new VaultClient(company.vault).getState();
  } catch (error) {
    return { status: 'unavailable', network, tokenId, reason: `Could not read the vault views: ${error instanceof Error ? error.message : String(error)}`, readAtMs };
  }
  let read: SourceRead;
  try {
    read = await readTransactions([company.vault, registryId], endpoints);
  } catch (error) {
    return { status: 'unavailable', network, tokenId, reason: error instanceof Error ? error.message : String(error), readAtMs };
  }
  const built = buildHistory({
    tokenId,
    registryId,
    vaultId: company.vault,
    intentsContract: state.intents_contract || intentsContract,
    computeReserveBps: state.compute_reserve_bps,
    usdcToken: state.usdc_token,
    txs: read.txs,
  });
  const { txs, ...source } = read;
  return {
    status: 'ok',
    network,
    tokenId,
    registryId,
    vaultId: company.vault,
    source: { ...source, transactions: txs.length },
    entries: built.entries,
    holders: built.holders,
    totals: built.totals,
    reconciliation: reconcile(built.totals, state),
    currentOwner: company.owner_id,
    untrustedLogs: built.untrusted,
    complete: read.missing === 0 && read.scans.every((s) => s.complete),
    readAtMs,
  };
}
