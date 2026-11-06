import type { ReactNode } from 'react';
import { TxHash } from './address';
import { errorSentence } from './errors';
import type { Chain } from './explorer';
import { CheckIcon, CrossIcon } from './icons';
import k from './kit.module.css';

export type TxStatus = 'pending' | 'ok' | 'rejected';

const STATUS: Record<TxStatus, { label: string; className: string | undefined }> = {
  pending: { label: 'Pending', className: k.txPending },
  ok: { label: 'Confirmed', className: k.txOk },
  rejected: { label: 'Rejected', className: k.txRejected },
};

export type TxResultProps = {
  status: TxStatus;
  /** What was attempted, e.g. "List c-3 at 1,200 USDC". */
  title: ReactNode;
  /** Transaction hash. Shown as a mono explorer link with a copy button. */
  hash?: string | null;
  chain?: Chain;
  /** Contract error code, e.g. ERR_RAW_SIGNATURES_THIS_EPOCH. Shown in a mono chip. */
  code?: string | null;
  /** One plain sentence. Defaults to the sentence for `code` when there is one. */
  message?: ReactNode;
  /** Extra rows: more hashes, amounts, a follow-up action. */
  children?: ReactNode;
};

/** Outcome of one transaction: status, ERR code, a sentence, and the hash linked to its explorer. */
export function TxResult({ status, title, hash, chain = 'near', code, message, children }: TxResultProps) {
  const { label, className } = STATUS[status];
  const sentence = message ?? (code ? errorSentence(code) : null);
  return (
    <div className={`${k.tx} ${className}`} role={status === 'rejected' ? 'alert' : 'status'}>
      <div className={k.txHead}>
        <span className={k.txIcon} aria-hidden>
          {status === 'pending' ? <span className={k.spinner} /> : status === 'ok' ? <CheckIcon /> : <CrossIcon />}
        </span>
        <p className={k.txTitle}>{title}</p>
        <span className={k.txStatus}>{label}</span>
      </div>
      {(code || sentence || hash || children) && (
        <div className={k.txBody}>
          {code && <code className={k.code}>{code}</code>}
          {sentence && <p className={k.txMessage}>{sentence}</p>}
          {hash && (
            <p className={k.txHashRow}>
              <span className={k.txHashLabel}>Transaction</span>
              <TxHash value={hash} chain={chain} head={10} tail={8} />
            </p>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
