'use client';

// L1 freshness check before a listing or a pledge. POSTs to /api/verify-l1, which reads the vault's
// current-epoch BTC, EVM and Solana addresses and the vault's own counters, and shows the report per
// chain. A dirty report blocks List and Accept in this UI. The vault enforces the raw-signature and
// live-intent rules on-chain regardless of what this page shows.

import { useCallback, useState } from 'react';
import type { FreshnessState } from '@/lib/l1FreshnessCheck';
import { Address, Button } from '../ui';
import { formatDuration, formatTime } from './format';
import type { FreshnessCheck, VerifyResponse } from './gate';
import s from './desk.module.css';

export { FRESHNESS_MAX_AGE_MS, freshnessGate, type FreshnessCheck, type Gate, type VerifyResponse } from './gate';

export function useFreshness(tokenId: string) {
  const [check, setCheck] = useState<FreshnessCheck>({ status: 'idle' });
  const run = useCallback(async () => {
    setCheck({ status: 'running', startedAtMs: Date.now() });
    try {
      const res = await fetch('/api/verify-l1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token_id: tokenId }),
      });
      const body = (await res.json().catch(() => null)) as (VerifyResponse & { error?: { message?: string } }) | null;
      if (!res.ok || !body || !body.report) {
        const reason = body?.error?.message ?? `HTTP ${res.status}`;
        setCheck({ status: 'error', message: `The freshness check did not run: ${reason}` });
        return;
      }
      setCheck({ status: 'done', data: body, receivedAtMs: Date.now() });
    } catch (error) {
      setCheck({ status: 'error', message: `The freshness check did not run: ${error instanceof Error ? error.message : String(error)}` });
    }
  }, [tokenId]);
  return { check, run };
}

const STATE_LABEL: Record<FreshnessState | 'not_applicable', string> = {
  clean: 'Clean',
  dirty: 'Dirty',
  unavailable: 'Unavailable',
  not_applicable: 'Not applicable',
};

function StateChip({ state }: { state: FreshnessState | 'not_applicable' }) {
  return <span className={`${s.chip} ${s[`chip_${state}`] ?? ''}`}>{STATE_LABEL[state]}</span>;
}

