import { NextResponse } from 'next/server';
import { enforceRateLimit, errorResponse } from '@/lib/api';
import { getNetworkConfig } from '@/lib/near';
import { evidenceAttempts, robSettings } from '@/lib/rob/server';
import { limiter, recentAttempts } from '@/lib/rob/store';

export const dynamic = 'force-dynamic';

const RATE_LIMIT = { route: 'rob-recent', perIpPerMinute: 60, globalPerMinute: 600 };

/**
 * Attempts this server sent since it started (memory only, newest first) and the refusals recorded in
 * docs/evidence/<network>.json by scripts/demo.mjs. Every entry carries a transaction hash.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, RATE_LIMIT);
    let usage: { usedToday: number; dailyMax: number } | null = null;
    try {
      usage = limiter('rob-attempt', robSettings().attemptLimits).usage();
    } catch {
      usage = null;
    }
    return NextResponse.json({
      network: getNetworkConfig().network,
      attempts: recentAttempts(),
      evidence: evidenceAttempts(),
      usage,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
