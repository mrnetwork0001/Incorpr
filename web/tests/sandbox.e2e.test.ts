// End to end against a local near-sandbox chain, running the compiled contracts in contracts/res.
//
// SANDBOX LIMITS, stated plainly:
// - Signing goes through contracts/test-doubles/mpc-signer, not the MPC network.
// - intents.near is contracts/test-doubles/intents, which does not settle.
// - The "TEE" signature comes from a key generated in this test. It exercises the vault's verifier
//   and the operator path. It is not evidence about any TEE: see nearAiTee.live.test.ts for that.
// The 1Click quote and the L1 reads in this file are real.

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as rebalancePost } from '@/app/api/rebalance/route';
import { POST as runServicePost } from '@/app/api/run-service/route';
import { POST as verifyPost } from '@/app/api/verify-l1/route';
import {
  RegistryClient,
  VaultClient,
  serviceCallId,
  usdcCalls,
  type CompanyView,
  type ContractCall,
  type SignedIntent,
  type SwapProposal,
  type VaultState,
} from '@/lib/contracts';
import { checkFreshness } from '@/lib/l1FreshnessCheck';
import { checkVaultAddresses } from '@/lib/mpcAddresses';
import { getProvider } from '@/lib/near';
import { NotAVaultError, assertRecipientIsVault, intentsBalance, randomNonce } from '@/lib/nearIntents';
import { sha256Hex } from '@/lib/nearAiTee';
import { TransactionFailedError, operatorCall } from '@/lib/operator';
import { TREASURY_SYSTEM_PROMPT, buildSwapTeeRequest, parseApproval, treasuryPromptHash } from '@/lib/rebalance';
import { chain, findSandboxBinary, startSandbox, type Sandbox } from './sandboxHarness';

const binary = findSandboxBinary();
const MODEL = 'Qwen/Qwen3-VL-30B-A3B-Instruct';
const USDC = 'usdc.test.near';
const USDC_ASSET = `nep141:${USDC}`;
const BTC_ASSET = 'nep141:btc.omft.near';
const SOL_ASSET = 'nep141:sol.omft.near';
const REGISTRY = 'registry.test.near';
const VAULT = `c-1.${REGISTRY}`;
const OPERATOR = 'operator.test.near';
const CUSTOMER = 'customer.test.near';
const FOUNDER = 'founder.test.near';
const INPUT = 'Translate hello to French.';
const SALT = 'sandbox-salt-0123456789';
const CALL_ID = serviceCallId(INPUT, SALT);

let sandbox: Sandbox | undefined;
let send: ReturnType<typeof chain>['send'];
let raw: ReturnType<typeof chain>['raw'];
let createAccount: ReturnType<typeof chain>['createAccount'];
const envNames = [
  'NEXT_PUBLIC_NEAR_RPC_URL',
  'NEXT_PUBLIC_REGISTRY_CONTRACT_ID',
  'NEXT_PUBLIC_NEAR_NETWORK',
  'NEAR_OPERATOR_ACCOUNT_ID',
  'NEAR_OPERATOR_PRIVATE_KEY',
  'NEAR_AI_API_KEY',
];
const savedEnv: Record<string, string | undefined> = {};
const teeAccount = privateKeyToAccount(generatePrivateKey());

function post(url: string, body: unknown, ip: string): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(body),
  });
}

/** Signs the way a model TEE does, with a local key. A vault that lists this key accepts it. */
async function localTeeProof(proposal: SwapProposal, state: Pick<VaultState, 'treasury_epoch' | 'owner_generation'>) {
  const request = buildSwapTeeRequest(
    { vaultAccount: VAULT, treasuryEpoch: state.treasury_epoch, ownerGeneration: state.owner_generation },
    proposal,
    MODEL,
    TREASURY_SYSTEM_PROMPT,
  );
  const responseBody = JSON.stringify({
    id: 'sandbox-chat',
    created: Math.floor(Date.now() / 1000),
    choices: [{ message: { content: `APPROVE ${request.proposal_hash}` } }],
  });
  const text = `${MODEL}:${sha256Hex(request.body)}:${sha256Hex(responseBody)}`;
  const signature = await teeAccount.signMessage({ message: text });
  return {
    request,
    proof: {
      text,
      signature_hex: signature.slice(2),
      response_body: responseBody,
      system_prompt: TREASURY_SYSTEM_PROMPT,
    },
  };
}

