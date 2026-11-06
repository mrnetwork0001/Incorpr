// Live: real mempool, EVM and Solana reads against network-correct public endpoints. The failure
// paths use a closed local port and an RFC 5737 address, so the fetches genuinely fail.

import { describe, expect, it } from 'vitest';
import {
  checkBtcMempool,
  checkEvmNonce,
  checkFreshness,
  checkIntentsKeys,
  checkSolanaSignatures,
  l1Endpoints,
} from '@/lib/l1FreshnessCheck';
import { deriveTreasuryAddresses } from '@/lib/mpcAddresses';
import type { VaultState } from '@/lib/contracts';

const DEAD = 'http://127.0.0.1:9';
const MAINNET_RPC = 'https://free.rpc.fastnear.com';

const TESTNET = { evm: '0x71c759bb341d5a542acdb715dee092cf73e9cbb8', btc: 'tb1qvwfh0wz4sf04av68ne9aytfdlt96dp30yrtlq7', sol: 'E3Trc6Kdz6eVN9usuTkcTrycqjSJ7EDC2sQ6rRDsnDSH' };

describe('network-correct endpoints', () => {
  it('uses testnet4, the Sepolia family and Solana devnet on testnet', () => {
    const testnet = l1Endpoints('testnet');
    expect(testnet.btcMempool.every((u) => u.includes('testnet4'))).toBe(true);
    expect(testnet.evm.base.rpc).toContain('sepolia');
    expect(testnet.evm.ethereum.rpc).toContain('sepolia');
    expect(testnet.evm.arbitrum.rpc).toContain('sepolia');
    expect(testnet.solanaRpc).toContain('devnet');
  });

  it('answers with the right chain id on each EVM endpoint', async () => {
    const chainId = async (url: string) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      return Number.parseInt(((await res.json()) as { result: string }).result, 16);
    };
    const testnet = l1Endpoints('testnet').evm;
    const mainnet = l1Endpoints('mainnet').evm;
    expect(await chainId(testnet.base.rpc)).toBe(84532);
    expect(await chainId(testnet.ethereum.rpc)).toBe(11155111);
    expect(await chainId(testnet.arbitrum.rpc)).toBe(421614);
    expect(await chainId(mainnet.base.rpc)).toBe(8453);
    expect(await chainId(mainnet.ethereum.rpc)).toBe(1);
    expect(await chainId(mainnet.arbitrum.rpc)).toBe(42161);
  });
});

describe('BTC mempool, live', () => {
  it('reads a real testnet4 mempool list for the vault address', async () => {
    const check = await checkBtcMempool(TESTNET.btc, l1Endpoints('testnet').btcMempool);
    console.log('[btc testnet4]', JSON.stringify(check));
    expect(check.state).toBe('clean');
    expect(check.endpoint).toContain('testnet4');
  });

  it('reads a real mainnet mempool list for a busy address', async () => {
    const check = await checkBtcMempool('bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', l1Endpoints('mainnet').btcMempool);
    console.log('[btc mainnet]', check.endpoint, check.state, check.spendingTxids.length, check.incomingTxids.length);
    expect(['clean', 'dirty']).toContain(check.state);
    expect(check.endpoint).not.toBeNull();
  });

  it('is unavailable, not clean, when every endpoint fails', async () => {
    const check = await checkBtcMempool(TESTNET.btc, [DEAD]);
    expect(check.state).toBe('unavailable');
    expect(check.errors.length).toBe(1);
  });
});

