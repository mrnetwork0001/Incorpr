'use client';

// A redirecting wallet (MyNearWallet) returns to this page with ?transactionHashes= or ?errorCode=.
// This reads them once, waits for each transaction to be final on our RPC, and shows the outcome.

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { awaitFinalTransaction } from '@/lib/txOutcome';
import { readWalletRedirect, useWallet, type WalletRedirectResult } from '@/lib/wallet';
import { OutcomeView, PENDING_ACTION_KEY, errorOutcome, type Outcome } from './tx-runner';
import s from './cockpit.module.css';

function pendingTitle(): string {
  try {
    const raw = sessionStorage.getItem(PENDING_ACTION_KEY);
    sessionStorage.removeItem(PENDING_ACTION_KEY);
    if (raw) return (JSON.parse(raw) as { title?: string }).title ?? 'Wallet transaction';
  } catch {
    // Fall through to the generic title.
  }
  return 'Wallet transaction';
}

export function WalletReturn() {
  const { accountId } = useWallet();
  const router = useRouter();
  const [redirect, setRedirect] = useState<(WalletRedirectResult & { title: string }) | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const resolved = useRef(false);

  useEffect(() => {
    const result = readWalletRedirect();
    if (result) setRedirect({ ...result, title: pendingTitle() });
  }, []);

  useEffect(() => {
    if (!redirect || resolved.current) return;
    if (redirect.txHashes.length === 0) {
      resolved.current = true;
      setOutcomes([
        {
          status: 'rejected',
          title: redirect.title,
          code: null,
          message: `The wallet returned ${redirect.errorCode ?? 'an error'}. Nothing was sent.`,
        },
      ]);
      return;
    }
    // The signer is needed to look the transactions up; wait until the wallet reports the account.
    if (!accountId) {
      setOutcomes(redirect.txHashes.map((hash) => ({ status: 'pending', title: redirect.title, hash })));
      return;
    }
    resolved.current = true;
    void (async () => {
      const results: Outcome[] = [];
      for (const hash of redirect.txHashes) {
        try {
          const tx = await awaitFinalTransaction(hash, accountId);
          results.push({
            status: tx.refusal ? 'rejected' : 'ok',
            title: redirect.title,
            hash,
            code: tx.refusal?.code ?? null,
            message: tx.refusal?.message,
          });
        } catch (error) {
          results.push({ ...errorOutcome(redirect.title, error), hash: (error as { txHash?: string }).txHash ?? hash });
        }
      }
      setOutcomes(results);
      router.refresh();
    })();
  }, [redirect, accountId, router]);

  if (outcomes.length === 0) return null;
  return (
    <div className={s.walletReturn} aria-label="Transactions returned by the wallet">
      {outcomes.map((outcome, i) => (
        <OutcomeView key={`${outcome.hash ?? 'none'}-${i}`} outcome={outcome} />
      ))}
    </div>
  );
}
