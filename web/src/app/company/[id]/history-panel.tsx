'use client';

// Per-token history: who held the company, what it earned, what it paid out and what the contracts
// refused. Read from /api/history, which rebuilds it from the registry's and vault's event logs.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { HistoryEntry, HistoryGroup, HistoryReady, HistoryResult, Holder, Payout } from '@/lib/history';
import { Address, Button, Glass, GlassHeader, Notice, SkeletonText, Stat, StatGrid, Tabs, TxHash } from '../../ui';
import { assetName, formatAsset, formatTime, formatUsdc } from './format';
import h from './history-panel.module.css';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; result: HistoryResult };

const PAGE = 40;

function Acct({ id }: { id: string }) {
  return id ? <Address value={id} /> : <span>unknown account</span>;
}

function usdc(micro: string): string {
  return `${formatUsdc(micro)} USDC`;
}

function days(ms: number): string {
  const d = ms / 86_400_000;
  return Number.isInteger(d) ? `${d} day${d === 1 ? '' : 's'}` : `${(ms / 3_600_000).toFixed(1)} hours`;
}

function shortId(id: string): string {
  return id.length > 32 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

function diffText(diff: Record<string, string>, usdcToken: string): string {
  return Object.entries(diff)
    .map(([asset, raw]) => {
      const negative = raw.startsWith('-');
      const abs = negative ? raw.slice(1) : raw;
      return `${negative ? '-' : '+'}${/^\d+$/.test(abs) ? formatAsset(abs, asset, usdcToken) : `${abs} ${assetName(asset, usdcToken)}`}`;
    })
    .join(', ');
}

function PayoutList({ payouts }: { payouts: Payout[] }) {
  if (payouts.length === 0) return null;
  return (
    <span className={h.detail}>
      Paid out:{' '}
      {payouts.map((p, i) => (
        <span key={i}>
          {i > 0 && '; '}
          {usdc(p.amount)} to {shortId(p.account)}
          {p.pending && ' (transfer failed, held in pending_withdrawals)'}
        </span>
      ))}
    </span>
  );
}

interface Described {
  title: ReactNode;
  body: ReactNode;
  detail?: ReactNode;
  amount?: { text: string; tone: 'in' | 'out' | 'neutral' };
}

/** Plain sentence for each event kind. Amounts stay in base units until formatted here. */
function describe(e: HistoryEntry, usdcToken: string): Described {
  switch (e.kind) {
    case 'incorporated':
      return { title: 'Incorporated', body: <>Minted to <Acct id={e.founder} /></>, detail: `vault ${e.vault}` };
    case 'payment':
      return {
        title: e.relatedParty ? 'Payment from the shareholder' : 'Customer payment',
        body: e.relatedParty ? (
          <>
            <Acct id={e.payer} /> paid while holding the company. Booked to related_party_revenue, excluded from revenue.
          </>
        ) : (
          <>
            <Acct id={e.payer} /> paid for one call
          </>
        ),
        detail: `call_id ${e.callId}`,
        amount: { text: `+${usdc(e.amount)}`, tone: 'in' },
      };
    case 'payment_refunded':
      return {
        title: 'Payment refunded',
        body: <><Acct id={e.payer} /> sent {usdc(e.amount)}. The vault returned it in full: below the price, an invalid msg or a reused call_id.</>,
      };
    case 'service_call':
      return { title: 'Call served', body: 'The operator marked the paid call served.', detail: `call_id ${e.callId} · TEE chat ${e.teeChatId}` };
    case 'compute_paid':
      return { title: 'Compute paid', body: <>From the compute reserve to <Acct id={e.payee} /></>, amount: { text: `-${usdc(e.amount)}`, tone: 'out' } };
    case 'compute_failed':
      return { title: 'Compute payment failed', body: `The transfer failed and ${usdc(e.amount)} went back to the reserve.` };
    case 'dividends':
      return { title: 'Dividends claimed', body: <>Retained earnings paid to <Acct id={e.shareholder} /></>, amount: { text: `-${usdc(e.amount)}`, tone: 'out' } };
    case 'dividends_failed':
      return { title: 'Dividend transfer failed', body: <>{usdc(e.amount)} to <Acct id={e.shareholder} /> failed and went back to retained earnings.</> };
    case 'listed':
      return { title: 'Listed for sale', body: <>The vault froze claims, signing and the agent. Listed by <Acct id={e.seller} /></>, amount: { text: `ask ${usdc(e.ask)}`, tone: 'neutral' } };
    case 'unlisted':
      return { title: 'Delisted', body: <>Listing withdrawn by <Acct id={e.seller} /></> };
    case 'sold':
      return {
        title: 'Sold',
        body: (
          <>
            Royalty {usdc(e.royalty)} to the founder. <Acct id={e.buyer} /> bought it from <Acct id={e.seller} />
          </>
        ),
        detail: <PayoutList payouts={e.payouts} />,
        amount: { text: usdc(e.price), tone: 'neutral' },
      };
    case 'offer_funded':
      return {
        title: `Loan offer #${e.offerId} funded`,
        body: <><Acct id={e.lender} /> offered {usdc(e.principal)}, repay {usdc(e.repayAmount)} within {days(e.termMs)}.</>,
      };
    case 'offer_closed':
      return { title: `Loan offer #${e.offerId} ${e.reason}`, body: e.reason === 'cancelled' ? 'The lender took the principal back.' : 'A larger offer replaced it; the lender was refunded.' };
    case 'loan_opened':
      return {
        title: 'Pledged: loan opened',
        body: (
          <>
            Owes {usdc(e.debt)} by {formatTime(e.dueMs)}. <Acct id={e.borrower} /> borrowed {usdc(e.principal)} from <Acct id={e.lender} />
          </>
        ),
        detail: <PayoutList payouts={e.payouts} />,
      };
    case 'loan_repaid':
      return { title: 'Loan repaid', body: <><Acct id={e.payer} /> repaid {usdc(e.debt)}. The company is free again.</>, detail: <PayoutList payouts={e.payouts} /> };
    case 'auction_started':
      return { title: 'Default: auction started', body: `The loan passed its due date. The Dutch auction started ${formatTime(e.startMs)}.` };
    case 'auction_settled':
      return {
        title: 'Auction settled',
        body: <><Acct id={e.bidder} /> won the auction. {usdc(e.toLender)} to the lender, {usdc(e.royalty)} royalty.</>,
        detail: <PayoutList payouts={e.payouts} />,
        amount: { text: usdc(e.price), tone: 'neutral' },
      };
    case 'collateral_claimed':
      return { title: 'Collateral claimed', body: <><Acct id={e.lender} /> took the company after an auction with no bid.</> };
    case 'settlement_failed':
      return { title: 'Settlement failed', body: <>{e.event}: nothing moved and NEP-141 payers are refunded{e.account ? <>. Account <Acct id={e.account} /></> : null}</> };
    case 'transferred':
      return { title: 'Transferred', body: <><Acct id={e.from} /> to <Acct id={e.to} />{e.memo ? `, memo "${e.memo}"` : ''}</> };
    case 'resync':
      return { title: e.event === 'vault_resynced' ? 'Vault resynced' : 'Vault resync required', body: 'A settlement callback failed; resync_vault_owner writes the registry owner to the vault.' };
    case 'treasury_addresses':
      return {
        title: `Treasury addresses, epoch ${e.epoch}`,
        body: 'Derived on-chain from the MPC signer.',
        detail: (
          <span className={h.detail}>
            BTC <Address value={e.btc} chain="btc" /> EVM <Address value={e.evm} chain="evm" /> SOL <Address value={e.sol} chain="sol" />
          </span>
        ),
      };
    case 'epoch_rotated':
      return { title: `Treasury epoch rotated to ${e.epoch}`, body: 'New L1 addresses. Funds on older epochs stop counting toward NAV.' };
    case 'intents_key':
      return { title: 'Intents key registered', body: 'The vault added its MPC-derived key on intents.near.', detail: e.publicKey };
    case 'intents_deposit':
      return {
        title: 'Deposited to intents.near',
        body: `Retained earnings moved to the vault's intents.near balance${e.restored !== '0' ? `; ${usdc(e.restored)} came back unused` : ''}.`,
        amount: { text: usdc(e.used), tone: 'neutral' },
      };
    case 'intent_signed':
      return {
        title: e.intent === 'ft_withdraw' ? 'Withdrawal intent signed' : 'Swap intent signed',
        body: e.diff
          ? `The vault built and signed a token_diff: ${diffText(e.diff, usdcToken)}${e.deadline ? `, valid until ${e.deadline}` : ''}.`
          : `Withdraw ${e.amount ?? '?'} of ${e.token ?? '?'} to ${e.destination ?? '?'}.`,
      };
    case 'intent_settled':
      return { title: 'Swap settled on intents.near', body: `Vault balance change: ${diffText(e.diff, usdcToken)}.`, detail: `intent ${e.intentHash}` };
    case 'raw_signature':
      return {
        title: e.legacy ? 'Legacy-epoch signature requested' : 'Raw signature requested',
        body: `Domain ${e.domainId}, subpath ${e.subpath}, epoch ${e.epoch}.${e.legacy ? '' : ' Marks the epoch dirty until rotation.'}`,
      };
    case 'policy':
      return { title: 'Policy changed', body: e.event };
    case 'approval':
      return { title: e.event.replace('_', ' '), body: e.account ? <><Acct id={e.account} /></> : 'All approvals cleared.' };
    case 'refused':
      return {
        title: (
          <>
            Refused {e.code && <span className={h.code}>{e.code}</span>}
          </>
        ),
        body: (
          <>
            <Acct id={e.caller} /> called {e.method} on the {e.target}.
          </>
        ),
        detail: e.code ? undefined : e.message,
      };
  }
}

function Row({ entry, usdcToken }: { entry: HistoryEntry; usdcToken: string }) {
  const d = describe(entry, usdcToken);
  const tone = d.amount?.tone === 'in' ? h.amountIn : d.amount?.tone === 'out' ? h.amountOut : undefined;
  return (
    <li className={h.row}>
      <span className={h.time}>{formatTime(entry.timestampMs)}</span>
      <div className={h.main}>
        <span className={`${h.title} ${h[`g_${entry.group}`] ?? ''}`}>{d.title}</span>
        <span className={h.body}>{d.body}</span>
        {d.detail && <span className={h.detail}>{d.detail}</span>}
      </div>
      <div className={h.side}>
        {d.amount && <span className={[h.amount, tone].filter(Boolean).join(' ')}>{d.amount.text}</span>}
        <TxHash value={entry.txHash} />
      </div>
    </li>
  );
}

function Timeline({ entries, usdcToken }: { entries: HistoryEntry[]; usdcToken: string }) {
  const [shown, setShown] = useState(PAGE);
  if (entries.length === 0) return <Notice tone="empty" title="Nothing of this kind yet" />;
  return (
    <>
      <ol className={h.timeline}>
        {entries.slice(0, shown).map((e) => (
          <Row key={e.id} entry={e} usdcToken={usdcToken} />
        ))}
      </ol>
      {entries.length > shown && (
        <div className={h.more}>
          <Button variant="quiet" size="sm" className={h.tapButton} onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, entries.length - shown)} more of {entries.length - shown}
          </Button>
        </div>
      )}
    </>
  );
}

