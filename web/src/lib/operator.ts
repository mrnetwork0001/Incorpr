import 'server-only';

import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { Account, actions, type KeyPairString } from 'near-api-js';
import type { ContractCall } from './contracts';
import { ConfigError, getProvider } from './near';
import { TransactionFailedError, failureReason } from './txOutcome';

export class OperatorNotConfiguredError extends ConfigError {
  constructor(variable: string) {
    super(`${variable} is not set, so this server cannot send operator transactions`);
    this.name = 'OperatorNotConfiguredError';
  }
}

/** The transaction was never accepted: no key on chain, a stale nonce, or an RPC failure. */
export class OperatorUnavailableError extends Error {
  constructor(detail: string) {
    super(`Operator could not send the transaction: ${detail}`);
    this.name = 'OperatorUnavailableError';
  }
}

// One class for wallet and operator failures, so callers need a single instanceof check.
export { TransactionFailedError };

export class TransactionPendingError extends Error {
  constructor(readonly txHash: string) {
    super(`Transaction ${txHash} was sent but has not finished. Check it on the explorer.`);
    this.name = 'TransactionPendingError';
  }
}

export function operatorAccountId(): string {
  const id = process.env.NEAR_OPERATOR_ACCOUNT_ID;
  if (!id) throw new OperatorNotConfiguredError('NEAR_OPERATOR_ACCOUNT_ID');
  return id;
}

function operatorAccount(): Account {
  const key = process.env.NEAR_OPERATOR_PRIVATE_KEY;
  if (!key) throw new OperatorNotConfiguredError('NEAR_OPERATOR_PRIVATE_KEY');
  return new Account(operatorAccountId(), getProvider(), key as KeyPairString);
}

interface OutcomeStatus {
  SuccessValue?: string;
  SuccessReceiptId?: string;
  Failure?: unknown;
}

export interface OperatorCallResult<T> {
  txHash: string;
  value: T | null;
}


// One key, one nonce sequence: concurrent sends from this process would collide.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

const POLL_INTERVAL_MS = 1_500;

/** NEAR's transaction hash: sha256 of the borsh-encoded transaction, in base58. */
export function transactionHash(signed: { transaction: { encode(): Uint8Array } }): string {
  return base58.encode(sha256(signed.transaction.encode()));
}

/**
 * Signs locally, broadcasts without waiting, then polls by hash. `sign` can outlast an RPC request
 * timeout, and this keeps the hash available whatever the RPC does.
 *
 * Resolves once the transaction is FINAL by default, so a view at `final` finality made after it
 * returns sees its effects. `EXECUTED_OPTIMISTIC` returns about two blocks sooner.
 */
export async function operatorCall<T = unknown>(
  contractCall: ContractCall,
  {
    timeoutMs = 180_000,
    waitUntil = 'FINAL',
  }: { timeoutMs?: number; waitUntil?: 'FINAL' | 'EXECUTED_OPTIMISTIC' } = {},
): Promise<OperatorCallResult<T>> {
  const account = operatorAccount();
  const provider = getProvider();

  const { txHash, signerId } = await serialized(async () => {
    try {
      const signed = await account.createSignedTransaction({
        receiverId: contractCall.contractId,
        actions: [
          actions.functionCall(
            contractCall.methodName,
            contractCall.args,
            BigInt(contractCall.gas),
            BigInt(contractCall.deposit),
          ),
        ],
      });
      const hash = transactionHash(signed);
      await provider.sendTransactionAsync(signed);
      return { txHash: hash, signerId: signed.transaction.signerId };
    } catch (error) {
      throw new OperatorUnavailableError(error instanceof Error ? error.message : String(error));
    }
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let status: OutcomeStatus | string;
    try {
      const response = await provider.viewTransactionStatus({
        txHash,
        accountId: signerId,
        waitUntil,
      });
      status = response.status as OutcomeStatus | string;
    } catch {
      // The node has not seen the transaction yet, or its wait timed out. Both resolve on a later poll.
      continue;
    }
    if (typeof status === 'string') continue;
    if (status.Failure !== undefined) {
      throw new TransactionFailedError(txHash, failureReason(status.Failure));
    }
    if (status.SuccessValue !== undefined) {
      const raw = Buffer.from(status.SuccessValue, 'base64').toString();
      return { txHash, value: raw ? (JSON.parse(raw) as T) : null };
    }
  }
  throw new TransactionPendingError(txHash);
}
