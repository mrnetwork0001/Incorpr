import 'server-only';

// Chain reads for the company cockpit. Everything shown on the page comes from these views: the
// registry's company record and NEP-177 token, and the vault's own state and payment stats.

import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import {
  RegistryClient,
  VaultClient,
  type CompanyView,
  type ListingView,
  type Loan,
  type PaymentStats,
  type VaultState,
} from '@/lib/contracts';
import { getNetworkConfig, NearViewError, type NearNetwork, type ViewOptions } from '@/lib/near';

/** Where to read from. Defaults to the app's configured network and registry. */
export interface ChainSource {
  registryId?: string;
  rpcUrl?: string;
}

export interface Charter {
  /** `data:image/svg+xml;base64,...` from the token's NEP-177 `media`. */
  src: string;
  /** sha256 of the SVG bytes equals `media_hash`. Null when either is missing or not base64. */
  hashMatches: boolean | null;
  mediaHash: string | null;
}

export interface CockpitData {
  network: NearNetwork;
  registryId: string;
  rpcUrl: string;
  tokenId: string;
  company: CompanyView;
  state: VaultState;
  stats: PaymentStats | null;
  charter: Charter | null;
  listing: ListingView | null;
  loan: Loan | null;
  openOffers: number;
  /** Full and function-call access keys on the vault account. Null when the RPC read failed. */
  vaultAccessKeys: number | null;
  readAtMs: number;
}

export type CockpitLoad =
  | { kind: 'no_registry'; network: NearNetwork }
  | { kind: 'not_found'; registryId: string; tokenId: string }
  | { kind: 'error'; registryId: string; message: string }
  | { kind: 'ready'; data: CockpitData };

const DATA_URI = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/;

export function readCharter(media: string | null | undefined, mediaHash: string | null | undefined): Charter | null {
  if (!media) return null;
  const match = DATA_URI.exec(media);
  let hashMatches: boolean | null = null;
  if (match && mediaHash) {
    try {
      hashMatches = base64.encode(sha256(base64.decode(match[1] as string))) === mediaHash;
    } catch {
      hashMatches = false;
    }
  }
  return { src: media, hashMatches, mediaHash: mediaHash ?? null };
}

export function viewOptions(source: ChainSource = {}): ViewOptions {
  return source.rpcUrl ? { rpcUrl: source.rpcUrl } : {};
}

/** `view_access_key_list` on the vault. A vault is deployed with no keys and has no upgrade method. */
async function accessKeyCount(rpcUrl: string, accountId: string): Promise<number | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'keys',
        method: 'query',
        params: { request_type: 'view_access_key_list', finality: 'final', account_id: accountId },
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json()) as { result?: { keys?: unknown[] } };
    return Array.isArray(body.result?.keys) ? body.result.keys.length : null;
  } catch {
    return null;
  }
}

export async function loadCockpit(tokenId: string, source: ChainSource = {}): Promise<CockpitLoad> {
  const config = getNetworkConfig();
  const registryId = source.registryId ?? config.registryId;
  if (!registryId) return { kind: 'no_registry', network: config.network };
  const options = viewOptions(source);
  const registry = new RegistryClient(registryId, options);
  try {
    const company = await registry.getCompany(tokenId);
    if (!company) return { kind: 'not_found', registryId, tokenId };
    const vault = new VaultClient(company.vault, options);
    const listed = company.encumbrance !== 'Free' && 'Listed' in company.encumbrance;
    const pledged = company.encumbrance !== 'Free' && 'Pledged' in company.encumbrance;
    const rpcUrl = source.rpcUrl ?? config.rpcUrl;
    const [state, token, stats, listing, loan, offers, vaultAccessKeys] = await Promise.all([
      vault.getState(),
      registry.nftToken(tokenId),
      // Older vaults may lack the view; the ledger then shows the state fields alone.
      vault.paymentStats().catch((error: unknown) => {
        if (error instanceof NearViewError && error.failure === 'method_not_found') return null;
        throw error;
      }),
      listed ? registry.getListing(tokenId) : Promise.resolve(null),
      pledged ? registry.getLoan(tokenId) : Promise.resolve(null),
      registry.getOffers(tokenId),
      accessKeyCount(rpcUrl, company.vault),
    ]);
    return {
      kind: 'ready',
      data: {
        network: config.network,
        registryId,
        rpcUrl,
        tokenId,
        company,
        state,
        stats,
        charter: readCharter(token?.metadata?.media, token?.metadata?.media_hash),
        listing,
        loan,
        openOffers: offers.length,
        vaultAccessKeys,
        readAtMs: Date.now(),
      },
    };
  } catch (error) {
    return { kind: 'error', registryId, message: error instanceof Error ? error.message : String(error) };
  }
}
