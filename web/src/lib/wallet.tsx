'use client';

import type { FinalExecutionOutcome, WalletSelector } from '@near-wallet-selector/core';
import type { WalletSelectorModal } from '@near-wallet-selector/modal-ui';
import '@near-wallet-selector/modal-ui/styles.css';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TxSender } from './actions';
import type { ContractCall } from './contracts';
import { getNetworkConfig } from './near';
import { awaitFinalTransaction, outcomeHash, type TxResult } from './txOutcome';

/** The wallet navigated away to sign. Results arrive as `?transactionHashes=` on return: see `readWalletRedirect`. */
export class WalletRedirectError extends Error {
  constructor() {
    super('The wallet opened its own page to sign. The result is read when it returns to this page.');
    this.name = 'WalletRedirectError';
  }
}

export interface WalletContextValue {
  /** False until the selector has loaded in the browser. */
  ready: boolean;
  /**
   * Set when no browser wallet can sign on this network. MyNearWallet and Meteor sign for mainnet and
   * testnet only; a local sandbox is driven by scripts/demo.mjs or the sandbox tests instead.
   */
  unavailableReason: string | null;
  accountId: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
  /** Signs and sends one contract call from the connected account. Returns the wallet's raw outcome. */
  send: (call: ContractCall) => Promise<FinalExecutionOutcome | void>;
  /**
   * Signs every call in one wallet confirmation, one transaction per call, in order. Resolves when
   * each transaction is FINAL on our RPC, with its hash and return value. Throws
   * `TransactionFailedError` (txOutcome.ts) for the first failed transaction.
   */
  sendCalls: (calls: ContractCall[]) => Promise<TxResult[]>;
  /** For actions.ts. Null until an account is connected. */
  sender: TxSender | null;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const config = getNetworkConfig();
    if (config.network === 'sandbox') {
      setUnavailableReason(
        'Browser wallets do not sign for a local sandbox. Use scripts/demo.mjs --network sandbox, or point the app at testnet or mainnet.',
      );
      return;
    }
    let unsubscribe: (() => void) | undefined;

    // Dynamic imports: these packages read `window` when loaded, which a server render does not have.
    void (async () => {
      const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }, { setupMeteorWallet }] = await Promise.all([
        import('@near-wallet-selector/core'),
        import('@near-wallet-selector/modal-ui'),
        import('@near-wallet-selector/my-near-wallet'),
        import('@near-wallet-selector/meteor-wallet'),
      ]);
      const walletSelector = await setupWalletSelector({
        // Narrowed: the sandbox branch returned above.
        network: config.network === 'mainnet' ? 'mainnet' : 'testnet',
        modules: [setupMyNearWallet(), setupMeteorWallet()],
      });
      if (cancelled) return;

      const activeAccount = () =>
        walletSelector.store.getState().accounts.find((account) => account.active)?.accountId ?? null;
      setAccountId(activeAccount());
      const subscription = walletSelector.store.observable.subscribe(() => setAccountId(activeAccount()));
      unsubscribe = () => subscription.unsubscribe();

      setSelector(walletSelector);
      setModal(setupModal(walletSelector, { contractId: config.registryId ?? '' }));
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const signIn = useCallback(() => modal?.show(), [modal]);

  const signOut = useCallback(async () => {
    if (!selector) return;
    const wallet = await selector.wallet();
    await wallet.signOut();
  }, [selector]);

  const send = useCallback(
    async (call: ContractCall) => {
      if (!selector) throw new Error(unavailableReason ?? 'Wallet selector has not loaded');
      const { actionCreators } = await import('@near-wallet-selector/core');
      const wallet = await selector.wallet();
      return wallet.signAndSendTransaction({
        receiverId: call.contractId,
        actions: [actionCreators.functionCall(call.methodName, call.args, BigInt(call.gas), BigInt(call.deposit))],
      });
    },
    [selector, unavailableReason],
  );

  const sendCalls = useCallback(
    async (calls: ContractCall[]): Promise<TxResult[]> => {
      if (!selector) throw new Error(unavailableReason ?? 'Wallet selector has not loaded');
      if (!accountId) throw new Error('Connect a wallet first');
      if (calls.length === 0) return [];
      const { actionCreators } = await import('@near-wallet-selector/core');
      const wallet = await selector.wallet();
      const outcomes = (await wallet.signAndSendTransactions({
        transactions: calls.map((call) => ({
          receiverId: call.contractId,
          actions: [actionCreators.functionCall(call.methodName, call.args, BigInt(call.gas), BigInt(call.deposit))],
        })),
      })) as FinalExecutionOutcome[] | void;
      if (!outcomes) throw new WalletRedirectError();
      const results: TxResult[] = [];
      for (const outcome of outcomes) {
        results.push(await awaitFinalTransaction(outcomeHash(outcome), accountId));
      }
      return results;
    },
    [selector, accountId, unavailableReason],
  );

  const sender = useMemo<TxSender | null>(
    () => (accountId ? { accountId, send: sendCalls } : null),
    [accountId, sendCalls],
  );

  const value = useMemo(
    () => ({
      ready: selector !== null || unavailableReason !== null,
      unavailableReason,
      accountId,
      signIn,
      signOut,
      send,
      sendCalls,
      sender,
    }),
    [selector, unavailableReason, accountId, signIn, signOut, send, sendCalls, sender],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWallet must be used inside WalletProvider');
  return value;
}

export interface WalletRedirectResult {
  txHashes: string[];
  /** Set when the user rejected in the wallet, or the wallet reported an error. */
  errorCode: string | null;
}

/**
 * Reads the hashes a redirecting wallet appends on return, then removes them from the address bar so
 * a reload does not replay them. Pass each hash to `awaitFinalTransaction` for its result.
 */
export function readWalletRedirect(): WalletRedirectResult | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const hashes = url.searchParams.get('transactionHashes');
  const errorCode = url.searchParams.get('errorCode');
  if (!hashes && !errorCode) return null;
  for (const name of ['transactionHashes', 'errorCode', 'errorMessage']) url.searchParams.delete(name);
  window.history.replaceState(null, '', url.toString());
  return { txHashes: hashes ? hashes.split(',').filter(Boolean) : [], errorCode };
}
