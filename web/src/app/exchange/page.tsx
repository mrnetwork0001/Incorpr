import type { Metadata } from 'next';
import { RegistryClient } from '@/lib/contracts';
import { getNetworkConfig, NearViewError } from '@/lib/near';
import { askOf, formatUsdc } from '../desk/format';
import { listAllCompanies } from '../desk/data';
import { AppShell } from '../ui/app-shell';
import { Address, ButtonLink, Glass, Notice, PageHeader, Stat, StatGrid } from '../ui';
import { CompanyRows, OfferBook, type Row } from './board';
import { WalletBar } from './wallet-bar';
import s from './exchange.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Exchange | Incorpr' };

type Board =
  | { kind: 'no_registry' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; registryId: string; rows: Row[]; truncated: boolean; readAtMs: number };

async function loadBoard(): Promise<Board> {
  const { registryId } = getNetworkConfig();
  if (!registryId) return { kind: 'no_registry' };
  const registry = new RegistryClient(registryId);
  try {
    const { companies, truncated } = await listAllCompanies(registry);
    const rows = await Promise.all(
      companies.map(async (company): Promise<Row> => {
        const pledged = company.encumbrance !== 'Free' && 'Pledged' in company.encumbrance;
        const [token, offers, loan, auctionPrice] = await Promise.all([
          registry.nftToken(company.token_id),
          registry.getOffers(company.token_id),
          pledged ? registry.getLoan(company.token_id) : Promise.resolve(null),
          pledged ? registry.auctionPrice(company.token_id) : Promise.resolve(null),
        ]);
        return { company, charter: token?.metadata?.media ?? null, offers, loan, auctionPrice };
      }),
    );
    return { kind: 'ready', registryId, rows, truncated, readAtMs: Date.now() };
  } catch (error) {
    const message = error instanceof NearViewError || error instanceof Error ? error.message : String(error);
    return { kind: 'error', message };
  }
}

export default async function ExchangePage() {
  const { network, mpcContract } = getNetworkConfig();
  const board = await loadBoard();
  const nowMs = Date.now();

  const rows = board.kind === 'ready' ? board.rows : [];
  const listed = rows.filter((r) => askOf(r.company.encumbrance) !== null).length;
  const pledged = rows.filter((r) => r.loan !== null).length;
  const offerCount = rows.reduce((n, r) => n + r.offers.length, 0);
  const revenue = rows.reduce((sum, r) => sum + BigInt(r.company.revenue_30d), 0n);

  return (
    <AppShell>
      <PageHeader
        eyebrow="Exchange"
        index="01"
        title="Companies on the registry."
        accent="Buy one in a single USDC transfer."
        intro={
          <>
            Each row is a NEP-171 token and the vault account it controls. A purchase is one USDC transfer. The registry locks the listing,
            moves the vault&apos;s shareholder, then the NFT, and pays the seller; if any step fails, the buyer is refunded.
          </>
        }
        aside={
          board.kind === 'ready' ? (
            <Glass pad="md" className={s.asideStats}>
              <StatGrid>
                <Stat label="Companies" value={String(rows.length)} size="sm" />
                <Stat label="Listed" value={String(listed)} tone={listed ? 'amber' : 'muted'} size="sm" />
                <Stat label="Pledged" value={String(pledged)} tone={pledged ? 'lilac' : 'muted'} size="sm" />
                <Stat label="Open offers" value={String(offerCount)} size="sm" />
                <Stat label="30d revenue" value={formatUsdc(revenue)} unit="USDC" tone="teal" size="sm" />
              </StatGrid>
            </Glass>
          ) : undefined
        }
      />

      <div className={s.body}>
        {board.kind === 'no_registry' && (
          <Notice tone="info" title="No registry configured">
            <p>
              This page reads companies directly from an <code className={s.code}>incorpr-registry</code> contract and shows no sample data.
              None is configured for {network}, so there is nothing to list.
            </p>
            <p>
              To connect one, set <code className={s.code}>NEXT_PUBLIC_REGISTRY_CONTRACT_ID</code> in <code className={s.code}>web/.env.local</code>{' '}
              and restart the server.
            </p>
          </Notice>
        )}
        {board.kind === 'error' && (
          <Notice tone="error" title="Could not read the registry">
            <span className={s.err}>{board.message}</span>
          </Notice>
        )}
        {board.kind === 'ready' && board.rows.length === 0 && (
          <Notice tone="empty" title="No companies yet" action={<ButtonLink href="/incorporate">Incorporate the first one</ButtonLink>}>
            <p>
              <code className={s.code}>{board.registryId}</code> has no companies incorporated.
            </p>
          </Notice>
        )}
        {board.kind === 'ready' && board.rows.length > 0 && (
          <>
            <WalletBar />
            <CompanyRows rows={board.rows} nowMs={nowMs} />
            {board.truncated && <p className={s.note}>Showing the first {board.rows.length} companies.</p>}
            <OfferBook rows={board.rows} />
          </>
        )}

        <p className={s.note}>
          {board.kind === 'ready' && (
            <>
              Registry <Address value={board.registryId} /> <span aria-hidden>·</span>{' '}
            </>
          )}
          Signer <span className={s.num}>{mpcContract}</span> <span aria-hidden>·</span> 30-day revenue here is the last value each vault reported to the registry; the
          cockpit reads the vault directly.
        </p>
      </div>
    </AppShell>
  );
}
