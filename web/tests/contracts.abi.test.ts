// Checks every client method against the ABI cargo-near generated from the deployed contract code,
// so a renamed method or argument fails here rather than on-chain. Also checks coverage: every
// public method in the ABI is either wrapped by the client or listed below as contract-only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const viewed: { contractId: string; method: string; args: Record<string, unknown> }[] = [];

vi.mock('@/lib/near', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/near')>();
  return {
    ...original,
    viewFunction: async (contractId: string, method: string, args: Record<string, unknown> = {}) => {
      viewed.push({ contractId, method, args });
      return null;
    },
  };
});

const { RegistryClient, VaultClient, ftCalls, usdcCalls, SIGNATURE_DEPOSIT } = await import('@/lib/contracts');
type ContractCall = import('@/lib/contracts').ContractCall;

interface AbiFunction {
  name: string;
  kind: 'view' | 'call';
  modifiers?: string[];
  params?: { args: { name: string }[] };
}

function abi(file: string): Map<string, AbiFunction> {
  const parsed = JSON.parse(readFileSync(path.resolve(__dirname, '../../contracts/res', file), 'utf8')) as {
    body: { functions: AbiFunction[] };
  };
  return new Map(parsed.body.functions.map((f) => [f.name, f]));
}

function expectMatches(functions: Map<string, AbiFunction>, call: ContractCall): void {
  const fn = functions.get(call.methodName);
  expect(fn, `${call.methodName} is in the ABI`).toBeDefined();
  expect(fn?.kind).toBe('call');
  expect(fn?.modifiers ?? []).not.toContain('private');
  expect(Object.keys(call.args).sort()).toEqual((fn?.params?.args ?? []).map((a) => a.name).sort());
  if (call.deposit !== '0') expect(fn?.modifiers ?? []).toContain('payable');
  expect(BigInt(call.gas)).toBeLessThanOrEqual(300_000_000_000_000n);
}

function expectViewMatches(functions: Map<string, AbiFunction>, method: string, args: Record<string, unknown>): void {
  const fn = functions.get(method);
  expect(fn, `${method} is in the ABI`).toBeDefined();
  expect(fn?.kind).toBe('view');
  expect(Object.keys(args).sort()).toEqual((fn?.params?.args ?? []).map((a) => a.name).sort());
}

/** Public in the ABI, but only a contract can call them, so the client does not wrap them. */
const CONTRACT_ONLY = {
  registry: ['ft_on_transfer', 'report_metrics', 'contract_source_metadata'],
  vault: ['ft_on_transfer', 'sync_owner', 'begin_transit', 'apply_encumbrance', 'contract_source_metadata'],
};

function publicMethods(functions: Map<string, AbiFunction>): string[] {
  return [...functions.values()]
    .filter((f) => !(f.modifiers ?? []).some((m) => m === 'private' || m === 'init'))
    .map((f) => f.name)
    .sort();
}

const swap = { sell_token: 'a', sell_amount: '1', buy_token: 'b', min_buy_amount: '1', nonce_b64: 'x' };
const withdraw = { token: 'a', amount: '1', destination: 'd', chain: 'btc' as const, nonce_b64: 'x' };
const tee = { text: 't', signature_hex: 's', response_body: 'r', system_prompt: 'p' };

