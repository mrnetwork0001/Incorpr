'use client';

import { useState } from 'react';
import { Button, Notice } from '../../ui';
import s from './cockpit.module.css';
import { Mono } from './mono';
import { runBrowserChecks, verdict, type BrowserChecks, type CheckResult } from './tee-verify';

/** Fields of /api/attestation used here. Every check is true, false, or a "not run: ..." string. */
interface AttestationBody {
  model: string;
  attestationNonce: string;
  attestationNodes: number;
  attestedSigningAddress: string | null;
  signingAddressInFreshAttestation: CheckResult;
  attestationEchoesNonce: CheckResult;
  tdxReportDataBindsSigningAddress: CheckResult;
  tdxReportDataBindsNonce: CheckResult;
  intelQuoteVerified: CheckResult;
  intelTcbStatus: string | null;
  nrasOverallResult: CheckResult;
  nrasJwtSignatures: CheckResult;
  nrasGpuCount: number | null;
}

type AttestationState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; body: AttestationBody }
  | { status: 'error'; message: string };

export interface VerifyInput {
  signedText: string;
  signature: string;
  signingAddress: string;
  model: string;
  system: string;
  userInput: string;
  requestBody?: string | null;
  responseBody?: string | null;
}

export function CheckRow({ label, result, note }: { label: string; result: CheckResult; note?: string | null }) {
  const state = result === true ? 'pass' : result === false ? 'fail' : 'skip';
  const reason = typeof result === 'string' ? result.replace(/^not run:\s*/, '') : null;
  return (
    <li className={s.check}>
      <span className={`${s.checkChip} ${s[`chip_${state}`]}`}>{state === 'pass' ? 'PASS' : state === 'fail' ? 'FAIL' : 'NOT RUN'}</span>
      <span className={s.checkText}>
        {label}
        {(reason || note) && <span className={s.checkNote}>{reason ?? note}</span>}
      </span>
    </li>
  );
}

const VERDICT_TEXT = {
  pass: 'Verified in this browser: the TEE key that signed this answer is bound to a fresh Intel TDX quote, and the signature covers your exact input.',
  fail: 'A check failed. Do not treat this answer as attested.',
  incomplete: 'Some checks did not run. The answer is not fully verified; the reasons are listed below.',
} as const;

export function VerifyPanel(input: VerifyInput) {
  const [browser, setBrowser] = useState<BrowserChecks | null>(null);
  const [attestation, setAttestation] = useState<AttestationState>({ status: 'idle' });

  async function verify() {
    setBrowser(runBrowserChecks(input));
    setAttestation({ status: 'loading' });
    try {
      const query = new URLSearchParams({ model: input.model, signing_address: input.signingAddress });
      const res = await fetch(`/api/attestation?${query}`, { cache: 'no-store' });
      const body = (await res.json()) as AttestationBody & { error?: { message?: string } };
      if (!res.ok) {
        setAttestation({ status: 'error', message: body.error?.message ?? `/api/attestation answered HTTP ${res.status}` });
        return;
      }
      setAttestation({ status: 'ok', body });
    } catch (error) {
      setAttestation({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  const att = attestation.status === 'ok' ? attestation.body : null;
  const attError = attestation.status === 'error' ? `not run: ${attestation.message}` : 'not run: waiting for the attestation report';
  const decisive: CheckResult[] = browser
    ? [
        browser.signatureRecoversSigningAddress,
        browser.signedTextParsed,
        browser.signedModelMatches,
        browser.requestHashMatchesYourInput,
        att?.signingAddressInFreshAttestation ?? attError,
        att?.tdxReportDataBindsSigningAddress ?? attError,
        att?.intelQuoteVerified ?? attError,
      ]
    : [];
  const result = browser && attestation.status !== 'loading' ? verdict(decisive) : null;

  return (
    <div className={s.verify}>
      <div className={s.verifyHead}>
        <div>
          <h4 className={s.subTitle}>Check the signature yourself</h4>
          <p className={s.muted}>
            Recovers the signer with secp256k1 in this tab, recomputes the request hash from the charter prompt and your input, then asks for a
            fresh attestation report with a new nonce.
          </p>
        </div>
        <Button variant="quiet" size="sm" onClick={() => void verify()} busy={attestation.status === 'loading'} busyLabel="Verifying">
          {browser ? 'Verify again' : 'Verify in this browser'}
        </Button>
      </div>

      {result && (
        <p className={`${s.verdict} ${s[`verdict_${result}`]}`} role="status">
          <strong>{result === 'pass' ? 'Pass' : result === 'fail' ? 'Fail' : 'Incomplete'}.</strong> {VERDICT_TEXT[result]}
        </p>
      )}

      {browser && (
        <div className={s.checkGroups}>
          <div>
            <p className={s.groupLabel}>Computed in this browser</p>
            <ul className={s.checks}>
              <CheckRow
                label="EIP-191 signature recovers to the signing address"
                result={browser.signatureRecoversSigningAddress}
                note={browser.recovered ? `recovered ${browser.recovered}` : null}
              />
              <CheckRow label="Signed text has the model:request:response form" result={browser.signedTextParsed} />
              <CheckRow label="Signed model is the model that answered" result={browser.signedModelMatches} />
              <CheckRow label="Signed request hash equals sha256 of the charter prompt and your input" result={browser.requestHashMatchesYourInput} />
              <CheckRow label="Signed response hash equals sha256 of the response bytes" result={browser.responseHashMatches} />
            </ul>
          </div>
          <div>
            <p className={s.groupLabel}>Fresh attestation report</p>
            {attestation.status === 'error' && (
              <Notice tone="error" title="The attestation report could not be checked">
                {attestation.message}
              </Notice>
            )}
            {attestation.status === 'loading' && <p className={s.muted}>Fetching the report and Intel collateral. This takes up to a minute.</p>}
            {att && (
              <>
                <ul className={s.checks}>
                  <CheckRow label="Signing address is one of the attested TEE nodes" result={att.signingAddressInFreshAttestation} />
                  <CheckRow label="Report echoes the new nonce" result={att.attestationEchoesNonce} />
                  <CheckRow label="TDX report_data binds the signing address" result={att.tdxReportDataBindsSigningAddress} />
                  <CheckRow label="TDX report_data binds the nonce" result={att.tdxReportDataBindsNonce} />
                  <CheckRow
                    label="Intel TDX quote verifies against Intel PCS collateral"
                    result={att.intelQuoteVerified}
                    note={att.intelTcbStatus ? `TCB status ${att.intelTcbStatus}` : null}
                  />
                  <CheckRow
                    label="NVIDIA NRAS overall GPU attestation result"
                    result={att.nrasOverallResult}
                    note={att.nrasGpuCount !== null ? `${att.nrasGpuCount} GPU token(s)` : null}
                  />
                  <CheckRow label="NRAS JWT signatures verify against NVIDIA keys" result={att.nrasJwtSignatures} />
                </ul>
                <p className={s.mutedSmall}>
                  Nonce <span className={s.mono}>{att.attestationNonce.slice(0, 16)}…</span>, {att.attestationNodes} node(s) for {att.model}.
                  {att.attestedSigningAddress && (
                    <>
                      {' '}
                      Attested key <Mono value={att.attestedSigningAddress} label="attested signing address" />
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