function host(url: string | null): string {
  if (!url) return 'none';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Row({ name, state, children }: { name: string; state: FreshnessState | 'not_applicable'; children: React.ReactNode }) {
  return (
    <li className={s.fRow}>
      <div className={s.fRowHead}>
        <span className={s.fName}>{name}</span>
        <StateChip state={state} />
      </div>
      <div className={s.fDetail}>{children}</div>
    </li>
  );
}

function ReportView({ data, receivedAtMs, nowMs }: { data: VerifyResponse; receivedAtMs: number; nowMs: number }) {
  const { report, attestation } = data;
  const vc = report.vaultChecks;
  const addressState: FreshnessState =
    vc.addressesMatchMpc.match === true ? 'clean' : 'reason' in vc.addressesMatchMpc && vc.addressesMatchMpc.reason === 'mismatch' ? 'dirty' : 'unavailable';
  const vaultState: FreshnessState = vc.rawSignaturesThisEpoch > 0 || vc.unexpiredIntents ? 'dirty' : 'clean';
  const evmAddress = report.evm[0]?.address ?? null;

  return (
    <div className={s.report}>
      <div className={s.reportHead}>
        <StateChip state={report.overall} />
        <span className={s.reportMeta}>
          Epoch {report.epoch} · read {formatDuration(nowMs - receivedAtMs)} ago · {report.network}
        </span>
      </div>

      {report.dirtyReasons.length > 0 && (
        <ul className={s.reasons}>
          {report.dirtyReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <ul className={s.fList}>
        <Row name="Vault" state={vaultState}>
          <span>
            Raw signatures this epoch <b className={s.num}>{vc.rawSignaturesThisEpoch}</b>
          </span>
          <span>
            {vc.unexpiredIntents ? `Signed intent live until ${formatTime(vc.latestIntentDeadlineMs)}` : 'No live signed intent'}
          </span>
        </Row>
        <Row name="MPC addresses" state={addressState}>
          {vc.addressesMatchMpc.match === true && <span>Stored addresses equal the derivation from the signer contract.</span>}
          {'reason' in vc.addressesMatchMpc && vc.addressesMatchMpc.reason === 'vault_has_no_addresses' && (
            <span>The vault has no stored addresses for this epoch. Anyone can call refresh_treasury_keys.</span>
          )}
          {'reason' in vc.addressesMatchMpc && vc.addressesMatchMpc.reason === 'mismatch' && (
            <span>Stored addresses differ from the derivation: {vc.addressesMatchMpc.mismatches.map((m) => m.field).join(', ')}.</span>
          )}
          {'error' in vc.addressesMatchMpc && <span className={s.err}>{vc.addressesMatchMpc.error}</span>}
        </Row>
        {report.btc ? (
          <Row name="Bitcoin" state={report.btc.state}>
            <Address value={report.btc.address} chain="btc" />
            <span>
              Mempool spends <b className={s.num}>{report.btc.spendingTxids.length}</b> · incoming{' '}
              <b className={s.num}>{report.btc.incomingTxids.length}</b> · via {host(report.btc.endpoint)}
            </span>
            {report.btc.spendingTxids.map((txid) => (
              <Address key={txid} value={txid} chain="btc" target="tx" />
            ))}
            {report.btc.state === 'unavailable' && <span className={s.err}>{report.btc.errors.join('; ')}</span>}
          </Row>
        ) : (
          <Row name="Bitcoin" state="unavailable">
            <span>No stored address to check.</span>
          </Row>
        )}
        {report.evm.length > 0 ? (
          <Row name="EVM" state={report.evm.some((c) => c.state === 'dirty') ? 'dirty' : report.evm.some((c) => c.state === 'unavailable') ? 'unavailable' : 'clean'}>
            {evmAddress && <Address value={evmAddress} chain="evm" />}
            {report.evm.map((c) => (
              <span key={c.chain} className={s.evmLine}>
                <StateChip state={c.state} /> {c.name}
                {c.error ? (
                  <span className={s.err}> {c.error}</span>
                ) : (
                  <span className={s.num}>
                    {' '}
                    nonce {c.latestNonce} latest / {c.pendingNonce} pending
                  </span>
                )}
              </span>
            ))}
          </Row>
        ) : (
          <Row name="EVM" state="unavailable">
            <span>No stored address to check.</span>
          </Row>
        )}
        {report.solana ? (
          <Row name="Solana" state={report.solana.state}>
            <Address value={report.solana.address} chain="sol" />
            <span>
              Signatures in the last {report.solana.windowSeconds}s <b className={s.num}>{report.solana.recentSignatures.length}</b> · via{' '}
              {host(report.solana.endpoint)}
            </span>
            {report.solana.recentSignatures.map((sig) => (
              <Address key={sig} value={sig} chain="sol" target="tx" />
            ))}
            {report.solana.error && <span className={s.err}>{report.solana.error}</span>}
          </Row>
        ) : (
          <Row name="Solana" state="unavailable">
            <span>No stored address to check.</span>
          </Row>
        )}
        <Row name="intents.near keys" state={report.intentsKeys.state}>
          {report.intentsKeys.state === 'not_applicable' ? (
            <span>{report.intentsKeys.reason}.</span>
          ) : (
            <>
              <span>
                Registered <b className={s.num}>{report.intentsKeys.registeredKeys.length}</b>, expected exactly the vault&apos;s derived key.
              </span>
              {report.intentsKeys.error && <span className={s.err}>{report.intentsKeys.error}</span>}
            </>
          )}
        </Row>
      </ul>

      <div className={s.attest}>
        <span className={s.attestLabel}>TEE attestation of this report</span>
        {attestation.state === 'signed' && (
          <span>
            Signed by {attestation.model}, chat <span className={s.num}>{attestation.chat_id}</span>. Checks passed{' '}
            <b className={s.num}>{attestation.verification_summary.passed.length}</b>, failed{' '}
            <b className={s.num}>{attestation.verification_summary.failed.length}</b>
            {attestation.verification_summary.failed.length > 0 && ` (${attestation.verification_summary.failed.join(', ')})`}.{' '}
            {attestation.scope}
          </span>
        )}
        {attestation.state === 'unsigned' && <span>Not signed: {attestation.reason}. The L1 report above stands by itself.</span>}
        {attestation.state === 'failed' && <span className={s.err}>Signing failed: {attestation.reason}</span>}
        <span className={s.sha}>
          sha256 <span className={s.num}>{data.report_sha256}</span>
        </span>
      </div>

      <p className={s.limits}>{report.limits}</p>
    </div>
  );
}

export function FreshnessPanel({
  check,
  onRun,
  nowMs,
  disabled,
}: {
  check: FreshnessCheck;
  onRun: () => void;
  nowMs: number;
  disabled?: boolean;
}) {
  return (
    <section className={s.freshness} aria-label="L1 freshness check">
      <div className={s.freshHead}>
        <div>
          <h4 className={s.subTitle}>L1 freshness check</h4>
          <p className={s.subText}>
            Reads the BTC mempool, EVM pending nonces and recent Solana signatures for this epoch&apos;s treasury addresses before you list or
            pledge.
          </p>
        </div>
        <Button
          variant="quiet"
          size="sm"
          onClick={onRun}
          busy={check.status === 'running'}
          busyLabel="Reading chains"
          disabled={disabled}
        >
          {check.status === 'done' ? 'Run again' : 'Run check'}
        </Button>
      </div>
      {check.status === 'error' && <p className={s.err}>{check.message}</p>}
      {check.status === 'done' && <ReportView data={check.data} receivedAtMs={check.receivedAtMs} nowMs={nowMs} />}
    </section>
  );
}
