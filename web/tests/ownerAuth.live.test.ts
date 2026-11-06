// Live, read-only: the owner-room chain reads against mainnet RPC. nft_token on incorpr.near, the
// holder's access keys, and a full sign-in attempt with a fresh key that the account does not have.
// No transaction is sent.

import { base64 } from '@scure/base';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { ChallengeStore, completeSignIn, jsonRpcOwnerRpc, OwnerAuthError } from '@/lib/ownerAuth';

const RPC = ['https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com'];
const REGISTRY = 'incorpr.near';

async function firstFullAccessKey(accountId: string): Promise<string | null> {
  const res = await fetch(RPC[0] as string, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_access_key_list', finality: 'final', account_id: accountId } }),
  });
  const body = (await res.json()) as { result?: { keys?: { public_key: string; access_key: { permission: unknown } }[] } };
  return body.result?.keys?.find((k) => k.access_key.permission === 'FullAccess')?.public_key ?? null;
}

describe('owner room chain reads (mainnet, read-only)', () => {
  const rpc = jsonRpcOwnerRpc(RPC);

  it('reads the holder of token 1 with the block it was read at', async () => {
    const holder = await rpc.nftOwner(REGISTRY, '1');
    expect(holder.ownerId).toMatch(/\.near$|^[0-9a-f]{64}$/);
    expect(holder.blockHeight).toBeGreaterThan(223_000_000);
    expect(holder.blockHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it('reads a token that does not exist as ownerId null', async () => {
    expect((await rpc.nftOwner(REGISTRY, '999999')).ownerId).toBeNull();
  });

  it("classifies the holder's full access key and a key it does not have", async () => {
    const holder = (await rpc.nftOwner(REGISTRY, '1')).ownerId as string;
    const key = await firstFullAccessKey(holder);
    expect(key).not.toBeNull();
    expect(await rpc.viewAccessKey(holder, key as string)).toBe('FullAccess');
    expect(await rpc.viewAccessKey(holder, KeyPair.fromRandom('ed25519').getPublicKey().toString())).toBeNull();
  });

  it('refuses a valid NEP-413 signature from a key that is not on the holder account', async () => {
    const holder = (await rpc.nftOwner(REGISTRY, '1')).ownerId as string;
    const store = new ChallengeStore();
    const challenge = store.issue({ tokenId: '1', registryId: REGISTRY, network: 'mainnet', recipient: 'localhost:3010', callbackUrl: 'http://localhost:3010/company/1/owner' });
    const keyPair = KeyPair.fromRandom('ed25519');
    const signed = await new KeyPairSigner(keyPair).signNep413Message(holder, { message: challenge.message, recipient: challenge.recipient, nonce: challenge.nonce });
    const attempt = completeSignIn(
      { challengeId: challenge.id, accountId: holder, publicKey: signed.publicKey.toString(), signature: base64.encode(signed.signature) },
      { store, rpc, recipient: 'localhost:3010' },
    );
    await expect(attempt).rejects.toBeInstanceOf(OwnerAuthError);
    await expect(attempt).rejects.toMatchObject({ code: 'key_not_on_account' });
  });
});
