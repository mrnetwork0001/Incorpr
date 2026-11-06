import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, enforceRateLimit, errorResponse, parseJsonBody, scrubSecrets } from '@/lib/api';
import { RegistryClient, VaultClient } from '@/lib/contracts';
import { checkFreshness } from '@/lib/l1FreshnessCheck';
import { getNetworkConfig } from '@/lib/near';
import {
  attestedChat,
  pickDefaultModel,
  sha256Hex,
  summarizeVerification,
  teeConfigured,
} from '@/lib/nearAiTee';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const RATE_LIMIT = { route: 'verify-l1', perIpPerMinute: 10, globalPerMinute: 60 };

const Body = z.strictObject({
  token_id: z.string().regex(/^\d{1,20}$/, 'must be a decimal token id'),
});

const ATTESTATION_SCOPE =
  'The TEE signature covers a request containing this report, so it proves the report existed in this form when the chat ran. ' +
  'The TEE did not read the chains itself: the L1 reads were made by this server.';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, RATE_LIMIT);
    const { token_id } = await parseJsonBody(request, Body);
    const company = await new RegistryClient().getCompany(token_id);
    if (!company) throw new ApiError(404, `Company ${token_id} does not exist`);
    const state = await new VaultClient(company.vault).getState();

    const report = await checkFreshness(company.vault, state, getNetworkConfig().network);
    const reportJson = JSON.stringify(report);
    const reportSha256 = sha256Hex(reportJson);

    if (!teeConfigured()) {
      return NextResponse.json({
        report,
        report_sha256: reportSha256,
        attestation: { state: 'unsigned', reason: 'NEAR_AI_API_KEY is not set on this server' },
      });
    }

    try {
      const { inference, verification } = await attestedChat({
        model: await pickDefaultModel(),
        system: 'You receive a JSON report and its sha256. Reply with exactly: ACK <sha256>. Output nothing else.',
        user: `${reportJson}\nsha256=${reportSha256}`,
        maxTokens: 128,
      });
      return NextResponse.json({
        report,
        report_sha256: reportSha256,
        attestation: {
          state: 'signed',
          scope: ATTESTATION_SCOPE,
          chat_id: inference.chatId,
          model: inference.model,
          model_output: inference.content,
          request_body: inference.requestBody,
          response_body: inference.responseBody,
          verification,
          verification_summary: summarizeVerification(verification),
        },
      });
    } catch (error) {
      // The L1 report stands by itself. A TEE outage must not hide it.
      return NextResponse.json({
        report,
        report_sha256: reportSha256,
        attestation: {
          state: 'failed',
          reason: scrubSecrets(error instanceof Error ? error.message : String(error)),
        },
      });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
