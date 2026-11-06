// /api/owner/session
//   POST   { challenge_id, account_id, public_key, signature } -> verifies the NEP-413 signature,
//          the full access key and the holder, then sets the HttpOnly session cookie.
//   GET    ?token_id=N -> 200 when the session account holds the token now, else 401 or 403.
//   DELETE ?token_id=N -> clears the cookie.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit, parseJsonBody } from '@/lib/api';
import {
  completeSignIn,
  jsonRpcOwnerRpc,
  sessionCookieName,
  sessionCookieOptions,
  sessionSecret,
  sharedChallengeStore,
  signSession,
  siteOrigin,
} from '@/lib/ownerAuth';
import { assertSameOrigin, noStore, ownerErrorResponse, requireHolder, tokenIdOrThrow } from '../_lib/http';

export const dynamic = 'force-dynamic';

const Body = z.strictObject({
  challenge_id: z.string().min(40).max(48),
  account_id: z.string().min(2).max(64),
  public_key: z.string().min(8).max(128),
  signature: z.string().min(8).max(200),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    enforceRateLimit(request, { route: 'owner-session', perIpPerMinute: 20, globalPerMinute: 600 });
    assertSameOrigin(request);
    const secret = sessionSecret();
    const body = await parseJsonBody(request, Body);
    const site = siteOrigin(request.headers);
    const { session, holder, signedCallbackUrl } = await completeSignIn(
      { challengeId: body.challenge_id, accountId: body.account_id, publicKey: body.public_key, signature: body.signature },
      { store: sharedChallengeStore(), rpc: jsonRpcOwnerRpc(), recipient: site.host },
    );
    const response = NextResponse.json({
      account_id: session.account_id,
      token_id: session.token_id,
      expires_at_ms: session.exp,
      holder_checked_at_block: holder.blockHeight,
      signed_callback_url: signedCallbackUrl,
    });
    response.cookies.set(sessionCookieName(session.token_id), signSession(session, secret), sessionCookieOptions(site, Math.floor((session.exp - session.iat) / 1000)));
    return noStore(response);
  } catch (error) {
    return ownerErrorResponse(error);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    enforceRateLimit(request, { route: 'owner-session-check', perIpPerMinute: 60, globalPerMinute: 1200 });
    const tokenId = tokenIdOrThrow(request.nextUrl.searchParams.get('token_id'));
    const { access } = await requireHolder(request, tokenId);
    return noStore(
      NextResponse.json({
        holder: true,
        account_id: access.session.account_id,
        token_id: tokenId,
        expires_at_ms: access.session.exp,
        checked_at_block: access.holder.blockHeight,
        checked_block_hash: access.holder.blockHash,
      }),
    );
  } catch (error) {
    return ownerErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    const tokenId = tokenIdOrThrow(request.nextUrl.searchParams.get('token_id'));
    const response = NextResponse.json({ signed_out: true, token_id: tokenId });
    response.cookies.set(sessionCookieName(tokenId), '', sessionCookieOptions(siteOrigin(request.headers), 0));
    return noStore(response);
  } catch (error) {
    return ownerErrorResponse(error);
  }
}
