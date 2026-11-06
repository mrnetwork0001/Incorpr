import type { ReactNode } from 'react';
import { AlertIcon, EmptyIcon, InfoIcon } from './icons';
import k from './kit.module.css';

/** empty: nothing to show yet. info: a precondition or a fact. error: a read or call failed. */
export type NoticeTone = 'empty' | 'info' | 'error';

const TONE: Record<NoticeTone, { className: string | undefined; icon: ReactNode }> = {
  empty: { className: k.noticeEmpty, icon: <EmptyIcon /> },
  info: { className: k.noticeInfo, icon: <InfoIcon /> },
  error: { className: k.noticeError, icon: <AlertIcon /> },
};

export type NoticeProps = {
  tone?: NoticeTone;
  title: ReactNode;
  /** Say plainly what is missing and how to supply it. */
  children?: ReactNode;
  /** Buttons or links below the text. */
  action?: ReactNode;
  className?: string;
};

export function Notice({ tone = 'info', title, children, action, className }: NoticeProps) {
  const { className: toneClass, icon } = TONE[tone];
  return (
    <div className={[k.notice, toneClass, className].filter(Boolean).join(' ')} role={tone === 'error' ? 'alert' : undefined}>
      <span className={k.noticeIcon} aria-hidden>
        {icon}
      </span>
      <div>
        <p className={k.noticeTitle}>{title}</p>
        {children && <div className={k.noticeBody}>{children}</div>}
        {action && <div className={k.noticeAction}>{action}</div>}
      </div>
    </div>
  );
}
