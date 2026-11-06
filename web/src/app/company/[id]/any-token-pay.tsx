'use client';

// Paying in a token other than USDC through NEAR Intents 1Click (lib/anyTokenPayment.ts). Mainnet
// only. The default path is two steps: 1Click delivers USDC to the payer, then the payer's wallet
// pays the vault with ft_transfer_call. Revenue counts as booked only when the vault's get_payment
// returns the call, whatever 1Click reports.

import { useEffect, useMemo, useState } from 'react';
import {
  anyTokenPaymentsAvailable,
  executeAnyTokenPayment,
  prepareAnyTokenPayment,
  type AnyTokenPaymentPlan,
  type AnyTokenPaymentResult,
} from '@/lib/anyTokenPayment';
import type { ExecutionStatus, OneClickToken } from '@/lib/intentsQuotes';
import { useWallet } from '@/lib/wallet';
import { Button, Field, Input, KeyValue, Notice, Select, TxHash, TxResult } from '../../ui';
import s from './cockpit.module.css';
import { formatTime } from './format';
import { Mono } from './mono';
import type { PaidCall } from './service-panel';
import { WalletGate, errorOutcome, OutcomeView, type Outcome } from './tx-runner';

export interface AnyTokenProps {
  tokenId: string;
  registryId: string;
  vault: string;
  usdcToken: string;
  input: string;
  /** False when the input is empty or the service route is not ready. */
  disabled: boolean;
  onPrepared: (call: PaidCall) => void;
  onBooked: (call: PaidCall) => void;
}

type TokenList = { status: 'loading' } | { status: 'ok'; tokens: OneClickToken[] } | { status: 'error'; message: string };

export function AnyTokenPay(props: AnyTokenProps) {
  const availability = anyTokenPaymentsAvailable();
  if (!availability.available) {
    return (
      <Notice tone="info" title="Other tokens settle on mainnet only">
        {availability.reason}
      </Notice>
    );
  }
  return <AnyTokenForm {...props} />;
}

