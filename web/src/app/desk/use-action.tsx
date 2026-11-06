'use client';

// Runs one wallet action and keeps its outcome for <TxResult>. Every outcome carries the real
// transaction hashes the wallet returned; a failure carries the root-cause ERR_ code and, when a
// transaction was sent, its hash.

import { useCallback, useEffect, useRef, useState } from 'react';
import { describeActionError } from '@/lib/actions';
import { awaitFinalTransaction } from '@/lib/txOutcome';
import { readWalletRedirect } from '@/lib/wallet';
import { TxHash, TxResult, useToast, type TxStatus } from '../ui';
import s from './desk.module.css';

export interface Outcome {
  status: TxStatus;
  title: string;
  hashes: string[];
  code?: string | null;
  message?: string | null;
}

/** What an action reports once its transactions are final and state has been read back. */
export interface Settled {
  hashes: string[];
  /** False when the transactions succeeded but chain state shows the action did not take effect. */
  ok: boolean;
  message?: string;
  code?: string | null;
}

export interface ActionRunner {
  outcomes: Record<string, Outcome>;
  /** Key of the action in flight, or null. One action at a time, because each needs a wallet prompt. */
  busy: string | null;
  run: (key: string, title: string, action: () => Promise<Settled>) => Promise<boolean>;
  clear: (key: string) => void;
}

export function useActionRunner(onSettled?: () => void): ActionRunner {
  const toast = useToast();
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const set = useCallback((key: string, outcome: Outcome) => setOutcomes((all) => ({ ...all, [key]: outcome })), []);

  const run = useCallback(
    async (key: string, title: string, action: () => Promise<Settled>) => {
      setBusy(key);
      set(key, { status: 'pending', title, hashes: [], message: 'Waiting for the wallet to sign, then for the transactions to be final.' });
      try {
        const result = await action();
        const outcome: Outcome = {
          status: result.ok ? 'ok' : 'rejected',
          title,
          hashes: result.hashes,
          code: result.code ?? null,
          message: result.message ?? null,
        };
        set(key, outcome);
        toast.show({
          tone: result.ok ? 'ok' : 'error',
          title,
          code: outcome.code ?? undefined,
          body: outcome.message ?? undefined,
          hash: result.hashes[result.hashes.length - 1],
        });
        return result.ok;
      } catch (error) {
        const described = describeActionError(error);
        const redirected = error instanceof Error && error.name === 'WalletRedirectError';
        set(key, {
          status: redirected ? 'pending' : 'rejected',
          title,
          hashes: described.txHash ? [described.txHash] : [],
          code: described.code,
          message: described.code ? null : described.message,
        });
        if (!redirected) {
          toast.show({
            tone: 'error',
            title,
            code: described.code ?? undefined,
            body: described.code ? undefined : described.message,
            hash: described.txHash ?? undefined,
          });
        }
        return false;
      } finally {
        setBusy(null);
        settledRef.current?.();
      }
    },
    [set, toast],
  );

  const clear = useCallback((key: string) => setOutcomes(({ [key]: _, ...rest }) => rest), []);

  return { outcomes, busy, run, clear };
}

/**
 * A redirecting wallet (MyNearWallet) returns to this page with `?transactionHashes=`. Reads them
 * once, waits for each to be final, and records the result under `wallet-return`.
 */
export function useWalletReturn(runner: ActionRunner, accountId: string | null, onDone: () => void): void {
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current || !accountId) return;
    handled.current = true;
    const back = readWalletRedirect();
    if (!back) return;
    if (back.errorCode) {
      void runner.run('wallet-return', 'Wallet returned an error', async () => ({
        hashes: back.txHashes,
        ok: false,
        message: `The wallet reported ${back.errorCode}. Nothing was signed, or the user rejected the request.`,
      }));
      return;
    }
    void runner
      .run('wallet-return', 'Transactions signed in the wallet', async () => {
        for (const hash of back.txHashes) await awaitFinalTransaction(hash, accountId);
        return { hashes: back.txHashes, ok: true, message: 'Final on-chain. The figures below were read after they landed.' };
      })
      .then(onDone);
    // The runner identity is stable enough: this runs once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);
}

/** TxResult for one outcome. The last hash is the action's main transaction; earlier ones are set-up calls. */
export function OutcomeView({ outcome, onDismiss }: { outcome: Outcome | undefined; onDismiss?: () => void }) {
  if (!outcome) return null;
  const main = outcome.hashes[outcome.hashes.length - 1] ?? null;
  const earlier = outcome.hashes.slice(0, -1);
  return (
    <div className={s.outcome}>
      <TxResult status={outcome.status} title={outcome.title} hash={main} code={outcome.code} message={outcome.message ?? undefined}>
        {earlier.length > 0 && (
          <div className={s.earlier}>
            <span className={s.earlierLabel}>Set-up {earlier.length === 1 ? 'transaction' : 'transactions'}</span>
            {earlier.map((hash) => (
              <TxHash key={hash} value={hash} head={10} tail={8} />
            ))}
          </div>
        )}
        {onDismiss && outcome.status !== 'pending' && (
          <button type="button" className={s.dismiss} onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </TxResult>
    </div>
  );
}
