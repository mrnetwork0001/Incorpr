'use client';

// "Try to rob this company". Links to the /rob walkthrough, and lets the owner of a listed or
// pledged company send a real claim_dividends from their own wallet. The vault checks the freeze
// before the amount, so the refusal names ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN, and the failed
// transaction stays on the explorer.

import { VaultClient } from '@/lib/contracts';
import { useWallet } from '@/lib/wallet';
import { Button, ButtonLink, Glass } from '../../ui';
import type { EncumbranceLabel } from '../../encumbrance-pill';
import s from './cockpit.module.css';
import { formatUsdc } from './format';
import { OutcomeView, useTxRunner } from './tx-runner';

// /rob attacks one house company, bound to the server's attack keys (NEXT_PUBLIC_ROB_COMPANY_ID).
const HOUSE_COMPANY_ID = process.env.NEXT_PUBLIC_ROB_COMPANY_ID || '1';

export interface RobCardProps {
  tokenId: string;
  vault: string;
  ownerId: string;
  label: EncumbranceLabel;
  retainedMicro: string;
}

export function RobCard({ tokenId, vault, ownerId, label, retainedMicro }: RobCardProps) {
  const { accountId, sender } = useWallet();
  const { outcome, run, busy } = useTxRunner();
  const isOwner = accountId !== null && accountId === ownerId;
  const encumbered = label !== 'FREE';
  // Any positive amount reaches the freeze check; the full retained balance is the realistic attempt.
  const amount = BigInt(retainedMicro) > 0n ? retainedMicro : '1';

  function attempt() {
    if (!sender) return;
    void run(`Withdraw ${formatUsdc(amount)} USDC from a ${label} company`, async () => {
      const [result] = await sender.send([new VaultClient(vault).claimDividends(amount)]);
      return {
        hash: result?.txHash ?? null,
        ok: true,
        message: 'The vault accepted the claim. It should not while the company is encumbered; report this with the transaction hash.',
      };
    });
  }

  return (
    <Glass as="aside" lit pad="lg" className={s.robCard} aria-labelledby="rob-title">
      <p className={s.robEyebrow}>Adversarial test</p>
      <h2 id="rob-title" className={s.robTitle}>
        Try to rob this company
      </h2>
      <p className={s.robText}>
        {encumbered
          ? `It is ${label}. The owner's claim, signing and policy rights are frozen in the vault, and the registry refuses transfers.`
          : 'List or pledge it, then try to drain it as the owner, sign a held transaction, or rush the sale. Each attempt is a real transaction with a real error.'}
      </p>
      <ButtonLink href="/rob" full>
        {tokenId === HOUSE_COMPANY_ID ? 'Open the robbery walkthrough' : `Rob the house company (#${HOUSE_COMPANY_ID}) on /rob`}
      </ButtonLink>

      {isOwner && encumbered && (
        <div className={s.robAttempt}>
          <p className={s.mutedSmall}>
            You own this company. Send <span className={s.mono}>claim_dividends</span> for {formatUsdc(amount)} USDC from your wallet and watch the
            vault refuse it.
          </p>
          <Button variant="quiet" onClick={attempt} busy={busy} busyLabel="Sending" full>
            Attempt a withdrawal as the owner
          </Button>
        </div>
      )}
      <OutcomeView outcome={outcome} />
    </Glass>
  );
}
