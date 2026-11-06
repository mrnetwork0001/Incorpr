// The failed-receipt parser, the sandbox network config and the pre-send checks in actions.ts.
// No network.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionRefusedError, describeActionError, validateIncorporate } from '@/lib/actions';
import {
  ConfigError,
  addressExplorerUrl,
  getNetworkConfig,
  transactionExplorerUrl,
  txExplorerUrl,
} from '@/lib/near';
import {
  CONTRACT_ERRORS,
  TransactionFailedError,
  describeContractError,
  parseOutcome,
  type OutcomeLike,
} from '@/lib/txOutcome';

const b64 = (text: string) => Buffer.from(text).toString('base64');
const panic = (message: string) => ({
  ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${message}` } } },
});

function rustErrorCodes(): string[] {
  const roots = ['incorpr-registry/src', 'company-vault/src', 'test-doubles/test-usdc/src'];
  const codes = new Set<string>();
  for (const root of roots) {
    const dir = path.resolve(__dirname, '../../contracts', root);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.rs'))) {
      for (const match of readFileSync(path.join(dir, file), 'utf8').matchAll(/"(ERR_[A-Z0-9_]+)"/g)) codes.add(match[1] as string);
    }
  }
  return [...codes].sort();
}

describe('contract error sentences', () => {
  it('cover every ERR_ code the contracts can return, and nothing else', () => {
    const rust = rustErrorCodes();
    expect(rust.length).toBeGreaterThan(100);
    expect(rust.filter((code) => !(code in CONTRACT_ERRORS))).toEqual([]);
    expect(Object.keys(CONTRACT_ERRORS).filter((code) => !rust.includes(code))).toEqual([]);
  });

  it('are one plain sentence each, without hype words or absolute claims', () => {
    for (const [code, sentence] of Object.entries(CONTRACT_ERRORS)) {
      expect(sentence, code).toMatch(/^[A-Z0-9"'(`].*\.$/);
      expect(sentence, code).not.toMatch(/seamless|revolution|unlock|impossible|guarantee/i);
    }
  });
});

describe('describeContractError', () => {
  it('reads the ERR_ code out of a receipt failure', () => {
    expect(describeContractError(panic('ERR_TOKEN_ENCUMBERED'))).toMatchObject({
      code: 'ERR_TOKEN_ENCUMBERED',
      kind: 'contract',
      message: CONTRACT_ERRORS.ERR_TOKEN_ENCUMBERED,
    });
  });

  it('keeps an unknown ERR_ code with a generic sentence', () => {
    expect(describeContractError('ERR_SOMETHING_NEW')).toMatchObject({ code: 'ERR_SOMETHING_NEW', kind: 'contract' });
  });

  it('names NEP-141 and runtime failures that carry no ERR_ code', () => {
    expect(describeContractError(panic('Requires attached deposit of exactly 1 yoctoNEAR')).message).toMatch(/exactly 1 yoctoNEAR/);
    expect(describeContractError(panic("The account doesn't have enough balance"))).toMatchObject({ code: null, kind: 'chain' });
    expect(describeContractError(panic('The account bob.near is not registered')).message).toMatch(/storage deposit/);
    expect(describeContractError({ ActionError: { kind: { FunctionCallError: { ExecutionError: 'Exceeded the prepaid gas.' } } } }).message).toMatch(
      /gas/,
    );
    expect(describeContractError({ InvalidTxError: { NotEnoughBalance: {} } }).message).toMatch(/NEAR/);
  });

  it('reports a wallet rejection as rejected, not as a contract failure', () => {
    expect(describeContractError(new Error('User rejected the request'))).toMatchObject({ kind: 'rejected', code: null });
  });
});

