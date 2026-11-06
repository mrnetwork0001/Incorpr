// Treasury rebalance execution, steps a to f, against a local near-sandbox running the compiled
// contracts in contracts/res (the vault wasm is byte-identical to the one on c-1.incorpr.near).
//
// SANDBOX LIMITS, stated plainly:
// - intents.near is contracts/test-doubles/intents: it registers keys and takes deposits, and does
//   not settle. Step g (publish to the solver relay) is mainnet only and is not run here.
// - Signing goes through contracts/test-doubles/mpc-signer, not the MPC network.
// - The tests in the first block approve with a key generated here, listed in the vault policy.
//   It exercises the vault's verifier and is not evidence about any TEE.
// - The route test at the end makes one real NEAR AI Cloud call when NEAR_AI_API_KEY is set, and
//   lists the signer from a fresh attestation report in the vault policy.

import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as rebalancePost } from '@/app/api/rebalance/route';
import { RegistryClient, VaultClient, usdcCalls, type ContractCall, type SignedIntent, type SwapProposal, type VaultState } from '@/lib/contracts';
import { viewFunction } from '@/lib/near';
import { fetchAttestationReport, sha256Hex } from '@/lib/nearAiTee';
import { intentsBalance, intentsHasPublicKey, randomNonce } from '@/lib/nearIntents';
import { TransactionFailedError, operatorCall } from '@/lib/operator';
import {
  REBALANCE_GAS_TGAS,
  TREASURY_SYSTEM_PROMPT,
  buildSwapTeeRequest,
  checkSignedSwapIntent,
  fundingPaymentFor,
  treasuryPromptHash,
} from '@/lib/rebalance';
import { chain, findSandboxBinary, startSandbox, type Sandbox } from './sandboxHarness';

const binary = findSandboxBinary();
const MODEL = 'Qwen/Qwen3-VL-30B-A3B-Instruct';
const USDC = 'usdc.test.near';
const USDC_ASSET = `nep141:${USDC}`;
const BTC_ASSET = 'nep141:btc.omft.near';
const SOL_ASSET = 'nep141:sol.omft.near';
const REGISTRY = 'registry.test.near';
const INTENTS = 'intents.test.near';
const MPC = 'mpc.test.near';
const VAULT = `c-1.${REGISTRY}`;
const OPERATOR = 'operator.test.near';
const CUSTOMER = 'customer.test.near';
const FOUNDER = 'founder.test.near';
const PRICE = 50_000n;
const RESERVE_BPS = 2000;
const SELL = 500_000n;
/** Same floor shape as mainnet: at least 0.0099 SOL per USDC. */
const SOL_FLOOR = { sell_token: USDC_ASSET, buy_token: SOL_ASSET, min_buy: '9912337', per_sell: '1000000' };

const tgas = (n: number) => `${n}000000000000`;
const envNames = [
  'NEXT_PUBLIC_NEAR_RPC_URL',
  'NEXT_PUBLIC_REGISTRY_CONTRACT_ID',
  'NEXT_PUBLIC_NEAR_NETWORK',
  'NEXT_PUBLIC_INTENTS_CONTRACT_ID',
  'NEAR_OPERATOR_ACCOUNT_ID',
  'NEAR_OPERATOR_PRIVATE_KEY',
  'INCORPR_ALLOW_MAINNET_REBALANCE',
];
const savedEnv: Record<string, string | undefined> = {};
const teeAccount = privateKeyToAccount(generatePrivateKey());
const liveTee = Boolean(process.env.NEAR_AI_API_KEY);

let sandbox: Sandbox | undefined;
let harness: ReturnType<typeof chain>;
let liveSigners: string[] = [];

interface ReceiptLike {
  outcome: { executor_id: string; gas_burnt: number; status: unknown };
}

