'use client';

// "Use the service": pay one call in USDC with ft_transfer_call to the vault, then ask
// /api/run-service to run the company's skill on NEAR AI Cloud. The route serves a call only when
// the vault holds an unserved payment for its call id, and the call id commits to the input, so the
// salt stays in this browser until the call is served.

import { useCallback, useEffect, useState } from 'react';
import { newCallSalt, payForService } from '@/lib/actions';
import { VaultClient, serviceCallId } from '@/lib/contracts';
import { useWallet } from '@/lib/wallet';
import { Button, Field, Glass, GlassHeader, KeyValue, Notice, Tabs, Textarea, TxResult } from '../../ui';
import { AnyTokenPay } from './any-token-pay';
import s from './cockpit.module.css';
import { formatUsdc } from './format';
import { Mono } from './mono';
import { OutcomeView, WalletGate, errorOutcome, type Outcome } from './tx-runner';
import { VerifyPanel } from './verify-panel';

export interface ServiceProps {
  tokenId: string;
  registryId: string;
  vault: string;
  /** The charter prompt: the system message of every call. */
  system: string;
  priceMicro: string;
  usdcToken: string;
}

export interface PaidCall {
  callId: string;
  salt: string;
  input: string;
}

interface Verification {
  signedText: string;
  signature: string;
  signingAddress: string;
  recoveredAddress: string | null;
  signatureKind: string;
  model: string;
  chatId: string;
}

interface RunOk {
  content: string | null;
  chat_id: string;
  model: string;
  vault: string;
  verification: Verification;
  verification_summary: { failed: string[]; notRun: Record<string, string>; passed: string[] };
  record: { state: 'recorded' | 'pending' | 'failed' | 'not_sent'; tx_hash: string | null; error: string | null };
  request_body?: string;
  response_body?: string;
}

type RunState =
  | { status: 'running'; call: PaidCall }
  | { status: 'ok'; call: PaidCall; body: RunOk }
  | { status: 'error'; call: PaidCall; http: number; code: string; message: string };

type Readiness = { status: 'checking' } | { status: 'ready' } | { status: 'unavailable'; message: string };

const MAX_INPUT = 8_000;

const storageKey = (vault: string) => `incorpr:paid-call:${vault}`;

function loadPaidCall(vault: string): PaidCall | null {
  try {
    const raw = localStorage.getItem(storageKey(vault));
    return raw ? (JSON.parse(raw) as PaidCall) : null;
  } catch {
    return null;
  }
}

function savePaidCall(vault: string, call: PaidCall | null) {
  try {
    if (call) localStorage.setItem(storageKey(vault), JSON.stringify(call));
    else localStorage.removeItem(storageKey(vault));
  } catch {
    // Without storage the salt lives only in this tab's memory.
  }
}

/**
 * Asks /api/run-service about a fresh random call. The route checks its own configuration (TEE key,
 * operator key) and that its operator is this vault's service operator before it looks for a
 * payment, so 402 "no payment" means it could serve a paid call on this vault.
 */
