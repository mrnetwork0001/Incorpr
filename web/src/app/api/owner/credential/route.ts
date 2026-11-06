// POST /api/owner/credential { token_id } -> a signed statement "<account> holds Incorpr token <id>
// as of block <height>", for the current holder only. The block is the one nft_token was read at
// for this request. Verify with the key at /api/owner/credential-key.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit, parseJsonBody } from '@/lib/api';
import { credentialKey, issueCredential } from '@/lib/ownerAuth';
import { assertSameOrigin, noStore, ownerErrorResponse, requestOrigin, requireHolder, TOKEN_ID } from '../_lib/http';

export const dynamic = 'force-dynamic';

const Body = z.strictObject({ token_id: z.string().regex(TOKEN_ID, 'must be a decimal token id') });

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    enforceRateLimit(request, { route: 'owner-credential', perIpPerMinute: 20, globalPerMinute: 300 });
    assertSameOrigin(request);
    const key = credentialKey();
    const { token_id } = await parseJsonBody(request, Body);
    const { access } = await requireHolder(request, token_id);
    const signed = issueCredential({ session: access.session, holder: access.holder, keyUrl: `${requestOrigin(request)}/api/owner/credential-key` }, key);
    const response = NextResponse.json({ ...signed, ephemeral_key: key.ephemeral });
    response.headers.set('content-disposition', `attachment; filename="incorpr-token-${token_id}-holder-${access.holder.blockHeight}.json"`);
    return noStore(response);
  } catch (error) {
    return ownerErrorResponse(error);
  }
}
