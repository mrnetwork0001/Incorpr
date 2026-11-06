// The four share cards. Each takes data from ./data and renders only what the chain returned.

import { C, Datum, fontFamilies, Frame, Headline, Lede, Panel, Pill, Row, StatePill } from './card';
import type { CompanyCardData, ExchangeCardData, RobTxData } from './data';
import { formatUsdc, middle, networkLabel, utcMinute, type StateLabel } from './format';

const { mono } = fontFamilies;

function hostOr(path: string): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (!site) return path;
  try {
    return `${new URL(site).host}${path === '/' ? '' : path}`;
  } catch {
    return path;
  }
}

const STATE_ROWS: [StateLabel, string][] = [
  ['FREE', 'The owner can claim dividends, sign with the treasury keys and change policy.'],
  ['LISTED', 'For sale. Claims, signing, policy changes and transfers are refused until it sells or is unlisted.'],
  ['PLEDGED', 'Loan collateral. The same rights stay frozen until the debt is repaid.'],
];

function StateLegend({ title }: { title: string }) {
  return (
    <Panel title={title} width={440}>
      {STATE_ROWS.map(([state, text]) => (
        <div key={state} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 0', borderTop: `1px solid ${C.hair}` }}>
          <div style={{ display: 'flex' }}>
            <StatePill state={state} size="sm" />
          </div>
          <span style={{ fontSize: 18, lineHeight: 1.4, color: C.grey1 }}>{text}</span>
        </div>
      ))}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------ Site

export function SiteCard() {
  return (
    <Frame footer={hostOr('/') === '/' ? '' : hostOr('/')}>
      <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 610 }}>
          <Pill>Companies as NEP-171 NFTs on NEAR</Pill>
          <Headline line1="A company you can sell" line2="in one NFT transfer." size={58} />
          <Lede width={560}>
            Each token is an AI service with its own NEAR sub-account, USDC revenue ledger, and Bitcoin, Solana and EVM addresses. The
            sub-account has no access keys.
          </Lede>
        </div>
        <StateLegend title="Vault states" />
      </div>
    </Frame>
  );
}

// -------------------------------------------------------------------------------------- Exchange

export function ExchangeCard({ data }: { data: ExchangeCardData }) {
  const network = data.network ? networkLabel(data.network) : null;
  return (
    <Frame network={network} footer={hostOr('/exchange')}>
      <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 610 }}>
          <Pill index="01">Exchange</Pill>
          <Headline line1="Buy a company," line2="or borrow against one." size={58} />
          <Lede width={560}>
            Listings settle in USDC through one ft_transfer_call. Loans pledge the NFT, which freezes the vault until the debt is repaid.
          </Lede>
        </div>
        {data.kind === 'ready' ? (
          <Panel title="Registry, read live" meta={middle(data.registryId, 14, 8)} width={440}>
            <div style={{ display: 'flex', flexWrap: 'wrap', rowGap: 26, paddingTop: 8 }}>
              <Datum label="Companies" value={String(data.companies)} width={190} size={44} />
              <Datum label="30d revenue" value={formatUsdc(data.revenue30d)} width={190} size={32} color={C.peach} />
              <Datum label="Listed" value={String(data.listed)} width={190} size={44} color={C.amber} />
              <Datum label="Pledged" value={String(data.pledged)} width={190} size={44} color={C.lilac} />
            </div>
          </Panel>
        ) : (
          <StateLegend title="What a listing freezes" />
        )}
      </div>
    </Frame>
  );
}

// --------------------------------------------------------------------------------------- Company

function nameSize(name: string): number {
  if (name.length <= 14) return 74;
  if (name.length <= 20) return 62;
  if (name.length <= 28) return 50;
  return 42;
}

