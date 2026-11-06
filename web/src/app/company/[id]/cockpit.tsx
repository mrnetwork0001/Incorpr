// Company cockpit (screen 3). Server component: every figure is read from the registry and the
// company's vault when the page renders. Client islands handle wallet actions and re-read through
// router.refresh() after each transaction.

import { Suspense } from 'react';
import { serviceOperator } from '@/lib/contracts';
import { Address, ButtonLink, EncumbrancePill, Glass, GlassHeader, KeyValue, Notice, PageHeader, Stat, StatGrid } from '../../ui';
import { AgentPanel } from './agent-panel';
import s from './cockpit.module.css';
import { bpsToPercent, encumbranceLabel, formatTime, formatUsdc, TOKEN_ID } from './format';
import { LedgerPanel } from './ledger-panel';
import { loadCockpit, viewOptions, type ChainSource, type CockpitData } from './load';
import { RobCard } from './rob-card';
import { ServicePanel } from './service-panel';
import { TreasuryBalances, TreasuryFallback, TreasuryFrame } from './treasury-panel';
import { WalletReturn } from './wallet-return';

function BackLink() {
  return (
    <ButtonLink href="/exchange" variant="secondary" size="sm">
      Back to the exchange
    </ButtonLink>
  );
}

function StateDetail({ data }: { data: CockpitData }) {
  const { company, listing, loan, state } = data;
  const label = encumbranceLabel(company.encumbrance);
  return (
    <span className={s.stateDetail}>
      <EncumbrancePill state={label} />
      {label === 'LISTED' && listing && (
        <span className={s.mono}>
          ask {formatUsdc(listing.ask)} USDC, sync nonce {listing.sync_nonce}
        </span>
      )}
      {label === 'PLEDGED' && loan && (
        <span className={s.mono}>
          debt {formatUsdc(loan.debt)} USDC to {loan.lender}, due {formatTime(loan.due_ms)}
          {loan.auction_start_ms ? `, auction since ${formatTime(loan.auction_start_ms)}` : ''}
        </span>
      )}
      {company.settling && <span className={s.warn}>A settlement is running.</span>}
      {company.needs_resync && <span className={s.warn}>Needs resync_vault_owner.</span>}
      {state.in_transit && <span className={s.warn}>Vault in transit between owners.</span>}
    </span>
  );
}

function Charter({ data }: { data: CockpitData }) {
  const { charter, company } = data;
  return (
    <Glass lit pad="sm" className={s.charterCard}>
      {charter ? (
        // eslint-disable-next-line @next/next/no-img-element -- on-chain SVG data URI from NEP-177 media
        <img src={charter.src} alt={`On-chain charter of ${company.name}`} className={s.charter} />
      ) : (
        <div className={s.charterMissing}>The token has no media.</div>
      )}
      <p className={s.charterNote}>
        NEP-177 media of token {company.token_id}
        {charter?.hashMatches === true && <span className={s.okText}> · sha256 matches media_hash</span>}
        {charter?.hashMatches === false && <span className={s.badText}> · sha256 does not match media_hash</span>}
      </p>
    </Glass>
  );
}

function Facts({ data }: { data: CockpitData }) {
  const { company, state } = data;
  return (
    <Glass pad="lg" className={s.facts}>
      <GlassHeader title="Charter" meta={`Read ${formatTime(data.readAtMs)}`} />
      <KeyValue
        items={[
          { label: 'State', value: <StateDetail data={data} /> },
          { label: 'Owner', value: <Address value={company.owner_id} /> },
          { label: 'Vault', value: <Address value={company.vault} /> },
          {
            label: 'Vault keys',
            value:
              data.vaultAccessKeys === null
                ? 'could not read view_access_key_list'
                : data.vaultAccessKeys === 0
                  ? 'none: no access keys and no upgrade method'
                  : `${data.vaultAccessKeys} access key(s)`,
            mono: true,
          },
          { label: 'Skill', value: <span className={s.skill}>{company.service_template}</span> },
          { label: 'Price', value: `${formatUsdc(state.price_micro_usdc)} USDC per call`, mono: true },
          {
            label: 'Founder',
            value: (
              <span className={s.stackTight}>
                <Address value={company.founder} />
                <span className={s.mutedSmall}>{bpsToPercent(company.founder_royalty_bps)} royalty on every sale</span>
              </span>
            ),
          },
          { label: 'Service operator', value: <Address value={serviceOperator(state)} /> },
          { label: 'Incorporated', value: formatTime(company.created_ms), mono: true },
          { label: 'Loan offers open', value: String(data.openOffers), mono: true },
        ]}
      />
    </Glass>
  );
}

