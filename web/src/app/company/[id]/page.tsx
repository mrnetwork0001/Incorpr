import type { Metadata } from 'next';
import { AppShell } from '../../ui/app-shell';
import { CockpitScreen } from './cockpit';

// Live chain state on every request: balances, encumbrance and the P&L change between renders.
export const dynamic = 'force-dynamic';

type Props = { params: { id: string } };

export function generateMetadata({ params }: Props): Metadata {
  return { title: `Company ${params.id} | Incorpr` };
}

export default function CompanyPage({ params }: Props) {
  return (
    <AppShell handoff={false}>
      <CockpitScreen tokenId={params.id} />
    </AppShell>
  );
}
