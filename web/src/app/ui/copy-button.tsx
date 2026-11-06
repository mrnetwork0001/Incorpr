'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './icons';
import k from './kit.module.css';

/** Icon button that copies `value`. `label` names what is copied, for screen readers. */
export function CopyButton({ value, label = 'value' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused (insecure origin, permissions). The value stays selectable.
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={`${k.iconBtn} ${copied ? k.copied : ''}`}
      onClick={() => void copy()}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