describe('registry client matches its ABI', () => {
  const functions = abi('incorpr_registry_abi.json');
  const r = new RegistryClient('registry.test.near');
  const calls: ContractCall[] = [
    r.incorporateCompany(
      {
        name: 'n',
        service_template: 's',
        price_micro_usdc: '1',
        target_bps: [10_000, 0, 0],
        founder_royalty_bps: 0,
        compute_reserve_bps: 100,
      },
      '1',
    ),
    r.listCompany('1', '1'),
    r.unlistCompany('1'),
    r.acceptOffer(1),
    r.cancelOffer(1),
    r.startAuction('1'),
    r.claimDefaultedCollateral('1'),
    r.withdrawPending(),
    r.resyncVaultOwner('1'),
    r.nftTransfer('a.near', '1'),
    r.nftTransferCall('a.near', '1', 'm'),
    r.nftTransferPayout('a.near', '1', '1'),
    r.nftApprove('1', 'a.near'),
    r.nftRevoke('1', 'a.near'),
    r.nftRevokeAll('1'),
    r.storageDeposit('1'),
    r.storageWithdraw('1'),
    r.storageUnregister(),
    r.setDefaultPolicy({
      default_operator: 'o.near',
      compute_payee: 'p.near',
      allowed_tokens: [],
      epoch_caps: [],
      tee_signers: [],
      tee_models: [],
      tee_prompt_hash: '',
      price_floors: [],
    }),
  ];

  it.each(calls.map((call) => [call.methodName, call] as const))('%s', (_name, call) => {
    expectMatches(functions, call);
  });

  it('attaches exactly 1 yoctoNEAR where the registry calls assert_one_yocto', () => {
    // From incorpr-registry/src/lib.rs: each of these starts with assert_one_yocto().
    const oneYocto = [
      r.listCompany('1', '1'),
      r.unlistCompany('1'),
      r.acceptOffer(1),
      r.cancelOffer(1),
      r.claimDefaultedCollateral('1'),
      r.withdrawPending(),
      r.nftTransfer('a.near', '1'),
      r.nftTransferCall('a.near', '1', 'm'),
      r.nftTransferPayout('a.near', '1', '1'),
      r.nftRevoke('1', 'a.near'),
      r.nftRevokeAll('1'),
      r.storageWithdraw(),
      r.storageUnregister(),
    ];
    for (const call of oneYocto) expect(call.deposit, call.methodName).toBe('1');
    expect(r.startAuction('1').deposit).toBe('0');
    expect(r.resyncVaultOwner('1').deposit).toBe('0');
  });

  it('gives incorporate_company and the market calls a full 300 TGas', () => {
    for (const call of [r.listCompany('1', '1'), r.unlistCompany('1'), r.acceptOffer(1), r.claimDefaultedCollateral('1')]) {
      expect(call.gas, call.methodName).toBe('300000000000000');
    }
    expect(r.incorporateCompany({} as never, '1').gas).toBe('300000000000000');
  });

  it('reads every view with the ABI argument names', async () => {
    viewed.length = 0;
    await Promise.all([
      r.getCompany('1'),
      r.listCompanies(),
      r.getOffers('1'),
      r.getLoan('1'),
      r.getListing('1'),
      r.auctionPrice('1'),
      r.pendingWithdrawal('a.near'),
      r.incorporationCost(),
      r.offerStorageCost(),
      r.storageBalanceOf('a.near'),
      r.storageBalanceBounds(),
      r.nftMetadata(),
      r.nftSupplyForOwner('a.near'),
      r.nftIsApproved('1', 'a.near'),
      r.nftToken('1'),
      r.nftTotalSupply(),
      r.nftTokens(),
      r.nftTokensForOwner('a.near'),
      r.nftPayout('1', '1'),
    ]);
    for (const view of viewed) expectViewMatches(functions, view.method, view.args);
    const wrapped = new Set([...calls.map((c) => c.methodName), ...viewed.map((v) => v.method), ...CONTRACT_ONLY.registry]);
    expect(publicMethods(functions).filter((name) => !wrapped.has(name))).toEqual([]);
  });
});

