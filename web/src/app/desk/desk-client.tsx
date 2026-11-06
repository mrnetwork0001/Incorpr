'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { cancelOffer, claimDefaultedCollateral, startAuction, withdrawPending, type TxSender } from '@/lib/actions';
import { useWallet } from '@/lib/wallet';
import { Address, Button, ButtonLink, Glass, GlassHeader, Notice, SkeletonText, Stat, StatGrid } from '../ui';
import { CompanyCard, LoanFacts, termsText } from './company-card';
import { loadDesk, MAX_SCANNED, type DeskData } from './data';
import { auctionState, formatDuration, formatUsdc, formatUsdcExact } from './format';
import { OfferForm } from './offer-form';
import { OutcomeView, useActionRunner, useWalletReturn, type ActionRunner } from './use-action';
import s from './desk.module.css';

/** Re-render once a second so due times, auction prices and the freshness age stay current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function Desk({ registryId, network }: { registryId: string; network: string }) {
  const wallet = useWallet();
  if (!wallet.ready) return <SkeletonText lines={4} label="Loading the wallet selector" />;
  if (wallet.unavailableReason) {
    return (
      <Notice tone="info" title="No browser wallet on this network">
        {wallet.unavailableReason}
      </Notice>
    );
  }
  if (!wallet.accountId || !wallet.sender) {
    return (
      <Notice
        tone="empty"
        title="Connect a wallet"
        action={
          <Button onClick={wallet.signIn} arrow>
            Connect wallet
          </Button>
        }
      >
        <p>
          The desk reads the companies the connected {network} account owns on <code className={s.code}>{registryId}</code>, the offers it
          funded and the loans it is owed. Nothing is shown before an account is connected.
        </p>
      </Notice>
    );
  }
  return <DeskLoaded registryId={registryId} accountId={wallet.accountId} sender={wallet.sender} />;
}

function DeskLoaded({ registryId, accountId, sender }: { registryId: string; accountId: string; sender: TxSender }) {
  const [data, setData] = useState<DeskData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const nowMs = useNow();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadDesk(registryId, accountId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [registryId, accountId]);

  useEffect(() => {
    setData(null);
    void reload();
  }, [reload]);

  const runner = useActionRunner(() => void reload());
  useWalletReturn(runner, accountId, () => void reload());

  if (!data) {
    if (error) {
      return (
        <Notice
          tone="error"
          title="Could not read the registry"
          action={
            <Button variant="quiet" size="sm" onClick={() => void reload()}>
              Try again
            </Button>
          }
        >
          <span className={s.err}>{error}</span>
        </Notice>
      );
    }
    return <SkeletonText lines={6} label="Reading the registry" />;
  }

  const listed = data.owned.filter((o) => o.company.encumbrance !== 'Free' && 'Listed' in o.company.encumbrance).length;
  const pledged = data.owned.filter((o) => o.loan).length;
  const borrowed = data.owned.reduce((sum, o) => sum + (o.loan ? BigInt(o.loan.loan.debt) : 0n), 0n);
  const lent = data.lending.reduce((sum, l) => sum + BigInt(l.loan.loan.principal), 0n);
  const escrowed = data.myOffers.reduce((sum, o) => sum + BigInt(o.offer.principal), 0n);

  return (
    <div className={s.desk}>
      <OutcomeView outcome={runner.outcomes['wallet-return']} onDismiss={() => runner.clear('wallet-return')} />

      <Glass lit pad="lg" as="section" aria-label="Account summary">
        <GlassHeader
          title={
            <span className={s.acctTitle}>
              Desk for <Address value={accountId} />
            </span>
          }
          meta={
            <span className={s.readAt}>
              Read {formatDuration(nowMs - data.readAtMs)} ago{' '}
              <Button variant="secondary" size="sm" onClick={() => void reload()} disabled={loading}>
                {loading ? 'Reading' : 'Reload'}
              </Button>
            </span>
          }
        />
        <StatGrid>
          <Stat label="Companies owned" value={String(data.owned.length)} />
          <Stat label="Listed" value={String(listed)} tone={listed ? 'amber' : 'muted'} />
          <Stat label="Pledged" value={String(pledged)} tone={pledged ? 'lilac' : 'muted'} />
          <Stat label="Debt owed" value={formatUsdc(borrowed)} unit="USDC" />
          <Stat label="Lent out" value={formatUsdc(lent)} unit="USDC" />
          <Stat label="In open offers" value={formatUsdc(escrowed)} unit="USDC" />
          <Stat
            label="USDC balance"
            value={data.usdcBalance !== null ? formatUsdc(data.usdcBalance) : 'Not read'}
            unit={data.usdcBalance !== null ? 'USDC' : undefined}
            hint={data.usdcToken ? undefined : 'No USDC token configured'}
            tone="teal"
          />
        </StatGrid>
        {data.pendingWithdrawal !== '0' && (
          <PendingWithdrawal amount={data.pendingWithdrawal} registryId={registryId} sender={sender} runner={runner} />
        )}
        {data.truncated && (
          <p className={s.subText}>
            The registry holds more than {MAX_SCANNED} companies. Offers and loans were read for the first {MAX_SCANNED} only.
          </p>
        )}
      </Glass>

      <section className={s.section} aria-labelledby="desk-owned">
        <div className={s.sectionHead}>
          <h2 id="desk-owned" className={s.sectionTitle}>
            Your companies
          </h2>
          <p className={s.sectionText}>
            List one for sale or borrow USDC against it. Both freeze the vault, so run the L1 freshness check first.
          </p>
        </div>
        {data.owned.length === 0 ? (
          <Notice
            tone="empty"
            title={`${accountId} owns no companies on ${registryId}`}
            action={
              <div className={s.actions}>
                <ButtonLink href="/incorporate" arrow>
                  Incorporate one
                </ButtonLink>
                <ButtonLink variant="secondary" href="/exchange">
                  Buy one on the Exchange
                </ButtonLink>
              </div>
            }
          />
        ) : (
          <div className={s.cards}>
            {data.owned.map((item) => (
              <CompanyCard key={item.company.token_id} item={item} registryId={registryId} sender={sender} runner={runner} nowMs={nowMs} />
            ))}
          </div>
        )}
      </section>

      <section className={s.section} aria-labelledby="desk-lending">
        <div className={s.sectionHead}>
          <h2 id="desk-lending" className={s.sectionTitle}>
            Loans you are owed
          </h2>
          <p className={s.sectionText}>
            After the due time anyone can start a Dutch auction from 200% to 50% of the debt. If the window closes with no bid, you claim the
            company.
          </p>
        </div>
        {data.lending.length === 0 ? (
          <Notice tone="empty" title="No loans where you are the lender" />
        ) : (
          <div className={s.cards}>
            {data.lending.map(({ company, loan }) => (
              <LenderLoan key={company.token_id} company={company} loan={loan} registryId={registryId} sender={sender} runner={runner} nowMs={nowMs} />
            ))}
          </div>
        )}
      </section>

      <section className={s.section} aria-labelledby="desk-offers">
        <div className={s.sectionHead}>
          <h2 id="desk-offers" className={s.sectionTitle}>
            Your open offers
          </h2>
          <p className={s.sectionText}>The principal stays in the registry until the owner accepts or you cancel.</p>
        </div>
        {data.myOffers.length === 0 ? (
          <Notice tone="empty" title="No open offers from this account" />
        ) : (
          <Glass pad="none" className={s.tableWrap}>
            <ul className={s.offerRows}>
              {data.myOffers.map(({ company, offer }) => (
                <li key={offer.id} className={s.offerRow}>
                  <span className={s.cell}>
                    <span className={s.k}>Company</span>
                    <Link href={`/company/${company.token_id}`} className={s.nameLink}>
                      {company.name}
                    </Link>{' '}
                    <span className={s.tokenId}>#{company.token_id}</span>
                  </span>
                  <span className={s.cell}>
                    <span className={s.k}>Principal</span>
                    <span className={s.num}>{formatUsdc(offer.principal)}</span>
                  </span>
                  <span className={s.cell}>
                    <span className={s.k}>Repay</span>
                    <span className={s.num}>{formatUsdc(offer.repay_amount)}</span>
                  </span>
                  <span className={s.cell}>
                    <span className={s.k}>Term</span>
                    <span className={s.num}>{formatDuration(offer.term_ms)}</span>
                  </span>
                  <span className={s.cell}>
                    <span className={s.k}>Terms</span>
                    <span className={s.num}>{termsText(offer)}</span>
                  </span>
                  <span className={s.cellAction}>
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={offer.settling || runner.busy !== null}
                      busy={runner.busy === `cancel-${offer.id}`}
                      busyLabel="Cancelling"
                      onClick={() =>
                        void runner.run(`cancel-${offer.id}`, `Cancel offer #${offer.id} on ${company.name}`, async () => {
                          const r = await cancelOffer(sender, company.token_id, offer.id, { registryId });
                          return {
                            hashes: r.txHashes,
                            ok: r.cancelled,
                            message: r.cancelled
                              ? `Cancelled. ${formatUsdcExact(offer.principal)} USDC and the offer's storage were returned.`
                              : 'The offer is still open.',
                          };
                        })
                      }
                    >
                      {offer.settling ? 'Being accepted' : 'Cancel'}
                    </Button>
                  </span>
                  <div className={s.rowOutcome}>
                    <OutcomeView outcome={runner.outcomes[`cancel-${offer.id}`]} onDismiss={() => runner.clear(`cancel-${offer.id}`)} />
                  </div>
                </li>
              ))}
            </ul>
          </Glass>
        )}
      </section>

      <section className={s.section} aria-labelledby="desk-fund">
        <div className={s.sectionHead}>
          <h2 id="desk-fund" className={s.sectionTitle}>
            Lend against a company
          </h2>
          <p className={s.sectionText}>
            Escrow USDC as an offer. The owner accepts it from their desk; the company is then pledged to you until repaid.
          </p>
        </div>
        <Glass pad="lg">
          <OfferForm
            companies={data.companies}
            accountId={accountId}
            registryId={registryId}
            sender={sender}
            runner={runner}
            offerStorageCost={data.offerStorageCost}
          />
        </Glass>
      </section>
    </div>
  );
}

function PendingWithdrawal({ amount, registryId, sender, runner }: { amount: string; registryId: string; sender: TxSender; runner: ActionRunner }) {
  return (
    <div className={s.pending}>
      <p className={s.subText}>
        The registry holds <b className={s.num}>{formatUsdcExact(amount)} USDC</b> for this account from a payout it could not transfer.
      </p>
      <Button
        variant="quiet"
        size="sm"
        disabled={runner.busy !== null}
        busy={runner.busy === 'withdraw'}
        onClick={() =>
          void runner.run('withdraw', `Withdraw ${formatUsdcExact(amount)} USDC`, async () => {
            const r = await withdrawPending(sender, { registryId });
            return { hashes: r.txHashes, ok: r.stillPending === '0', message: r.stillPending === '0' ? 'Paid out.' : `Still pending: ${formatUsdcExact(r.stillPending)} USDC.` };
          })
        }
      >
        Withdraw
      </Button>
      <OutcomeView outcome={runner.outcomes.withdraw} onDismiss={() => runner.clear('withdraw')} />
    </div>
  );
}

function LenderLoan({
  company,
  loan,
  registryId,
  sender,
  runner,
  nowMs,
}: {
  company: DeskData['lending'][number]['company'];
  loan: DeskData['lending'][number]['loan'];
  registryId: string;
  sender: TxSender;
  runner: ActionRunner;
  nowMs: number;
}) {
  const tokenId = company.token_id;
  const l = loan.loan;
  const auction = auctionState(l.debt, l.auction_start_ms, loan.auctionPrice, nowMs);
  const overdue = nowMs > l.due_ms;
  const key = `lender-${tokenId}`;

  const start = () =>
    void runner.run(key, `Start the auction for ${company.name}`, async () => {
      const r = await startAuction(sender, tokenId, { registryId });
      return {
        hashes: r.txHashes,
        ok: r.price !== null,
        message: r.price ? `Auction running. Current price ${formatUsdcExact(r.price)} USDC, falling to half the debt.` : 'The registry shows no running auction.',
      };
    });
  const claim = () =>
    void runner.run(key, `Claim ${company.name} as collateral`, async () => {
      const r = await claimDefaultedCollateral(sender, tokenId, { registryId });
      return {
        hashes: r.txHashes,
        ok: r.claimed,
        message: r.claimed ? 'Claimed. The NFT and the vault shareholder moved to you.' : 'The registry still shows the borrower as owner.',
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
        </div>
      </header>
      <LoanFacts loan={loan} auctionPrice={loan.auctionPrice} nowMs={nowMs} role="lender" />
      <div className={s.actions}>
        {auction.phase === 'none' && overdue && (
          <Button onClick={start} disabled={runner.busy !== null} busy={runner.busy === key} busyLabel="Starting">
            Start auction
          </Button>
        )}
        {auction.phase === 'none' && !overdue && <p className={s.subText}>Waiting for repayment until the due time.</p>}
        {auction.phase === 'running' && <p className={s.subText}>Bids pay you up to the debt. Claim opens when the window closes with no bid.</p>}
        {auction.phase === 'closed' && (
          <Button onClick={claim} disabled={runner.busy !== null} busy={runner.busy === key} busyLabel="Claiming">
            Claim collateral
          </Button>
        )}
      </div>
      <OutcomeView outcome={runner.outcomes[key]} onDismiss={() => runner.clear(key)} />
    </Glass>
  );
}
