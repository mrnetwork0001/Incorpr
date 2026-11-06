'use client';

import { useCallback, useEffect, useState } from 'react';
import { describeActionError, refreshTreasuryKeys, type ActionError, type IncorporateResult } from '@/lib/actions';
import { RegistryClient, VaultClient, type TreasuryAddresses } from '@/lib/contracts';
import { checkVaultAddresses, type AddressComparison } from '@/lib/mpcAddresses';
import { useWallet } from '@/lib/wallet';
import { Address, Button, ButtonLink, Glass, GlassHeader, KeyValue, Notice, Skeleton, TxResult } from '../ui';
import { formatBps, formatNear, formatUsdc } from './format';
import s from './incorporate.module.css';

/** `deposit` is null when a redirecting wallet returned: the page did not see what it attached. */
export type Incorporated = Omit<IncorporateResult, 'deposit'> & { deposit: string | null };

type Vault =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; addresses: TreasuryAddresses | null; mpc: string; epoch: number; comparison: AddressComparison | null; compareError: string | null };

type Refresh = { status: 'idle' } | { status: 'pending' } | { status: 'ok'; hash: string } | { status: 'rejected'; error: ActionError };

const CHAINS = [
  { key: 'btc', chain: 'btc', label: 'Bitcoin', note: 'P2WPKH' },
  { key: 'evm', chain: 'evm', label: 'EVM', note: 'Same address on every EVM chain; linked on Base' },
  { key: 'sol', chain: 'sol', label: 'Solana', note: 'Ed25519' },
] as const;

