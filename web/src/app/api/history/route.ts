import { NextResponse } from 'next/server';
import { ApiError, enforceRateLimit, errorResponse } from '@/lib/api';
import { loadHistory } from '@/lib/history';

export const dynamic = 'force-dynamic';

const RATE_LIMIT = { route: 'history', perIpPerMinute: 30, globalPerMinute: 300 };
const TOKEN_ID = /^\d{1,20}$/;

/**
 * GET /api/history?token_id=1. The token's timeline, holders and event totals, rebuilt from the
 * registry's and vault's NEP-297 logs and compared with the vault's get_state. Results are cached
 * for 60 s per token; transaction bodies for the life of the process.
 *
 * 200 `status: "ok"`, 404 `status: "not_found"`, 503 `status: "unavailable"` with the reason.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, RATE_LIMIT);
    const tokenId = new URL(request.url).searchParams.get('token_id') ?? '';
    if (!TOKEN_ID.test(tokenId)) throw new ApiError(400, 'token_id must be a decimal token id, for example 1');
    const result = await loadHistory(tokenId);
    const status = result.status === 'ok' ? 200 : result.status === 'not_found' ? 404 : 503;
    return NextResponse.json(result, { status, headers: { 'cache-control': 'public, max-age=30' } });
  } catch (error) {
    return errorResponse(error);
  }
}
