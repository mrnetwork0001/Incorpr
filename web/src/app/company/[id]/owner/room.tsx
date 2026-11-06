// Owner room (/company/<id>/owner). Server component. Opens only for the account nft_token names
// on this render; the session cookie proves who is asking, the chain decides whether they may.

import { cookies } from 'next/headers';
import { sessionCookieName } from '@/lib/ownerAuth';
import { Address, ButtonLink, EncumbrancePill, Glass, GlassHeader, KeyValue, Notice, PageHeader } from '../../../ui';
import { encumbranceLabel, formatTime, TOKEN_ID } from '../format';
import { WalletReturn } from '../wallet-return';
import { HolderCredential } from './credential';
import { loadOwnerRoom, type OwnerRoomLoad } from './load';
import { OwnerControls } from './owner-controls';
import s from './owner.module.css';
import { SettingsView } from './settings-view';
import { SignInPanel, SignOutButton } from './sign-in';

const ACCESS_RULE = 'Access follows the NFT: checked against nft_token on every request.';

function Header({ tokenId, name }: { tokenId: string; name?: string }) {
  return (
    <PageHeader
      eyebrow={`Company ${tokenId}`}
      title="Owner room"
      accent={name}
      intro={
        <>
          Opens only for the account that holds token {tokenId}. {ACCESS_RULE} When the company sells, the buyer can sign in and the seller&apos;s
          next request is refused, with no logout step.
        </>
      }
    />
  );
}

function Locked({ tokenId, load }: { tokenId: string; load: Extract<OwnerRoomLoad, { kind: 'locked' }> }) {
  const { access } = load;
  const holder = access.holder.ownerId as string;
  const ended = access.kind === 'not_holder';
  const title = ended ? `Access ended: ${access.session.account_id} no longer holds token ${tokenId}` : `Locked: only the holder of token ${tokenId} can open this room`;
  return (
    <>
      <Header tokenId={tokenId} />
      <Glass lit pad="lg" as="section" aria-labelledby="locked-title" className={s.locked}>
        <div className={s.lockHead}>
          <span className={s.lockBadge}>LOCKED</span>
          <h2 id="locked-title" className={s.lockTitle}>
            {title}
          </h2>
        </div>
        <KeyValue
          items={[
            { label: 'Holder now', value: <Address value={holder} /> },
            { label: 'Read at block', value: `${access.holder.blockHeight.toLocaleString('en-US')} (final)`, mono: true },
            { label: 'Registry', value: `${load.registryId} on ${load.network}`, mono: true },
            {
              label: 'Your session',
              value: ended ? `${access.session.account_id}, still signed but refused: nft_token names ${holder}` : access.reason,
            },
          ]}
        />
        <p className={s.rule}>{ACCESS_RULE}</p>

        <div className={s.lockedGrid}>
          <section aria-labelledby="signin-title" className={s.stack}>
            <h3 id="signin-title" className={s.subTitle}>
              Hold the token? Sign in
            </h3>
            <SignInPanel tokenId={tokenId} holder={holder} signedOut={access.kind === 'signed_out'} />
          </section>
          <section aria-labelledby="buy-title" className={s.stack}>
            <h3 id="buy-title" className={s.subTitle}>
              Want access? Buy the company
            </h3>
            <p className={s.controlText}>
              The room belongs to whoever holds the NFT. Buy token {tokenId} when it is listed on the exchange: once the sale settles, nft_token names
              you, you can sign in here, and the seller is refused on their next request.
            </p>
            <div className={s.actionRow}>
              <ButtonLink href="/exchange" variant="quiet">
                Buy it on the exchange
              </ButtonLink>
              <ButtonLink href={`/company/${tokenId}`} variant="secondary" size="sm">
                Public company page
              </ButtonLink>
            </div>
          </section>
        </div>
      </Glass>
    </>
  );
}

