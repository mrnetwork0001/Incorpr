'use client';

import { useEffect, useId, useState } from 'react';
import { fundOffer, type TxSender } from '@/lib/actions';
import { VaultClient, type CompanyView, type PledgeTerms, type VaultState } from '@/lib/contracts';
import { Button, Field, Input, Select } from '../ui';
import { encumbranceLabel, formatBps, formatUsdc, formatUsdcExact, offerRate, parseUsdc } from './format';
import { OutcomeView, type ActionRunner } from './use-action';
import s from './desk.module.css';

const DAY_MS = 86_400_000;
const MIN_PRINCIPAL = 1_000_000n;

/** Lender side: escrow USDC as an offer against one company. The owner accepts it on their Desk. */
export function OfferForm({
  companies,
  accountId,
  registryId,
  sender,
  runner,
  offerStorageCost,
  initialTokenId,
}: {
  companies: CompanyView[];
  accountId: string;
  registryId: string;
  sender: TxSender;
  runner: ActionRunner;
  /** yoctoNEAR locked per open offer. */
  offerStorageCost: string;
  initialTokenId?: string;
}) {
  const ids = useId();
  const targets = companies.filter((c) => c.owner_id !== accountId);
  const [tokenId, setTokenId] = useState(initialTokenId && targets.some((c) => c.token_id === initialTokenId) ? initialTokenId : (targets[0]?.token_id ?? ''));
  const [principalText, setPrincipalText] = useState('');
  const [repayText, setRepayText] = useState('');
  const [daysText, setDaysText] = useState('30');
  const [minRetainedText, setMinRetainedText] = useState('');
  const [pinEpoch, setPinEpoch] = useState(true);
  const [vault, setVault] = useState<{ tokenId: string; state: VaultState | null; error: string | null } | null>(null);

  const company = targets.find((c) => c.token_id === tokenId) ?? null;

  useEffect(() => {
    if (!company) return;
    let cancelled = false;
    new VaultClient(company.vault, { finality: 'optimistic' })
      .getState()
      .then((state) => !cancelled && setVault({ tokenId: company.token_id, state, error: null }))
      .catch((error: unknown) => !cancelled && setVault({ tokenId: company.token_id, state: null, error: error instanceof Error ? error.message : String(error) }));
    return () => {
      cancelled = true;
    };
  }, [company]);

  if (targets.length === 0) {
    return <p className={s.empty}>There are no companies owned by other accounts to lend against.</p>;
  }

  const vaultState = vault?.tokenId === tokenId ? vault.state : null;
  const principal = parseUsdc(principalText);
  const repay = parseUsdc(repayText);
  const days = Number(daysText);
  const termMs = Number.isFinite(days) && days > 0 ? Math.round(days * DAY_MS) : 0;
  const minRetained = minRetainedText.trim() ? parseUsdc(minRetainedText) : null;

  const principalError = principalText && (principal === null || BigInt(principal) < MIN_PRINCIPAL) ? 'At least 1 USDC.' : null;
  const repayError =
    repayText && (repay === null || (principal !== null && BigInt(repay) < BigInt(principal))) ? 'At least the principal.' : null;
  const termError = daysText && termMs <= 0 ? 'Above zero days.' : null;
  const minRetainedError = minRetainedText.trim() && minRetained === null ? 'A USDC amount, up to 6 decimals.' : null;
  const ready = Boolean(company && principal && repay && termMs > 0 && !principalError && !repayError && !termError && !minRetainedError);
  const rate = principal && repay && !principalError && !repayError ? offerRate(principal, repay, termMs) : null;

  const terms: PledgeTerms | undefined =
    minRetained || (pinEpoch && vaultState)
      ? {
          ...(minRetained ? { min_retained: minRetained } : {}),
          ...(pinEpoch && vaultState ? { required_epoch: vaultState.treasury_epoch } : {}),
        }
      : undefined;

  const submit = () => {
    if (!ready || !company || !principal || !repay) return;
    void runner.run('fund-offer', `Offer ${formatUsdcExact(principal)} USDC against ${company.name}`, async () => {
      const r = await fundOffer(sender, { tokenId: company.token_id, principal, repayAmount: repay, termMs, terms }, { registryId });
      return {
        hashes: r.txHashes,
        ok: r.offer !== null,
        code: r.refusal?.code ?? null,
        message: r.offer
          ? `Offer #${r.offer.id} is open. The principal sits in the registry until the owner accepts or you cancel.`
          : r.refusal
            ? undefined
            : 'The transfer landed, but the registry holds no new offer from this account. It refunded the principal.',
      };
    });
  };

  return (
    <form
      className={s.offerForm}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label="Company" htmlFor={`${ids}-company`}>
        <Select id={`${ids}-company`} value={tokenId} onChange={(e) => setTokenId(e.target.value)}>
          {targets.map((c) => (
            <option key={c.token_id} value={c.token_id}>
              #{c.token_id} {c.name} · {encumbranceLabel(c.encumbrance)} · {formatUsdc(c.revenue_30d)} USDC 30d
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Principal" htmlFor={`${ids}-principal`} error={principalError} hint="Paid to the owner when they accept.">
        <Input id={`${ids}-principal`} mono inputMode="decimal" suffix="USDC" placeholder="0.00" value={principalText} invalid={Boolean(principalError)} onChange={(e) => setPrincipalText(e.target.value)} />
      </Field>
      <Field
        label="Repay amount"
        htmlFor={`${ids}-repay`}
        error={repayError}
        hint={rate ? `${formatBps(rate.termBps)} over the term${rate.aprBps !== null ? `, ${formatBps(rate.aprBps)} APR simple` : ''}.` : 'Owed at the due time.'}
      >
        <Input id={`${ids}-repay`} mono inputMode="decimal" suffix="USDC" placeholder="0.00" value={repayText} invalid={Boolean(repayError)} onChange={(e) => setRepayText(e.target.value)} />
      </Field>
      <Field label="Term" htmlFor={`${ids}-term`} error={termError} hint="Counted from acceptance.">
        <Input id={`${ids}-term`} mono inputMode="decimal" suffix="days" value={daysText} invalid={Boolean(termError)} onChange={(e) => setDaysText(e.target.value)} />
      </Field>
      <Field
        label="Minimum retained earnings"
        htmlFor={`${ids}-retained`}
        optional
        error={minRetainedError}
        hint={vaultState ? `The vault holds ${formatUsdc(vaultState.retained_earnings)} USDC now. The pledge fails if it holds less at acceptance.` : 'The pledge fails if the vault holds less at acceptance.'}
      >
        <Input id={`${ids}-retained`} mono inputMode="decimal" suffix="USDC" placeholder="none" value={minRetainedText} invalid={Boolean(minRetainedError)} onChange={(e) => setMinRetainedText(e.target.value)} />
      </Field>
      <label className={s.ack} htmlFor={`${ids}-epoch`}>
        <input id={`${ids}-epoch`} type="checkbox" checked={pinEpoch} onChange={(e) => setPinEpoch(e.target.checked)} disabled={!vaultState} />
        <span>
          Require treasury epoch{' '}
          {vaultState ? <b className={s.num}>{vaultState.treasury_epoch}</b> : vault?.error ? '(vault not read)' : '(reading the vault)'}. If the owner
          rotates the treasury to new addresses before accepting, the pledge fails.
        </span>
      </label>
      {vault?.error && vault.tokenId === tokenId && <p className={s.err}>Could not read the vault: {vault.error}</p>}
      <p className={s.subText}>
        The first offer also prepays registry storage; each open offer locks {formatNear(offerStorageCost)} NEAR of it until the offer is
        cancelled or its loan closes. Your wallet signs the storage deposit and the USDC transfer together.
      </p>
      <div className={s.actions}>
        <Button type="submit" disabled={!ready || runner.busy !== null} busy={runner.busy === 'fund-offer'} busyLabel="Funding offer">
          Fund offer
        </Button>
      </div>
      <OutcomeView outcome={runner.outcomes['fund-offer']} onDismiss={() => runner.clear('fund-offer')} />
    </form>
  );
}

/** yoctoNEAR to NEAR with up to 5 decimals. */
export function formatNear(yocto: string): string {
  const v = BigInt(yocto);
  const unit = 10n ** 24n;
  const whole = v / unit;
  const frac = ((v % unit) / 10n ** 19n).toString().padStart(5, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
