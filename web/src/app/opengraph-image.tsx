import { renderCard } from '@/lib/og/card';
import { SiteCard } from '@/lib/og/cards';

export const alt = 'Incorpr: companies as NEP-171 NFTs on NEAR. A company you can sell in one NFT transfer.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  return renderCard(<SiteCard />, { maxAge: 3600 });
}
