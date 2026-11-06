// TEMPORARY visual check for the design kit. Delete before finishing.
import { AppShell } from '../ui/app-shell';
import { Address, ButtonLink, EncumbrancePill, Glass, GlassHeader, KeyValue, Notice, PageHeader, Skeleton, SkeletonText, Stat, StatGrid, TxHash, TxResult } from '../ui';
import { FormDemo, TabsDemo, ToastDemo } from './demo';

const H = '8Yk2xZ7dWq1a9QpTt3oJcV5mLrNs4bHfEgD6uK2iPw9A';

export default function KitPreview() {
  return (
    <AppShell>
      <PageHeader
        index="02"
        eyebrow="Capital markets desk"
        title="Borrow against a company,"
        accent="or sell it outright."
        intro="Every action below is one contract call. Results show the transaction hash and link to the explorer."
        aside={<ButtonLink href="/exchange" arrow>Open exchange</ButtonLink>}
      />
      <div style={{ display: 'grid', gap: 20, marginTop: 48 }}>
        <Glass lit pad="lg">
          <GlassHeader title="c-1 Summarizer" meta={<EncumbrancePill state="LISTED" />} />
          <StatGrid>
            <Stat label="30d revenue" value="$1,204.50" unit="USDC" tone="amber" size="lg" />
            <Stat label="Retained" value="$880.10" />
            <Stat label="Calls" value="12,408" hint="since incorporation" />
            <Stat label="NAV" value="-" tone="muted" hint="Needs a price for BTC" />
          </StatGrid>
        </Glass>
        <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))' }}>
          <Glass>
            <GlassHeader title="Treasury" meta="epoch 0" />
            <KeyValue
              items={[
                { label: 'Vault', value: <Address value="c-1.incorpr.testnet" /> },
                { label: 'Bitcoin', value: <Address chain="btc" value="tb1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" showChain /> },
                { label: 'Solana', value: <Address chain="sol" value="7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV" showChain /> },
                { label: 'EVM', value: <Address chain="evm" value="0x52908400098527886e0f7030069857d2e4169ee7" showChain /> },
                { label: 'USDC', value: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', mono: true },
                { label: 'Full hash', value: <TxHash value={H} full /> },
              ]}
            />
          </Glass>
          <Glass>
            <GlassHeader title="Results" />
            <div style={{ display: 'grid', gap: 12 }}>
              <TxResult status="pending" title="List c-1 at 1,200 USDC" message="Waiting for the wallet to sign." />
              <TxResult status="ok" title="Listed c-1 at 1,200 USDC" hash={H} />
              <TxResult status="rejected" title="List c-2" code="ERR_RAW_SIGNATURES_THIS_EPOCH" hash={H} />
            </div>
          </Glass>
        </div>
        <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))' }}>
          <Glass>
            <GlassHeader title="Form" />
            <FormDemo />
          </Glass>
          <Glass>
            <GlassHeader title="Tabs, skeleton, toasts" />
            <TabsDemo />
            <div style={{ display: 'grid', gap: 12, margin: '24px 0' }}>
              <Skeleton height={28} width={180} />
              <SkeletonText lines={3} />
            </div>
            <ToastDemo />
            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <EncumbrancePill state="FREE" />
              <EncumbrancePill state="LISTED" />
              <EncumbrancePill state="PLEDGED" />
            </div>
          </Glass>
        </div>
        <Notice tone="empty" title="No companies yet">
          <p>
            <code>incorpr.testnet</code> has no companies incorporated.
          </p>
        </Notice>
        <Notice tone="info" title="No registry configured" action={<ButtonLink href="/incorporate" variant="secondary">Read the deploy guide</ButtonLink>}>
          <p>
            Set <code>NEXT_PUBLIC_REGISTRY_CONTRACT_ID</code> in <code>web/.env.local</code> and restart the server.
          </p>
        </Notice>
        <Notice tone="error" title="Could not read the registry">
          <p>
            <code>incorpr.testnet.list_companies: account_not_found</code>
          </p>
        </Notice>
      </div>
    </AppShell>
  );
}
