import { afterEach, describe, expect, it } from 'vitest';
import { buildSelfDeliveryQuote, buildVaultPaymentQuote, nep141Contract } from '@/lib/intentsQuotes';
import {
  btcAddressUrl,
  evmAddressUrl,
  getNetworkConfig,
  solAddressUrl,
  txExplorerUrl,
  viewFunction,
  NearViewError,
} from '@/lib/near';
import { TransactionFailedError, parseOutcome } from '@/lib/txOutcome';

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('parseOutcome', () => {
  it('returns the hash and the decoded JSON value', () => {
    expect(parseOutcome({ status: { SuccessValue: b64('"7"') }, transaction: { hash: 'H' } })).toEqual({ txHash: 'H', value: '7' });
    expect(parseOutcome({ status: { SuccessValue: '' }, transaction_outcome: { id: 'H2' } })).toEqual({ txHash: 'H2', value: null });
  });

  it('throws TransactionFailedError with the contract error code', () => {
    const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: ERR_TOKEN_ENCUMBERED' } } } };
    const error = (() => {
      try {
        parseOutcome({ status: { Failure: failure }, transaction: { hash: 'H' } });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect((error as TransactionFailedError).reason).toBe('ERR_TOKEN_ENCUMBERED');
    expect((error as TransactionFailedError).txHash).toBe('H');
  });

  it('refuses an outcome that has not finished', () => {
    expect(() => parseOutcome({ status: 'Started', transaction: { hash: 'H' } })).toThrow(TransactionFailedError);
    expect(() => parseOutcome({ status: {}, transaction: { hash: 'H' } })).toThrow(/not finished/);
  });
});

describe('any-token payment quotes', () => {
  const common = {
    dry: false,
    originAsset: 'nep141:wrap.near',
    usdcAsset: 'nep141:usdc.near',
    amount: '1000000',
    refundTo: 'alice.near',
  };

  it('direct: delivers exact USDC to the vault with the vault msg, so ft_on_transfer books it', () => {
    const q = buildVaultPaymentQuote({ ...common, vault: 'c-1.incorpr.near', callId: 'abc' });
    expect(q).toMatchObject({
      swapType: 'EXACT_OUTPUT',
      recipient: 'c-1.incorpr.near',
      recipientType: 'DESTINATION_CHAIN',
      destinationAsset: 'nep141:usdc.near',
      amount: '1000000',
      customRecipientMsg: '{"call_id":"abc"}',
    });
  });

  it('two steps: delivers exact USDC to the payer, with no msg', () => {
    const q = buildSelfDeliveryQuote({ ...common, payer: 'alice.near' });
    expect(q).toMatchObject({ swapType: 'EXACT_OUTPUT', recipient: 'alice.near', recipientType: 'DESTINATION_CHAIN' });
    expect(q.customRecipientMsg).toBeUndefined();
  });

  it('parses nep141 asset ids', () => {
    expect(nep141Contract('nep141:wrap.near')).toBe('wrap.near');
    expect(nep141Contract('1cs_v1:btc:native:coin')).toBeNull();
  });
});

describe('network config', () => {
  const names = ['NEXT_PUBLIC_NEAR_NETWORK', 'NEXT_PUBLIC_NEAR_RPC_URL', 'NEXT_PUBLIC_USDC_CONTRACT_ID'] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('mainnet: fastnear with fallback, v1.signer, intents.near, native USDC, mainnet explorers', () => {
    process.env.NEXT_PUBLIC_NEAR_NETWORK = 'mainnet';
    delete process.env.NEXT_PUBLIC_NEAR_RPC_URL;
    delete process.env.NEXT_PUBLIC_USDC_CONTRACT_ID;
    const config = getNetworkConfig();
    expect(config.rpcUrls).toEqual(['https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com']);
    expect(config.mpcContract).toBe('v1.signer');
    expect(config.intentsContract).toBe('intents.near');
    expect(config.usdcToken).toBe('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
    expect(config.btcHrp).toBe('bc');
    expect(txExplorerUrl('H', config)).toBe('https://nearblocks.io/txns/H');
    expect(btcAddressUrl('bc1q', config)).toBe('https://mempool.space/address/bc1q');
    expect(solAddressUrl('So1', config)).toBe('https://solscan.io/account/So1');
    expect(evmAddressUrl('0xab', config)).toBe('https://basescan.org/address/0xab');
  });

  it('testnet: testnet signer and explorers, no intents contract', () => {
    process.env.NEXT_PUBLIC_NEAR_NETWORK = 'testnet';
    delete process.env.NEXT_PUBLIC_NEAR_RPC_URL;
    const config = getNetworkConfig();
    expect(config.rpcUrl).toBe('https://test.rpc.fastnear.com');
    expect(config.mpcContract).toBe('v1.signer-prod.testnet');
    expect(config.intentsContract).toBeNull();
    expect(config.btcHrp).toBe('tb');
    expect(btcAddressUrl('tb1q', config)).toBe('https://mempool.space/testnet4/address/tb1q');
    expect(solAddressUrl('So1', config)).toBe('https://solscan.io/account/So1?cluster=devnet');
    expect(evmAddressUrl('0xab', config)).toBe('https://sepolia.basescan.org/address/0xab');
  });

  it('an explicit RPC URL replaces the defaults, with no fallback', () => {
    process.env.NEXT_PUBLIC_NEAR_NETWORK = 'mainnet';
    process.env.NEXT_PUBLIC_NEAR_RPC_URL = 'http://127.0.0.1:1';
    expect(getNetworkConfig().rpcUrls).toEqual(['http://127.0.0.1:1']);
  });

  it('a view that cannot reach any endpoint reports an rpc failure', async () => {
    process.env.NEXT_PUBLIC_NEAR_RPC_URL = 'http://127.0.0.1:1';
    const error = await viewFunction('a.near', 'm').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NearViewError);
    expect((error as NearViewError).failure).toBe('rpc');
  });
});