/** Gas burnt per receipt, in TGas, for the report of what each call needs. */
function gasByReceipt(outcome: unknown): string[] {
  const receipts = ((outcome as { receipts_outcome?: ReceiptLike[] }).receipts_outcome ?? []).map(
    (r) => `${r.outcome.executor_id}:${(r.outcome.gas_burnt / 1e12).toFixed(2)}`,
  );
  const tx = (outcome as { transaction_outcome?: { outcome: { gas_burnt: number } } }).transaction_outcome;
  return [`tx:${((tx?.outcome.gas_burnt ?? 0) / 1e12).toFixed(2)}`, ...receipts];
}

async function localApproval(proposal: SwapProposal, state: Pick<VaultState, 'treasury_epoch' | 'owner_generation'>, reply?: string) {
  const request = buildSwapTeeRequest(
    { vaultAccount: VAULT, treasuryEpoch: state.treasury_epoch, ownerGeneration: state.owner_generation },
    proposal,
    MODEL,
    TREASURY_SYSTEM_PROMPT,
  );
  const responseBody = JSON.stringify({
    id: 'sandbox-chat',
    created: Math.floor(Date.now() / 1000),
    choices: [{ message: { content: reply ?? `APPROVE ${request.proposal_hash}` } }],
  });
  const text = `${MODEL}:${sha256Hex(request.body)}:${sha256Hex(responseBody)}`;
  const signature = await teeAccount.signMessage({ message: text });
  return { request, tee: { text, signature_hex: signature.slice(2), response_body: responseBody, system_prompt: TREASURY_SYSTEM_PROMPT } };
}

