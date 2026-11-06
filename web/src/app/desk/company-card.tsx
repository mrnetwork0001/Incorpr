'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { acceptOffer, listCompany, repayLoan, unlistCompany, type TxSender } from '@/lib/actions';
import { RegistryClient, type Offer, type VaultState } from '@/lib/contracts';
import { Address, Button, ButtonLink, EncumbrancePill, Field, Glass, Input, KeyValue, Notice } from '../ui';
import type { LoanView, OwnedCompany } from './data';
import { FreshnessPanel, freshnessGate, useFreshness, type Gate } from './freshness';
import {
  auctionState,
  encumbranceLabel,
  formatBps,
  formatDuration,
  formatTime,
  formatUsdc,
  formatUsdcExact,
  impliedMultiple,
  offerRate,
  parseUsdc,
} from './format';
import { OutcomeView, type ActionRunner } from './use-action';
import s from './desk.module.css';

interface CardProps {
  item: OwnedCompany;
  registryId: string;
  sender: TxSender;
  runner: ActionRunner;
  nowMs: number;
}

/** Whether a lender's pledge terms hold against the vault as last read. Null when they do. */
export function termsProblem(offer: Offer, vault: VaultState | null): string | null {
  const terms = offer.terms;
  if (!terms || !vault) return null;
  if (terms.min_retained != null && BigInt(vault.retained_earnings) < BigInt(terms.min_retained)) {
    return `Needs at least ${formatUsdc(terms.min_retained)} USDC retained; the vault holds ${formatUsdc(vault.retained_earnings)}.`;
  }
  if (terms.required_epoch != null && vault.treasury_epoch !== terms.required_epoch) {
    return `Needs treasury epoch ${terms.required_epoch}; the vault is on epoch ${vault.treasury_epoch}.`;
  }
  return null;
}

export function termsText(offer: Offer): string {
  const parts: string[] = [];
  if (offer.terms?.min_retained != null) parts.push(`retained >= ${formatUsdc(offer.terms.min_retained)}`);
  if (offer.terms?.required_epoch != null) parts.push(`epoch = ${offer.terms.required_epoch}`);
  return parts.length ? parts.join(', ') : 'none';
}

function GateNote({ gate, ack, onAck, id }: { gate: Gate; ack: boolean; onAck: (v: boolean) => void; id: string }) {
  return (
    <>
      {gate.needsAck && (
        <label className={s.ack} htmlFor={id}>
          <input id={id} type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} />
          <span>
            Continue without the chains marked unavailable. The vault still refuses on-chain if it signed raw payloads this epoch or holds a
            live intent.
          </span>
        </label>
      )}
      {!gate.allowed && gate.reason && <p className={gate.pending ? s.waiting : s.blocked}>{gate.reason}</p>}
    </>
  );
}

