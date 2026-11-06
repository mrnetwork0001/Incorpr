import Link from 'next/link';
import type { CompanyView, Loan, Offer } from '@/lib/contracts';
import { askOf, auctionState, encumbranceLabel, formatBps, formatDuration, formatUsdc, impliedMultiple, offerRate } from '../desk/format';
import { Address, ButtonLink, EncumbrancePill, Glass, Notice } from '../ui';
import { RowActions } from './row-actions';
import s from './exchange.module.css';

/** One company on the board, with what the registry holds against it. */
export interface Row {
  company: CompanyView;
  /** NEP-177 `media`: the on-chain SVG charter as a data URI. */
  charter: string | null;
  offers: Offer[];
  loan: Loan | null;
  auctionPrice: string | null;
}

const HEAD = ['Company · amounts in USDC', 'State', '30d revenue', 'Retained', 'Calls', 'Ask', 'Multiple', ''];

export function CompanyRows({ rows, nowMs }: { rows: Row[]; nowMs: number }) {
  return (
    <Glass pad="none" lit as="section" aria-label="Companies" className={s.board}>
      <div className={`${s.row} ${s.head}`} aria-hidden>
        {HEAD.map((h, i) => (
          <span key={i} className={i > 1 && i < 7 ? s.right : undefined}>
            {h}
          </span>
        ))}
      </div>
      <ul className={s.rows}>
        {rows.map(({ company, charter, loan, auctionPrice }) => {
          const ask = askOf(company.encumbrance);
          const auction = loan ? auctionState(loan.debt, loan.auction_start_ms, auctionPrice, nowMs) : null;
          return (
            <li key={company.token_id} className={s.row}>
              <div className={s.company}>
                {charter ? (
                  // eslint-disable-next-line @next/next/no-img-element -- on-chain SVG data URI, not an optimizable asset
                  <img src={charter} alt={`${company.name} charter`} className={s.charter} />
                ) : (
                  <span className={s.charter} aria-hidden />
                )}
                <div className={s.companyText}>
                  <Link href={`/company/${company.token_id}`} className={s.name}>
                    {company.name} <span className={s.tokenId}>#{company.token_id}</span>
                  </Link>
                  <Address value={company.vault} />
                </div>
              </div>
              <span className={s.cell} data-label="State">
                <EncumbrancePill state={encumbranceLabel(company.encumbrance)} />
                {company.settling && <span className={s.flag}>settling</span>}
                {company.needs_resync && <span className={s.flag}>needs resync</span>}
              </span>
              <span className={`${s.cell} ${s.right} ${s.num}`} data-label="30d revenue">
                {formatUsdc(company.revenue_30d)}
              </span>
              <span className={`${s.cell} ${s.right} ${s.num}`} data-label="Retained">
                {formatUsdc(company.retained)}
              </span>
              <span className={`${s.cell} ${s.right} ${s.num}`} data-label="Calls">
                {company.calls.toLocaleString('en-US')}
              </span>
              <span className={`${s.cell} ${s.right} ${s.num} ${ask ? s.ask : s.muted}`} data-label="Ask">
                {ask ? formatUsdc(ask) : auction && auction.phase === 'running' ? `${formatUsdc(auction.price)} bid` : '-'}
              </span>
              <span className={`${s.cell} ${s.right} ${s.num}`} data-label="Multiple">
                {impliedMultiple(company) ?? '-'}
              </span>
              <RowActions
                tokenId={company.token_id}
                name={company.name}
                owner={company.owner_id}
                ask={ask}
                syncNonce={company.sync_nonce}
                auctionPrice={auction?.phase === 'running' ? auction.price : null}
                blocked={company.settling || company.needs_resync}
              />
            </li>
          );
        })}
      </ul>
    </Glass>
  );
}

export function OfferBook({ rows }: { rows: Row[] }) {
  const offers = rows.flatMap((row) => row.offers.map((offer) => ({ company: row.company, offer })));
  offers.sort((a, b) => (BigInt(b.offer.principal) > BigInt(a.offer.principal) ? 1 : -1));
  return (
    <section className={s.section} aria-labelledby="offer-book">
      <div className={s.sectionHead}>
        <h2 id="offer-book" className={s.sectionTitle}>
          Open lender offers
        </h2>
        <p className={s.sectionText}>
          USDC escrowed in the registry against a named company. Its owner accepts one on the Desk, which pledges the company and pays the
          principal in the same settlement.
        </p>
      </div>
      {offers.length === 0 ? (
        <Notice tone="empty" title="No open offers" action={<ButtonLink href="/desk" variant="secondary">Fund one on the Desk</ButtonLink>}>
          No lender has escrowed USDC against any company on this registry.
        </Notice>
      ) : (
        <Glass pad="none">
          <ul className={s.offers}>
            {offers.map(({ company, offer }) => {
              const rate = offerRate(offer.principal, offer.repay_amount, offer.term_ms);
              return (
                <li key={offer.id} className={s.offer}>
                  <span className={s.ocell}>
                    <span className={s.k}>Company</span>
                    <Link href={`/company/${company.token_id}`} className={s.name}>
                      {company.name} <span className={s.tokenId}>#{company.token_id}</span>
                    </Link>
                  </span>
                  <span className={s.ocell}>
                    <span className={s.k}>Lender</span>
                    <Address value={offer.lender} />
                  </span>
                  <span className={s.ocell}>
                    <span className={s.k}>Principal</span>
                    <span className={s.num}>{formatUsdc(offer.principal)}</span>
                  </span>
                  <span className={s.ocell}>
                    <span className={s.k}>Repay</span>
                    <span className={s.num}>{formatUsdc(offer.repay_amount)}</span>
                  </span>
                  <span className={s.ocell}>
                    <span className={s.k}>Term</span>
                    <span className={s.num}>{formatDuration(offer.term_ms)}</span>
                  </span>
                  <span className={s.ocell}>
                    <span className={s.k}>Rate</span>
                    <span className={s.num}>{formatBps(rate.termBps)}</span>
                    {rate.aprBps !== null && <span className={`${s.num} ${s.muted}`}>{formatBps(rate.aprBps)} APR</span>}
                  </span>
                  <span className={s.ocell}>
                    <span className={s.k}>Terms</span>
                    <span className={s.num}>
                      {offer.terms?.min_retained != null || offer.terms?.required_epoch != null
                        ? [
                            offer.terms?.min_retained != null ? `retained >= ${formatUsdc(offer.terms.min_retained)}` : null,
                            offer.terms?.required_epoch != null ? `epoch ${offer.terms.required_epoch}` : null,
                          ]
                            .filter(Boolean)
                            .join(', ')
                        : 'none'}
                      {offer.settling && <span className={s.flag}>being accepted</span>}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Glass>
      )}
    </section>
  );
}