const HOW: Record<Holder['how'], string> = {
  minted: 'Minted at incorporation',
  bought: 'Bought',
  auction: 'Won the default auction',
  collateral: 'Claimed as defaulted collateral',
  transfer: 'Transfer',
};

function Holders({ holders, currentOwner }: { holders: Holder[]; currentOwner: string }) {
  const last = holders[holders.length - 1];
  return (
    <div>
      <p className={h.sectionTitle}>Holders, from NEP-171 mint and transfer events</p>
      {holders.length === 0 ? (
        <Notice tone="empty" title="No mint or transfer event found" />
      ) : (
        <ol className={h.holders}>
          {holders.map((holder, i) => (
            <li key={`${holder.txHash}:${i}`} className={h.holder}>
              <span>
                <Acct id={holder.account} />
                {holder.toMs === null && <span className={h.current}>current</span>}
              </span>
              <span className={h.holderHow}>
                {HOW[holder.how]}
                {holder.price && ` for ${usdc(holder.price)}`}
                {holder.how === 'transfer' && holder.memo && `, memo "${holder.memo}"`}
              </span>
              <span className={h.time}>
                {formatTime(holder.fromMs)} to {holder.toMs === null ? 'now' : formatTime(holder.toMs)}
              </span>
              <TxHash value={holder.txHash} />
            </li>
          ))}
        </ol>
      )}
      {last && last.account !== currentOwner && (
        <p className={h.note}>
          The last holder in the events is {last.account}, but nft_token names {currentOwner} now. The index may be behind the chain.
        </p>
      )}
    </div>
  );
}

