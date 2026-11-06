// No funds move here. The first test signs offline with a generated key. The second asks the real
// testnet RPC about an account that does not exist, so nothing can be sent. A live transaction needs
// a funded operator account and is not part of this suite.

import { base58 } from '@scure/base';
import { createTransaction, KeyPair, KeyPairSigner, actions, type KeyPairString } from 'near-api-js';
import { afterEach, describe, expect, it } from 'vitest';
import { errorResponse } from '@/lib/api';
import { VaultClient } from '@/lib/contracts';
import { OperatorNotConfiguredError, operatorCall, transactionHash } from '@/lib/operator';

const saved = {
  id: process.env.NEAR_OPERATOR_ACCOUNT_ID,
  key: process.env.NEAR_OPERATOR_PRIVATE_KEY,
};

afterEach(() => {
  if (saved.id === undefined) delete process.env.NEAR_OPERATOR_ACCOUNT_ID;
  else process.env.NEAR_OPERATOR_ACCOUNT_ID = saved.id;
  if (saved.key === undefined) delete process.env.NEAR_OPERATOR_PRIVATE_KEY;
  else process.env.NEAR_OPERATOR_PRIVATE_KEY = saved.key;
});

describe('operator signer', () => {
  it('computes the same transaction hash the signer reports', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const transaction = createTransaction(
      'operator.testnet',
      keyPair.getPublicKey(),
      'c-1.registry.testnet',
      1n,
      [actions.functionCall('record_service_call', { call_id: 'a', tee_chat_id: 'b' }, 40_000_000_000_000n, 0n)],
      new Uint8Array(32).fill(1),
    );
    const signer = new KeyPairSigner(keyPair);
    const { signedTransaction, txHash } = await signer.signTransaction(transaction);
    expect(transactionHash(signedTransaction)).toBe(base58.encode(Uint8Array.from(txHash)));
  });

  it('throws the typed error when the key or account is unset', async () => {
    delete process.env.NEAR_OPERATOR_ACCOUNT_ID;
    delete process.env.NEAR_OPERATOR_PRIVATE_KEY;
    const call = new VaultClient('c-1.registry.testnet').recordServiceCall('a', 'b');
    await expect(operatorCall(call)).rejects.toBeInstanceOf(OperatorNotConfiguredError);
    process.env.NEAR_OPERATOR_ACCOUNT_ID = 'operator.testnet';
    await expect(operatorCall(call)).rejects.toBeInstanceOf(OperatorNotConfiguredError);
  });

  it('maps a real RPC refusal to 503 without printing the key', async () => {
    const secret = KeyPair.fromRandom('ed25519').toString() as KeyPairString;
    process.env.NEAR_OPERATOR_ACCOUNT_ID = 'no-such-operator-for-incorpr-tests.testnet';
    process.env.NEAR_OPERATOR_PRIVATE_KEY = secret;
    const call = new VaultClient('c-1.registry.testnet').recordServiceCall('a', 'b');
    const error = await operatorCall(call).catch((e: unknown) => e);
    const response = errorResponse(error);
    const body = JSON.stringify(await response.json());
    console.log('[operator refusal]', response.status, body);
    expect(response.status).toBe(503);
    expect(body).not.toContain(secret);
  });
});
