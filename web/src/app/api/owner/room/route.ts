// GET /api/owner/room?token_id=N -> the vault settings and claimable amount shown in the owner
// room, for the current holder only. nft_token is read on this request.

import { NextResponse, type NextRequest } from 'next/server';
import { enforceRateLimit } from '@/lib/api';
import { RegistryClient, VaultClient } from '@/lib/contracts';
import { vaultSettings } from '../../../company/[id]/owner/load';
import { noStore, ownerErrorResponse, requireHolder, tokenIdOrThrow } from '../_lib/http';
import { OwnerAuthError } from '@/lib/ownerAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    enforceRateLimit(request, { route: 'owner-room', perIpPerMinute: 60, globalPerMinute: 1200 });
    const tokenId = tokenIdOrThrow(request.nextUrl.searchParams.get('token_id'));
    const { access, registryId } = await requireHolder(request, tokenId);
    const company = await new RegistryClient(registryId).getCompany(tokenId);
    if (!company) throw new OwnerAuthError(404, 'token_not_found', `${registryId} has no company ${tokenId}`);
    const state = await new VaultClient(company.vault).getState();
    return noStore(
      NextResponse.json({
        account_id: access.session.account_id,
        token_id: tokenId,
        checked_at_block: access.holder.blockHeight,
        checked_block_hash: access.holder.blockHash,
        claimable_micro_usdc: state.retained_earnings,
        settings: vaultSettings(company, state),
      }),
    );
  } catch (error) {
    return ownerErrorResponse(error);
  }
}
