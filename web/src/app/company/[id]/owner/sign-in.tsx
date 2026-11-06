'use client';

// NEP-413 sign-in for the owner room.
//
// 1. POST /api/owner/challenge: the server returns a message naming the token, a 32-byte nonce
//    (single use, 5 minutes) and recipient = the site host from NEXT_PUBLIC_SITE_URL (localhost on a
//    dev server). The server never takes the recipient from a request header.
// 2. The wallet signs it with wallet-selector signMessage. Meteor and MyNearWallet (v10) answer in
//    a popup and resolve with { accountId, publicKey, signature (base64) }. A wallet that redirects
//    instead returns to callback_url with #accountId=..&publicKey=..&signature=..&state=<challenge>.
// 3. POST /api/owner/session: the server verifies the signature, the full access key and nft_token,
//    then sets an HttpOnly cookie. The page re-renders through router.refresh().

import type { WalletSelector } from '@near-wallet-selector/core';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getNetworkConfig } from '@/lib/near';
import { useWallet } from '@/lib/wallet';
import { Button, Notice } from '../../../ui';
import s from './owner.module.css';

interface Challenge {
  challenge_id: string;
  message: string;
  nonce: string;
  recipient: string;
  callback_url: string;
  token_id: string;
  expires_at_ms: number;
}

interface Signed {
  accountId: string;
  publicKey: string;
  signature: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; step: string; challenge?: Challenge }
  | { kind: 'redirect'; challenge: Challenge }
  | { kind: 'error'; title: string; message: string; challenge?: Challenge }
  | { kind: 'done'; accountId: string };

const PENDING_KEY = 'incorpr:owner:pending-challenge';

/**
 * The selector WalletProvider created. setupWalletSelector keeps one instance per page, so this
 * call returns it rather than a second selector. lib/wallet.tsx does not expose signMessage.
 */
async function walletSelector(): Promise<WalletSelector> {
  const config = getNetworkConfig();
  const [{ setupWalletSelector }, { setupMyNearWallet }, { setupMeteorWallet }] = await Promise.all([
    import('@near-wallet-selector/core'),
    import('@near-wallet-selector/my-near-wallet'),
    import('@near-wallet-selector/meteor-wallet'),
  ]);
  return setupWalletSelector({
    network: config.network === 'mainnet' ? 'mainnet' : 'testnet',
    modules: [setupMyNearWallet(), setupMeteorWallet()],
  });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: string } }) | null;
  if (!res.ok || !json) {
    const message = json?.error?.message ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(message), { code: json?.error?.code ?? null, status: res.status });
  }
  return json;
}

/** NEP-413 redirect return: the fields arrive in the URL fragment, or in the query on some wallets. */
function readRedirectReturn(): (Signed & { state: string | null }) | { error: string } | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  for (const [k, v] of url.searchParams) if (!params.has(k)) params.set(k, v);
  const keys = ['accountId', 'publicKey', 'signature', 'state', 'error', 'errorCode', 'errorMessage'];
  if (!keys.some((k) => params.has(k))) return null;
  for (const k of keys) url.searchParams.delete(k);
  url.hash = '';
  window.history.replaceState(null, '', url.toString());
  const error = params.get('error') ?? params.get('errorCode') ?? params.get('errorMessage');
  if (error) return { error };
  const accountId = params.get('accountId');
  const publicKey = params.get('publicKey');
  const signature = params.get('signature');
  if (!accountId || !publicKey || !signature) return { error: 'The wallet returned without a signature.' };
  return { accountId, publicKey, signature, state: params.get('state') };
}

function rememberChallenge(challenge: Challenge) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ id: challenge.challenge_id, token: challenge.token_id, exp: challenge.expires_at_ms }));
  } catch {
    // Storage unavailable: a redirecting wallet still returns the id in `state`.
  }
}

function takeRememberedChallenge(tokenId: string): string | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    localStorage.removeItem(PENDING_KEY);
    const parsed = raw ? (JSON.parse(raw) as { id?: string; token?: string; exp?: number }) : null;
    if (parsed?.id && parsed.token === tokenId && (parsed.exp ?? 0) > Date.now()) return parsed.id;
  } catch {
    // Fall through.
  }
  return null;
}

export interface SignInPanelProps {
  tokenId: string;
  /** nft_token owner_id as of this render. */
  holder: string;
  /** True when the server render found no valid session cookie. */
  signedOut: boolean;
}