function post(body: unknown, ip: string): Request {
  return new Request('http://localhost/api/rebalance', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!binary)('rebalance execution on a sandbox, steps a to f', () => {
  beforeAll(async () => {
    sandbox = await startSandbox(binary as string);
    harness = chain(sandbox);
    const { send, raw, createAccount } = harness;
    for (const name of envNames) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    process.env.NEXT_PUBLIC_NEAR_NETWORK = 'sandbox';
    process.env.NEXT_PUBLIC_NEAR_RPC_URL = sandbox.rpcUrl;
    process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID = REGISTRY;
    process.env.NEXT_PUBLIC_INTENTS_CONTRACT_ID = INTENTS;
    process.env.NEAR_OPERATOR_ACCOUNT_ID = OPERATOR;
    process.env.NEAR_OPERATOR_PRIVATE_KEY = sandbox.key;

    if (liveTee) {
      // Real signers, from a report fetched now with a fresh nonce. verifyChat in the route checks the chat against it again.
      const report = await fetchAttestationReport(MODEL, randomBytes(32).toString('hex'));
      liveSigners = [...new Set((report.model_attestations ?? []).map((e) => String(e.signing_address).toLowerCase()))];
      expect(liveSigners.length).toBeGreaterThan(0);
    }

    await createAccount(USDC, 30n, 'test_usdc.wasm');
    await createAccount(MPC, 30n, 'mpc_signer_double.wasm');
    await createAccount(INTENTS, 30n, 'intents_double.wasm');
    // 0.3 NEAR, like operator.incorpr.near holds on mainnet, so the gas figures are checked against a realistic balance.
    await harness.account('test.near').createAccount({
      newAccountId: OPERATOR,
      publicKey: KeyPair.fromString(sandbox.key).getPublicKey(),
      nearToTransfer: 3n * 10n ** 23n,
    });
    await createAccount('payee.test.near', 5n);
    await createAccount(FOUNDER, 40n);
    await createAccount(CUSTOMER, 10n);
    await createAccount(REGISTRY, 50n, 'incorpr_registry.wasm');
    await send(USDC, raw(USDC, 'new', {}));
    await send(MPC, raw(MPC, 'new', {}));
    await send(INTENTS, raw(INTENTS, 'new', {}));
    await send(
      REGISTRY,
      raw(REGISTRY, 'new', {
        args: {
          owner: REGISTRY,
          usdc_token: USDC,
          mpc_contract: MPC,
          intents_contract: INTENTS,
          btc_hrp: 'tb',
          default_operator: OPERATOR,
          compute_payee: 'payee.test.near',
          allowed_tokens: [USDC_ASSET, BTC_ASSET, SOL_ASSET],
          epoch_caps: [
            [USDC_ASSET, '25000000'],
            [BTC_ASSET, '33000'],
            [SOL_ASSET, '275000000'],
          ],
          tee_signers: [teeAccount.address.toLowerCase(), ...liveSigners],
          tee_models: [MODEL],
          tee_prompt_hash: treasuryPromptHash(),
          price_floors: [SOL_FLOOR, { sell_token: USDC_ASSET, buy_token: BTC_ASSET, min_buy: '1189', per_sell: '1000000' }],
          auction_duration_ms: 3_600_000,
        },
      }),
    );
    const storage = '1250000000000000000000';
    for (const who of ['payee.test.near', INTENTS, CUSTOMER]) {
      await send(CUSTOMER, raw(USDC, 'storage_deposit', { account_id: who }, storage));
    }
    await send(USDC, raw(USDC, 'mint', { account_id: CUSTOMER, amount: '10000000' }));

    const registry = new RegistryClient();
    await send(
      FOUNDER,
      registry.incorporateCompany(
        {
          name: 'Ledgerline Audit',
          service_template: 'Audit this smart contract.',
          price_micro_usdc: PRICE.toString(),
          // No BTC target, so the route plans USDC -> SOL, the pair solvers quote at this size.
          target_bps: [0, 6000, 4000],
          founder_royalty_bps: 500,
          compute_reserve_bps: RESERVE_BPS,
        },
        await registry.incorporationCost(),
      ),
    );
  }, 240_000);

  afterAll(() => {
    sandbox?.stop();
    for (const name of envNames) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it('b, funding: one payment above the price adds exactly the computed retained earnings', async () => {
    const payment = fundingPaymentFor(SELL, RESERVE_BPS, PRICE) as bigint;
    expect(payment).toBe(624_999n);
    const outcome = await harness.send(CUSTOMER, usdcCalls.payForService(USDC, VAULT, payment.toString(), 'funding-1'));
    console.log('[gas] customer ft_transfer_call', gasByReceipt(outcome).join(' '));
    const state = await new VaultClient(VAULT).getState();
    expect(BigInt(state.retained_earnings)).toBe(SELL);
    expect(BigInt(state.compute_reserve)).toBe(124_999n);
  });

  it('a, key: setup_intents_key registers the MPC-derived key on the intents contract at the shared gas figure', async () => {
    const vault = new VaultClient(VAULT);
    const call: ContractCall = { ...vault.setupIntentsKey(), gas: tgas(REBALANCE_GAS_TGAS.setupIntentsKey) };
    const outcome = await harness.send(OPERATOR, call);
    console.log('[gas] setup_intents_key', gasByReceipt(outcome).join(' '));
    const state = await vault.getState();
    expect(state.intents_key_registered).toBe(true);
    const derived = await viewFunction<string>(MPC, 'derived_public_key', { path: 'incorpr-1-intents', predecessor: VAULT, domain_id: 1 });
    expect(state.intents_key).toBe(derived);
    expect(await intentsHasPublicKey(INTENTS, VAULT, state.intents_key as string)).toBe(true);
  });

  it('b, deposit: agent_deposit_to_intents moves retained earnings onto the intents contract', async () => {
    const vault = new VaultClient(VAULT);
    const outcome = await harness.send(OPERATOR, { ...vault.agentDepositToIntents(SELL.toString()), gas: tgas(REBALANCE_GAS_TGAS.deposit) });
    console.log('[gas] agent_deposit_to_intents', gasByReceipt(outcome).join(' '));
    expect(await intentsBalance(INTENTS, VAULT, USDC_ASSET)).toBe(SELL.toString());
    const state = await vault.getState();
    expect(state.retained_earnings).toBe('0');
    expect(state.deposited_to_intents).toBe(SELL.toString());
  });

  it('f, firewall: a quote below the price floor is refused before any signature', async () => {
    const vault = new VaultClient(VAULT);
    const state = await vault.getState();
    const proposal: SwapProposal = { sell_token: USDC_ASSET, sell_amount: SELL.toString(), buy_token: SOL_ASSET, min_buy_amount: '4956168', nonce_b64: randomNonce() };
    const { tee } = await localApproval(proposal, state);
    const error = await operatorCall({ ...vault.agentSwapIntent(proposal, tee), gas: tgas(REBALANCE_GAS_TGAS.swap) }).catch((e: unknown) => e);
    expect((error as TransactionFailedError).reason).toBe('ERR_FIREWALL_PRICE_BELOW_FLOOR');
  });

  it('f, firewall: a model reply other than APPROVE <hash> is refused', async () => {
    const vault = new VaultClient(VAULT);
    const state = await vault.getState();
    const proposal: SwapProposal = { sell_token: USDC_ASSET, sell_amount: '1000', buy_token: SOL_ASSET, min_buy_amount: '9913', nonce_b64: randomNonce() };
    const { tee } = await localApproval(proposal, state, 'REJECT not convinced');
    const error = await operatorCall({ ...vault.agentSwapIntent(proposal, tee), gas: tgas(REBALANCE_GAS_TGAS.swap) }).catch((e: unknown) => e);
    expect((error as TransactionFailedError).reason).toBe('ERR_TEE_NOT_APPROVED');
  });

  it('f, sign: agent_swap_intent returns a NEP-413 token_diff that verifies against the registered key', async () => {
    const vault = new VaultClient(VAULT);
    const state = await vault.getState();
    // 5513613 lamports for 0.5 USDC: a real solver relay offer on 2026-11-06, above the 4956169 floor.
    const proposal: SwapProposal = { sell_token: USDC_ASSET, sell_amount: SELL.toString(), buy_token: SOL_ASSET, min_buy_amount: '5513613', nonce_b64: randomNonce() };
    const { tee } = await localApproval(proposal, state);
    const outcome = await harness.send(OPERATOR, { ...vault.agentSwapIntent(proposal, tee), gas: tgas(REBALANCE_GAS_TGAS.swap) });
    console.log('[gas] agent_swap_intent', gasByReceipt(outcome).join(' '));
    const status = (outcome as { status: { SuccessValue?: string } }).status;
    const signed = JSON.parse(Buffer.from(status.SuccessValue as string, 'base64').toString()) as SignedIntent;

    const check = checkSignedSwapIntent(signed, { vault: VAULT, intentsContract: INTENTS, intentsKey: state.intents_key as string, proposal, nowMs: Date.now() });
    expect(check.failures).toEqual([]);
    expect(check.ok).toBe(true);
    expect(await intentsHasPublicKey(INTENTS, VAULT, signed.public_key)).toBe(true);
    expect(JSON.parse(signed.payload.message)).toMatchObject({
      signer_id: VAULT,
      intents: [{ intent: 'token_diff', diff: { [USDC_ASSET]: '-500000', [SOL_ASSET]: '5513613' } }],
    });
    const deadline = Date.parse(check.message?.deadline as string);
    expect(deadline - Date.now()).toBeGreaterThan(200_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(300_000);

    // A changed amount no longer matches the signature.
    const tampered = { ...signed, payload: { ...signed.payload, message: signed.payload.message.replace('5513613', '5513614') } };
    const bad = checkSignedSwapIntent(tampered, { vault: VAULT, intentsContract: INTENTS, intentsKey: state.intents_key as string, proposal, nowMs: Date.now() });
    expect(bad.ok).toBe(false);
    expect(bad.failures.join(' ')).toMatch(/does not verify/);

    // The spend counts against the 24 h cap, and the nonce cannot be reused.
    const after = await vault.getState();
    expect(after.spent_this_window).toContainEqual([USDC_ASSET, '500000']);
    const again = await operatorCall({ ...vault.agentSwapIntent(proposal, (await localApproval(proposal, after)).tee), gas: tgas(REBALANCE_GAS_TGAS.swap) }).catch((e: unknown) => e);
    expect((again as TransactionFailedError).reason).toBe('ERR_NONCE_USED');
  });

  it('route: refuses to sign while an intent the vault signed is still live', async () => {
    // The previous test signed an intent for c-1 that can settle for 300 s.
    const state = await new VaultClient(VAULT).getState();
    expect(state.latest_intent_deadline_ms).toBeGreaterThan(Date.now());
    process.env.NEAR_AI_API_KEY ??= 'unused-the-route-refuses-before-any-inference';
    const res = await rebalancePost(post({ token_id: '1' }, '10.20.0.2'));
    if (!liveTee) delete process.env.NEAR_AI_API_KEY;
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.message).toMatch(/live until/);
    const after = await new VaultClient(VAULT).getState();
    expect(after.spent_this_window).toEqual(state.spent_this_window);
    expect(after.latest_intent_deadline_ms).toBe(state.latest_intent_deadline_ms);
  });

  it.skipIf(!liveTee)('route: executes a to f with a real NEAR AI Cloud approval and returns the signed intent', async () => {
    // c-1 has a live intent from the tests above, so the route runs on a second company.
    const registry = new RegistryClient();
    await harness.send(
      FOUNDER,
      registry.incorporateCompany(
        {
          name: 'Tessera Translate',
          service_template: 'Translate this text.',
          price_micro_usdc: PRICE.toString(),
          target_bps: [0, 6000, 4000],
          founder_royalty_bps: 500,
          compute_reserve_bps: RESERVE_BPS,
        },
        await registry.incorporationCost(),
      ),
    );
    const vault2 = `c-2.${REGISTRY}`;
    await harness.send(CUSTOMER, usdcCalls.payForService(USDC, vault2, '1250000', 'funding-2'));
    // Two requests at once: one runs, the other is refused by the per-vault lock before any work.
    const [first, second] = await Promise.all([
      rebalancePost(post({ token_id: '2', next_asset_if_unquoted: true }, '10.20.0.1')),
      rebalancePost(post({ token_id: '2', next_asset_if_unquoted: true }, '10.20.0.3')),
    ]);
    const bodies = await Promise.all([first.json(), second.json()]);
    const lockedIndex = bodies.findIndex((b) => /already running/.test(b?.error?.message ?? ''));
    expect(lockedIndex).toBeGreaterThanOrEqual(0);
    const responses = [first, second];
    expect((responses[lockedIndex] as Response).status).toBe(409);
    const res = responses[1 - lockedIndex] as Response;
    const body = bodies[1 - lockedIndex];
    console.log('[route execute]', res.status, JSON.stringify({ ...body, tee: body.tee ? { ...body.tee, verification: '(omitted)' } : undefined }));
    if (body.state === 'rejected') {
      // The model's reply is printed above. A refusal is a real outcome, and the vault would refuse it too.
      expect(body.model_output).toBeTruthy();
      return;
    }
    if (body.state === 'no_quote') {
      expect(body.reason).toBeTruthy();
      return;
    }
    expect(res.status).toBe(200);
    expect(body.state).toBe('signed');
    expect(body.proposal.buy_token).toBe(SOL_ASSET);
    expect(body.sign.signature_verifies).toBe(true);
    expect(body.sign.tx_hash).toBeTruthy();
    expect(body.tee.signer_in_policy).toBe(true);
    expect(liveSigners).toContain(body.tee.signer);
    expect(body.relay.state).toBe('not_submitted');
    expect(body.balances.before[USDC_ASSET]).toBeDefined();
  }, 300_000);
});
