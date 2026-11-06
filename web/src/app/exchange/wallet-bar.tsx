'use client';

import { useRouter } from 'next/navigation';
import { useWallet } from '@/lib/wallet';
import { Notice } from '../ui';
import { OutcomeView, useActionRunner, useWalletReturn } from '../desk/use-action';

/**
 * Page-level wallet state for the Exchange: why no wallet can sign here (sandbox), and the result of
 * transactions a redirecting wallet returns with.
 */
export function WalletBar() {
  const router = useRouter();
  const wallet = useWallet();
  const runner = useActionRunner(() => router.refresh());
  useWalletReturn(runner, wallet.accountId, () => router.refresh());
  return (
    <>
      {wallet.unavailableReason && (
        <Notice tone="info" title="Buying needs a browser wallet">
          {wallet.unavailableReason}
        </Notice>
      )}
      <OutcomeView outcome={runner.outcomes['wallet-return']} onDismiss={() => runner.clear('wallet-return')} />
    </>
  );
}