export function CompanyCard({ data }: { data: CompanyCardData }) {
  const network = data.network ? networkLabel(data.network) : null;
  const footer = hostOr(`/company/${data.tokenId}`);

  if (data.kind !== 'ready') {
    const line2 =
      data.kind === 'no_registry'
        ? 'No registry set.'
        : data.kind === 'not_found'
          ? 'Not on this registry.'
          : 'Could not be read.';
    const body =
      data.kind === 'no_registry'
        ? 'This deployment has no NEXT_PUBLIC_REGISTRY_CONTRACT_ID, so there is no company to read.'
        : data.kind === 'not_found'
          ? `The registry ${data.registryId} has no company with this token id.`
          : `The registry ${data.registryId} could not be read. Open the page for the live state.`;
    return (
      <Frame network={network} footer={footer}>
        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', width: 600 }}>
            <Pill index={data.tokenId.length <= 6 ? data.tokenId : undefined}>Company</Pill>
            <Headline line1={`Company #${middle(data.tokenId, 6, 4)}`} line2={line2} size={60} />
            <Lede width={560}>{body}</Lede>
          </div>
          <StateLegend title="Vault states" />
        </div>
      </Frame>
    );
  }

  const amountLabel = data.state === 'LISTED' ? 'ask' : data.state === 'PLEDGED' ? 'debt' : null;
  const addresses = data.addresses;
  return (
    <Frame network={network} footer={footer}>
      <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 560 }}>
          <Pill index={data.tokenId.length <= 6 ? data.tokenId : undefined}>Company NFT</Pill>
          <div style={{ display: 'flex', marginTop: 26, maxHeight: 170, overflow: 'hidden' }}>
            <span style={{ fontSize: nameSize(data.name), fontWeight: 500, letterSpacing: '-0.042em', lineHeight: 1.04, color: '#fff' }}>
              {data.name}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 24 }}>
            <StatePill state={data.state} />
            {amountLabel && data.stateAmount ? (
              <span style={{ fontFamily: mono, fontSize: 20, color: C.grey1 }}>{`${amountLabel} ${formatUsdc(data.stateAmount)} USDC`}</span>
            ) : null}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 26 }}>
            <span style={{ fontFamily: mono, fontSize: 13, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.grey2 }}>
              Vault account, no access keys
            </span>
            <span style={{ fontFamily: mono, fontSize: 24, color: C.amber }}>{middle(data.vault, 22, 14)}</span>
          </div>
        </div>

        <Panel title="Treasury" meta={addresses ? `epoch ${addresses.epoch}` : undefined} width={500}>
          {addresses ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Row label="BTC" value={middle(addresses.btc, 14, 10)} color={C.peach} />
              <Row label="SOL" value={middle(addresses.sol, 14, 10)} color={C.lilac} />
              <Row label="EVM" value={middle(addresses.evm, 14, 10)} color={C.teal} />
            </div>
          ) : (
            <span style={{ fontSize: 18, lineHeight: 1.4, color: C.grey1, padding: '10px 0 6px', borderTop: `1px solid ${C.hair}` }}>
              {data.exact
                ? 'Treasury addresses are not derived yet. Anyone can call refresh_treasury_keys on the vault.'
                : 'The vault could not be read, so the treasury addresses are not shown.'}
            </span>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 22, paddingTop: 20, borderTop: `1px solid ${C.amberHair}` }}>
            <Datum label="Booked revenue" value={formatUsdc(data.bookedRevenue)} size={30} />
            <Datum label="30 days" value={formatUsdc(data.revenue30d)} size={30} color={C.peach} />
            <Datum label="Calls" value={data.calls.toLocaleString('en-US')} size={30} />
          </div>
        </Panel>
      </div>
    </Frame>
  );
}

// ------------------------------------------------------------------------------------------- Rob

const FROZEN: [string, string][] = [
  ['claim_dividends', 'ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN'],
  ['request_shareholder_signature', 'ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN'],
  ['nft_transfer', 'ERR_TOKEN_ENCUMBERED'],
];

export function RobCard({ data }: { data: RobTxData }) {
  const network = data.network ? networkLabel(data.network) : null;

  if (data.kind === 'none') {
    return (
      <Frame network={network} footer={hostOr('/rob')}>
        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', width: 560 }}>
            <Pill index="!" tone="coral">
              Rob this company
            </Pill>
            <Headline line1="Sell a company," line2="then try to rob it." size={64} />
            <Lede width={540}>
              While a company is listed or pledged, its owner still holds the NFT but cannot claim, sign or transfer. Each attempt is a
              real transaction that the contracts refuse.
            </Lede>
          </div>
          <Panel title="Refused while listed or pledged" width={520}>
            {FROZEN.map(([method, code]) => (
              <div key={method} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '13px 0', borderTop: `1px solid ${C.hair}` }}>
                <span style={{ fontFamily: mono, fontSize: 18, color: '#fff' }}>{method}</span>
                <span style={{ fontFamily: mono, fontSize: 16, color: C.coral }}>{code}</span>
              </div>
            ))}
          </Panel>
        </div>
      </Frame>
    );
  }

  const refused = data.kind === 'refused';
  const when = data.blockHeight !== null ? `${data.blockHeight.toLocaleString('en-US')}${data.blockTime ? `, ${utcMinute(data.blockTime)}` : ''}` : null;
  return (
    <Frame network={network} footer={data.explorerUrl ? data.explorerUrl.replace(/^https?:\/\//, '').replace(data.hash, middle(data.hash, 8, 6)) : hostOr('/rob')}>
      <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 520 }}>
          <Pill index="!" tone={refused ? 'coral' : 'amber'}>
            {refused ? 'Rob attempt' : 'Transaction'}
          </Pill>
          <Headline line1={refused ? 'Refused' : 'Executed,'} line2={refused ? 'on-chain.' : 'not refused.'} size={74} />
          <Lede width={500}>
            {refused
              ? data.refunded
                ? `The contract returned the transfer. ${data.sentence}`
                : data.sentence || 'The transaction failed.'
              : 'This transaction succeeded. Nothing in it was refused by the contracts.'}
          </Lede>
        </div>
        <Panel title={refused ? 'Contract error' : 'Outcome'} width={540}>
          <span style={{ fontFamily: mono, fontSize: 21, fontWeight: 500, color: refused ? C.coral : C.teal, paddingBottom: 16 }}>
            {data.code ?? (refused ? 'failed without an ERR_ code' : 'success')}
          </span>
          <Row label="Call" value={middle(data.method, 26, 10)} color="#fff" size={18} />
          <Row label="From" value={middle(data.signer, 26, 10)} color={C.peach} size={18} />
          <Row label="To" value={middle(data.receiver, 26, 10)} color={C.peach} size={18} />
          {when ? <Row label="Block" value={when} color={C.grey1} size={16} /> : null}
          <Row label="Tx" value={data.hash} color={C.cream} size={15} />
        </Panel>
      </div>
    </Frame>
  );
}
