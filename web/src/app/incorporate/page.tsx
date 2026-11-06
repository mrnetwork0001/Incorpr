import type { Metadata } from 'next';
import { RegistryClient } from '@/lib/contracts';
import { getNetworkConfig } from '@/lib/near';
import { AppShell } from '../ui/app-shell';
import { Address, Glass, KeyValue, Notice, PageHeader } from '../ui';
import { formatNear } from './format';
import { IncorporateWizard, type InitialCost } from './wizard';
import s from './incorporate.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Incorporate | Incorpr' };

async function readCost(registryId: string | null): Promise<InitialCost> {
  if (!registryId) return null;
  try {
    const yocto = await new RegistryClient(registryId).incorporationCost();
    return { yocto, readAt: new Date().toISOString() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export default async function IncorporatePage() {
  const { network, registryId, mpcContract } = getNetworkConfig();
  const cost = await readCost(registryId);

  return (
    <AppShell>
      <div className={s.page}>
        <PageHeader
          eyebrow="Incorporate"
          index="02"
          title="Incorporate a company"
          accent="in one transaction."
          intro={
            <>
              Name a service, price it per call in USDC and set its treasury target. The registry creates a keyless NEAR sub-account for it,
              deploys the vault, and mints the NFT that owns it.
            </>
          }
          aside={
            <Glass>
              <KeyValue
                items={[
                  { label: 'Network', value: network, mono: true },
                  { label: 'Registry', value: registryId ? <Address value={registryId} /> : 'Not configured' },
                  { label: 'Signer for the treasury keys', value: mpcContract, mono: true },
                  {
                    label: 'incorporation_cost()',
                    value: cost === null ? 'No registry to read' : 'error' in cost ? 'Could not read' : formatNear(cost.yocto),
                    mono: true,
                  },
                ]}
              />
            </Glass>
          }
        />

        {!registryId && (
          <div className={s.notices}>
            <Notice tone="info" title={`No registry configured for ${network}`}>
              <p>
                This app incorporates through an <code>incorpr-registry</code> contract and has none to call: <code>NEXT_PUBLIC_REGISTRY_CONTRACT_ID</code> is
                not set. You can fill in the form and see the exact call it builds, but signing stays off until a registry is configured.
              </p>
              <p>
                <code>node scripts/deploy.mjs --network {network}</code> deploys one and writes its id to <code>web/.env.local</code>. Restart the app afterwards.
              </p>
            </Notice>
          </div>
        )}
        {cost && 'error' in cost && (
          <Notice tone="error" title={`Could not read incorporation_cost() from ${registryId}`}>
            {cost.error}
          </Notice>
        )}

        <IncorporateWizard network={network} registryId={registryId} initialCost={cost} />
      </div>
    </AppShell>
  );
}
