// Live: reads keys from the real v1.signer-prod.testnet and v1.signer. Nothing is mocked.
// The cross-check uses viem, bitcoinjs-lib and bs58, which share no code with mpcAddresses.ts.

import * as bitcoin from 'bitcoinjs-lib';
import bs58 from 'bs58';
import { publicKeyToAddress } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  compareWithVaultAddresses,
  deriveIntentsKey,
  deriveTreasuryAddresses,
  intentsPath,
  parseSecp256k1Key,
  readDerivedKey,
  treasuryPath,
} from '@/lib/mpcAddresses';

const TESTNET_MPC = 'v1.signer-prod.testnet';
const TESTNET_RPC = 'https://test.rpc.fastnear.com';
const MAINNET_RPC = 'https://free.rpc.fastnear.com';
const VAULT = 'c-1.incorpr.testnet';

function independentAddresses(secp256k1Key: string, ed25519Key: string, network: bitcoin.Network) {
  const xy = bs58.decode(secp256k1Key.slice('secp256k1:'.length));
  expect(xy.length).toBe(64);
  const uncompressed = Buffer.concat([Buffer.from([4]), Buffer.from(xy)]);
  const parity = xy[63]! & 1;
  const compressed = Buffer.concat([Buffer.from([parity ? 3 : 2]), Buffer.from(xy.subarray(0, 32))]);
  return {
    evm: publicKeyToAddress(`0x${uncompressed.toString('hex')}`).toLowerCase(),
    btc: bitcoin.payments.p2wpkh({ pubkey: compressed, network }).address,
    sol: bs58.encode(bs58.decode(ed25519Key.slice('ed25519:'.length))),
  };
}

describe('MPC address derivation, live', () => {
  it('matches independent libraries for a testnet vault', async () => {
    const derived = await deriveTreasuryAddresses(
      { mpcContract: TESTNET_MPC, vaultAccount: VAULT, tokenId: '1', epoch: 0, btcHrp: 'tb' },
      { rpcUrl: TESTNET_RPC },
    );
    const independent = independentAddresses(derived.secp256k1_key, derived.ed25519_key, bitcoin.networks.testnet);
    expect(derived.evm).toBe(independent.evm);
    expect(derived.btc).toBe(independent.btc);
    expect(derived.sol).toBe(independent.sol);
    expect(derived.btc.startsWith('tb1q')).toBe(true);
  });

  it('reproduces the vector in contracts/company-vault/src/chain.rs', async () => {
    // The Rust tests derived these with k256, sha3, ripemd and bech32 from the same live key.
    const derived = await deriveTreasuryAddresses(
      { mpcContract: TESTNET_MPC, vaultAccount: VAULT, tokenId: '1', epoch: 0, btcHrp: 'tb' },
      { rpcUrl: TESTNET_RPC },
    );
    expect(derived.evm).toBe('0x71c759bb341d5a542acdb715dee092cf73e9cbb8');
    expect(derived.btc).toBe('tb1qvwfh0wz4sf04av68ne9aytfdlt96dp30yrtlq7');
    expect(derived.sol).toBe('E3Trc6Kdz6eVN9usuTkcTrycqjSJ7EDC2sQ6rRDsnDSH');
  });

  it('matches independent libraries on mainnet v1.signer, read only', async () => {
    const derived = await deriveTreasuryAddresses(
      { mpcContract: 'v1.signer', vaultAccount: 'c-1.incorpr.near', tokenId: '1', epoch: 0, btcHrp: 'bc' },
      { rpcUrl: MAINNET_RPC },
    );
    const independent = independentAddresses(derived.secp256k1_key, derived.ed25519_key, bitcoin.networks.bitcoin);
    expect(derived.evm).toBe(independent.evm);
    expect(derived.btc).toBe(independent.btc);
    expect(derived.sol).toBe(independent.sol);
    expect(derived.btc.startsWith('bc1q')).toBe(true);
  });

  it('gives different keys per epoch, per vault and for the intents path', async () => {
    const options = { rpcUrl: TESTNET_RPC };
    const [e0, e1, otherVault, intents] = await Promise.all([
      readDerivedKey(TESTNET_MPC, VAULT, treasuryPath('1', 0), 1, options),
      readDerivedKey(TESTNET_MPC, VAULT, treasuryPath('1', 1), 1, options),
      readDerivedKey(TESTNET_MPC, 'c-2.incorpr.testnet', treasuryPath('1', 0), 1, options),
      deriveIntentsKey(TESTNET_MPC, VAULT, '1', options),
    ]);
    expect(new Set([e0, e1, otherVault, intents]).size).toBe(4);
    expect(intentsPath('1')).toBe('incorpr-1-intents');
  });

  it('compares with stored vault addresses field by field', async () => {
    const derived = await deriveTreasuryAddresses(
      { mpcContract: TESTNET_MPC, vaultAccount: VAULT, tokenId: '1', epoch: 0, btcHrp: 'tb' },
      { rpcUrl: TESTNET_RPC },
    );
    expect(compareWithVaultAddresses(derived, { ...derived })).toEqual({ match: true });
    expect(compareWithVaultAddresses(derived, null)).toEqual({ match: false, reason: 'vault_has_no_addresses' });

    const stored = { ...derived, sol: 'SellerControlledAddress' };
    const result = compareWithVaultAddresses(derived, stored);
    expect(result).toEqual({
      match: false,
      reason: 'mismatch',
      mismatches: [{ field: 'sol', derived: derived.sol, vault: 'SellerControlledAddress' }],
    });
  });

  it('rejects a point that is not on the curve', () => {
    const bad = `secp256k1:${bs58.encode(new Uint8Array(64).fill(7))}`;
    expect(() => parseSecp256k1Key(bad)).toThrow();
  });
});