describe('EVM nonces, live', () => {
  it('reads pending and latest on each testnet chain', async () => {
    const endpoints = l1Endpoints('testnet').evm;
    for (const [chain, { name, rpc }] of Object.entries(endpoints)) {
      const check = await checkEvmNonce(chain as 'base', name, rpc, TESTNET.evm);
      console.log('[evm]', name, check.latestNonce, check.pendingNonce, check.state);
      expect(check.latestNonce).toBe(0);
      expect(check.state).toBe('clean');
    }
  });

  it('reads a used nonce from a real mainnet account', async () => {
    const { name, rpc } = l1Endpoints('mainnet').evm.ethereum;
    const check = await checkEvmNonce('ethereum', name, rpc, '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(check.latestNonce).toBeGreaterThan(1000);
    expect(check.pendingNonce).toBeGreaterThanOrEqual(check.latestNonce!);
  });

  it('is unavailable, not clean, when the fetch fails', async () => {
    const check = await checkEvmNonce('base', 'dead', DEAD, TESTNET.evm);
    expect(check.state).toBe('unavailable');
    expect(check.error).toBeTruthy();
  });
});

describe('Solana signatures, live', () => {
  it('finds no recent signatures on the fresh vault address on devnet', async () => {
    const check = await checkSolanaSignatures(TESTNET.sol, l1Endpoints('testnet').solanaRpc);
    console.log('[solana devnet]', JSON.stringify(check));
    expect(check.state).toBe('clean');
    expect(check.recentSignatures).toEqual([]);
  });

  it('flags a busy mainnet program address as recently active, or says it could not read it', async () => {
    const check = await checkSolanaSignatures('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', l1Endpoints('mainnet').solanaRpc);
    console.log('[solana mainnet busy]', check.state, check.recentSignatures.length, check.error);
    expect(['dirty', 'unavailable']).toContain(check.state);
  });

  it('is unavailable, not clean, when the fetch fails', async () => {
    const check = await checkSolanaSignatures(TESTNET.sol, DEAD);
    expect(check.state).toBe('unavailable');
  });
});

describe('intents.near keys, live on mainnet', () => {
  const state = { mpc_contract: 'v1.signer', token_id: '1', intents_contract: 'intents.near', intents_key: null };

  it('is not clean when the account has registered no key', async () => {
    const check = await checkIntentsKeys('c-1.never-deployed-incorpr.near', state, 'mainnet', { rpcUrl: MAINNET_RPC });
    console.log('[intents keys]', JSON.stringify(check));
    expect(check.state).toBe('dirty');
    if (check.state !== 'not_applicable') {
      expect(check.registeredKeys).toEqual([]);
      expect(check.expectedKey).toMatch(/^ed25519:/);
    }
  });

  it('is explicit that testnet has no intents.near', async () => {
    const check = await checkIntentsKeys('c-1.incorpr.testnet', state, 'testnet');
    expect(check.state).toBe('not_applicable');
  });

  it('is unavailable, not clean, when the RPC fails', async () => {
    const check = await checkIntentsKeys('c-1.x.near', state, 'mainnet', { rpcUrl: DEAD });
    expect(check.state).toBe('unavailable');
  });
});

describe('whole report', () => {
  const vault = 'c-1.incorpr.testnet';

  async function stateFor(overrides: Partial<VaultState>): Promise<VaultState> {
    const addresses = await deriveTreasuryAddresses({
      mpcContract: 'v1.signer-prod.testnet',
      vaultAccount: vault,
      tokenId: '1',
      epoch: 0,
      btcHrp: 'tb',
    });
    return {
      token_id: '1',
      mpc_contract: 'v1.signer-prod.testnet',
      btc_hrp: 'tb',
      treasury_epoch: 0,
      addresses,
      raw_sigs_this_epoch: 0,
      latest_intent_deadline_ms: 0,
      intents_contract: 'none',
      intents_key: null,
      ...overrides,
    } as VaultState;
  }

  it('is clean for a fresh testnet vault, from real reads', async () => {
    const report = await checkFreshness(vault, await stateFor({}), 'testnet');
    console.log('[report]', JSON.stringify({ overall: report.overall, dirty: report.dirtyReasons, unavailable: report.unavailableReasons }));
    expect(report.overall).toBe('clean');
    expect(report.vaultChecks.addressesMatchMpc).toEqual({ match: true });
    expect(report.intentsKeys.state).toBe('not_applicable');
    expect(report.evm).toHaveLength(3);
  });

  it('is dirty when the vault has issued raw signatures this epoch', async () => {
    // Dirty takes priority over unavailable, so dead endpoints still give dirty here.
    const report = await checkFreshness(vault, await stateFor({ raw_sigs_this_epoch: 1 }), 'testnet', {
      btcMempool: [DEAD],
      evm: {
        base: { name: 'dead', rpc: DEAD },
        ethereum: { name: 'dead', rpc: DEAD },
        arbitrum: { name: 'dead', rpc: DEAD },
      },
      solanaRpc: DEAD,
    });
    expect(report.overall).toBe('dirty');
    expect(report.dirtyReasons[0]).toMatch(/raw signature/);
  });

  it('is unavailable, never clean, when the L1 endpoints fail', async () => {
    const report = await checkFreshness(vault, await stateFor({}), 'testnet', {
      btcMempool: [DEAD],
      evm: {
        base: { name: 'dead', rpc: DEAD },
        ethereum: { name: 'dead', rpc: DEAD },
        arbitrum: { name: 'dead', rpc: DEAD },
      },
      solanaRpc: DEAD,
    });
    expect(report.overall).toBe('unavailable');
    expect(report.unavailableReasons.length).toBe(5);
  });

  it('is unavailable when the vault has no stored addresses', async () => {
    const report = await checkFreshness(vault, await stateFor({ addresses: null }), 'testnet');
    expect(report.overall).toBe('unavailable');
    expect(report.btc).toBeNull();
  });
});
