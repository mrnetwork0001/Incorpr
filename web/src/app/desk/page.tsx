import type { Metadata } from 'next';
import { getNetworkConfig } from '@/lib/near';
import { AppShell } from '../ui/app-shell';
import { Notice, PageHeader } from '../ui';
import { Desk } from './desk-client';
import s from './desk.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Capital Markets Desk | Incorpr' };

export default function DeskPage() {
  const { network, registryId } = getNetworkConfig();
  return (
    <AppShell handoff={false}>
      <PageHeader
        eyebrow="Capital Markets Desk"
        index="04"
        title="Borrow against a company,"
        accent="or sell it in one transfer."
        intro={
          <>
            Listing and pledging both freeze the company&apos;s vault: no dividends, raw signatures or policy changes until it sells, is unlisted
            or the loan is repaid. Before either, the desk reads the vault&apos;s Bitcoin, EVM and Solana addresses for pending spends and
            blocks the action when it finds any.
          </>
        }
      />
      <div className={s.body}>
        {registryId ? (
          <Desk registryId={registryId} network={network} />
        ) : (
          <Notice tone="info" title="No registry configured">
            <p>
              The desk reads companies, offers and loans directly from an <code className={s.code}>incorpr-registry</code> contract and shows no
              sample data. None is configured for {network}.
            </p>
            <p>
              Set <code className={s.code}>NEXT_PUBLIC_REGISTRY_CONTRACT_ID</code> in <code className={s.code}>web/.env.local</code> after{' '}
              <code className={s.code}>scripts/deploy.mjs</code> has deployed one, then restart the server.
            </p>
          </Notice>
        )}
      </div>
    </AppShell>
  );
}