export function SignInPanel({ tokenId, holder, signedOut }: SignInPanelProps) {
  const router = useRouter();
  const { ready, accountId, unavailableReason, signIn } = useWallet();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const once = useRef(false);

  const complete = useCallback(
    async (challengeId: string, signed: Signed, challenge?: Challenge) => {
      setStatus({ kind: 'busy', step: 'Checking the signature, the access key and nft_token', challenge });
      try {
        const result = await postJson<{ account_id: string }>('/api/owner/session', {
          challenge_id: challengeId,
          account_id: signed.accountId,
          public_key: signed.publicKey,
          signature: signed.signature,
        });
        setStatus({ kind: 'done', accountId: result.account_id });
        router.refresh();
      } catch (error) {
        setStatus({ kind: 'error', title: 'Sign-in refused', message: error instanceof Error ? error.message : String(error), challenge });
      }
    },
    [router],
  );

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const returned = readRedirectReturn();
    if (returned) {
      const remembered = takeRememberedChallenge(tokenId);
      if ('error' in returned) {
        setStatus({ kind: 'error', title: 'The wallet did not sign', message: returned.error });
        return;
      }
      const challengeId = returned.state ?? remembered;
      if (!challengeId) {
        setStatus({ kind: 'error', title: 'Sign-in could not finish', message: 'The wallet returned a signature but no challenge id. Start again.' });
        return;
      }
      void complete(challengeId, returned);
      return;
    }
    // The cookie is SameSite=Strict, so a page opened from another site renders without it. A
    // same-origin fetch carries it; when that finds a live session, render again with it.
    if (signedOut) {
      void fetch(`/api/owner/session?token_id=${encodeURIComponent(tokenId)}`, { credentials: 'same-origin', cache: 'no-store' })
        .then((res) => {
          if (res.ok) router.refresh();
        })
        .catch(() => undefined);
    }
  }, [complete, router, signedOut, tokenId]);

  async function start() {
    let challenge: Challenge | undefined;
    try {
      setStatus({ kind: 'busy', step: 'Requesting a single-use nonce' });
      challenge = await postJson<Challenge>('/api/owner/challenge', { token_id: tokenId });
      rememberChallenge(challenge);
      setStatus({ kind: 'busy', step: 'Waiting for the wallet to sign the message', challenge });
      const wallet = await (await walletSelector()).wallet();
      const signed = await wallet.signMessage({
        message: challenge.message,
        recipient: challenge.recipient,
        nonce: Buffer.from(challenge.nonce, 'base64'),
        callbackUrl: challenge.callback_url,
        state: challenge.challenge_id,
      });
      if (!signed) {
        // The wallet navigated away. The fragment on return carries the signature.
        setStatus({ kind: 'redirect', challenge });
        return;
      }
      takeRememberedChallenge(tokenId);
      await complete(challenge.challenge_id, signed, challenge);
    } catch (error) {
      takeRememberedChallenge(tokenId);
      setStatus({ kind: 'error', title: 'Sign-in did not finish', message: error instanceof Error ? error.message : String(error), challenge });
    }
  }

  const busy = status.kind === 'busy' || status.kind === 'done';
  const shownChallenge = 'challenge' in status ? status.challenge : undefined;
  const wrongAccount = accountId !== null && accountId !== holder;

  return (
    <div className={s.signIn}>
      <ol className={s.steps}>
        <li>
          Connect the wallet of <span className={s.mono}>{holder}</span>, the account nft_token names now.
        </li>
        <li>Sign a message naming token {tokenId}. It is a NEP-413 message, not a transaction: nothing is sent and no funds move.</li>
        <li>The server checks the ed25519 signature, that the key is a full access key on the account, and that the account still holds the token.</li>
      </ol>

      {unavailableReason ? (
        <Notice tone="info" title="No browser wallet can sign here">
          {unavailableReason}
        </Notice>
      ) : accountId === null ? (
        <div className={s.actionRow}>
          <Button onClick={signIn} disabled={!ready}>
            {ready ? 'Connect wallet' : 'Loading wallets'}
          </Button>
        </div>
      ) : (
        <div className={s.actionRow}>
          <Button onClick={() => void start()} busy={busy} busyLabel={status.kind === 'busy' ? status.step : 'Signed in'}>
            Sign in as {accountId}
          </Button>
          {wrongAccount && (
            <span className={s.warnSmall}>
              The connected wallet is {accountId}, not the holder. The server will refuse it unless the wallet signs as {holder}.
            </span>
          )}
        </div>
      )}

      {shownChallenge && (
        <details className={s.details} open={status.kind === 'busy'}>
          <summary>What the wallet is asked to sign</summary>
          <pre className={s.pre}>{shownChallenge.message}</pre>
          <p className={s.mutedSmall}>
            recipient <span className={s.mono}>{shownChallenge.recipient}</span>, nonce <span className={s.mono}>{shownChallenge.nonce}</span>, expires{' '}
            {new Date(shownChallenge.expires_at_ms).toISOString().slice(11, 19)} UTC
          </p>
        </details>
      )}

      {status.kind === 'redirect' && (
        <Notice tone="info" title="The wallet opened its own page">
          Approve the message there. The wallet returns to this page with the signature, and sign-in finishes here.
        </Notice>
      )}
      {status.kind === 'error' && (
        <Notice tone="error" title={status.title}>
          <span className={s.wrapMono}>{status.message}</span>
        </Notice>
      )}
    </div>
  );
}

export function SignOutButton({ tokenId }: { tokenId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      await fetch(`/api/owner/session?token_id=${encodeURIComponent(tokenId)}`, { method: 'DELETE', credentials: 'same-origin' });
    } finally {
      router.refresh();
      setBusy(false);
    }
  }
  return (
    <Button variant="quiet" size="sm" onClick={() => void signOut()} busy={busy} busyLabel="Signing out">
      Sign out of the room
    </Button>
  );
}