describe('vault client matches its ABI', () => {
  const functions = abi('company_vault_abi.json');
  const v = new VaultClient('c-1.registry.test.near');
  const calls: ContractCall[] = [
    v.recordServiceCall('c', 't'),
    v.payComputeBill('1'),
    v.agentDepositToIntents('1'),
    v.agentSwapIntent(swap, tee),
    v.agentWithdrawIntent(withdraw, tee),
    v.claimDividends('1'),
    v.requestShareholderSignature(0, 'aa', 'treasury'),
    v.signLegacyEpoch(0, 0, 'aa', 'treasury'),
    v.rotateTreasuryEpoch(),
    v.setOperator('a.near'),
    v.setTeeSigners([]),
    v.setPolicy([], []),
    v.setTeePolicy([], ''),
    v.setPriceFloors([]),
    v.refreshTreasuryKeys(),
    v.setupIntentsKey(),
    v.refreshMetrics(),
  ];

  it.each(calls.map((call) => [call.methodName, call] as const))('%s', (_name, call) => {
    expectMatches(functions, call);
  });

  it('attaches the deposit each shareholder method asserts', () => {
    for (const call of [
      v.claimDividends('1'),
      v.rotateTreasuryEpoch(),
      v.setOperator('a.near'),
      v.setTeeSigners([]),
      v.setPolicy([], []),
      v.setTeePolicy([], ''),
      v.setPriceFloors([]),
    ]) {
      expect(call.deposit, call.methodName).toBe('1');
    }
    // The vault forwards the whole deposit to the signer and requires at least 1 yoctoNEAR.
    expect(v.requestShareholderSignature(0, 'aa', 'treasury').deposit).toBe(SIGNATURE_DEPOSIT);
    expect(v.requestShareholderSignature(0, 'aa', 'treasury', '5').deposit).toBe('5');
    expect(v.requestShareholderSignature(0, 'aa', 'treasury').gas).toBe('300000000000000');
    // Operator and permissionless methods take no deposit.
    for (const call of [v.recordServiceCall('c', 't'), v.agentSwapIntent(swap, tee), v.refreshTreasuryKeys()]) {
      expect(call.deposit, call.methodName).toBe('0');
    }
  });

  it('reads every view with the ABI argument names', async () => {
    viewed.length = 0;
    await Promise.all([
      v.getState(),
      v.getPayment('c'),
      v.treasuryAddresses(),
      v.revenue30d(),
      v.paymentStats(),
      v.swapTeeRequest(swap, 'm', 'p'),
      v.withdrawTeeRequest(withdraw, 'm', 'p'),
    ]);
    for (const view of viewed) expectViewMatches(functions, view.method, view.args);
    const wrapped = new Set([...calls.map((c) => c.methodName), ...viewed.map((x) => x.method), ...CONTRACT_ONLY.vault]);
    expect(publicMethods(functions).filter((name) => !wrapped.has(name))).toEqual([]);
  });
});

describe('NEP-141 messages', () => {
  it('use the shapes the vault and registry parse', () => {
    expect(usdcCalls.payForService('u', 'v', '1', 'id').args.msg).toBe('{"call_id":"id"}');
    expect(usdcCalls.acquire('u', 'r', '1', '7', 3).args.msg).toBe(
      '{"action":"acquire","token_id":"7","expected_sync_nonce":3}',
    );
    expect(usdcCalls.fundOffer('u', 'r', '1', '7', '2', 100).args.msg).toBe(
      '{"action":"fund_offer","token_id":"7","repay_amount":"2","term_ms":100}',
    );
    expect(
      usdcCalls.fundOffer('u', 'r', '1', '7', '2', 100, { min_retained: '5', required_epoch: null }).args.msg,
    ).toBe('{"action":"fund_offer","token_id":"7","repay_amount":"2","term_ms":100,"terms":{"min_retained":"5","required_epoch":null}}');
    expect(usdcCalls.repay('u', 'r', '1', '7').args.msg).toBe('{"action":"repay","token_id":"7"}');
    expect(usdcCalls.bid('u', 'r', '1', '7').args.msg).toBe('{"action":"bid","token_id":"7"}');
  });

  it('ft_transfer_call and ft_transfer attach 1 yoctoNEAR, storage_deposit registers only', () => {
    const pay = usdcCalls.payForService('u', 'v', '1', 'id');
    expect(pay).toMatchObject({ methodName: 'ft_transfer_call', deposit: '1', gas: '300000000000000' });
    expect(Object.keys(pay.args).sort()).toEqual(['amount', 'msg', 'receiver_id']);
    expect(ftCalls.ftTransfer('t', 'r', '1')).toMatchObject({ methodName: 'ft_transfer', deposit: '1' });
    expect(ftCalls.storageDeposit('t', 'a.near', '1250000000000000000000')).toMatchObject({
      methodName: 'storage_deposit',
      args: { account_id: 'a.near', registration_only: true },
      deposit: '1250000000000000000000',
    });
  });
});
