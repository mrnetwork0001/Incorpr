// POST /api/owner/challenge { token_id } -> a NEP-413 message for the wallet to sign.
// The nonce is 32 random bytes, single use, valid for 5 minutes. recipient is the configured site
// host (NEXT_PUBLIC_SITE_URL, or localhost on a dev server), never a request header.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit, parseJsonBody } from '@/lib/api';
import { sessionSecret, sharedChallengeStore, siteOrigin } from '@/lib/ownerAuth';
import { assertSameOrigin, noStore, ownerErrorResponse, registryOrThrow, TOKEN_ID } from '../_lib/http';

export const dynamic = 'force-dynamic';

const Body = z.strictObject({ token_id: z.string().regex(TOKEN_ID, 'must be a decimal token id') });

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    enforceRateLimit(request, { route: 'owner-challenge', perIpPerMinute: 20, globalPerMinute: 600 });
    assertSameOrigin(request);
    // Refuse before the wallet prompt when the server cannot issue a session anyway.
    sessionSecret();
    const { registryId, network } = registryOrThrow();
    const { token_id } = await parseJsonBody(request, Body);
    const site = siteOrigin(request.headers);
    const challenge = sharedChallengeStore().issue({
      tokenId: token_id,
      registryId,
      network,
      recipient: site.host,
      callbackUrl: `${site.origin}/company/${token_id}/owner`,
    });
    return noStore(
      NextResponse.json({
        challenge_id: challenge.id,
        message: challenge.message,
        nonce: Buffer.from(challenge.nonce).toString('base64'),
        recipient: challenge.recipient,
        callback_url: challenge.callbackUrl,
        token_id,
        expires_at_ms: challenge.expiresAtMs,
      }),
    );
  } catch (error) {
    return ownerErrorResponse(error);
  }
}
