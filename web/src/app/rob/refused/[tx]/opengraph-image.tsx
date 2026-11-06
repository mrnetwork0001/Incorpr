import { renderCard } from '@/lib/og/card';
import { RobCard } from '@/lib/og/cards';
import { loadRobTx } from '@/lib/og/data';

// One transaction, read from RPC: its root-cause ERR_ code, call, signer, receiver and block.
// A hash that is malformed or not on chain gets the generic card, without any hash.
export const dynamic = 'force-dynamic';
export const alt = 'Incorpr: a rob attempt and the contract error that refused it, read from the transaction on NEAR.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image({ params }: { params: { tx: string } }) {
  const data = await loadRobTx(decodeURIComponent(params.tx));
  // A settled outcome does not change, so a found transaction can be cached for a day.
  return renderCard(<RobCard data={data} />, { maxAge: data.kind === 'none' ? 60 : 86_400 });
}
