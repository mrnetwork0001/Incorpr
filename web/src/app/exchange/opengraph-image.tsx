import { renderCard } from '@/lib/og/card';
import { ExchangeCard } from '@/lib/og/cards';
import { loadExchangeCard } from '@/lib/og/data';

// Reads the registry on each request; the response carries its own cache-control.
export const dynamic = 'force-dynamic';
export const alt = 'Incorpr exchange: companies listed for sale and pledged as loan collateral, read live from the registry.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  return renderCard(<ExchangeCard data={await loadExchangeCard()} />, { maxAge: 300 });
}