function Reconciliation({ result }: { result: HistoryReady }) {
  const differing = result.reconciliation.filter((r) => !r.matches);
  if (differing.length === 0) {
    return (
      <p className={h.ok}>
        Event sums match the vault&apos;s get_state on all {result.reconciliation.length} fields: {result.reconciliation.map((r) => r.field).join(', ')}.
      </p>
    );
  }
  return (
    <Notice tone="info" title={`Event sums differ from get_state on ${differing.length} field${differing.length === 1 ? '' : 's'}`}>
      <p>
        {result.complete
          ? 'Every transaction was read, so a difference means an event this page does not parse, or the index is behind the chain.'
          : 'The scan stopped at its page cap or some transaction bodies were missing, so older events are not counted.'}
      </p>
      <div className={h.diffTable}>
        {differing.map((r) => (
          <span key={r.field}>
            {r.field}: events {r.fromEvents}, view {r.fromView}
          </span>
        ))}
      </div>
    </Notice>
  );
}

const TABS: { id: string; label: string; groups: HistoryGroup[] | null }[] = [
  { id: 'all', label: 'All', groups: null },
  { id: 'money', label: 'Earned and paid', groups: ['earned', 'paid'] },
  { id: 'ownership', label: 'Sales and credit', groups: ['market', 'credit'] },
  { id: 'treasury', label: 'Treasury', groups: ['treasury'] },
  { id: 'refused', label: 'Refused', groups: ['refused'] },
];

