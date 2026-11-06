'use client';

// Holder actions. Each one is a transaction signed by the connected wallet; the vault checks the
// caller is the shareholder, so the room adds convenience, not authority.

import { useState } from 'react';
import { claimDividends, rotateTreasuryEpoch } from '@/lib/actions';
import { useWallet } from '@/lib/wallet';
import { Button, ButtonLink, EncumbrancePill, Field, Input, Notice, Stat, StatGrid } from '../../../ui';
import type { EncumbranceLabel } from '../../../encumbrance-pill';
import { formatUsdc, parseUsdc } from '../format';
import { OutcomeView, WalletGate, useTxRunner } from '../tx-runner';
import s from './owner.module.css';

export interface OwnerControlsProps {
  tokenId: string;
  registryId: string;
  sessionAccount: string;
  shareholder: string;
  retainedMicro: string;
  label: EncumbranceLabel;
  inTransit: boolean;
  treasuryEpoch: number;
  rawSigs: number;
  askMicro: string | null;
}

export function OwnerControls(props: OwnerControlsProps) {
  const { tokenId, registryId, sessionAccount, shareholder, retainedMicro, label, inTransit, treasuryEpoch, rawSigs, askMicro } = props;
  const { accountId, sender } = useWallet();
  const claimRunner = useTxRunner();
  const rotateRunner = useTxRunner();
  const [amount, setAmount] = useState(() => formatUsdc(retainedMicro).replace(/,/g, ''));

  const frozen = label !== 'FREE' || inTransit;
  const retained = BigInt(retainedMicro);
  const micro = parseUsdc(amount);
  const amountError =
    micro === null ? 'Enter a USDC amount with up to 6 decimals.' : BigInt(micro) === 0n ? 'Enter more than zero.' : BigInt(micro) > retained ? 'More than the claimable amount.' : null;
  const walletMismatch = accountId !== null && accountId !== sessionAccount;

  function claim() {
    if (!sender || !micro) return;
    void claimRunner.run(`Claim ${formatUsdc(micro)} USDC of dividends`, async () => {
      const result = await claimDividends(sender, tokenId, micro, { registryId });
      return {
        hash: result.txHashes[result.txHashes.length - 1] ?? null,
        ok: result.paid,
        message: result.paid
          ? `The vault sent ${formatUsdc(result.amount)} USDC to ${shareholder}.`
          : 'The transaction landed but dividends_paid did not grow by the amount. The USDC transfer failed and the vault restored retained earnings.',
      };
    });
  }

  function rotate() {
    if (!sender) return;
    void rotateRunner.run('Rotate the treasury epoch', async () => {
      const result = await rotateTreasuryEpoch(sender, tokenId, { registryId });
      return {
        hash: result.txHashes[result.txHashes.length - 1] ?? null,
        message: `The treasury is now epoch ${result.epoch}${result.addresses ? '' : '; derive its addresses on the company page next'}. Move funds from the old addresses before listing.`,
      };
    });
  }

  return (
    <div className={s.controls}>
      {walletMismatch && (
        <Notice tone="info" title={`The wallet is connected as ${accountId}`}>
          You signed in to this room as {sessionAccount}. Transactions are signed by the connected wallet, and the vault accepts them only from the
          shareholder, {shareholder}. Switch the wallet account before sending.
        </Notice>
      )}

      <section className={s.control} aria-labelledby="ctl-claim">
        <h3 id="ctl-claim" className={s.controlTitle}>
          Claim dividends
        </h3>
        <StatGrid>
          <Stat label="Claimable now" value={formatUsdc(retainedMicro)} unit="USDC" tone="teal" />
        </StatGrid>
        <WalletGate action="claim dividends">
          {frozen ? (
            <Notice tone="info" title={`Claims are frozen while ${label === 'FREE' ? 'in transit' : label}`}>
              The vault refuses claim_dividends until the company is free again.
            </Notice>
          ) : retained === 0n ? (
            <Notice tone="empty" title="Nothing to claim yet">
              Retained earnings are zero. Paid calls add to them after the compute reserve.
            </Notice>
          ) : (
            <div className={s.formRow}>
              <Field label="Claim amount" htmlFor="owner-claim-amount" error={amountError ?? undefined}>
                <Input
                  id="owner-claim-amount"
                  mono
                  inputMode="decimal"
                  suffix="USDC"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  invalid={amountError !== null}
                />
              </Field>
              <Button onClick={claim} disabled={amountError !== null} busy={claimRunner.busy} busyLabel="Claiming">
                Claim dividends
              </Button>
            </div>
          )}
        </WalletGate>
        <OutcomeView outcome={claimRunner.outcome} />
      </section>

      <section className={s.control} aria-labelledby="ctl-market">
        <h3 id="ctl-market" className={s.controlTitle}>
          List or unlist
        </h3>
        <p className={s.controlText}>
          <EncumbrancePill state={label} />{' '}
          {label === 'LISTED' && askMicro
            ? `Listed at ${formatUsdc(askMicro)} USDC. Unlisting returns the company to free.`
            : label === 'PLEDGED'
              ? 'Pledged as loan collateral. Repay the loan on the desk to free it.'
              : 'Listing freezes the vault until it sells or you unlist. The desk checks the treasury for pending spends first.'}
        </p>
        <div className={s.actionRow}>
          <ButtonLink href="/desk" variant="quiet" size="sm">
            Open the capital markets desk
          </ButtonLink>
        </div>
      </section>

      <section className={s.control} aria-labelledby="ctl-rotate">
        <h3 id="ctl-rotate" className={s.controlTitle}>
          Rotate the treasury epoch
        </h3>
        <p className={s.controlText}>
          Epoch {treasuryEpoch}, {rawSigs} raw signature(s) this epoch.{' '}
          {rawSigs > 0
            ? 'Listing and pledging are refused until you rotate, because a signed but unbroadcast transaction could spend the treasury after a sale.'
            : 'Rotation moves the treasury to fresh addresses that have never signed.'}
        </p>
        <WalletGate action="rotate the treasury epoch">
          <div className={s.actionRow}>
            <Button variant="quiet" size="sm" onClick={rotate} disabled={frozen} busy={rotateRunner.busy} busyLabel="Rotating">
              Rotate treasury epoch
            </Button>
            {frozen && <span className={s.mutedSmall}>The vault refuses rotation while the company is {label === 'FREE' ? 'in transit' : label}.</span>}
          </div>
        </WalletGate>
        <OutcomeView outcome={rotateRunner.outcome} />
      </section>

      <section className={s.control} aria-labelledby="ctl-raw">
        <h3 id="ctl-raw" className={s.controlTitle}>
          Raw signatures: what a request does
        </h3>
        <p className={s.controlText}>
          <span className={s.mono}>request_shareholder_signature(domain_id, payload_hex, subpath)</span> asks v1.signer to sign bytes you supply with a
          key derived for this vault. Domain 0 (secp256k1) signs a 32-byte digest for Bitcoin or EVM; domain 1 (ed25519) signs a Solana message.
        </p>
        <ul className={s.bullets}>
          <li>Shareholder only, and only while the company is free. Listed, pledged or in transit: ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN.</li>
          <li>The vault counts the signature before calling the signer. Any count above zero this epoch blocks listing and pledging (ERR_RAW_SIGNATURES_THIS_EPOCH).</li>
          <li>Rotating the epoch clears the count and moves the treasury to new addresses. Move funds first; old-epoch funds stay reachable through sign_legacy_epoch.</li>
          <li>Deposit: 1 yoctoNEAR, which the vault forwards as the signer fee (v1.signer charges 1 yoctoNEAR per sign today). Gas: 300 TGas, most of it forwarded to the signer.</li>
        </ul>
        <p className={s.mutedSmall}>The room explains the call and does not send one: a raw signature is irreversible once broadcast on the target chain.</p>
      </section>
    </div>
  );
}
