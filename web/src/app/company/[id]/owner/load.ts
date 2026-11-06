import 'server-only';

// Reads for the owner room. The access check runs first and on every render: nft_token(token_id)
// from the chain against the session cookie. Vault state is read only for the holder.

import { RegistryClient, VaultClient, type CompanyView, type VaultState } from '@/lib/contracts';
import { getNetworkConfig, type NearNetwork } from '@/lib/near';
import {
  checkOwnerAccess,
  jsonRpcOwnerRpc,
  OwnerNotConfiguredError,
  OwnerRpcError,
  sessionSecret,
  type OwnerAccess,
  type OwnerRpc,
} from '@/lib/ownerAuth';

export type OwnerRoomLoad =
  | { kind: 'no_registry'; network: NearNetwork }
  | { kind: 'not_configured'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'not_found'; registryId: string }
  | { kind: 'locked'; access: Exclude<OwnerAccess, { kind: 'holder' }>; registryId: string; network: NearNetwork }
  | {
      kind: 'open';
      access: Extract<OwnerAccess, { kind: 'holder' }>;
      registryId: string;
      network: NearNetwork;
      company: CompanyView;
      state: VaultState;
      readAtMs: number;
    };

export async function loadOwnerRoom(tokenId: string, cookie: string | undefined, rpc: OwnerRpc = jsonRpcOwnerRpc()): Promise<OwnerRoomLoad> {
  const config = getNetworkConfig();
  const registryId = config.registryId;
  if (!registryId) return { kind: 'no_registry', network: config.network };
  let secret: Uint8Array;
  try {
    secret = sessionSecret();
  } catch (error) {
    if (error instanceof OwnerNotConfiguredError) return { kind: 'not_configured', message: error.message };
    throw error;
  }
  try {
    const access = await checkOwnerAccess({ cookie, tokenId, registryId, network: config.network, secret, rpc });
    if (access.holder.ownerId === null) return { kind: 'not_found', registryId };
    if (access.kind !== 'holder') return { kind: 'locked', access, registryId, network: config.network };
    const company = await new RegistryClient(registryId).getCompany(tokenId);
    if (!company) return { kind: 'not_found', registryId };
    const state = await new VaultClient(company.vault).getState();
    return { kind: 'open', access, registryId, network: config.network, company, state, readAtMs: Date.now() };
  } catch (error) {
    const message = error instanceof OwnerRpcError || error instanceof Error ? error.message : String(error);
    return { kind: 'error', message };
  }
}

/** The vault settings the room shows, as plain JSON. Also served by GET /api/owner/room. */
export function vaultSettings(company: CompanyView, state: VaultState) {
  return {
    vault: company.vault,
    shareholder: state.shareholder,
    encumbrance: state.encumbrance,
    in_transit: state.in_transit,
    price_micro_usdc: state.price_micro_usdc,
    compute_reserve_bps: state.compute_reserve_bps,
    compute_payee: state.compute_payee,
    founder: state.founder,
    founder_royalty_bps: state.founder_royalty_bps,
    usdc_token: state.usdc_token,
    mpc_contract: state.mpc_contract,
    intents_contract: state.intents_contract,
    treasury_epoch: state.treasury_epoch,
    raw_sigs_this_epoch: state.raw_sigs_this_epoch,
    owner_generation: state.owner_generation,
    sync_nonce: state.sync_nonce,
    intents_key_registered: state.intents_key_registered,
    latest_intent_deadline_ms: state.latest_intent_deadline_ms,
    spend_window: state.spend_window,
    spent_this_window: state.spent_this_window,
    retained_earnings: state.retained_earnings,
    /** In force while Free. */
    policy: state.policy,
    /** The charter policy the vault falls back to while listed, pledged or in transit. */
    default_policy: state.default_policy,
  };
}
