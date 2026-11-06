// Reads everything the Desk shows for one account, straight from the registry and the vaults.
// Optimistic finality, so a transaction the wallet just confirmed is visible on the next read.

import {
  RegistryClient,
  VaultClient,
  ftViews,
  type CompanyView,
  type Loan,
  type ListingView,
  type Offer,
  type VaultState,
} from '@/lib/contracts';
import { getNetworkConfig } from '@/lib/near';

const PAGE = 100;
/** Upper bound on companies scanned for offers and loans. The registry pages at 100. */
export const MAX_SCANNED = 1_000;

export interface LoanView {
  loan: Loan;
  /** `auction_price`: null until an auction starts; the floor once its window has closed. */
  auctionPrice: string | null;
}

export interface OwnedCompany {
  company: CompanyView;
  vault: VaultState | null;
  vaultError: string | null;
  offers: Offer[];
  listing: ListingView | null;
  loan: LoanView | null;
}

export interface DeskData {
  readAtMs: number;
  owned: OwnedCompany[];
  /** Loans where the connected account is the lender. */
  lending: { company: CompanyView; loan: LoanView }[];
  /** Open offers the connected account funded. */
  myOffers: { company: CompanyView; offer: Offer }[];
  /** Every company, for the offer form. */
  companies: CompanyView[];
  pendingWithdrawal: string;
  usdcToken: string | null;
  usdcBalance: string | null;
  offerStorageCost: string;
  /** True when the registry holds more companies than were scanned. */
  truncated: boolean;
}

const LATEST = { finality: 'optimistic' } as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function listAllCompanies(registry: RegistryClient): Promise<{ companies: CompanyView[]; truncated: boolean }> {
  const companies: CompanyView[] = [];
  for (let from = 0; from < MAX_SCANNED; from += PAGE) {
    const page = await registry.listCompanies(from, PAGE);
    companies.push(...page);
    if (page.length < PAGE) return { companies, truncated: false };
  }
  return { companies, truncated: true };
}

function isPledged(company: CompanyView): boolean {
  return company.encumbrance !== 'Free' && 'Pledged' in company.encumbrance;
}

export async function loadDesk(registryId: string, accountId: string): Promise<DeskData> {
  const registry = new RegistryClient(registryId, LATEST);
  const [{ companies, truncated }, pendingWithdrawal, offerStorageCost] = await Promise.all([
    listAllCompanies(registry),
    registry.pendingWithdrawal(accountId),
    registry.offerStorageCost(),
  ]);

  const [offersByToken, loansByToken] = await Promise.all([
    Promise.all(companies.map((c) => registry.getOffers(c.token_id))),
    Promise.all(
      companies.map(async (c): Promise<LoanView | null> => {
        if (!isPledged(c)) return null;
        const [loan, auctionPrice] = await Promise.all([registry.getLoan(c.token_id), registry.auctionPrice(c.token_id)]);
        return loan ? { loan, auctionPrice } : null;
      }),
    ),
  ]);

  const owned = await Promise.all(
    companies
      .map((company, i) => ({ company, i }))
      .filter(({ company }) => company.owner_id === accountId)
      .map(async ({ company, i }): Promise<OwnedCompany> => {
        const listingPromise = registry.getListing(company.token_id);
        let vault: VaultState | null = null;
        let vaultError: string | null = null;
        try {
          vault = await new VaultClient(company.vault, LATEST).getState();
        } catch (error) {
          vaultError = message(error);
        }
        return {
          company,
          vault,
          vaultError,
          offers: offersByToken[i] ?? [],
          listing: await listingPromise,
          loan: loansByToken[i] ?? null,
        };
      }),
  );

  const lending: DeskData['lending'] = [];
  const myOffers: DeskData['myOffers'] = [];
  companies.forEach((company, i) => {
    const loan = loansByToken[i];
    if (loan && loan.loan.lender === accountId) lending.push({ company, loan });
    for (const offer of offersByToken[i] ?? []) {
      if (offer.lender === accountId) myOffers.push({ company, offer });
    }
  });

  const usdcToken = getNetworkConfig().usdcToken ?? owned.find((o) => o.vault)?.vault?.usdc_token ?? null;
  let usdcBalance: string | null = null;
  if (usdcToken) {
    try {
      usdcBalance = await ftViews.balanceOf(usdcToken, accountId, LATEST);
    } catch {
      usdcBalance = null;
    }
  }

  return {
    readAtMs: Date.now(),
    owned,
    lending,
    myOffers,
    companies,
    pendingWithdrawal,
    usdcToken,
    usdcBalance,
    offerStorageCost,
    truncated,
  };
}