function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  return sha256(
    Buffer.concat([
      u32(2_147_484_061),
      u32(Buffer.byteLength(message)),
      Buffer.from(message),
      nonce,
      u32(Buffer.byteLength(recipient)),
      Buffer.from(recipient),
      Buffer.from([0]),
    ]),
  );
}

describe.skipIf(!binary)('sandbox end to end, compiled contracts', () => {
  beforeAll(async () => {
    sandbox = await startSandbox(binary as string);
    ({ send, raw, createAccount } = chain(sandbox));
    for (const name of envNames) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    process.env.NEXT_PUBLIC_NEAR_RPC_URL = sandbox.rpcUrl;
    process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID = REGISTRY;
    process.env.NEAR_OPERATOR_ACCOUNT_ID = OPERATOR;
    process.env.NEAR_OPERATOR_PRIVATE_KEY = sandbox.key;

    await createAccount(USDC, 30n, 'test_usdc.wasm');
    await createAccount('mpc.test.near', 30n, 'mpc_signer_double.wasm');
    await createAccount('intents.test.near', 30n, 'intents_double.wasm');
    await createAccount(OPERATOR, 30n);
    await createAccount('payee.test.near', 30n);
    await createAccount(FOUNDER, 40n);
    await createAccount(CUSTOMER, 30n);
    await createAccount(REGISTRY, 50n, 'incorpr_registry.wasm');
    await send(USDC, raw(USDC, 'new', {}));
    await send('mpc.test.near', raw('mpc.test.near', 'new', {}));
    await send('intents.test.near', raw('intents.test.near', 'new', {}));

    const cap = '1000000000000000';
    await send(
      REGISTRY,
      raw(REGISTRY, 'new', {
        args: {
          owner: REGISTRY,
          usdc_token: USDC,
          mpc_contract: 'mpc.test.near',
          intents_contract: 'intents.test.near',
          btc_hrp: 'tb',
          default_operator: OPERATOR,
          compute_payee: 'payee.test.near',
          allowed_tokens: [USDC_ASSET, BTC_ASSET, SOL_ASSET],
          epoch_caps: [
            [USDC_ASSET, cap],
            [BTC_ASSET, cap],
            [SOL_ASSET, cap],
          ],
          tee_signers: [teeAccount.address.toLowerCase()],
          tee_models: [MODEL],
          tee_prompt_hash: treasuryPromptHash(),
          price_floors: [
            { sell_token: USDC_ASSET, buy_token: BTC_ASSET, min_buy: '1', per_sell: '1000000000' },
            { sell_token: USDC_ASSET, buy_token: SOL_ASSET, min_buy: '1', per_sell: '1000000000' },
          ],
          auction_duration_ms: 3_600_000,
        },
      }),
    );

    const storage = '1250000000000000000000';
    for (const who of ['payee.test.near', 'intents.test.near', CUSTOMER]) {
      await send(CUSTOMER, raw(USDC, 'storage_deposit', { account_id: who }, storage));
    }
    await send(USDC, raw(USDC, 'mint', { account_id: CUSTOMER, amount: '100000000' }));
  }, 180_000);

  afterAll(() => {
    sandbox?.stop();
    for (const name of envNames) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it('incorporates through the typed client and reads every registry view', async () => {
    const registry = new RegistryClient();
    const cost = await registry.incorporationCost();
    await send(
      FOUNDER,
      registry.incorporateCompany(
        {
          name: 'Acme Translate',
          service_template: 'Translate the text you receive.',
          price_micro_usdc: '1000000',
          target_bps: [5000, 2500, 2500],
          founder_royalty_bps: 100,
          compute_reserve_bps: 1000,
        },
        cost,
      ),
    );

    const company = await registry.getCompany('1');
    const expected: Record<keyof CompanyView, true> = {
      token_id: true, owner_id: true, name: true, service_template: true, price_micro_usdc: true,
      target_bps: true, founder: true, founder_royalty_bps: true, compute_reserve_bps: true, vault: true,
      created_ms: true, gross: true, retained: true, revenue_30d: true, calls: true, metrics_ms: true,
      encumbrance: true, settling: true, needs_resync: true, sync_nonce: true,
    };
    expect(Object.keys(company as CompanyView).sort()).toEqual(Object.keys(expected).sort());
    expect(company?.vault).toBe(VAULT);
    expect(company?.encumbrance).toBe('Free');

    expect(await registry.listCompanies()).toHaveLength(1);
    expect(await registry.getOffers('1')).toEqual([]);
    expect(await registry.getLoan('1')).toBeNull();
    expect(await registry.getListing('1')).toBeNull();
    expect(await registry.auctionPrice('1')).toBeNull();
    expect(await registry.pendingWithdrawal(FOUNDER)).toBe('0');
    expect(BigInt(await registry.offerStorageCost())).toBeGreaterThan(0n);
    expect(await registry.storageBalanceOf(FOUNDER)).toBeNull();
    expect((await registry.storageBalanceBounds()).min).toMatch(/^\d+$/);
    expect((await registry.nftToken('1'))?.owner_id).toBe(FOUNDER);
    expect((await registry.nftToken('1'))?.metadata?.media).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(await registry.nftTotalSupply()).toBe('1');
    expect(await registry.nftTokens()).toHaveLength(1);
    expect(await registry.nftTokensForOwner(FOUNDER)).toHaveLength(1);
    expect((await registry.nftPayout('1', '1000000')).payout[FOUNDER]).toBeDefined();
  });

  it('reads vault state with exactly the declared fields', async () => {
    const state = await new VaultClient(VAULT).getState();
    const expected: Record<keyof VaultState, true> = {
      token_id: true, registry: true, shareholder: true, founder: true, founder_royalty_bps: true,
      compute_payee: true, mpc_contract: true, intents_contract: true, usdc_token: true, btc_hrp: true,
      price_micro_usdc: true, compute_reserve_bps: true, policy: true, default_policy: true, encumbrance: true,
      in_transit: true, sync_nonce: true, owner_generation: true, treasury_epoch: true, raw_sigs_this_epoch: true,
      addresses: true, intents_key: true, intents_key_registered: true, latest_intent_deadline_ms: true,
      gross_revenue: true, related_party_revenue: true, compute_reserve: true, retained_earnings: true,
      revenue_30d: true, api_calls_served: true, dividends_paid: true, compute_paid: true,
      deposited_to_intents: true, spend_window: true, spent_this_window: true, payment_records: true,
      free_near_balance: true,
    };
    expect(Object.keys(state).sort()).toEqual(Object.keys(expected).sort());
    expect(state.policy.operator).toBe(OPERATOR);
    expect(state.policy.tee_prompt_hash).toBe(treasuryPromptHash());
  });

  it('run-service answers 402 from chain state before any inference', async () => {
    process.env.NEAR_AI_API_KEY = 'sk-invalid-key-for-sandbox-routing';
    const res = await runServicePost(post('/api/run-service', { token_id: '1', call_id: CALL_ID, salt: SALT, input: INPUT }, '10.9.0.1'));
    expect(res.status).toBe(402);
    expect((await res.json()).error.message).toContain(CALL_ID);
  });

  it('books a real ft_transfer_call payment', async () => {
    await send(CUSTOMER, usdcCalls.payForService(USDC, VAULT, '20000000', CALL_ID));
    const vault = new VaultClient(VAULT);
    expect(await vault.getPayment(CALL_ID)).toEqual({ payer: CUSTOMER, amount: '20000000', served: false, tee_chat_id: null });
    const state = await vault.getState();
    expect(state.compute_reserve).toBe('2000000');
    expect(state.retained_earnings).toBe('18000000');
    expect(await vault.revenue30d()).toBe('20000000');
    const stats = await vault.paymentStats();
    expect(stats.records).toBe(1);
    expect(stats.distinct_payers).toBe(1);
  });

  it('run-service reaches inference only when paid and unserved, and maps a real upstream 401', async () => {
    process.env.NEAR_AI_API_KEY = 'sk-invalid-key-for-sandbox-routing';
    const res = await runServicePost(post('/api/run-service', { token_id: '1', call_id: CALL_ID, salt: SALT, input: INPUT }, '10.9.0.2'));
    const body = await res.json();
    console.log('[run-service with invalid key]', res.status, JSON.stringify(body));
    expect(res.status).toBe(502);
    expect(body.error.code).toBe('tee_upstream');
    expect(JSON.stringify(body)).not.toContain('sk-invalid-key');
    expect((await new VaultClient(VAULT).getPayment(CALL_ID))?.served).toBe(false);
  });

  it('run-service refuses when this server is not the vault operator', async () => {
    process.env.NEAR_AI_API_KEY = 'sk-invalid-key-for-sandbox-routing';
    process.env.NEAR_OPERATOR_ACCOUNT_ID = FOUNDER;
    try {
      const res = await runServicePost(post('/api/run-service', { token_id: '1', call_id: CALL_ID, salt: SALT, input: INPUT }, '10.9.0.3'));
      expect(res.status).toBe(409);
      expect((await res.json()).error.message).toContain(OPERATOR);
    } finally {
      process.env.NEAR_OPERATOR_ACCOUNT_ID = OPERATOR;
      delete process.env.NEAR_AI_API_KEY;
    }
  });

  it('sends a real operator transaction and returns its hash', async () => {
    const vault = new VaultClient(VAULT);
    const { txHash } = await operatorCall(vault.recordServiceCall(CALL_ID, 'sandbox-chat-id'));
    expect(txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const onChain = await getProvider().viewTransactionStatus({ txHash, accountId: OPERATOR, waitUntil: 'EXECUTED_OPTIMISTIC' });
    expect(onChain.transaction.hash).toBe(txHash);
    expect(await vault.getPayment(CALL_ID)).toMatchObject({ served: true, tee_chat_id: 'sandbox-chat-id' });
    expect((await vault.getState()).api_calls_served).toBe(1);
  });

  it('reports a contract panic with its error code and transaction hash', async () => {
    const vault = new VaultClient(VAULT);
    const error = await operatorCall(vault.recordServiceCall(CALL_ID, 'again')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect((error as TransactionFailedError).reason).toBe('ERR_PAYMENT_ALREADY_SERVED');
    expect((error as TransactionFailedError).txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it('run-service answers 409 for a served call, before inference', async () => {
    process.env.NEAR_AI_API_KEY = 'sk-invalid-key-for-sandbox-routing';
    try {
      const res = await runServicePost(post('/api/run-service', { token_id: '1', call_id: CALL_ID, salt: SALT, input: INPUT }, '10.9.0.4'));
      expect(res.status).toBe(409);
    } finally {
      delete process.env.NEAR_AI_API_KEY;
    }
  });

  it('derives the same addresses off-chain as the vault stored on-chain', async () => {
    const vault = new VaultClient(VAULT);
    expect(await vault.treasuryAddresses()).toBeNull();
    await operatorCall(vault.refreshTreasuryKeys());
    const state = await vault.getState();
    expect(state.addresses?.btc).toMatch(/^tb1q/);
    const { comparison } = await checkVaultAddresses(VAULT, state);
    expect(comparison).toEqual({ match: true });
  });

  it('registers the intents key and deposits retained earnings', async () => {
    const vault = new VaultClient(VAULT);
    await operatorCall(vault.setupIntentsKey());
    expect((await vault.getState()).intents_key_registered).toBe(true);
    await operatorCall(vault.agentDepositToIntents('18000000'));
    expect(await intentsBalance('intents.test.near', VAULT, USDC_ASSET)).toBe('18000000');
    expect((await vault.getState()).deposited_to_intents).toBe('18000000');
  });

  it('verify-l1 returns a real L1 report, explicitly unsigned without an API key', async () => {
    const res = await verifyPost(post('/api/verify-l1', { token_id: '1' }, '10.9.0.5'));
    expect(res.status).toBe(200);
    const body = await res.json();
    console.log('[verify-l1 unsigned]', body.report.overall, JSON.stringify(body.report.unavailableReasons), JSON.stringify(body.attestation));
    expect(body.attestation.state).toBe('unsigned');
    expect(body.report.vaultChecks.addressesMatchMpc).toEqual({ match: true });
    expect(body.report.dirtyReasons).toEqual([]);
    expect(body.report_sha256).toBe(sha256Hex(JSON.stringify(body.report)));
  });

  let plannedProposal: SwapProposal;

  it('rebalance dry run plans from chain state, target_bps and a real 1Click quote', async () => {
    const res = await rebalancePost(post('/api/rebalance', { token_id: '1', dry_run: true }, '10.9.0.6'));
    const body = await res.json();
    console.log('[rebalance dry run]', res.status, JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(body.quote_source).toBe('1click_dry_quote');
    // The quote is live. When 1Click has no market for the pair it says so, and the route still
    // returns the planned trade with nothing signed. Either answer is real; anything else fails.
    expect(['dry_run', 'no_quote']).toContain(body.state);
    if (body.state === 'dry_run') {
      expect(body.proposal.sell_token).toBe(USDC_ASSET);
      expect(body.proposal.buy_token).toBe(BTC_ASSET);
      expect(BigInt(body.proposal.min_buy_amount)).toBeGreaterThan(0n);
      plannedProposal = body.proposal;
    } else {
      expect(body.reason).toMatch(/liquidity/i);
      expect(body.planned.sell_token).toBe(USDC_ASSET);
      expect(body.planned.buy_token).toBe(BTC_ASSET);
      expect(BigInt(body.planned.sell_amount)).toBeGreaterThan(0n);
      // The later tests exercise the vault's verifier through the signer double, which needs some
      // proposal: the planned trade at the smallest amount the vault's price floor accepts.
      plannedProposal = {
        sell_token: body.planned.sell_token,
        sell_amount: body.planned.sell_amount,
        buy_token: body.planned.buy_token,
        min_buy_amount: body.planned.price_floor_min_buy,
        nonce_b64: randomNonce(),
      };
    }
  });

  it('builds the exact bytes of the vault swap_tee_request view', async () => {
    const vault = new VaultClient(VAULT);
    const state = await vault.getState();
    const local = buildSwapTeeRequest(
      { vaultAccount: VAULT, treasuryEpoch: state.treasury_epoch, ownerGeneration: state.owner_generation },
      plannedProposal,
      MODEL,
      TREASURY_SYSTEM_PROMPT,
    );
    const onChain = await vault.swapTeeRequest(plannedProposal, MODEL, TREASURY_SYSTEM_PROMPT);
    expect(local.body).toBe(onChain.body);
    expect(local.proposal_hash).toBe(onChain.proposal_hash);
  });

  it('rebalance without an API key answers 503 and spends nothing', async () => {
    const res = await rebalancePost(post('/api/rebalance', { token_id: '1' }, '10.9.0.7'));
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('NEAR_AI_API_KEY');
  });

  it('the vault accepts a proof the route would build and returns a signed intent (local key, signer double)', async () => {
    const vault = new VaultClient(VAULT);
    const state = await vault.getState();
    const proposal = { ...plannedProposal, nonce_b64: randomNonce() };
    const { request, proof } = await localTeeProof(proposal, state);
    expect(parseApproval(proof.response_body, request.proposal_hash).approved).toBe(true);

    const { txHash, value } = await operatorCall<SignedIntent>(vault.agentSwapIntent(proposal, proof));
    expect(txHash).toBeTruthy();
    expect(value?.standard).toBe('nep413');
    expect(value?.payload.nonce).toBe(proposal.nonce_b64);
    expect(value?.payload.recipient).toBe('intents.test.near');
    const message = JSON.parse(value?.payload.message as string) as {
      signer_id: string;
      intents: { intent: string; diff: Record<string, string> }[];
    };
    expect(message.signer_id).toBe(VAULT);
    expect(message.intents[0]?.diff).toEqual({
      [proposal.sell_token]: `-${proposal.sell_amount}`,
      [proposal.buy_token]: proposal.min_buy_amount,
    });

    // Verified off-chain against the key the vault registered, over the NEP-413 hash.
    const hash = nep413Hash(value?.payload.message as string, Buffer.from(proposal.nonce_b64, 'base64'), 'intents.test.near');
    const publicKey = base58.decode((value?.public_key as string).replace('ed25519:', ''));
    const signature = base58.decode((value?.signature as string).replace('ed25519:', ''));
    expect(ed25519.verify(signature, hash, publicKey)).toBe(true);
  });

  it('the vault refuses a reused nonce, and rejects a proof from a key it does not list', async () => {
    const vault = new VaultClient(VAULT);
    const state = await vault.getState();
    const proposal = { ...plannedProposal, nonce_b64: randomNonce() };
    const { proof } = await localTeeProof(proposal, state);
    const stranger = privateKeyToAccount(generatePrivateKey());
    const forged = { ...proof, signature_hex: (await stranger.signMessage({ message: proof.text })).slice(2) };
    const error = await operatorCall(vault.agentSwapIntent(proposal, forged)).catch((e: unknown) => e);
    expect((error as TransactionFailedError).reason).toBe('ERR_TEE_SIGNATURE_UNTRUSTED');
  });

  it('marks the freshness report dirty while a signed intent is unexpired', async () => {
    const vault = new VaultClient(VAULT);
    const state = await vault.getState();
    expect(state.latest_intent_deadline_ms).toBeGreaterThan(Date.now());
    const report = await checkFreshness(VAULT, state, 'testnet');
    expect(report.overall).toBe('dirty');
    expect(report.dirtyReasons).toContain('vault has a signed intent that has not expired');
  });

  it('the customRecipientMsg guard accepts a real vault and refuses each unsafe case', async () => {
    const good = { recipient: VAULT, destinationAsset: USDC_ASSET, amount: '1000000', callId: 'fresh-call', registryId: REGISTRY };
    await expect(assertRecipientIsVault(good)).resolves.toBeUndefined();
    await expect(assertRecipientIsVault({ ...good, amount: '999999' })).rejects.toThrow(/below the price/);
    await expect(assertRecipientIsVault({ ...good, callId: CALL_ID })).rejects.toThrow(/already paid/);
    await expect(assertRecipientIsVault({ ...good, destinationAsset: 'nep141:wrap.near' })).rejects.toThrow(/books only/);
    await expect(assertRecipientIsVault({ ...good, recipient: `c-99.${REGISTRY}` })).rejects.toBeInstanceOf(NotAVaultError);
    await expect(assertRecipientIsVault({ ...good, recipient: CUSTOMER })).rejects.toBeInstanceOf(NotAVaultError);
  });

  it('confirms the vault has no access keys, through the same RPC the guard uses', async () => {
    const keys = await getProvider().viewAccessKeyList({ accountId: VAULT });
    expect(keys.keys).toEqual([]);
  });
});
