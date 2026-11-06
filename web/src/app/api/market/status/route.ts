import { NextResponse } from 'next/server';
import { enforceRateLimit, errorResponse } from '@/lib/api';
import {
  fetchPublicAgent,
  listingUrls,
  marketClientFromEnv,
  marketHandle,
  scrubMarketSecrets,
  type AssignmentStatus,
} from '@/lib/agentMarket';
import { marketCompanyId } from '@/lib/agentMarketWork';
import { teeConfigured } from '@/lib/nearAiTee';

// Public, read-only summary of the company's Agent Market listing for the site. Counts only: no
// buyer, job or deliverable data leaves this route.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const RATE_LIMIT = { route: 'market-status', perIpPerMinute: 30, globalPerMinute: 300 };
const CACHE_MS = 60_000;

interface JobCounts {
  in_progress: number;
  in_review: number;
  accepted: number;
  other: number;
  /** Assignments with at least one delivered version: in review, accepted, disputed or split. */
  delivered: number;
}

let cache: { at: number; key: string; body: Record<string, unknown> } | null = null;

function errorText(error: unknown): string {
  return scrubMarketSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200);
}

async function jobCounts(): Promise<JobCounts> {
  const rows = await marketClientFromEnv().listAllAssignments('all', 2_000);
  const by = (status: AssignmentStatus) => rows.filter((r) => r.assignment.status === status).length;
  const inProgress = by('in_progress');
  const inReview = by('submitted');
  const accepted = by('accepted');
  return {
    in_progress: inProgress,
    in_review: inReview,
    accepted,
    other: rows.length - inProgress - inReview - accepted,
    delivered: inReview + accepted + by('disputed') + by('dispute_resolved'),
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, RATE_LIMIT);
    const handle = marketHandle();
    const tokenSet = Boolean(process.env.AGENT_MARKET_TOKEN);
    const key = `${handle}:${tokenSet}`;
    if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return NextResponse.json(cache.body);

    let listing: Record<string, unknown> | null = null;
    let listingError: string | null = null;
    if (handle) {
      try {
        const agent = await fetchPublicAgent(handle);
        listing = agent
          ? {
              name: agent.name,
              listing_status: agent.listing_status,
              delivered_jobs: agent.delivered_jobs,
              success_rate: agent.success_rate ?? null,
              response_time_seconds_median: agent.response_time_seconds_median ?? null,
            }
          : null;
      } catch (error) {
        listingError = errorText(error);
      }
    }

    let jobs: JobCounts | null = null;
    let jobsError: string | null = null;
    if (tokenSet) {
      try {
        jobs = await jobCounts();
      } catch (error) {
        jobsError = errorText(error);
      }
    }

    const body = {
      handle,
      company_token_id: marketCompanyId(),
      urls: handle ? listingUrls(handle) : null,
      configured: {
        handle: Boolean(handle),
        token: tokenSet,
        webhook_secret: Boolean(process.env.AGENT_MARKET_WEBHOOK_SECRET),
        near_ai: teeConfigured(),
        cron_secret: Boolean(process.env.CRON_SECRET),
      },
      // Public listing as market.near.ai serves it; null while the listing is a draft, paused or archived.
      listing,
      listing_error: listingError,
      // This agent's assignments, counted. Null without AGENT_MARKET_TOKEN.
      jobs,
      jobs_error: jobsError,
      checked_at: new Date().toISOString(),
    };
    cache = { at: Date.now(), key, body };
    return NextResponse.json(body);
  } catch (error) {
    return errorResponse(error);
  }
}