export function IncorporatedResult({ result, registryId, onReset }: { result: Incorporated; registryId: string; onReset: () => void }) {
  const wallet = useWallet();
  const { company, tokenId, vault } = result;
  const [state, setState] = useState<Vault>({ status: 'loading' });
  const [charter, setCharter] = useState<string | null | undefined>(undefined);
  const [refresh, setRefresh] = useState<Refresh>({ status: 'idle' });

  const load = useCallback(async () => {
    try {
      const vs = await new VaultClient(vault, { finality: 'optimistic' }).getState();
      const addresses = vs.addresses ?? null;
      let comparison: AddressComparison | null = null;
      let compareError: string | null = null;
      if (addresses) {
        try {
          comparison = (await checkVaultAddresses(vault, vs)).comparison;
        } catch (error) {
          compareError = error instanceof Error ? error.message : String(error);
        }
      }
      setState({ status: 'ok', addresses, mpc: vs.mpc_contract, epoch: vs.treasury_epoch, comparison, compareError });
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [vault]);

  useEffect(() => {
    void load();
    new RegistryClient(registryId, { finality: 'optimistic' })
      .nftToken(tokenId)
      .then((token) => setCharter(token?.metadata?.media ?? null))
      .catch(() => setCharter(null));
  }, [load, registryId, tokenId]);

  async function derive() {
    if (!wallet.sender) return;
    setRefresh({ status: 'pending' });
    try {
      const out = await refreshTreasuryKeys(wallet.sender, tokenId, { registryId });
      setRefresh({ status: 'ok', hash: out.txHashes[out.txHashes.length - 1] as string });
      await load();
    } catch (error) {
      if (error instanceof Error && error.name === 'WalletRedirectError') return;
      setRefresh({ status: 'rejected', error: describeActionError(error) });
    }
  }

  const txHash = result.txHashes[result.txHashes.length - 1] ?? null;

  return (
    <div className={s.result}>
      <TxResult status="ok" title={`Incorporated ${company.name} as token #${tokenId}`} hash={txHash}>
        <KeyValue
          items={[
            { label: 'Token id', value: tokenId, mono: true },
            { label: 'Vault account', value: <Address value={vault} /> },
            { label: 'Owner', value: <Address value={company.owner_id} /> },
            { label: 'Price per call', value: formatUsdc(company.price_micro_usdc), mono: true },
            {
              label: 'Treasury target',
              value: `${formatBps(company.target_bps[0])} BTC / ${formatBps(company.target_bps[1])} SOL / ${formatBps(company.target_bps[2])} USDC`,
              mono: true,
            },
            {
              label: 'Deposit attached',
              value: result.deposit ? `${formatNear(result.deposit)}, unused part refunded` : 'Shown in the transaction on the explorer',
              mono: Boolean(result.deposit),
            },
          ]}
        />
      </TxResult>

      <div className={s.resultGrid}>
        <Glass lit>
          <GlassHeader title="Treasury addresses" meta={state.status === 'ok' ? `epoch ${state.epoch}` : undefined} />
          {state.status === 'loading' && (
            <div className="grid gap-3">
              <Skeleton height={18} />
              <Skeleton height={18} />
              <Skeleton height={18} width="70%" />
            </div>
          )}
          {state.status === 'error' && (
            <Notice tone="error" title="Could not read the vault" action={<Button variant="quiet" size="sm" onClick={() => void load()}>Read again</Button>}>
              {state.message}
            </Notice>
          )}
          {state.status === 'ok' && state.addresses && (
            <>
              <div className={s.addresses}>
                {CHAINS.map((c) => (
                  <div key={c.key} className={s.addressRow}>
                    <span className={s.addressLabel}>
                      <span>{c.label}</span>
                      <span>{c.note}</span>
                    </span>
                    <Address value={state.addresses?.[c.key] ?? ''} chain={c.chain} head={14} tail={10} />
                  </div>
                ))}
              </div>
              {state.comparison?.match && (
                <p className={`${s.match} ${s.matchOk}`}>Equal to an independent derivation in this browser from {state.mpc}.derived_public_key</p>
              )}
              {state.comparison && !state.comparison.match && (
                <p className={`${s.match} ${s.matchBad}`}>
                  Differs from the derivation in this browser
                  {state.comparison.reason === 'mismatch' ? `: ${state.comparison.mismatches.map((m) => m.field).join(', ')}` : ''}
                </p>
              )}
              {state.compareError && <p className={`${s.match} ${s.matchBad}`}>Could not derive in this browser: {state.compareError}</p>}
            </>
          )}
          {state.status === 'ok' && !state.addresses && (
            <Notice
              tone="empty"
              title="No addresses stored yet"
              action={
                wallet.sender ? (
                  <Button size="sm" onClick={() => void derive()} busy={refresh.status === 'pending'} busyLabel="Deriving">
                    Derive addresses
                  </Button>
                ) : (
                  <Button size="sm" variant="quiet" onClick={wallet.signIn}>
                    Connect wallet to derive
                  </Button>
                )
              }
            >
              The vault reads its Bitcoin, EVM and Solana keys from {state.mpc} when anyone calls <code>refresh_treasury_keys</code>. The call is
              permissionless, takes no deposit and costs only gas.
            </Notice>
          )}
          {refresh.status === 'ok' && (
            <div className="mt-4">
              <TxResult status="ok" title="refresh_treasury_keys" hash={refresh.hash} message="The vault stored the addresses it derived on-chain." />
            </div>
          )}
          {refresh.status === 'rejected' && (
            <div className="mt-4">
              <TxResult status="rejected" title="refresh_treasury_keys" hash={refresh.error.txHash} code={refresh.error.code} message={refresh.error.message} />
            </div>
          )}
        </Glass>

        <Glass>
          <GlassHeader title="On-chain charter" meta="nft_token media" />
          {charter === undefined && <Skeleton height={220} radius={14} />}
          {charter === null && <p className="text-[13.5px] text-[var(--ui-grey-2)]">The registry returned no media for this token yet. Reload in a few seconds.</p>}
          {charter && (
            // eslint-disable-next-line @next/next/no-img-element -- on-chain SVG data URI from the registry, not an optimizable asset
            <img src={charter} alt={`${company.name} charter, rendered by the registry`} className={s.charter} />
          )}
        </Glass>
      </div>

      <div className={s.resultActions}>
        <ButtonLink href={`/company/${tokenId}`}>
          Open the company
        </ButtonLink>
        <Button variant="secondary" onClick={onReset}>
          Incorporate another
        </Button>
      </div>
    </div>
  );
}
