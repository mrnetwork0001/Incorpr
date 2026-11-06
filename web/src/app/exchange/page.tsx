import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { RegistryClient, type CompanyView, type EncumbranceState } from '@/lib/contracts';
import { getNetworkConfig, NearViewError } from '@/lib/near';
import { EncumbrancePill, type EncumbranceLabel } from '../encumbrance-pill';
import { WalletStatus } from '../wallet-status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Exchange | Incorpr' };

const PAGE_SIZE = 100;
const USDC_DECIMALS = 1_000_000n;
const DAYS_PER_YEAR = 365n;
const REVENUE_WINDOW_DAYS = 30n;

function encumbranceLabel(state: EncumbranceState): EncumbranceLabel {
  if (state === 'Free') return 'FREE';
  return 'Listed' in state ? 'LISTED' : 'PLEDGED';
}

function formatUsdc(microUsdc: string): string {
  const value = BigInt(microUsdc);
  const whole = (value / USDC_DECIMALS).toLocaleString('en-US');
  const cents = ((value % USDC_DECIMALS) / 10_000n).toString().padStart(2, '0');
  return `$${whole}.${cents}`;
}

/** Ask divided by 30-day revenue annualized. A dash when there is no ask or no revenue. */
function impliedMultiple(state: EncumbranceState, revenue30d: string): string {
  if (state === 'Free' || !('Listed' in state)) return '-';
  const annualized = (BigInt(revenue30d) * DAYS_PER_YEAR) / REVENUE_WINDOW_DAYS;
  if (annualized === 0n) return '-';
  const tenths = (BigInt(state.Listed.ask) * 10n) / annualized;
  return `${tenths / 10n}.${tenths % 10n}x`;
}

function askOf(state: EncumbranceState): string {
  return state !== 'Free' && 'Listed' in state ? formatUsdc(state.Listed.ask) : '-';
}

type Board =
  | { kind: 'no_registry' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; registryId: string; companies: CompanyView[]; charters: Map<string, string> };

async function loadBoard(): Promise<Board> {
  const { registryId } = getNetworkConfig();
  if (!registryId) return { kind: 'no_registry' };
  const registry = new RegistryClient(registryId);
  try {
    const companies = await registry.listCompanies(0, PAGE_SIZE);
    const tokens = await Promise.all(companies.map((company) => registry.nftToken(company.token_id)));
    const charters = new Map<string, string>();
    for (const token of tokens) {
      if (token?.metadata?.media) charters.set(token.token_id, token.metadata.media);
    }
    return { kind: 'ready', registryId, companies, charters };
  } catch (error) {
    const message = error instanceof NearViewError || error instanceof Error ? error.message : String(error);
    return { kind: 'error', message };
  }
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border border-line bg-panel p-6 md:p-8">
      <h2 className="font-display text-2xl">{title}</h2>
      <div className="mt-3 max-w-2xl space-y-3 leading-relaxed text-dim">{children}</div>
    </div>
  );
}

function CompanyTable({ companies, charters }: { companies: CompanyView[]; charters: Map<string, string> }) {
  const head = ['Company', 'State', '30d revenue', 'Retained', 'Calls', 'Ask', 'Implied multiple'];
  return (
    <div className="overflow-x-auto border border-line">
      <table className="w-full min-w-[860px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line">
            {head.map((h, i) => (
              <th key={h} scope="col" className={`label px-4 py-3 font-normal ${i > 1 ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {companies.map((company) => {
            const charter = charters.get(company.token_id);
            return (
              <tr key={company.token_id} className="border-b border-line last:border-b-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    {charter ? (
                      // eslint-disable-next-line @next/next/no-img-element -- on-chain SVG data URI, not an optimizable asset
                      <img src={charter} alt={`${company.name} charter`} className="h-12 w-12 shrink-0 border border-line object-cover" />
                    ) : (
                      <div className="h-12 w-12 shrink-0 border border-line" aria-hidden />
                    )}
                    <div>
                      <p>{company.name}</p>
                      <p className="data text-xs text-dim">{company.vault}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <EncumbrancePill state={encumbranceLabel(company.encumbrance)} />
                </td>
                <td className="data px-4 py-3 text-right">{formatUsdc(company.revenue_30d)}</td>
                <td className="data px-4 py-3 text-right">{formatUsdc(company.retained)}</td>
                <td className="data px-4 py-3 text-right">{company.calls.toLocaleString('en-US')}</td>
                <td className="data px-4 py-3 text-right">{askOf(company.encumbrance)}</td>
                <td className="data px-4 py-3 text-right">{impliedMultiple(company.encumbrance, company.revenue_30d)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function ExchangePage() {
  const { network, mpcContract } = getNetworkConfig();
  const board = await loadBoard();

  return (
    <>
      <header className="border-b border-line">
        <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-5 md:px-8" aria-label="App">
          <div className="flex items-center gap-5">
            <Link href="/" className="font-display text-xl">
              Incorpr
            </Link>
            <span className="label border border-line px-2 py-0.5">{network}</span>
          </div>
          <WalletStatus />
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-10 md:px-8">
        <p className="label">Exchange</p>
        <h1 className="mt-2 font-display text-4xl">Companies on the registry</h1>

        <div className="mt-8">
          {board.kind === 'no_registry' && (
            <Notice title="No registry configured">
              <p>
                This app reads companies directly from an <code className="data text-sm text-paper">incorpr-registry</code> contract and shows
                no sample data. None is deployed on {network} yet, so there is nothing to list.
              </p>
              <p>
                To connect one, set <code className="data text-sm text-paper">NEXT_PUBLIC_REGISTRY_CONTRACT_ID</code> in{' '}
                <code className="data text-sm text-paper">web/.env.local</code> and restart the server.
              </p>
            </Notice>
          )}
          {board.kind === 'error' && (
            <Notice title="Could not read the registry">
              <p className="data break-words text-sm text-danger">{board.message}</p>
            </Notice>
          )}
          {board.kind === 'ready' && board.companies.length === 0 && (
            <Notice title="No companies yet">
              <p>
                <code className="data text-sm text-paper">{board.registryId}</code> has no companies incorporated.
              </p>
            </Notice>
          )}
          {board.kind === 'ready' && board.companies.length > 0 && <CompanyTable companies={board.companies} charters={board.charters} />}
        </div>

        <p className="mt-6 text-xs text-dim">
          Signer: <span className="data">{mpcContract}</span>. Registry 30-day revenue is the last value each vault reported.
        </p>
      </main>
    </>
  );
}
