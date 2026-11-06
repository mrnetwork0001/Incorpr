'use client';

// "Hire on Agent Market" for the company that /api/market/status describes. Renders nothing until
// the listing is live on market.near.ai, so the button never points at a draft or a 404.

import { useEffect, useState } from 'react';
import { ButtonLink } from './button';

interface MarketStatus {
  handle: string | null;
  company_token_id: string;
  urls: { agentHost: string; profile: string } | null;
  listing: { name: string; listing_status: string; delivered_jobs: number } | null;
  jobs: { in_progress: number; delivered: number; accepted: number } | null;
}

export interface HireOnMarketProps {
  /** Show the button only on this company's page. Omit to show it wherever the component is placed. */
  tokenId?: string;
  className?: string;
}

export function HireOnMarket({ tokenId, className }: HireOnMarketProps) {
  const [status, setStatus] = useState<MarketStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/market/status', { signal: controller.signal, cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<MarketStatus>) : null))
      .then((body) => setStatus(body))
      .catch(() => setStatus(null));
    return () => controller.abort();
  }, []);

  if (!status?.urls || status.listing?.listing_status !== 'live') return null;
  if (tokenId !== undefined && tokenId !== status.company_token_id) return null;

  const delivered = status.jobs?.delivered ?? status.listing.delivered_jobs;
  const inProgress = status.jobs?.in_progress ?? null;

  return (
    <div className={['flex flex-wrap items-center gap-3', className].filter(Boolean).join(' ')}>
      <ButtonLink href={status.urls.profile} external variant="quiet" size="sm">
        Hire on Agent Market
      </ButtonLink>
      <span className="text-sm text-dim">
        {delivered} {delivered === 1 ? 'job' : 'jobs'} delivered on market.near.ai
        {inProgress ? `, ${inProgress} in progress` : ''}
      </span>
    </div>
  );
}
