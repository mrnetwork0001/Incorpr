'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TxHash } from './address';
import { errorSentence } from './errors';
import type { Chain } from './explorer';
import { CheckIcon, CrossIcon, InfoIcon } from './icons';
import k from './kit.module.css';

export type ToastTone = 'info' | 'pending' | 'ok' | 'error';

export type ToastInput = {
  tone?: ToastTone;
  title: string;
  body?: ReactNode;
  /** Contract error code. Its sentence is used when `body` is not given. */
  code?: string;
  /** Transaction hash, linked to the explorer for `chain`. */
  hash?: string;
  chain?: Chain;
  /** Milliseconds before it closes. Pending toasts stay until updated or dismissed. Default 7000. */
  duration?: number;
};

type ToastEntry = ToastInput & { id: number };

export type ToastApi = {
  /** Shows a toast and returns its id. */
  show: (toast: ToastInput) => number;
  /** Replaces a toast's content, e.g. pending to ok once the transaction is final. */
  update: (id: number, toast: ToastInput) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);
const MAX_VISIBLE = 4;

const TONE_STYLE: Record<ToastTone, { hair: string; color: string; icon: ReactNode }> = {
  info: { hair: 'rgba(240, 162, 76, 0.22)', color: 'var(--ui-amber)', icon: <InfoIcon /> },
  pending: { hair: 'rgba(240, 162, 76, 0.32)', color: 'var(--ui-amber)', icon: <span className={k.spinner} /> },
  ok: { hair: 'rgba(121, 212, 192, 0.35)', color: 'var(--ui-teal)', icon: <CheckIcon /> },
  error: { hair: 'rgba(240, 143, 125, 0.4)', color: 'var(--ui-coral)', icon: <CrossIcon /> },
};

function ToastView({ toast, dismiss }: { toast: ToastEntry; dismiss: (id: number) => void }) {
  const tone = toast.tone ?? 'info';
  const style = TONE_STYLE[tone];
  const body = toast.body ?? (toast.code ? errorSentence(toast.code) : null);

  useEffect(() => {
    if (tone === 'pending') return;
    const timer = setTimeout(() => dismiss(toast.id), toast.duration ?? 7000);
    return () => clearTimeout(timer);
    // `toast` changes identity only on update(), which restarts the timer.
  }, [tone, toast, dismiss]);

  return (
    <div className={k.toast} style={{ ['--tone-hair' as string]: style.hair }} role={tone === 'error' ? 'alert' : 'status'}>
      <span className={k.txIcon} style={{ color: style.color, ['--tone' as string]: style.color, ['--tone-hair' as string]: style.hair }} aria-hidden>
        {style.icon}
      </span>
      <div>
        <p className={k.toastTitle}>{toast.title}</p>
        {toast.code && <code className={`${k.code} ${k.toastExtra}`}>{toast.code}</code>}
        {body && <div className={k.toastBody}>{body}</div>}
        {toast.hash && (
          <div className={k.toastExtra}>
            <TxHash value={toast.hash} chain={toast.chain} />
          </div>
        )}
      </div>
      <button type="button" className={`${k.iconBtn} ${k.toastClose}`} onClick={() => dismiss(toast.id)} aria-label="Dismiss notification">
        <CrossIcon />
      </button>
    </div>
  );
}

/** Mounted once by AppShell. Use `useToast()` in client components below it. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback((toast: ToastInput) => {
    const id = nextId.current++;
    setToasts((all) => [...all, { ...toast, id }].slice(-MAX_VISIBLE));
    return id;
  }, []);
  const update = useCallback(
    (id: number, toast: ToastInput) => setToasts((all) => all.map((t) => (t.id === id ? { ...toast, id } : t))),
    [],
  );

  const api = useMemo(() => ({ show, update, dismiss }), [show, update, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={k.toasts} aria-live="polite">
        {toasts.map((toast) => (
          <ToastView key={toast.id} toast={toast} dismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside ToastProvider (AppShell mounts one)');
  return api;
}