function Ready({ result, usdcToken }: { result: HistoryReady; usdcToken: string }) {
  const { totals, source } = result;
  const paidOut = (BigInt(totals.dividends) + BigInt(totals.computePaid)).toString();
  const customer = totals.payments - totals.relatedPayments;
  const tabs = useMemo(
    () =>
      TABS.map((t) => {
        const list = t.groups ? result.entries.filter((e) => (t.groups as HistoryGroup[]).includes(e.group)) : result.entries;
        return { id: t.id, label: t.label, badge: list.length, content: <Timeline entries={list} usdcToken={usdcToken} /> };
      }),
    [result.entries, usdcToken],
  );
  return (
    <>
      <StatGrid>
        <Stat label="Earned" value={formatUsdc(totals.gross)} unit="USDC" tone="teal" hint={`${customer} customer payment${customer === 1 ? '' : 's'}`} />
        <Stat label="From the shareholder" value={formatUsdc(totals.relatedParty)} unit="USDC" tone="muted" hint={`${totals.relatedPayments} payment${totals.relatedPayments === 1 ? '' : 's'}, not revenue`} />
        <Stat label="Paid out" value={formatUsdc(paidOut)} unit="USDC" tone="peach" hint="dividends and compute" />
        <Stat label="Holders" value={String(result.holders.length)} hint={`${totals.sales} sale${totals.sales === 1 ? '' : 's'}`} />
        <Stat label="Refused" value={String(totals.refused)} tone="coral" hint="failed calls" />
      </StatGrid>

      <Reconciliation result={result} />

      {source.fallbackReason && (
        <Notice tone="info" title={`Read from ${source.name}`}>
          FastNEAR did not answer ({source.fallbackReason}). This source lists receipts that the vault or registry executed, so an
          intents.near settlement that only names the vault in a log is not shown.
        </Notice>
      )}
      {result.untrustedLogs > 0 && (
        <p className={h.note}>
          {result.untrustedLogs} log{result.untrustedLogs === 1 ? '' : 's'} used an Incorpr event standard from another contract and{' '}
          {result.untrustedLogs === 1 ? 'was' : 'were'} ignored.
        </p>
      )}

      <Holders holders={result.holders} currentOwner={result.currentOwner} />

      <div>
        <p className={h.sectionTitle}>Timeline, oldest first</p>
        <Tabs label="Filter the history" tabs={tabs} />
      </div>

      <p className={h.note}>
        {source.transactions} transactions touching {result.vaultId} or {result.registryId}, read through {source.hosts.join(' and ')}
        {source.scans.some((s) => !s.complete) && ', stopped at the page cap'}
        {source.missing > 0 && `, ${source.missing} not returned in full`}. Amounts and accounts come from the registry&apos;s
        and vault&apos;s NEP-297 logs; refusals from failed receipt outcomes. Read {formatTime(result.readAtMs)}.
      </p>
    </>
  );
}

