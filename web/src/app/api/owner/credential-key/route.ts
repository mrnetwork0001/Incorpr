// GET  /api/owner/credential-key -> the ed25519 public key that signs holder credentials.
// POST /api/owner/credential-key { payload, signature, credential? } -> checks a credential
//      against that key. The check is local arithmetic; anyone can repeat it with the public key.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit, parseJsonBody } from '@/lib/api';
import { credentialKey, CREDENTIAL_TYPE, verifyCredential } from '@/lib/ownerAuth';
import { noStore, ownerErrorResponse } from '../_lib/http';

export const dynamic = 'force-dynamic';

const HOW_TO_VERIFY =
  'ed25519.verify(base64decode(signature), utf8(payload), base58decode(public_key without "ed25519:")). ' +
  'The statement is true as of block_height on network; read nft_token on the registry at that block to check it.';

export async function GET(): Promise<NextResponse> {
  try {
    const key = credentialKey();
    return noStore(
      NextResponse.json({
        public_key: key.publicKey,
        algorithm: 'ed25519',
        credential_type: CREDENTIAL_TYPE,
        signed_bytes: 'UTF-8 bytes of the payload string',
        how_to_verify: HOW_TO_VERIFY,
        ephemeral: key.ephemeral,
        ...(key.ephemeral ? { note: 'OWNER_CREDENTIAL_KEY is not set: this dev server made a random key that ends when it restarts.' } : {}),
      }),
    );
  } catch (error) {
    return ownerErrorResponse(error);
  }
}

const Body = z.object({
  payload: z.string().min(2).max(4096),
  signature: z.string().min(8).max(200),
  credential: z.unknown().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    enforceRateLimit(request, { route: 'owner-credential-verify', perIpPerMinute: 30, globalPerMinute: 600 });
    const key = credentialKey();
    const doc = await parseJsonBody(request, Body);
    const check = verifyCredential(doc, key.publicKey);
    return noStore(NextResponse.json({ ...check, public_key: key.publicKey }));
  } catch (error) {
    return ownerErrorResponse(error);
  }
}
