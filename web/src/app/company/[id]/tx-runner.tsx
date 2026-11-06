'use client';

// Shared client plumbing for the cockpit's wallet actions: one outcome per action, shown with
// TxResult, and a server re-read of chain state after anything was sent.

import { useRouter } from 'next/navigation';
import { useCallback, useState, type ReactNode } from 'react';
import { describeActionError } from '@/lib/actions';
import { useWallet } from '@/lib/wallet';
import { Button, Notice, TxResult, type TxStatus } from '../../ui';

export interface Outcome {
  status: TxStatus;
  title: string;
  hash?: string | null;
  code?: string | null;
  message?: ReactNode;
  extra?: ReactNode;
}

export interface ActionReport {
  hash: string | null;
  /** False when the transaction landed but the contract refused or refunded. */
  ok?: boolean;
  code?: string | null;
  message?: ReactNode;
  extra?: ReactNode;
}

/** sessionStorage key naming the action a redirecting wallet is signing, read by WalletReturn. */
export const PENDING_ACTION_KEY = 'incorpr:cockpit:pending-action';

export function errorOutcome(title: string, error: unknown): Outcome {
  const described = describeActionError(error);
  if (error instanceof Error && error.name === 'WalletRedirectError') {
    return { status: 'pending', title, message: described.message };
  }
  const nothingSent = described.txHash === null;
  return {
    status: 'rejected',
    title,
    hash: described.txHash,
    code: described.code,
    message: (
      <>
        {described.message}
        {nothingSent && described.kind !== 'rejected' ? ' Nothing was signed.' : ''}
      </>
    ),
  };
}

export function useTxRunner() {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = useCallback(
    async (title: string, action: () => Promise<ActionReport>): Promise<boolean> => {
      setOutcome({ status: 'pending', title, message: 'Waiting for the wallet and for the transaction to be final.' });
      try {
        sessionStorage.setItem(PENDING_ACTION_KEY, JSON.stringify({ title, at: Date.now() }));
      } catch {
        // Storage can be unavailable (private mode). The redirect result is then shown without a title.
      }
      let redirected = false;
      try {
        const report = await action();
        setOutcome({
          status: report.ok === false ? 'rejected' : 'ok',
          title,
          hash: report.hash,
          code: report.code,
          message: report.message,
          extra: report.extra,
        });
        router.refresh();
        return report.ok !== false;
      } catch (error) {
        redirected = error instanceof Error && error.name === 'WalletRedirectError';
        const next = errorOutcome(title, error);
        setOutcome(next);
        if (next.hash) router.refresh();
        return false;
      } finally {
        if (!redirected) {
          try {
            sessionStorage.removeItem(PENDING_ACTION_KEY);
          } catch {
            // See above.
          }
        }
      }
    },
    [router],
  );

  return { outcome, setOutcome, run, busy: outcome?.status === 'pending' };
}

export function OutcomeView({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  return (
    <TxResult status={outcome.status} title={outcome.title} hash={outcome.hash} code={outcome.code} message={outcome.message}>
      {outcome.extra}
    </TxResult>
  );
}

/** Renders `children(sender)` once a wallet is connected; otherwise says what is missing. */
export function WalletGate({ action, children }: { action: string; children: ReactNode }) {
  const { ready, accountId, unavailableReason, signIn } = useWallet();
  if (accountId) return <>{children}</>;
  if (unavailableReason) {
    return (
      <Notice tone="info" title={`No browser wallet can ${action} here`}>
        {unavailableReason}
      </Notice>
    );
  }
  return (
    <Notice
      tone="info"
      title={`Connect a NEAR wallet to ${action}`}
      action={
        <Button variant="quiet" size="sm" onClick={signIn} disabled={!ready}>
          {ready ? 'Connect wallet' : 'Loading wallets'}
        </Button>
      }
    >
      The transaction is signed by your wallet and sent to the chain from your account.
    </Notice>
  );
}