export function HistoryPanel({ tokenId, usdcToken }: { tokenId: string; usdcToken: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const fetchHistory = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      const res = await fetch(`/api/history?token_id=${encodeURIComponent(tokenId)}`);
      const body = (await res.json()) as HistoryResult | { error?: { message?: string } };
      if ('status' in body) setLoad({ kind: 'done', result: body });
      else setLoad({ kind: 'error', message: body.error?.message ?? `HTTP ${res.status}` });
    } catch (error) {
      setLoad({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [tokenId]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  const meta = load.kind === 'done' && load.result.status === 'ok' ? `From event logs via ${load.result.source.name}` : 'From event logs';

  return (
    <Glass as="section" pad="lg" aria-labelledby="history-title" className={h.panel}>
      <GlassHeader title={<span id="history-title">History</span>} meta={meta} />
      <div className={h.toolbar}>
        <p className={h.intro}>
          What this company earned, what it paid out, who held it, and every call its vault or the registry refused. Each row links the
          transaction.
        </p>
        <Button variant="quiet" size="sm" className={h.tapButton} onClick={() => void fetchHistory()} busy={load.kind === 'loading'} busyLabel="Reading">
          Reload
        </Button>
      </div>

      {load.kind === 'loading' && <SkeletonText lines={6} label="Reading the history" />}
      {load.kind === 'error' && (
        <Notice tone="error" title="History source unavailable">
          {load.message}
        </Notice>
      )}
      {load.kind === 'done' && load.result.status === 'unavailable' && (
        <Notice tone="error" title="History source unavailable">
          <p>{load.result.reason}</p>
          <p>The figures above come from the vault&apos;s views and do not depend on this source.</p>
        </Notice>
      )}
      {load.kind === 'done' && load.result.status === 'not_found' && (
        <Notice tone="empty" title={`Company ${tokenId} does not exist`}>
          {load.result.registryId} has no token {tokenId}.
        </Notice>
      )}
      {load.kind === 'done' && load.result.status === 'ok' && <Ready result={load.result} usdcToken={usdcToken} />}
    </Glass>
  );
}
