import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, enforceRateLimit, errorResponse, parseValue } from '@/lib/api';
import { isPrivateTeeModel, listLiveModels, pickDefaultModel, verifyAttestation } from '@/lib/nearAiTee';
import { treasuryPromptHash } from '@/lib/rebalance';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const RATE_LIMIT = { route: 'attestation', perIpPerMinute: 6, globalPerMinute: 60 };

const Query = z.strictObject({
  model: z.string().min(1).max(128).optional(),
  signing_address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

/**
 * Live attestation of a model's nodes, for comparing with a vault's `tee_signers`, `tee_models` and
 * `tee_prompt_hash`. Hardware evidence only: no chat and no API credits.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, RATE_LIMIT);
    const query = parseValue(Object.fromEntries(new URL(request.url).searchParams), Query);
    const model = query.model ?? (await pickDefaultModel());
    const live = (await listLiveModels()).find((m) => m.id === model);
    if (!live || !isPrivateTeeModel(live)) throw new ApiError(404, `${model} is not a ready Private TEE model`);
    const checks = await verifyAttestation({ model, signingAddress: query.signing_address });
    return NextResponse.json({ model, treasury_prompt_sha256: treasuryPromptHash(), ...checks });
  } catch (error) {
    return errorResponse(error);
  }
}
