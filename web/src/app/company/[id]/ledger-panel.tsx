'use client';

// P&L from the vault's own state. Revenue is booked only by ft_on_transfer; nobody reports it.

import { useState } from 'react';
import { claimDividends } from '@/lib/actions';
import type { PaymentStats, VaultState } from '@/lib/contracts';
import { useWallet } from '@/lib/wallet';
import { Button, Field, Glass, GlassHeader, Input, KeyValue, Notice, Stat, StatGrid } from '../../ui';
import type { EncumbranceLabel } from '../../encumbrance-pill';
import s from './cockpit.module.css';
import { bpsToPercent, formatTime, formatUsdc, parseUsdc } from './format';
import { OutcomeView, useTxRunner } from './tx-runner';

export interface LedgerProps {
  tokenId: string;
  registryId: string;
  state: VaultState;
  stats: PaymentStats | null;
  label: EncumbranceLabel;
  /** Registry snapshot, for comparison with the vault's exact figure. */
  snapshotRevenue30d: string;
  snapshotAtMs: number;
}

export function LedgerPanel({ tokenId, registryId, state, stats, label, snapshotRevenue30d, snapshotAtMs }: LedgerProps) {
  const { accountId, sender } = useWallet();
  const { outcome, run, busy } = useTxRunner();
  const [amount, setAmount] = useState(() => formatUsdc(state.retained_earnings).replace(/,/g, ''));

  const isShareholder = accountId !== null && accountId === state.shareholder;
  const frozen = label !== 'FREE' || state.in_transit;
  const micro = parseUsdc(amount);
  const retained = BigInt(state.retained_earnings);
  const amountError =
    micro === null ? 'Enter a USDC amount with up to 6 decimals.' : BigInt(micro) === 0n ? 'Enter more than zero.' : BigInt(micro) > retained ? 'More than the retained earnings.' : null;

  function claim() {
    if (!sender || !micro) return;
    void run(`Claim ${formatUsdc(micro)} USDC of dividends`, async () => {
      const result = await claimDividends(sender, tokenId, micro, { registryId });
      return {
        hash: result.txHashes[result.txHashes.length - 1] ?? null,
        ok: result.paid,
        message: result.paid
          ? `The vault sent ${formatUsdc(result.amount)} USDC to ${state.shareholder}.`
          : 'The transaction landed but dividends_paid did not grow by the amount. The USDC transfer failed and the vault restored retained earnings.',
      };
    });
  }

  return (
    <Glass as="section" pad="lg" aria-labelledby="ledger-title">
      <GlassHeader title={<span id="ledger-title">P&amp;L ledger</span>} meta="From vault get_state" />
      <StatGrid>
        <Stat label="Revenue, 30 days" value={formatUsdc(state.revenue_30d)} unit="USDC" tone="amber" size="lg" />
        <Stat label="Gross revenue" value={formatUsdc(state.gross_revenue)} unit="USDC" />
        <Stat label="Calls served" value={state.api_calls_served.toLocaleString('en-US')} />
        <Stat label="Dividends claimable" value={formatUsdc(state.retained_earnings)} unit="USDC" tone="teal" />
      </StatGrid>

      <KeyValue
        className={s.ledgerRows}
        items={[
          { label: 'Compute reserve', value: `${formatUsdc(state.compute_reserve)} USDC (${bpsToPercent(state.compute_reserve_bps)} of each payment)`, mono: true },
          { label: 'Compute paid', value: `${formatUsdc(state.compute_paid)} USDC to ${state.compute_payee}`, mono: true },
          { label: 'Retained earnings', value: `${formatUsdc(state.retained_earnings)} USDC`, mono: true },
          { label: 'Dividends paid', value: `${formatUsdc(state.dividends_paid)} USDC`, mono: true },
          { label: 'Deposited to intents', value: `${formatUsdc(state.deposited_to_intents)} USDC`, mono: true },
          { label: 'Related-party revenue', value: `${formatUsdc(state.related_party_revenue)} USDC, paid by the shareholder, excluded from revenue`, mono: true },
          ...(stats
            ? [
                {
                  label: 'Payment records',
                  value: `${stats.records} on-chain, ${stats.distinct_payers} distinct payer(s), largest payer ${formatUsdc(stats.largest_payer_amount)} of ${formatUsdc(stats.total_amount)} USDC`,
                  mono: true,
                },
              ]
            : []),
          {
            label: 'Registry snapshot',
            value: `${formatUsdc(snapshotRevenue30d)} USDC 30-day revenue, reported ${formatTime(snapshotAtMs)}`,
            mono: true,
          },
        ]}
      />
      <p className={s.mutedSmall}>
        Revenue is booked only when USDC arrives through the vault&apos;s ft_on_transfer. Payer counts are not checked for sybils: a seller&apos;s
        second account counts as a customer. Compare the payer spread before you price a company on revenue.
      </p>

      {isShareholder && (
        <div className={s.claim}>
          {frozen ? (
            <Notice tone="info" title={`Claims are frozen while ${label === 'FREE' ? 'in transit' : label}`}>
              The vault refuses claim_dividends until the company is free again. The card at the top of this page sends the claim anyway, so
              you can see the refusal on-chain.
            </Notice>
          ) : retained === 0n ? (
            <Notice tone="empty" title="Nothing to claim yet">
              Retained earnings are zero. Paid calls add to them after the compute reserve.
            </Notice>
          ) : (
            <div className={s.formRow}>
              <Field label="Claim amount" htmlFor="claim-amount" error={amountError ?? undefined}>
                <Input
                  id="claim-amount"
                  mono
                  inputMode="decimal"
                  suffix="USDC"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  invalid={amountError !== null}
                  aria-describedby={amountError ? 'claim-amount-error' : undefined}
                />
              </Field>
              <Button onClick={claim} disabled={amountError !== null} busy={busy} busyLabel="Claiming">
                Claim dividends
              </Button>
            </div>
          )}
          <OutcomeView outcome={outcome} />
        </div>
      )}
    </Glass>
  );
}