async function checkReadiness(tokenId: string): Promise<Readiness> {
  const input = 'readiness probe';
  const salt = newCallSalt();
  try {
    const res = await fetch('/api/run-service', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token_id: tokenId, call_id: serviceCallId(input, salt), salt, input }),
    });
    if (res.status === 402) return { status: 'ready' };
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return { status: 'unavailable', message: body.error?.message ?? `/api/run-service answered HTTP ${res.status}` };
  } catch (error) {
    return { status: 'unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}

export function ServicePanel({ tokenId, registryId, vault, system, priceMicro, usdcToken }: ServiceProps) {
  const { sender } = useWallet();
  const [input, setInput] = useState('');
  const [payOutcome, setPayOutcome] = useState<Outcome | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [readiness, setReadiness] = useState<Readiness>({ status: 'checking' });
  const [unserved, setUnserved] = useState<PaidCall | null>(null);

  useEffect(() => {
    void checkReadiness(tokenId).then(setReadiness);
  }, [tokenId]);

  // A call paid in an earlier visit (or before a wallet redirect) and not served yet.
  useEffect(() => {
    const call = loadPaidCall(vault);
    if (!call) return;
    void new VaultClient(vault, { finality: 'optimistic' })
      .getPayment(call.callId)
      .then((payment) => {
        if (payment && !payment.served) setUnserved(call);
        else if (payment?.served) savePaidCall(vault, null);
      })
      .catch(() => setUnserved(null));
  }, [vault]);

  const runService = useCallback(
    async (call: PaidCall) => {
      setRun({ status: 'running', call });
      setUnserved(null);
      try {
        const res = await fetch('/api/run-service', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token_id: tokenId, call_id: call.callId, salt: call.salt, input: call.input }),
        });
        const body = (await res.json()) as RunOk & { error?: { code?: string; message?: string } };
        if (!res.ok || body.error) {
          setRun({
            status: 'error',
            call,
            http: res.status,
            code: body.error?.code ?? 'error',
            message: body.error?.message ?? `/api/run-service answered HTTP ${res.status}`,
          });
          // 409 "already served" means the payment is used; anything else can be retried with the same call.
          if (res.status === 409 && /already served/i.test(body.error?.message ?? '')) savePaidCall(vault, null);
          else setUnserved(call);
          return;
        }
        setRun({ status: 'ok', call, body });
        if (body.record.state === 'recorded') savePaidCall(vault, null);
      } catch (error) {
        setRun({ status: 'error', call, http: 0, code: 'network', message: error instanceof Error ? error.message : String(error) });
        setUnserved(call);
      }
    },
    [tokenId, vault],
  );

  async function payAndRun() {
    if (!sender) return;
    const salt = newCallSalt();
    const call: PaidCall = { callId: serviceCallId(input, salt), salt, input };
    // Saved before signing: a redirecting wallet leaves this page, and only the salt proves the input.
    savePaidCall(vault, call);
    const title = `Pay ${formatUsdc(priceMicro)} USDC for one call`;
    setRun(null);
    setPayOutcome({ status: 'pending', title, message: 'Sign usdc.ft_transfer_call to the vault in your wallet.' });
    try {
      const paid = await payForService(sender, { tokenId, input, salt }, { registryId });
      const hash = paid.txHashes[paid.txHashes.length - 1] ?? null;
      if (!paid.booked) {
        savePaidCall(vault, null);
        setPayOutcome({
          status: 'rejected',
          title,
          hash,
          message: 'The transfer landed but the vault holds no payment for this call id, so it refunded the USDC. The price may have changed since this page loaded.',
        });
        return;
      }
      setPayOutcome({ status: 'ok', title, hash, message: `Booked by ${vault}. get_payment now returns this call as unserved.` });
      await runService(call);
    } catch (error) {
      const outcome = errorOutcome(title, error);
      if (outcome.status === 'rejected' && !outcome.hash) savePaidCall(vault, null);
      setPayOutcome(outcome);
    }
  }

  const tooLong = input.length > MAX_INPUT;
  const canPay = Boolean(sender) && input.trim().length > 0 && !tooLong && readiness.status === 'ready' && run?.status !== 'running';
  const busy = payOutcome?.status === 'pending' || run?.status === 'running';

  return (
    <Glass as="section" lit pad="lg" aria-labelledby="service-title" className={s.servicePanel}>
      <GlassHeader title={<span id="service-title">Use the service</span>} meta={`${formatUsdc(priceMicro)} USDC per call, paid to the vault`} />

      <div className={s.serviceGrid}>
        <div className={s.serviceForm}>
          <Field
            label="Your input"
            htmlFor="service-input"
            hint={`Sent as the user message. The charter prompt is the system message. ${input.length.toLocaleString('en-US')} / ${MAX_INPUT.toLocaleString('en-US')} characters.`}
            error={tooLong ? `Inputs are limited to ${MAX_INPUT.toLocaleString('en-US')} characters.` : undefined}
          >
            <Textarea
              id="service-input"
              rows={5}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="What should this company do for you?"
              invalid={tooLong}
              aria-describedby={tooLong ? 'service-input-error' : 'service-input-hint'}
            />
          </Field>

          {readiness.status === 'unavailable' && (
            <Notice tone="error" title="This server cannot serve calls right now">
              {readiness.message.replace(/\.?\s*$/, '.')} Paying now would leave the call unserved, so payment is disabled until this is fixed.
            </Notice>
          )}

          {unserved && run?.status !== 'running' && (
            <Notice
              tone="info"
              title="You paid for a call that has not been served"
              action={
                <span className={s.actionRow}>
                  <Button variant="quiet" size="sm" onClick={() => void runService(unserved)} disabled={readiness.status !== 'ready'}>
                    Run the paid call
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      savePaidCall(vault, null);
                      setUnserved(null);
                    }}
                  >
                    Forget it
                  </Button>
                </span>
              }
            >
              <p>
                Call <code>{unserved.callId.slice(0, 16)}…</code> is booked on the vault. Running it costs nothing more.
              </p>
            </Notice>
          )}

          <Tabs
            label="Payment method"
            tabs={[
              {
                id: 'usdc',
                label: 'Pay in USDC',
                content: (
                  <div className={s.stack}>
                    <p className={s.muted}>
                      One <span className={s.mono}>ft_transfer_call</span> of {formatUsdc(priceMicro)} USDC to <span className={s.mono}>{vault}</span>{' '}
                      with msg <span className={s.mono}>{'{"call_id"}'}</span>. The vault books revenue in <span className={s.mono}>ft_on_transfer</span>, or
                      refunds in full.
                    </p>
                    <WalletGate action="pay for a call">
                      <Button onClick={() => void payAndRun()} disabled={!canPay} busy={busy} busyLabel="Working" arrow>
                        Pay {formatUsdc(priceMicro)} USDC and run
                      </Button>
                    </WalletGate>
                  </div>
                ),
              },
              {
                id: 'any',
                label: 'Pay in another token',
                content: (
                  <AnyTokenPay
                    tokenId={tokenId}
                    registryId={registryId}
                    vault={vault}
                    usdcToken={usdcToken}
                    input={input}
                    disabled={!canPay}
                    onPrepared={(call) => savePaidCall(vault, call)}
                    onBooked={(call) => void runService(call)}
                  />
                ),
              },
            ]}
          />
          <OutcomeView outcome={payOutcome} />
        </div>

        <div className={s.serviceResult} aria-live="polite">
          {!run && (
            <Notice tone="empty" title="No call yet">
              <ol className={s.steps}>
                <li>Your wallet sends the price to the vault with ft_transfer_call. The vault books it or refunds it.</li>
                <li>This server checks get_payment, then runs the charter prompt and your input on a NEAR AI Cloud TEE model.</li>
                <li>The model&apos;s TEE key signs the request and response hashes. The operator records the call on the vault.</li>
                <li>You check the signature and a fresh hardware attestation here, in this browser.</li>
              </ol>
            </Notice>
          )}
          {run?.status === 'running' && (
            <TxResult status="pending" title="Running on NEAR AI Cloud" message="Inference in a TEE, then the signature and a fresh attestation are fetched. This can take a minute." />
          )}
          {run?.status === 'error' && (
            <TxResult status="rejected" title="The service did not answer" code={run.code} message={run.message}>
              <p className={s.mutedSmall}>
                HTTP {run.http || 'none'}. The payment stays booked and unserved, so the same call can be run again.
              </p>
            </TxResult>
          )}
          {run?.status === 'ok' && <RunOutput body={run.body} call={run.call} system={system} />}
        </div>
      </div>
    </Glass>
  );
}