function Open({ tokenId, load }: { tokenId: string; load: Extract<OwnerRoomLoad, { kind: 'open' }> }) {
  const { access, company, state } = load;
  const label = encumbranceLabel(company.encumbrance);
  const ask = company.encumbrance !== 'Free' && 'Listed' in company.encumbrance ? company.encumbrance.Listed.ask : null;
  return (
    <>
      <Header tokenId={tokenId} name={company.name} />

      <Glass lit pad="lg" as="section" aria-labelledby="access-title">
        <GlassHeader title={<span id="access-title">Access</span>} meta={<SignOutButton tokenId={tokenId} />} />
        <p className={s.rule}>{ACCESS_RULE}</p>
        <KeyValue
          items={[
            { label: 'Signed in as', value: <Address value={access.session.account_id} /> },
            { label: 'Holder now', value: <Address value={access.holder.ownerId as string} /> },
            {
              label: 'Checked at block',
              value: (
                <span className={s.stackTight}>
                  <span className={s.mono}>{access.holder.blockHeight.toLocaleString('en-US')} (final)</span>
                  <span className={s.wrapMono}>{access.holder.blockHash}</span>
                </span>
              ),
            },
            { label: 'Signed in with', value: access.session.public_key, mono: true },
            { label: 'Session ends', value: formatTime(access.session.exp), mono: true },
            { label: 'State', value: <EncumbrancePill state={label} /> },
          ]}
        />
        {state.shareholder !== access.session.account_id && (
          <Notice tone="info" title="The vault names a different shareholder">
            nft_token names {access.session.account_id}, the vault&apos;s shareholder is {state.shareholder}
            {state.in_transit ? ' while a settlement is in transit' : ''}. The vault accepts shareholder calls only from {state.shareholder}
            {company.needs_resync ? '; anyone can call resync_vault_owner on the registry to align them' : ''}.
          </Notice>
        )}
      </Glass>

      <div className={s.twoUp}>
        <Glass pad="lg" as="section" aria-labelledby="controls-title">
          <GlassHeader title={<span id="controls-title">Owner controls</span>} meta="Signed by your wallet" />
          <OwnerControls
            tokenId={tokenId}
            registryId={load.registryId}
            sessionAccount={access.session.account_id}
            shareholder={state.shareholder}
            retainedMicro={state.retained_earnings}
            label={label}
            inTransit={state.in_transit}
            treasuryEpoch={state.treasury_epoch}
            rawSigs={state.raw_sigs_this_epoch}
            askMicro={ask}
          />
        </Glass>

        <div className={s.stack}>
          <Glass pad="lg" as="section" aria-labelledby="settings-title">
            <GlassHeader title={<span id="settings-title">Vault settings</span>} meta={`get_state, ${formatTime(load.readAtMs)}`} />
            <SettingsView company={company} state={state} />
          </Glass>
          <Glass pad="lg" as="section" aria-labelledby="credential-title">
            <GlassHeader title={<span id="credential-title">Holder credential</span>} meta="ed25519, server key" />
            <HolderCredential tokenId={tokenId} />
          </Glass>
        </div>
      </div>
    </>
  );
}

export async function OwnerRoom({ tokenId }: { tokenId: string }) {
  const back = (
    <ButtonLink href={TOKEN_ID.test(tokenId) ? `/company/${tokenId}` : '/exchange'} variant="secondary" size="sm">
      {TOKEN_ID.test(tokenId) ? `Back to company ${tokenId}` : 'Back to the exchange'}
    </ButtonLink>
  );
  if (!TOKEN_ID.test(tokenId)) {
    return (
      <div className={s.page}>
        {back}
        <Notice tone="error" title="Not a company id">
          <p>
            Company ids are decimal token ids on the registry, for example <code>/company/1/owner</code>.
          </p>
        </Notice>
      </div>
    );
  }
  const load = await loadOwnerRoom(tokenId, cookies().get(sessionCookieName(tokenId))?.value);
  return (
    <div className={s.page}>
      {back}
      <WalletReturn />
      {load.kind === 'no_registry' && (
        <Notice tone="info" title="No registry configured">
          <p>
            The owner room reads token {tokenId} from an incorpr-registry contract. None is configured for {load.network}. Set{' '}
            <code>NEXT_PUBLIC_REGISTRY_CONTRACT_ID</code> in <code>web/.env.local</code> and restart the server.
          </p>
        </Notice>
      )}
      {load.kind === 'not_configured' && (
        <Notice tone="error" title="Owner sign-in is not configured on this server">
          <p>{load.message}</p>
        </Notice>
      )}
      {load.kind === 'error' && (
        <Notice tone="error" title="Could not check the holder">
          <span className={s.wrapMono}>{load.message}</span>
          <p>The room stays locked when the chain cannot be read.</p>
        </Notice>
      )}
      {load.kind === 'not_found' && (
        <Notice tone="empty" title={`Company ${tokenId} does not exist`} action={<ButtonLink href="/exchange" variant="quiet" size="sm">See all companies</ButtonLink>}>
          <p>
            <code>{load.registryId}</code> has no token {tokenId}.
          </p>
        </Notice>
      )}
      {load.kind === 'locked' && <Locked tokenId={tokenId} load={load} />}
      {load.kind === 'open' && <Open tokenId={tokenId} load={load} />}
    </div>
  );
}
