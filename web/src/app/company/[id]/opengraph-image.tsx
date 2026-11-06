import { renderCard } from '@/lib/og/card';
import { CompanyCard } from '@/lib/og/cards';
import { loadCompanyCard } from '@/lib/og/data';

// Reads the registry and the company's vault on each request; the response carries its own cache-control.
export const dynamic = 'force-dynamic';
export const alt = 'Incorpr company: name, vault account, treasury addresses, booked revenue and encumbrance state, read live from NEAR.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image({ params }: { params: { id: string } }) {
  return renderCard(<CompanyCard data={await loadCompanyCard(decodeURIComponent(params.id))} />, { maxAge: 120 });
}
