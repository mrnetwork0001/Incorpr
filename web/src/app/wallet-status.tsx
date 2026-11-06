'use client';

import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@/lib/wallet';
import { explorerHref, middleTruncate } from './ui/explorer';
import { CheckIcon, CopyIcon, ExternalIcon } from './ui/icons';
import w from './ui/wallet.module.css';

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" className={w.chevron} aria-hidden>
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Amber glass wallet pill. Connected: account menu with copy, explorer link and disconnect. */
export function WalletStatus() {
  const { ready, accountId, signIn, signOut } = useWallet();
  const menu = useRef<HTMLDetailsElement>(null);
  const [copied, setCopied] = useState(false);

  // Close the menu on an outside click or Escape.
  useEffect(() => {
    function onPointer(event: PointerEvent) {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector('summary')?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!ready) {
    return (
      <span className={w.wrap}>
        <span className={`${w.pill} ${w.loading}`} role="status">
          <span className={`${w.dot} ${w.loadingDot}`} aria-hidden />
          Wallet loading
        </span>
      </span>
    );
  }

  if (!accountId) {
    return (
      <span className={w.wrap}>
        <button type="button" className={w.pill} onClick={signIn}>
          Connect wallet
        </button>
      </span>
    );
  }

  const explorer = explorerHref('near', 'address', accountId);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <details ref={menu} className={w.wrap}>
      <summary className={w.pill} aria-label={`Wallet ${accountId}. Open account menu`}>
        <span className={w.dot} aria-hidden />
        <span className={`${w.account} ${w.accountLong}`}>{middleTruncate(accountId, 12, 8)}</span>
        <span className={`${w.account} ${w.accountShort}`}>{middleTruncate(accountId, 6, 5)}</span>
        <Chevron />
      </summary>
      <div className={w.menu}>
        <p className={w.menuLabel}>Connected account</p>
        <p className={w.menuAccount}>{accountId}</p>
        <button type="button" className={w.menuItem} onClick={() => void copy(accountId)}>
          {copied ? 'Copied' : 'Copy account id'}
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        {explorer && (
          <a href={explorer} target="_blank" rel="noreferrer" className={w.menuItem}>
            View on NearBlocks
            <ExternalIcon />
          </a>
        )}
        <button
          type="button"
          className={`${w.menuItem} ${w.danger}`}
          onClick={() => {
            if (menu.current) menu.current.open = false;
            void signOut();
          }}
        >
          Disconnect
        </button>
      </div>
    </details>
  );
}
