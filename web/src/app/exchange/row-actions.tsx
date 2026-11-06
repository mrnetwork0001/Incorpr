'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { bidAuction, buyCompany, type BuyResult } from '@/lib/actions';
import { useWallet } from '@/lib/wallet';
import { Button, ButtonLink } from '../ui';
import { formatUsdc, formatUsdcExact } from '../desk/format';
import { OutcomeView, useActionRunner, type Settled } from '../desk/use-action';
import s from './exchange.module.css';

function settled(result: BuyResult, verb: string): Settled {
  return {
    hashes: result.txHashes,
    ok: result.acquired,
    code: result.refusal?.code ?? null,
    message: result.acquired
      ? `${verb} for ${formatUsdcExact(result.price)} USDC. The NFT and the vault's shareholder are now the connected account.`
      : result.refusal
        ? undefined
        : `The transfer landed, but the registry records ${result.owner ?? 'no one'} as owner. The USDC was refunded.`,
  };
}

/** Buy (listed) or Bid (auction running) for one Exchange row, with its transaction result below the row. */
export function RowActions({
  tokenId,
  name,
  owner,
  ask,
  syncNonce,
  auctionPrice,
  blocked,
}: {
  tokenId: string;
  name: string;
  owner: string;
  ask: string | null;
  /** The company's sync_nonce as rendered; the purchase is pinned to it. */
  syncNonce: number;
  auctionPrice: string | null;
  blocked: boolean;
}) {
  const router = useRouter();
  const wallet = useWallet();
  const runner = useActionRunner(() => router.refresh());
  const [confirming, setConfirming] = useState(false);
  const key = `buy-${tokenId}`;
  const busy = runner.busy === key;
  const mine = wallet.accountId === owner;

  const price = ask ?? auctionPrice;
  const kind = ask ? 'buy' : auctionPrice ? 'bid' : null;

  let action: React.ReactNode;
  if (!kind || mine || blocked) {
    action = (
      <ButtonLink variant="quiet" size="sm" href={mine ? '/desk' : `/company/${tokenId}`}>
        {mine ? 'On your desk' : 'Open'}
      </ButtonLink>
    );
  } else if (!wallet.sender) {
    action = (
      <Button
        variant="quiet"
        size="sm"
        onClick={wallet.signIn}
        disabled={!wallet.ready || Boolean(wallet.unavailableReason)}
        title={wallet.unavailableReason ?? undefined}
      >
        {kind === 'buy' ? 'Connect to buy' : 'Connect to bid'}
      </Button>
    );
  } else if (!confirming) {
    action = (
      <Button variant="primary" size="sm" onClick={() => setConfirming(true)} disabled={runner.busy !== null}>
        {kind === 'buy' ? 'Buy' : 'Bid'} {formatUsdc(price as string)}
      </Button>
    );
  } else {
    const sender = wallet.sender;
    action = (
      <span className={s.confirm}>
        <Button
          variant="primary"
          size="sm"
          busy={busy}
          busyLabel={kind === 'buy' ? 'Buying' : 'Bidding'}
          onClick={() => {
            setConfirming(false);
            void runner.run(
              key,
              kind === 'buy' ? `Buy ${name} for ${formatUsdcExact(price as string)} USDC` : `Bid ${formatUsdcExact(price as string)} USDC on ${name}`,
              async () =>
                kind === 'buy'
                  ? settled(await buyCompany(sender, tokenId, { expected: { ask: ask as string, syncNonce } }), 'Bought')
                  : settled(await bidAuction(sender, tokenId), 'Won the auction'),
            );
          }}
        >
          Pay {formatUsdc(price as string)} USDC
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <>
      <span className={s.action}>{busy ? <Button variant="primary" size="sm" busy busyLabel="Settling" /> : action}</span>
      {runner.outcomes[key] && (
        <div className={s.rowOutcome}>
          <OutcomeView outcome={runner.outcomes[key]} onDismiss={() => runner.clear(key)} />
        </div>
      )}
    </>
  );
}
