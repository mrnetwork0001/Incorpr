'use client';

// Treasury key actions. refresh_treasury_keys is permissionless; rotate_treasury_epoch is the
// shareholder's, and only while the company is free.

import { refreshTreasuryKeys, rotateTreasuryEpoch } from '@/lib/actions';
import { useWallet } from '@/lib/wallet';
import { Button } from '../../ui';
import s from './cockpit.module.css';
import { OutcomeView, WalletGate, useTxRunner } from './tx-runner';

export interface TreasuryActionsProps {
  tokenId: string;
  registryId: string;
  shareholder: string;
  hasAddresses: boolean;
  rawSigs: number;
  free: boolean;
}

export function TreasuryActions({ tokenId, registryId, shareholder, hasAddresses, rawSigs, free }: TreasuryActionsProps) {
  const { accountId, sender } = useWallet();
  const { outcome, run, busy } = useTxRunner();
  const isShareholder = accountId === shareholder;
  const showRotate = isShareholder && free;
  if (hasAddresses && !showRotate && !outcome) return null;

  function refresh() {
    if (!sender) return;
    void run('Derive treasury addresses (refresh_treasury_keys)', async () => {
      const result = await refreshTreasuryKeys(sender, tokenId, { registryId });
      return {
        hash: result.txHashes[result.txHashes.length - 1] ?? null,
        ok: result.addresses !== null,
        message: result.addresses
          ? `Epoch ${result.epoch} addresses are stored on the vault.`
          : 'The transaction landed but the vault stored no addresses. The MPC derivation may have failed; the transaction receipts say why.',
      };
    });
  }

  function rotate() {
    if (!sender) return;
    void run('Rotate the treasury epoch', async () => {
      const result = await rotateTreasuryEpoch(sender, tokenId, { registryId });
      return {
        hash: result.txHashes[result.txHashes.length - 1] ?? null,
        message: `The treasury is now epoch ${result.epoch}${result.addresses ? '' : '; derive its addresses next'}. Move funds from the old addresses before listing.`,
      };
    });
  }

  return (
    <div className={s.stack}>
      <WalletGate action={hasAddresses ? 'manage treasury keys' : 'derive the treasury addresses'}>
        <div className={s.actionRow}>
          {!hasAddresses && (
            <Button variant="quiet" size="sm" onClick={refresh} busy={busy} busyLabel="Deriving">
              Derive addresses
            </Button>
          )}
          {showRotate && (
            <Button variant="quiet" size="sm" onClick={rotate} busy={busy} busyLabel="Rotating">
              Rotate treasury epoch
            </Button>
          )}
          {showRotate && (
            <span className={s.mutedSmall}>
              {rawSigs > 0
                ? `${rawSigs} raw signature(s) this epoch block listing and pledging until you rotate.`
                : 'Rotation moves the treasury to fresh addresses that have never signed.'}
            </span>
          )}
        </div>
      </WalletGate>
      <OutcomeView outcome={outcome} />
    </div>
  );
}
