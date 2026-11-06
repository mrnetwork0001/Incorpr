import type { Metadata } from 'next';
import { AppShell } from '../../../ui/app-shell';
import { OwnerRoom } from './room';

// The holder check reads nft_token on every request; nothing here may be cached.
export const dynamic = 'force-dynamic';

type Props = { params: { id: string } };

export function generateMetadata({ params }: Props): Metadata {
  return { title: `Owner room, company ${params.id} | Incorpr`, robots: { index: false } };
}

export default function OwnerPage({ params }: Props) {
  return (
    <AppShell>
      <OwnerRoom tokenId={params.id} />
    </AppShell>
  );
}
