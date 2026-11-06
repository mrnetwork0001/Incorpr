import 'server-only';

// Route plumbing shared by /api/owner/*. Every gated route calls `requireHolder`, which reads
// nft_token from the chain on each request.

import { NextResponse, type NextRequest } from 'next/server';
import { ApiError, errorResponse, scrubSecrets } from '@/lib/api';
import { getNetworkConfig, type NearNetwork } from '@/lib/near';
import {
  checkOwnerAccess,
  jsonRpcOwnerRpc,
  OwnerAuthError,
  OwnerNotConfiguredError,
  OwnerRpcError,
  sessionCookieName,
  sessionSecret,
  siteOrigin,
  type OwnerAccess,
  type OwnerRpc,
} from '@/lib/ownerAuth';

export const TOKEN_ID = /^\d{1,20}$/;

function isOwnerAuthError(error: unknown): error is OwnerAuthError {
  // By name too: in dev each route bundle has its own copy of the class.
  return error instanceof OwnerAuthError || (error instanceof Error && error.name === 'OwnerAuthError' && typeof (error as OwnerAuthError).status === 'number');
}

export function ownerErrorResponse(error: unknown): NextResponse {
  if (isOwnerAuthError(error)) {
    return NextResponse.json({ error: { code: error.code, message: scrubSecrets(error.message) } }, { status: error.status });
  }
  if (error instanceof OwnerNotConfiguredError) {
    return NextResponse.json({ error: { code: 'owner_auth_not_configured', message: error.message } }, { status: 503 });
  }
  if (error instanceof OwnerRpcError) {
    return NextResponse.json({ error: { code: 'near_rpc', message: scrubSecrets(error.message) } }, { status: 502 });
  }
  return errorResponse(error);
}

export function registryOrThrow(): { registryId: string; network: NearNetwork } {
  const config = getNetworkConfig();
  if (!config.registryId) throw new ApiError(503, `No registry is configured for ${config.network}. Set NEXT_PUBLIC_REGISTRY_CONTRACT_ID.`);
  return { registryId: config.registryId, network: config.network };
}

export function tokenIdOrThrow(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN_ID.test(value)) throw new OwnerAuthError(400, 'bad_token_id', 'token_id must be a decimal token id');
  return value;
}

/**
 * State-changing owner routes refuse a browser request from another origin. The session cookie is
 * SameSite=Strict as well; this also covers the sign-in route, which carries no cookie. The origin
 * compared against is the configured site origin (siteOrigin), not the request's own Host header.
 */
export function assertSameOrigin(request: Request): void {
  const site = siteOrigin(request.headers);
  const origin = request.headers.get('origin');
  if (origin) {
    let given = '';
    try {
      given = new URL(origin).origin.toLowerCase();
    } catch {
      given = '';
    }
    if (given !== site.origin.toLowerCase()) throw new OwnerAuthError(403, 'cross_origin', 'Owner routes accept requests from this site only.');
    return;
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw new OwnerAuthError(403, 'cross_origin', 'Owner routes accept requests from this site only.');
}

/** The configured site origin, for the wallet callback URL and the credential key URL. */
export function requestOrigin(request: Request): string {
  return siteOrigin(request.headers).origin;
}

export interface Gate {
  access: Extract<OwnerAccess, { kind: 'holder' }>;
  registryId: string;
  network: NearNetwork;
  rpc: OwnerRpc;
}

/** 401 without a valid session, 403 when nft_token no longer names the session account. */
export async function requireHolder(request: NextRequest, tokenId: string, rpc: OwnerRpc = jsonRpcOwnerRpc()): Promise<Gate> {
  const { registryId, network } = registryOrThrow();
  const access = await checkOwnerAccess({
    cookie: request.cookies.get(sessionCookieName(tokenId))?.value,
    tokenId,
    registryId,
    network,
    secret: sessionSecret(),
    rpc,
  });
  if (access.kind === 'signed_out') throw new OwnerAuthError(401, 'signed_out', `${access.reason} Sign in on /company/${tokenId}/owner.`);
  if (access.kind === 'not_holder') {
    throw new OwnerAuthError(
      403,
      'not_holder',
      `${access.session.account_id} no longer holds token ${tokenId}: nft_token names ${access.holder.ownerId ?? 'nobody'} at block ${access.holder.blockHeight}.`,
    );
  }
  return { access, registryId, network, rpc };
}

export function noStore(response: NextResponse): NextResponse {
  response.headers.set('cache-control', 'no-store');
  return response;
}