function Ready({ data, source }: { data: CockpitData; source: ChainSource }) {
  const { company, state, tokenId } = data;
  const label = encumbranceLabel(company.encumbrance);
  const frozen = label !== 'FREE' || state.in_transit;
  return (
    <>
      <PageHeader
        eyebrow={`Company ${tokenId}`}
        index="03"
        title={company.name}
        accent={`${formatUsdc(state.price_micro_usdc)} USDC a call`}
        intro={
          <>
            An NFT on <span className={s.mono}>{data.registryId}</span> with its own vault account. Customers pay the vault in USDC, it pays its compute,
            and the owner claims what is left.
          </>
        }
        aside={
          <div className={s.headerStats}>
            <EncumbrancePill state={label} />
            <StatGrid>
              <Stat label="30-day revenue" value={formatUsdc(state.revenue_30d)} unit="USDC" tone="amber" />
              <Stat label="Calls served" value={state.api_calls_served.toLocaleString('en-US')} />
            </StatGrid>
          </div>
        }
      />

      <div className={s.hero}>
        <Charter data={data} />
        <Facts data={data} />
        <RobCard tokenId={tokenId} vault={company.vault} ownerId={company.owner_id} label={label} retainedMicro={state.retained_earnings} />
      </div>

      <ServicePanel
        tokenId={tokenId}
        registryId={data.registryId}
        vault={company.vault}
        system={company.service_template}
        priceMicro={state.price_micro_usdc}
        usdcToken={state.usdc_token}
      />

      <div className={s.twoUp}>
        <LedgerPanel
          tokenId={tokenId}
          registryId={data.registryId}
          state={state}
          stats={data.stats}
          label={label}
          snapshotRevenue30d={company.revenue_30d}
          snapshotAtMs={company.metrics_ms}
        />
        <TreasuryFrame state={state}>
          <Suspense fallback={<TreasuryFallback />}>
            <TreasuryBalances
              tokenId={tokenId}
              registryId={data.registryId}
              vault={company.vault}
              state={state}
              network={data.network}
              view={viewOptions(source)}
            />
          </Suspense>
        </TreasuryFrame>
      </div>

      <AgentPanel
        tokenId={tokenId}
        policy={state.policy}
        usdcToken={state.usdc_token}
        targetBps={company.target_bps}
        spendWindow={state.spend_window}
        spentThisWindow={state.spent_this_window}
        frozen={frozen}
        intentsKeyRegistered={state.intents_key_registered}
        latestIntentDeadlineMs={state.latest_intent_deadline_ms}
      />

      <p className={s.footnote}>
        Read from {data.rpcUrl} on {data.network}.{' '}
        {data.network === 'sandbox' && 'No public explorer indexes a local sandbox, so NEAR hashes are shown without links. '}
        To list this company or borrow against it, use the <ButtonLink href="/desk" variant="secondary" size="sm">capital markets desk</ButtonLink>.
      </p>
    </>
  );
}

export async function CockpitScreen({ tokenId, source = {} }: { tokenId: string; source?: ChainSource }) {
  if (!TOKEN_ID.test(tokenId)) {
    return (
      <div className={s.page}>
        <BackLink />
        <Notice tone="error" title="Not a company id">
          <p>
            Company ids are decimal token ids on the registry, for example <code>/company/1</code>.
          </p>
        </Notice>
      </div>
    );
  }
  const load = await loadCockpit(tokenId, source);
  return (
    <div className={s.page}>
      <BackLink />
      <WalletReturn />
      {load.kind === 'no_registry' && (
        <Notice tone="info" title="No registry configured">
          <p>
            This page reads company {tokenId} from an incorpr-registry contract and shows no sample data. None is configured for {load.network}.
            Set <code>NEXT_PUBLIC_REGISTRY_CONTRACT_ID</code> in <code>web/.env.local</code> and restart the server.
          </p>
        </Notice>
      )}
      {load.kind === 'not_found' && (
        <Notice tone="empty" title={`Company ${tokenId} does not exist`} action={<ButtonLink href="/exchange" variant="quiet" size="sm">See all companies</ButtonLink>}>
          <p>
            <code>{load.registryId}</code> has no token {tokenId}.
          </p>
        </Notice>
      )}
      {load.kind === 'error' && (
        <Notice tone="error" title="Could not read the company">
          <span className={s.wrapMono}>{load.message}</span>
        </Notice>
      )}
      {load.kind === 'ready' && <Ready data={load.data} source={source} />}
    </div>
  );
}
