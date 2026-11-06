import { NextResponse } from 'next/server';
import { marketErrorResponse, pollOnce, safeEqual, workDepsFromEnv } from '@/lib/agentMarketWork';

// Fallback for missed Agent Market webhooks. Vercel Cron calls it with
// "Authorization: Bearer <CRON_SECRET>"; scripts/market-poll.mjs calls it the same way by hand.
// Idempotent: it acts only on assignments the marketplace lists as in_progress, and every
// assignment is re-read and leased before work (see src/lib/agentMarketWork.ts).

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Stop starting new audits after this, so the last one finishes inside maxDuration. */
const WORK_BUDGET_MS = 150_000;

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return NextResponse.json(
        { error: { code: 'not_configured', message: 'CRON_SECRET is not set, so the Agent Market poll is unavailable' } },
        { status: 503 },
      );
    }
    const header = request.headers.get('authorization') ?? '';
    if (!safeEqual(header, `Bearer ${secret}`)) {
      return NextResponse.json({ error: { code: 'unauthorized', message: 'Bearer CRON_SECRET required' } }, { status: 401 });
    }
    const deps = workDepsFromEnv();
    const report = await pollOnce(deps, { budgetMs: WORK_BUDGET_MS });
    return NextResponse.json({ ok: true, ...report, checked_at: new Date().toISOString() });
  } catch (error) {
    return marketErrorResponse(error);
  }
}