function FreeActions({ item, registryId, sender, runner, nowMs }: CardProps) {
  const { company, vault, offers } = item;
  const tokenId = company.token_id;
  const freshness = useFreshness(tokenId);
  const [ack, setAck] = useState(false);
  const [askText, setAskText] = useState('');
  const ids = useId();
  const gate = freshnessGate(freshness.check, vault, ack, nowMs);
  const ask = parseUsdc(askText);
  const askError = askText && (ask === null || ask === '0') ? 'Enter an amount above zero, up to 6 decimals.' : null;
  const anyBusy = runner.busy !== null;

  const list = () => {
    if (!ask) return;
    void runner.run(`list-${tokenId}`, `List ${company.name} at ${formatUsdcExact(ask)} USDC`, async () => {
      const r = await listCompany(sender, tokenId, ask, { registryId });
      return {
        hashes: r.txHashes,
        ok: r.listed,
        message: r.listed
          ? 'Listed. The vault is frozen: no dividends, signatures or policy changes until it sells or you unlist.'
          : 'The transactions landed, but the registry shows no listing at this ask. The vault refused the freeze.',
      };
    });
  };

  const accept = (offer: Offer) => {
    void runner.run(`accept-${tokenId}`, `Borrow ${formatUsdcExact(offer.principal)} USDC against ${company.name}`, async () => {
      const r = await acceptOffer(sender, tokenId, offer.id, { registryId });
      return {
        hashes: r.txHashes,
        ok: r.borrowed,
        message: r.borrowed
          ? `Pledged. ${formatUsdcExact(offer.principal)} USDC was paid to ${sender.accountId}; ${formatUsdcExact(offer.repay_amount)} USDC is due ${formatTime(r.loan?.due_ms ?? 0)}.`
          : 'The transactions landed, but the registry records no loan. The vault refused the pledge.',
      };
    });
  };

  return (
    <>
      <FreshnessPanel check={freshness.check} onRun={() => void freshness.run()} nowMs={nowMs} disabled={anyBusy} />
      <GateNote gate={gate} ack={ack} onAck={setAck} id={`${ids}-ack`} />

      <div className={s.split}>
        <section className={s.sub} aria-label="List for sale">
          <h4 className={s.subTitle}>List for sale</h4>
          <p className={s.subText}>
            A buyer pays the ask in one USDC transfer. The registry moves the NFT and the vault&apos;s shareholder in the same settlement, or
            refunds the buyer.
          </p>
          <form
            className={s.inline}
            onSubmit={(e) => {
              e.preventDefault();
              list();
            }}
          >
            <Field label="Ask" htmlFor={`${ids}-ask`} error={askError} hint={ask && impliedHint(company.revenue_30d, ask)}>
              <Input
                id={`${ids}-ask`}
                mono
                inputMode="decimal"
                placeholder="0.00"
                suffix="USDC"
                value={askText}
                invalid={Boolean(askError)}
                onChange={(e) => setAskText(e.target.value)}
                aria-describedby={askError ? `${ids}-ask-error` : `${ids}-ask-hint`}
              />
            </Field>
            <Button
              type="submit"
              disabled={!gate.allowed || !ask || ask === '0' || anyBusy}
              busy={runner.busy === `list-${tokenId}`}
              busyLabel="Listing"
            >
              List company
            </Button>
          </form>
          <OutcomeView outcome={runner.outcomes[`list-${tokenId}`]} onDismiss={() => runner.clear(`list-${tokenId}`)} />
        </section>

        <section className={s.sub} aria-label="Lender offers">
          <h4 className={s.subTitle}>
            Lender offers <span className={s.count}>{offers.length}</span>
          </h4>
          <p className={s.subText}>
            Accepting pledges the company: it stays yours, the vault freezes, and the principal is paid to you. Repay before the due time or a
            Dutch auction can start.
          </p>
          {offers.length === 0 ? (
            <p className={s.empty}>No open offers on this company. Lenders fund offers from this page or the Exchange.</p>
          ) : (
            <ul className={s.offers}>
              {offers.map((offer) => {
                const rate = offerRate(offer.principal, offer.repay_amount, offer.term_ms);
                const problem = termsProblem(offer, vault);
                return (
                  <li key={offer.id} className={s.offer}>
                    <div className={s.offerFigures}>
                      <span>
                        <span className={s.k}>Principal</span>
                        <b className={s.num}>{formatUsdc(offer.principal)}</b>
                      </span>
                      <span>
                        <span className={s.k}>Repay</span>
                        <b className={s.num}>{formatUsdc(offer.repay_amount)}</b>
                      </span>
                      <span>
                        <span className={s.k}>Term</span>
                        <b className={s.num}>{formatDuration(offer.term_ms)}</b>
                      </span>
                      <span>
                        <span className={s.k}>Rate</span>
                        <b className={s.num}>{formatBps(rate.termBps)}</b>
                        {rate.aprBps !== null && <span className={`${s.num} ${s.dim}`}>{formatBps(rate.aprBps)} APR</span>}
                      </span>
                    </div>
                    <div className={s.offerMeta}>
                      <span className={s.k}>Offer #{offer.id} from</span> <Address value={offer.lender} />
                      <span className={s.k}> Terms</span> <span className={s.num}>{termsText(offer)}</span>
                    </div>
                    {problem && <p className={s.blocked}>{problem} The vault would refuse with ERR_PLEDGE_TERMS_NOT_MET.</p>}
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={!gate.allowed || Boolean(problem) || offer.settling || anyBusy}
                      busy={runner.busy === `accept-${tokenId}`}
                      busyLabel="Pledging"
                      onClick={() => accept(offer)}
                    >
                      {offer.settling ? 'Settling' : 'Accept and borrow'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <OutcomeView outcome={runner.outcomes[`accept-${tokenId}`]} onDismiss={() => runner.clear(`accept-${tokenId}`)} />
        </section>
      </div>
    </>
  );
}

function impliedHint(revenue30d: string, ask: string): string {
  const multiple = impliedMultiple({ encumbrance: { Listed: { ask } }, revenue_30d: revenue30d });
  return multiple ? `${multiple} annualized 30-day revenue` : 'No 30-day revenue, so no multiple.';
}

function ListedActions({ item, registryId, sender, runner }: CardProps) {
  const { company, listing } = item;
  const tokenId = company.token_id;
  const unlist = () =>
    void runner.run(`unlist-${tokenId}`, `Unlist ${company.name}`, async () => {
      const r = await unlistCompany(sender, tokenId, { registryId });
      return {
        hashes: r.txHashes,
        ok: r.unlisted,
        message: r.unlisted ? 'Unlisted. The vault is free again and the sync nonce moved, so old purchase attempts refund.' : 'The registry still shows the listing.',
      };
    });
  return (
    <section className={s.sub} aria-label="Listing">
      <h4 className={s.subTitle}>Listed for sale</h4>
      {listing ? (
        <KeyValue
          items={[
            { label: 'Ask', value: `${formatUsdcExact(listing.ask)} USDC`, mono: true },
            { label: 'Implied multiple', value: impliedMultiple(company) ?? 'No 30-day revenue', mono: true },
            { label: 'Sync nonce a buyer must name', value: String(listing.sync_nonce), mono: true },
          ]}
        />
      ) : (
        <p className={s.empty}>The registry shows the company as listed but returned no listing.</p>
      )}
      <div className={s.actions}>
        <Button variant="quiet" onClick={unlist} disabled={runner.busy !== null} busy={runner.busy === `unlist-${tokenId}`} busyLabel="Unlisting">
          Unlist
        </Button>
        <ButtonLink variant="secondary" href="/exchange">
          See it on the Exchange
        </ButtonLink>
      </div>
      <OutcomeView outcome={runner.outcomes[`unlist-${tokenId}`]} onDismiss={() => runner.clear(`unlist-${tokenId}`)} />
    </section>
  );
}

export function LoanFacts({ loan, auctionPrice, nowMs, role }: { loan: LoanView; auctionPrice: string | null; nowMs: number; role: 'borrower' | 'lender' }) {
  const l = loan.loan;
  const overdue = nowMs > l.due_ms;
  const auction = auctionState(l.debt, l.auction_start_ms, auctionPrice, nowMs);
  return (
    <KeyValue
      items={[
        { label: role === 'borrower' ? 'Lender' : 'Borrower', value: <Address value={role === 'borrower' ? l.lender : l.borrower} /> },
        { label: 'Principal', value: `${formatUsdcExact(l.principal)} USDC`, mono: true },
        { label: 'Debt', value: `${formatUsdcExact(l.debt)} USDC`, mono: true },
        {
          label: 'Due',
          value: (
            <span className={overdue ? s.overdue : undefined}>
              {formatTime(l.due_ms)} · {overdue ? `overdue by ${formatDuration(nowMs - l.due_ms)}` : `in ${formatDuration(l.due_ms - nowMs)}`}
            </span>
          ),
          mono: true,
        },
        {
          label: 'Auction',
          value:
            auction.phase === 'none'
              ? overdue
                ? 'Not started. Anyone can start it now.'
                : 'Not started. It can start after the due time.'
              : auction.phase === 'running'
                ? `Running since ${formatTime(l.auction_start_ms ?? 0)}. Price ${formatUsdc(auction.price)} USDC${
                    auction.estimatedEndMs ? `, window ends about ${formatTime(auction.estimatedEndMs)}` : ''
                  }`
                : `Window closed at the floor of ${formatUsdc(auction.price)} USDC with no bid. The lender can claim the company.`,
          mono: true,
        },
      ]}
    />
  );
}

function PledgedActions({ item, registryId, sender, runner, nowMs }: CardProps) {
  const { company, loan } = item;
  const tokenId = company.token_id;
  if (!loan) {
    return <Notice tone="error" title="Pledged, but no loan record">The registry returned no loan for this company. Reload in a few seconds.</Notice>;
  }
  const repay = () =>
    void runner.run(`repay-${tokenId}`, `Repay ${formatUsdcExact(loan.loan.debt)} USDC on ${company.name}`, async () => {
      const r = await repayLoan(sender, tokenId, { registryId });
      return {
        hashes: r.txHashes,
        ok: r.repaid,
        code: r.refusal?.code ?? null,
        message: r.repaid ? 'Repaid. The lender was paid and the vault is free again.' : r.refusal ? undefined : 'The registry still shows the loan.',
      };
    });
  return (
    <section className={s.sub} aria-label="Loan">
      <h4 className={s.subTitle}>Pledged as collateral</h4>
      <LoanFacts loan={loan} auctionPrice={loan.auctionPrice} nowMs={nowMs} role="borrower" />
      <div className={s.actions}>
        <Button onClick={repay} disabled={runner.busy !== null} busy={runner.busy === `repay-${tokenId}`} busyLabel="Repaying">
          Repay {formatUsdc(loan.loan.debt)} USDC
        </Button>
      </div>
      <OutcomeView outcome={runner.outcomes[`repay-${tokenId}`]} onDismiss={() => runner.clear(`repay-${tokenId}`)} />
    </section>
  );
}

export function CompanyCard(props: CardProps) {
  const { item, registryId, sender, runner } = props;
  const { company, vault, vaultError } = item;
  const tokenId = company.token_id;
  const label = encumbranceLabel(company.encumbrance);

  const resync = () =>
    void runner.run(`resync-${tokenId}`, `Resync the vault of ${company.name}`, async () => {
      const registry = new RegistryClient(registryId, { finality: 'optimistic' });
      const results = await sender.send([registry.resyncVaultOwner(tokenId)]);
      const hashes = results.map((r) => r.txHash);
      // on_resync returns false, without failing the transaction, when the vault refused the write.
      const applied = results.at(-1)?.value === true;
      const after = await registry.getCompany(tokenId);
      if (applied && after && !after.needs_resync) {
        return { hashes, ok: true, message: 'The registry wrote its current owner and state to the vault.' };
      }
      return {
        hashes,
        ok: false,
        message: applied
          ? 'The vault accepted the write, but the registry still flags this company as needing a resync. A newer transfer may hold the lock; reload and try again.'
          : 'The transaction landed, but the vault refused the write (on_resync returned false). The company still needs a resync.',
      };
    });

  return (
    <Glass as="article" pad="lg" className={s.card}>
      <header className={s.cardHead}>
        <div className={s.cardTitle}>
          <h3>
            <Link href={`/company/${tokenId}`} className={s.nameLink}>
              {company.name}
            </Link>
          </h3>
          <span className={s.tokenId}>#{tokenId}</span>
          <EncumbrancePill state={label} />
        </div>
        <ButtonLink variant="secondary" href={`/company/${tokenId}`} arrow>
          Cockpit
        </ButtonLink>
      </header>

      <KeyValue
        className={s.cardFacts}
        items={[
          { label: 'Vault', value: <Address value={company.vault} /> },
          { label: '30-day revenue', value: `${formatUsdc(vault?.revenue_30d ?? company.revenue_30d)} USDC`, mono: true },
          { label: 'Retained earnings', value: `${formatUsdc(vault?.retained_earnings ?? company.retained)} USDC`, mono: true },
          {
            label: 'Treasury epoch',
            value: vault
              ? `epoch ${vault.treasury_epoch} · ${vault.raw_sigs_this_epoch} raw ${vault.raw_sigs_this_epoch === 1 ? 'signature' : 'signatures'} this epoch`
              : 'Vault not read',
            mono: true,
          },
        ]}
      />

      {vaultError && (
        <Notice tone="error" title="Could not read the vault">
          <span className={s.err}>{vaultError}</span>
        </Notice>
      )}

      {company.needs_resync ? (
        <Notice
          tone="error"
          title="The vault needs a resync"
          action={
            <Button variant="quiet" size="sm" onClick={resync} disabled={runner.busy !== null} busy={runner.busy === `resync-${tokenId}`}>
              Call resync_vault_owner
            </Button>
          }
        >
          A settlement callback failed while the token was locked. Market actions stay blocked until anyone writes the registry&apos;s owner
          and state back to the vault.
        </Notice>
      ) : company.settling ? (
        <Notice tone="info" title="Settlement running">
          A market call on this company is still settling. Actions return when it finishes; reload in a few seconds.
        </Notice>
      ) : label === 'FREE' ? (
        <FreeActions {...props} />
      ) : label === 'LISTED' ? (
        <ListedActions {...props} />
      ) : (
        <PledgedActions {...props} />
      )}
      <OutcomeView outcome={runner.outcomes[`resync-${tokenId}`]} onDismiss={() => runner.clear(`resync-${tokenId}`)} />
    </Glass>
  );
}