function RunOutput({ body, call, system }: { body: RunOk; call: PaidCall; system: string }) {
  const v = body.verification;
  const summary = body.verification_summary;
  const record = body.record;
  return (
    <div className={s.stack}>
      <div>
        <p className={s.groupLabel}>Answer</p>
        <pre className={s.answer}>{body.content ?? '(The model returned no text.)'}</pre>
      </div>

      <TxResult
        status={record.state === 'recorded' ? 'ok' : record.state === 'pending' ? 'pending' : 'rejected'}
        title="record_service_call on the vault"
        hash={record.tx_hash}
        code={record.state === 'failed' ? record.error : null}
        message={
          record.state === 'recorded'
            ? 'The operator marked this paid call as served, with the TEE chat id.'
            : record.state === 'pending'
              ? 'Sent by the operator, not final yet.'
              : record.state === 'not_sent'
                ? `The operator could not send the record transaction (${record.error ?? 'no detail'}). You keep the verified answer; the payment stays unserved, and a retry re-sends only the record.`
                : 'The operator could not record the call. You keep the verified answer; the payment stays unserved.'
        }
      />

      <KeyValue
        items={[
          { label: 'Model', value: body.model, mono: true },
          { label: 'Chat id', value: <Mono value={body.chat_id} label="chat id" /> },
          { label: 'Call id', value: <Mono value={call.callId} label="call id" /> },
          { label: 'Signature kind', value: v.signatureKind, mono: true },
          { label: 'Signing address', value: <Mono value={v.signingAddress} label="TEE signing address" full /> },
          { label: 'Signature', value: <Mono value={v.signature} label="ECDSA signature" head={14} tail={10} /> },
          { label: 'Signed text', value: <span className={s.wrapMono}>{v.signedText}</span> },
          {
            label: 'Server checks',
            value: (
              <span>
                {summary.passed.length} passed, {summary.failed.length} failed, {Object.keys(summary.notRun).length} not run
              </span>
            ),
          },
        ]}
      />

      {Object.keys(summary.notRun).length > 0 && (
        <details className={s.details}>
          <summary>Checks the server did not run</summary>
          <ul className={s.plainList}>
            {Object.entries(summary.notRun).map(([field, reason]) => (
              <li key={field}>
                <span className={s.mono}>{field}</span>: {reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      <VerifyPanel
        signedText={v.signedText}
        signature={v.signature}
        signingAddress={v.signingAddress}
        model={body.model}
        system={system}
        userInput={call.input}
        requestBody={body.request_body ?? null}
        responseBody={body.response_body ?? null}
      />
    </div>
  );
}
