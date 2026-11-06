// Treasury: the vault's current-epoch BTC, Solana and EVM addresses with live balances, its USDC on
// NEAR and its intents.near holdings. Async server component, streamed in behind a Suspense
// boundary so slow L1 endpoints do not hold up the rest of the page.

import type { ReactNode } from 'react';
import type { VaultState } from '@/lib/contracts';
import type { NearNetwork, ViewOptions } from '@/lib/near';
import { Address, Glass, GlassHeader, Notice, Skeleton, Stat, StatGrid, type Chain } from '../../ui';
import s from './cockpit.module.css';
import { formatTime } from './format';
import { Mono } from './mono';
import { TreasuryActions } from './treasury-actions';
import { loadTreasury, type AddressCheck, type Reading } from './treasury-data';

export interface TreasuryPanelProps {
  tokenId: string;
  registryId: string;
  vault: string;
  state: VaultState;
  network: NearNetwork;
  view: ViewOptions;
}

function ReadingValue({ reading }: { reading: Reading | null }) {
  if (!reading) return <span className={s.muted}>no address</span>;
  if (!reading.ok) {
    return (
      <span className={s.readingError} title={reading.error}>
        unavailable: {reading.error}
      </span>
    );
  }
  return (
    <span className={s.reading}>
      <span className={s.readingAmount}>{reading.amount}</span>
      {reading.detail && <span className={s.mutedSmall}>{reading.detail}</span>}
      <span className={s.readingSource}>via {reading.source}</span>
    </span>
  );
}

function AddressRow({ chain, label, address, reading }: { chain: Chain; label: string; address: string | null; reading: Reading | null }) {
  return (
    <li className={s.treasuryRow}>
      <span className={s.treasuryChain}>{label}</span>
      <span className={s.treasuryAddress}>
        {address ? (
          <Address value={address} chain={chain} {...(chain === 'near' ? {} : { head: 10, tail: 8 })} />
        ) : (
          <span className={s.muted}>not derived</span>
        )}
      </span>
      <ReadingValue reading={reading} />
    </li>
  );
}

const CHECK_TEXT: Record<AddressCheck['kind'], string> = {
  match: 'Stored addresses match an off-chain derivation from the MPC contract’s derived_public_key.',
  no_addresses: 'The vault has no stored addresses for this epoch.',
  mismatch: 'Stored addresses differ from the MPC derivation.',
  error: 'Could not derive the addresses off-chain to compare.',
};

export async function TreasuryBalances({ tokenId, registryId, vault, state, network, view }: TreasuryPanelProps) {
  const t = await loadTreasury(vault, state, network, view);
  const a = state.addresses ?? null;
  const check = t.addressCheck;
  return (
    <>
      <p className={`${s.addressCheck} ${check.kind === 'match' ? s.checkOk : check.kind === 'mismatch' ? s.checkBad : s.checkSkip}`}>
        {CHECK_TEXT[check.kind]}
        {check.kind === 'mismatch' && ` Fields: ${check.fields.join(', ')}.`}
        {check.kind === 'error' && ` ${check.message}`}
      </p>

      {!a && (
        <Notice tone="empty" title={`No addresses for epoch ${state.treasury_epoch}`}>
          The vault derives its addresses on-chain from {state.mpc_contract}. Anyone can call refresh_treasury_keys to store them.
        </Notice>
      )}

      <ul className={s.treasuryList}>
        <AddressRow chain="btc" label="Bitcoin" address={a?.btc ?? null} reading={t.btc} />
        <AddressRow chain="sol" label="Solana" address={a?.sol ?? null} reading={t.sol} />
        <AddressRow chain="evm" label={t.evmChain} address={a?.evm ?? null} reading={t.evm} />
        <AddressRow chain="near" label="USDC on NEAR" address={vault} reading={t.usdcOnNear} />
      </ul>

      <div className={s.intents}>
        <p className={s.groupLabel}>Held on {t.intents.contract ?? 'the intents contract'}</p>
        {t.intents.contract === null ? (
          <p className={s.muted}>{t.intents.reason}</p>
        ) : (
          <ul className={s.treasuryList}>
            {t.intents.holdings.map((h) => (
              <li key={h.asset} className={s.treasuryRow}>
                <span className={s.treasuryChain}>{h.symbol}</span>
                <span className={s.treasuryAddress}>
                  <Mono value={h.asset} label={`${h.symbol} asset id`} head={16} tail={6} />
                </span>
                <ReadingValue reading={h.reading} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <TreasuryActions
        tokenId={tokenId}
        registryId={registryId}
        shareholder={state.shareholder}
        hasAddresses={a !== null}
        rawSigs={state.raw_sigs_this_epoch}
        free={state.encumbrance === 'Free' && !state.in_transit}
      />
      <p className={s.mutedSmall}>Balances read {formatTime(t.readAtMs)}. NAV counts only current-epoch addresses and the intents balance.</p>
    </>
  );
}

export function TreasuryFallback() {
  return (
    <div className={s.stack} role="status" aria-label="Loading treasury balances">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height={44} radius={12} />
      ))}
    </div>
  );
}

/** Frame and epoch facts render at once; balances stream into `children`. */
export function TreasuryFrame({ state, children }: { state: VaultState; children: ReactNode }) {
  const dirty = state.raw_sigs_this_epoch > 0;
  return (
    <Glass as="section" pad="lg" aria-labelledby="treasury-title">
      <GlassHeader title={<span id="treasury-title">Treasury</span>} meta={`Chain Signatures via ${state.mpc_contract}`} />
      <StatGrid>
        <Stat label="Treasury epoch" value={state.treasury_epoch} size="sm" />
        <Stat
          label="Raw signatures this epoch"
          value={state.raw_sigs_this_epoch}
          size="sm"
          tone={dirty ? 'coral' : 'teal'}
          hint={dirty ? 'Blocks listing and pledging' : 'Keys have not signed a raw payload'}
        />
        <Stat label="Owner generation" value={state.owner_generation} size="sm" hint="Changes on every new shareholder" />
      </StatGrid>
      <div className={s.treasuryBody}>{children}</div>
    </Glass>
  );
}
