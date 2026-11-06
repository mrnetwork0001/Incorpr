import { renderCard } from '@/lib/og/card';
import { RobCard } from '@/lib/og/cards';
import { loadRobTx } from '@/lib/og/data';

// Generic card without a transaction. /rob?tx=<hash> points at rob/refused/[tx] through
// robShareMetadata() in the rob page's generateMetadata.
export const alt = 'Incorpr: try to rob a company you have listed or pledged, and see the contract refuse it.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  return renderCard(<RobCard data={await loadRobTx(null)} />, { maxAge: 3600 });
}
