'use client';

// Holder credential: a statement signed by this server's ed25519 key, issued only after the same
// nft_token check as the page. Anyone can verify it with the key at /api/owner/credential-key.

import { useState } from 'react';
import { Button, ButtonLink, CopyButton, KeyValue, Notice } from '../../../ui';
import s from './owner.module.css';

interface SignedCredential {
  credential: { statement: string; block_height: number; block_hash: string; issued_at: string; network: string; registry: string };
  payload: string;
  signature: string;
  public_key: string;
  key_url: string;
  ephemeral_key: boolean;
}

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ready'; doc: SignedCredential; verified: boolean | null }
  | { kind: 'error'; message: string };

function download(doc: SignedCredential, tokenId: string) {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `incorpr-token-${tokenId}-holder-${doc.credential.block_height}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function HolderCredential({ tokenId }: { tokenId: string }) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function issue() {
    setState({ kind: 'busy' });
    try {
      const res = await fetch('/api/owner/credential', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token_id: tokenId }),
        credentials: 'same-origin',
      });
      const json = (await res.json()) as SignedCredential & { error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      // Check the signature against the published key, the way a third party would.
      const check = await fetch('/api/owner/credential-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: json.payload, signature: json.signature, credential: json.credential }),
      })
        .then((r) => r.json() as Promise<{ valid?: boolean }>)
        .catch(() => ({ valid: undefined }));
      setState({ kind: 'ready', doc: json, verified: typeof check.valid === 'boolean' ? check.valid : null });
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <div className={s.stack}>
      <p className={s.controlText}>
        A JSON statement that this account holds the token as of a block height, signed with the server&apos;s ed25519 key. Use it where another app
        asks for proof of holding without a wallet prompt. It is true as of that block only; a buyer of the company gets their own.
      </p>
      <div className={s.actionRow}>
        <Button variant="quiet" onClick={() => void issue()} busy={state.kind === 'busy'} busyLabel="Signing">
          Issue holder credential
        </Button>
        <ButtonLink href="/api/owner/credential-key" variant="secondary" size="sm" external>
          Public key
        </ButtonLink>
      </div>
      {state.kind === 'error' && (
        <Notice tone="error" title="Credential refused">
          <span className={s.wrapMono}>{state.message}</span>
        </Notice>
      )}
      {state.kind === 'ready' && (
        <div className={s.credential}>
          <p className={s.statement}>{state.doc.credential.statement}</p>
          <KeyValue
            items={[
              { label: 'Block hash', value: state.doc.credential.block_hash, mono: true },
              { label: 'Registry', value: `${state.doc.credential.registry} (${state.doc.credential.network})`, mono: true },
              { label: 'Issued', value: state.doc.credential.issued_at, mono: true },
              {
                label: 'Signature',
                value: (
                  <span className={s.inlineCopy}>
                    <span className={s.wrapMono}>{state.doc.signature}</span>
                    <CopyButton value={state.doc.signature} label="signature" />
                  </span>
                ),
              },
              { label: 'Server key', value: state.doc.public_key, mono: true },
              {
                label: 'Check',
                value:
                  state.verified === true
                    ? 'Signature verifies against the published key'
                    : state.verified === false
                      ? 'Signature does not verify against the published key'
                      : 'Could not reach the key route to check',
              },
            ]}
          />
          {state.doc.ephemeral_key && (
            <p className={s.warnSmall}>OWNER_CREDENTIAL_KEY is not set on this server: the key is random for this dev process and ends on restart.</p>
          )}
          <div className={s.actionRow}>
            <Button size="sm" onClick={() => download(state.doc, tokenId)}>
              Download JSON
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
