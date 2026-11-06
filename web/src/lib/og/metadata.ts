// Share card metadata for pages. Card images live next to the pages as opengraph-image.tsx files:
//   /opengraph-image                       site card
//   /exchange/opengraph-image              live registry totals
//   /company/<id>/opengraph-image          one company, read live
//   /rob/opengraph-image                   generic "rob attempt refused" card, no hash
//   /rob/refused/<tx>/opengraph-image      one refused transaction, read from RPC
//
// An opengraph-image file cannot see query strings, so /rob?tx=<hash> needs the rob page to point
// its metadata at the per-transaction card with robShareMetadata(). Next fills twitter:image from
// og:image and sets twitter:card to summary_large_image when an image is present.

import type { Metadata } from 'next';
import { OG_SIZE, TX_HASH_PATTERN } from './format';

/**
 * Public origin used to make card URLs absolute (NEXT_PUBLIC_SITE_URL, for example
 * https://incorpr.xyz). X and other crawlers need absolute og:image URLs, so the root layout should
 * set `metadataBase: siteUrl()`.
 */
export function siteUrl(): URL | undefined {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** Path of the card for one transaction, or null when `tx` is not a NEAR transaction hash. */
export function robCardPath(tx: unknown): string | null {
  const hash = Array.isArray(tx) ? tx[0] : tx;
  return typeof hash === 'string' && TX_HASH_PATTERN.test(hash) ? `/rob/refused/${hash}/opengraph-image` : null;
}

/**
 * For the rob page: `export async function generateMetadata({ searchParams }) { return { title, ...robShareMetadata(searchParams.tx) } }`.
 * With a valid hash the card shows that transaction's real outcome; otherwise it returns {} and the
 * generic /rob card applies.
 */
export function robShareMetadata(tx: unknown): Pick<Metadata, 'openGraph' | 'twitter'> {
  const path = robCardPath(tx);
  if (!path) return {};
  const image = { url: path, ...OG_SIZE, alt: 'Incorpr: a rob attempt and the contract error that refused it' };
  return {
    openGraph: { images: [image] },
    twitter: { card: 'summary_large_image', images: [image] },
  };
}