describe('parseOutcome on real outcome shapes', () => {
  it('reports the root cause: the vault code, not the registry follow-up', () => {
    // list_company on a dirty epoch: the vault's apply_encumbrance panics, then the registry
    // callback fails visibly with ERR_VAULT_FREEZE_FAILED.
    const outcome: OutcomeLike = {
      status: { Failure: panic('ERR_VAULT_FREEZE_FAILED') },
      transaction: { hash: 'H' },
      receipts_outcome: [
        { id: 'r0', outcome: { logs: [], status: { SuccessReceiptId: 'r1' } } },
        { id: 'r1', outcome: { logs: [], status: { Failure: panic('ERR_RAW_SIGNATURES_THIS_EPOCH') } } },
        { id: 'r2', outcome: { logs: [], status: { SuccessReceiptId: 'r3' } } },
        { id: 'r3', outcome: { logs: [], status: { Failure: panic('ERR_VAULT_FREEZE_FAILED') } } },
      ],
    };
    const error = (() => {
      try {
        parseOutcome(outcome);
      } catch (e) {
        return e;
      }
    })() as TransactionFailedError;
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.code).toBe('ERR_RAW_SIGNATURES_THIS_EPOCH');
    expect(error.reason).toBe('ERR_RAW_SIGNATURES_THIS_EPOCH');
    expect(error.error.message).toMatch(/Rotate the treasury epoch/);
    expect(error.txHash).toBe('H');
  });

  it('a refunded ft_transfer_call succeeds, and carries the logged refusal', () => {
    const result = parseOutcome({
      status: { SuccessValue: b64('"0"') },
      transaction: { hash: 'H' },
      receipts_outcome: [
        { outcome: { logs: [], status: { SuccessReceiptId: 'x' } } },
        { outcome: { logs: ['ERR_LISTING_CHANGED'], status: { SuccessValue: b64('"50000000"') } } },
        { outcome: { logs: ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer"}'], status: { SuccessValue: '' } } },
      ],
    });
    expect(result.value).toBe('0');
    expect(result.refusal).toMatchObject({ code: 'ERR_LISTING_CHANGED', message: CONTRACT_ERRORS.ERR_LISTING_CHANGED });
  });

  it('an ordinary success has no refusal field', () => {
    expect(parseOutcome({ status: { SuccessValue: '' }, transaction: { hash: 'H' }, receipts_outcome: [] })).toEqual({ txHash: 'H', value: null });
  });
});

describe('describeActionError', () => {
  it('gives one shape for refusals, failed transactions and anything else', () => {
    expect(describeActionError(new ActionRefusedError('Company 1 is not listed', 'ERR_TOKEN_NOT_LISTED'))).toEqual({
      code: 'ERR_TOKEN_NOT_LISTED',
      message: 'Company 1 is not listed',
      kind: 'contract',
      raw: 'Company 1 is not listed',
      txHash: null,
    });
    expect(describeActionError(new TransactionFailedError('H', 'ERR_NO_LOAN'))).toMatchObject({ code: 'ERR_NO_LOAN', txHash: 'H' });
    expect(describeActionError(new Error('fetch failed'))).toMatchObject({ code: null, kind: 'unknown', txHash: null });
  });
});

describe('validateIncorporate mirrors the registry checks', () => {
  const ok = {
    name: 'Acme Translate',
    service_template: 'Translate the text you receive.',
    price_micro_usdc: '20000',
    target_bps: [5000, 2500, 2500] as [number, number, number],
    founder_royalty_bps: 100,
    compute_reserve_bps: 1000,
  };
  it.each([
    [{}, null],
    [{ name: '' }, 'ERR_INVALID_NAME'],
    [{ name: 'x'.repeat(65) }, 'ERR_INVALID_NAME'],
    [{ name: 'é'.repeat(33) }, 'ERR_INVALID_NAME'],
    [{ name: 'a\nb' }, 'ERR_INVALID_NAME'],
    [{ service_template: '' }, 'ERR_INVALID_SERVICE'],
    [{ price_micro_usdc: '0' }, 'ERR_INVALID_PRICE'],
    [{ price_micro_usdc: '1.5' }, 'ERR_INVALID_PRICE'],
    [{ founder_royalty_bps: 1001 }, 'ERR_INVALID_ROYALTY'],
    [{ compute_reserve_bps: 99 }, 'ERR_INVALID_RESERVE'],
    [{ target_bps: [5000, 5000, 1] }, 'ERR_INVALID_TARGET_ALLOCATION'],
  ])('%j -> %s', (patch, code) => {
    expect(validateIncorporate({ ...ok, ...patch } as typeof ok)).toBe(code);
  });
});

describe('sandbox network config and explorer links', () => {
  const names = ['NEXT_PUBLIC_NEAR_NETWORK', 'NEXT_PUBLIC_NEAR_RPC_URL', 'NEXT_PUBLIC_MPC_CONTRACT_ID'] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('sandbox: local RPC, test doubles, no NEAR explorer, test-network L1 explorers', () => {
    process.env.NEXT_PUBLIC_NEAR_NETWORK = 'sandbox';
    delete process.env.NEXT_PUBLIC_NEAR_RPC_URL;
    delete process.env.NEXT_PUBLIC_MPC_CONTRACT_ID;
    const config = getNetworkConfig();
    expect(config.rpcUrls).toEqual(['http://127.0.0.1:32123']);
    expect(config).toMatchObject({
      mpcContract: 'mpc.test.near',
      intentsContract: 'intents.test.near',
      usdcToken: 'usdc.test.near',
      btcHrp: 'tb',
      explorerUrl: null,
    });
    expect(() => txExplorerUrl('H', config)).toThrow(ConfigError);
    expect(transactionExplorerUrl('near', 'H', config)).toBeNull();
    expect(addressExplorerUrl('near', 'a.test.near', config)).toBeNull();
    expect(addressExplorerUrl('btc', 'tb1q', config)).toBe('https://mempool.space/testnet4/address/tb1q');
    expect(transactionExplorerUrl('sol', 'sig', config)).toBe('https://solscan.io/tx/sig?cluster=devnet');
    expect(transactionExplorerUrl('evm', '0x1', config)).toBe('https://sepolia.basescan.org/tx/0x1');
  });

  it('mainnet and testnet: one link helper per chain and target', () => {
    process.env.NEXT_PUBLIC_NEAR_NETWORK = 'mainnet';
    const main = getNetworkConfig();
    expect(transactionExplorerUrl('near', 'H', main)).toBe('https://nearblocks.io/txns/H');
    expect(addressExplorerUrl('near', 'c-1.incorpr.near', main)).toBe('https://nearblocks.io/address/c-1.incorpr.near');
    expect(transactionExplorerUrl('btc', 'txid', main)).toBe('https://mempool.space/tx/txid');
    expect(addressExplorerUrl('sol', 'So1', main)).toBe('https://solscan.io/account/So1');
    expect(transactionExplorerUrl('evm', '0x1', main)).toBe('https://basescan.org/tx/0x1');
    process.env.NEXT_PUBLIC_NEAR_NETWORK = 'testnet';
    const test = getNetworkConfig();
    expect(transactionExplorerUrl('near', 'H', test)).toBe('https://testnet.nearblocks.io/txns/H');
    expect(transactionExplorerUrl('btc', 'txid', test)).toBe('https://mempool.space/testnet4/tx/txid');
  });

  it('refuses an unknown network name', () => {
    process.env.NEXT_PUBLIC_NEAR_NETWORK = 'localnet';
    expect(() => getNetworkConfig()).toThrow(/mainnet, testnet or sandbox/);
  });
});