function AnyTokenForm({ tokenId, registryId, vault, usdcToken, input, disabled, onPrepared, onBooked }: AnyTokenProps) {
  const { sender } = useWallet();
  const [list, setList] = useState<TokenList>({ status: 'loading' });
  const [assetId, setAssetId] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [externalTx, setExternalTx] = useState('');
  const [plan, setPlan] = useState<AnyTokenPaymentPlan | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [status, setStatus] = useState<ExecutionStatus | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [result, setResult] = useState<AnyTokenPaymentResult | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/intents?op=tokens', { cache: 'no-store' });
        const body = (await res.json()) as { tokens?: OneClickToken[]; error?: { message?: string } };
        if (!res.ok || !body.tokens) throw new Error(body.error?.message ?? `/api/intents answered HTTP ${res.status}`);
        setList({ status: 'ok', tokens: body.tokens });
      } catch (error) {
        setList({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
  }, []);

  const tokens = useMemo(
    () =>
      list.status === 'ok'
        ? list.tokens
            .filter((t) => t.assetId !== `nep141:${usdcToken}`)
            .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.blockchain.localeCompare(b.blockchain))
        : [],
    [list, usdcToken],
  );
  const origin = tokens.find((t) => t.assetId === assetId) ?? null;
  const onNear = origin?.blockchain === 'near';

  async function quote() {
    if (!sender || !origin) return;
    setQuoting(true);
    setPlan(null);
    setResult(null);
    setOutcome(null);
    try {
      const prepared = await prepareAnyTokenPayment(sender, {
        tokenId,
        input,
        origin,
        refundTo: onNear ? undefined : refundTo.trim(),
        registryId,
      });
      setPlan(prepared);
      onPrepared({ callId: prepared.callId, salt: prepared.salt, input: prepared.input });
    } catch (error) {
      setOutcome(errorOutcome('Get a live 1Click quote', error));
    } finally {
      setQuoting(false);
    }
  }

  async function execute() {
    if (!sender || !plan || !origin) return;
    const title = `Pay with ${origin.symbol} through 1Click`;
    setOutcome({ status: 'pending', title, message: 'Following the 1Click status until it settles. Keep this tab open.' });
    try {
      const done = await executeAnyTokenPayment(sender, plan, {
        onStatus: setStatus,
        externalDepositTxHash: externalTx.trim() || undefined,
      });
      setResult(done);
      setOutcome({
        status: done.booked ? 'ok' : 'rejected',
        title,
        hash: done.txHashes[done.txHashes.length - 1] ?? null,
        message: done.booked
          ? `1Click status ${done.status}. The vault holds the payment for this call.`
          : `1Click status ${done.status}. The vault holds no payment for this call id, so nothing was booked.`,
      });
      if (done.booked) onBooked({ callId: plan.callId, salt: plan.salt, input: plan.input });
    } catch (error) {
      setOutcome(errorOutcome(title, error));
    }
  }

  if (list.status === 'error') {
    return (
      <Notice tone="error" title="Could not load the 1Click token list">
        {list.message}
      </Notice>
    );
  }

  return (
    <div className={s.stack}>
      <p className={s.muted}>
        1Click swaps your token to USDC on NEAR and delivers it to your account. Your wallet then pays the vault with the same
        ft_transfer_call as a USDC payment. Two wallet confirmations.
      </p>
      <WalletGate action="pay with another token">
        <div className={s.formRow}>
          <Field label="Token" htmlFor="any-token">
            <Select id="any-token" value={assetId} onChange={(event) => setAssetId(event.target.value)} disabled={list.status === 'loading'}>
              <option value="">{list.status === 'loading' ? 'Loading tokens' : 'Choose a token'}</option>
              {tokens.map((t) => (
                <option key={t.assetId} value={t.assetId}>
                  {t.symbol} on {t.blockchain}
                </option>
              ))}
            </Select>
          </Field>
          {origin && !onNear && (
            <Field label={`Refund address on ${origin.blockchain}`} htmlFor="any-refund" hint="1Click returns your deposit here if it cannot fill.">
              <Input id="any-refund" mono value={refundTo} onChange={(event) => setRefundTo(event.target.value)} />
            </Field>
          )}
        </div>
        <Button
          variant="quiet"
          onClick={() => void quote()}
          disabled={disabled || !origin || (!onNear && !refundTo.trim())}
          busy={quoting}
          busyLabel="Quoting"
        >
          Get a live quote
        </Button>
      </WalletGate>

      {plan && origin && (
        <div className={s.quote}>
          <KeyValue
            items={[
              { label: 'You send', value: `${plan.quote.quote.amountInFormatted} ${origin.symbol}`, mono: true },
              { label: 'Worth about', value: `$${plan.quote.quote.amountInUsd}`, mono: true },
              { label: 'Vault receives', value: `${plan.price} micro-USDC`, mono: true },
              { label: 'Deposit address', value: <Mono value={plan.depositAddress} label="1Click deposit address" full /> },
              ...(plan.depositMemo ? [{ label: 'Memo', value: plan.depositMemo, mono: true }] : []),
              { label: 'Quote valid until', value: formatTime(plan.quote.quote.deadline ? Date.parse(plan.quote.quote.deadline) : null), mono: true },
              { label: 'Estimated time', value: `${plan.quote.quote.timeEstimate} s`, mono: true },
            ]}
          />
          {plan.depositCalls ? (
            <Button onClick={() => void execute()} busy={outcome?.status === 'pending'} busyLabel={status ?? 'Working'} arrow>
              Send {origin.symbol} and pay
            </Button>
          ) : (
            <>
              <Notice tone="info" title={`Send from your ${origin.blockchain} wallet`}>
                Send exactly {plan.quote.quote.amountInFormatted} {origin.symbol} to the deposit address above, then start tracking. Add the
                transaction hash if you have it; 1Click finds the deposit sooner.
              </Notice>
              <Field label="Deposit transaction hash" htmlFor="any-external" optional>
                <Input id="any-external" mono value={externalTx} onChange={(event) => setExternalTx(event.target.value)} />
              </Field>
              <Button onClick={() => void execute()} busy={outcome?.status === 'pending'} busyLabel={status ?? 'Tracking'} arrow>
                I sent it: track the deposit
              </Button>
            </>
          )}
        </div>
      )}

      <OutcomeView outcome={outcome} />
      {result && result.txHashes.length > 1 && (
        <TxResult status="ok" title="NEAR transactions in this payment">
          <ul className={s.plainList}>
            {result.txHashes.map((hash) => (
              <li key={hash}>
                <TxHash value={hash} head={10} tail={8} />
              </li>
            ))}
          </ul>
        </TxResult>
      )}
      <p className={s.mutedSmall}>
        Call id <span className={s.mono}>{plan ? `${plan.callId.slice(0, 16)}…` : 'chosen when you quote'}</span> on{' '}
        <span className={s.mono}>{vault}</span>.
      </p>
    </div>
  );
}
