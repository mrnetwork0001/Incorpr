import type { ReactNode } from 'react';
import { Address, CopyButton, TxHash } from '../ui';
import type { CheckStatus } from './checks';
import type { EvidenceTx } from './sources';
import v from './verify.module.css';

const BADGE: Record<CheckStatus, { label: string; className: string | undefined }> = {
  pass: { label: 'Pass', className: v.pass },
  fail: { label: 'Fail', className: v.fail },
  info: { label: 'Note', className: v.info },
  unavailable: { label: 'Not checked', className: v.unavailable },
};

export function StatusBadge({ status, label }: { status: CheckStatus; label?: string }) {
  const { label: fallback, className } = BADGE[status];
  return <span className={`${v.badge} ${className}`}>{label ?? fallback}</span>;
}

export function Section({
  id,
  index,
  eyebrow,
  title,
  intro,
  children,
}: {
  id: string;
  index: string;
  eyebrow: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className={v.section} aria-labelledby={`${id}-title`}>
      <div className={v.sectionHead}>
        <p className={v.eyebrow}>
          <span className={v.eyebrowIndex}>{index}</span>
          {eyebrow}
        </p>
        <h2 id={`${id}-title`} className={v.sectionTitle}>
          {title}
        </h2>
        {intro && <div className={v.sectionIntro}>{intro}</div>}
      </div>
      {children}
    </section>
  );
}

export function CheckRow({ label, status, detail, children }: { label: ReactNode; status: CheckStatus; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className={v.checkRow}>
      <div className={v.checkLabel}>
        <span>{label}</span>
        {detail && <span className={v.checkDetail}>{detail}</span>}
        {children}
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

/** One transaction from the evidence log: what it tried, its outcome, and the hash. */
export function EvidenceItem({ tx }: { tx: EvidenceTx }) {
  const failed = tx.status === 'failure';
  return (
    <div className={v.evidenceItem}>
      <div className={v.evidenceTop}>
        <code className={v.code}>{tx.method}</code>
        {failed ? (
          <span className={v.rejected}>{tx.expected_failure ? `rejected as expected: ${tx.error ?? 'no code'}` : `failed: ${tx.error ?? 'no code'}`}</span>
        ) : (
          <span className={v.ok}>success</span>
        )}
      </div>
      <p className={v.evidencePurpose}>{tx.purpose}</p>
      <TxHash value={tx.tx_hash} head={10} tail={8} />
    </div>
  );
}

export function Command({ command, what }: { command: string; what: string }) {
  return (
    <div className={v.command}>
      <code className={v.commandText}>
        <span className={v.prompt} aria-hidden>
          ${' '}
        </span>
        {command}
      </code>
      <CopyButton value={command} label="command" />
      <p className={v.commandWhat}>{what}</p>
    </div>
  );
}

export function AccountCell({ accountId, link }: { accountId: string | null; link: boolean }) {
  if (!accountId) return <span className={v.muted}>None</span>;
  return <Address value={accountId} noLink={!link} />;
}
