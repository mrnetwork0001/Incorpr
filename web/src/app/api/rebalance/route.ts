import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, enforceKeyedLimit, enforceRateLimit, errorResponse, parseJsonBody } from '@/lib/api';
import {
  RegistryClient,
  VaultClient,
  isFree,
  type ContractCall,
  type SignedIntent,
  type SwapProposal,
  type TeeProof,
  type VaultState,
} from '@/lib/contracts';
import { getNetworkConfig, NearViewError, txExplorerUrl, type NetworkConfig } from '@/lib/near';
import {
  TeeApiKeyMissingError,
  directEndpointFor,
  pickDefaultModel,
  runInference,
  summarizeVerification,
  teeConfigured,
  verifyChat,
} from '@/lib/nearAiTee';
import {
  MAINNET_USDC_ASSET,
  OneClickError,
  bestSolverQuote,
  buildIntentNonce,
  buildPublishIntentPayload,
  currentSalt,
  getQuote,
  getTokens,
  intentsBalance,
  intentsBalances,
  intentsHasPublicKey,
  publishIntent,
  randomNonce,
  solverQuote,
  waitForIntent,
  type IntentStatus,
  type OneClickToken,
  type PublishIntentResult,
  type SolverQuote,
} from '@/lib/nearIntents';
import { operatorAccountId, operatorCall } from '@/lib/operator';
import {
  REBALANCE_GAS_TGAS,
  SOLVER_MIN_DEADLINES_MS,
  TREASURY_SYSTEM_PROMPT,
  buildSwapTeeRequest,
  checkSignedSwapIntent,
  epochCapRemaining,
  parseApproval,
  planRebalance,
  priceFloorMinBuy,
  treasuryPromptHash,
  type RebalancePlan,
  type TreasuryHolding,
} from '@/lib/rebalance';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const RATE_LIMIT = { route: 'rebalance', perIpPerMinute: 6, globalPerMinute: 20 };
const PER_TOKEN_PER_MINUTE = 2;
const MIN_DRIFT_BPS = 200;
const SLIPPAGE_BPS = 100;
const MAX_TEE_RESPONSE_BYTES = 16_384;
/** Must outlast the vault's 300 s intent deadline, or `intents.near` refuses the nonce (DeadlineGreaterThanNonce). */
const NONCE_TTL_MS = 15 * 60_000;
/** The signed intent must reach the relay before the solver's offer expires. */
const MIN_QUOTE_LIFE_MS = 45_000;
const SETTLE_WAIT_MS = 90_000;
/** Quote life the TEE inference and its attestation checks may take before signing; below it, re-quote. */
const TEE_STEP_BUDGET_MS = 60_000;

/**
 * Vaults with an execution in progress in this server process. One execution per vault at a time:
 * two concurrent runs would read the same holdings and sign the same trade twice.
 */
const executing = new Set<string>();

const BTC_ASSET = 'nep141:btc.omft.near';
const SOL_ASSET = 'nep141:sol.omft.near';

const Body = z.strictObject({
  token_id: z.string().regex(/^\d{1,20}$/, 'must be a decimal token id'),
  dry_run: z.boolean().optional(),
  /** When nobody quotes the most underweight asset, plan the next most underweight one instead. */
  next_asset_if_unquoted: z.boolean().optional(),
});

const tgas = (n: number) => `${n}000000000000`;

function priceMicroUsd(token: OneClickToken): bigint {
  return BigInt(Math.round(token.price * 1_000_000));
}

/** Testnet and sandbox USDC have no market, so they price as mainnet USDC. BTC and SOL ids are the same everywhere. */
function marketAsset(asset: string, usdcAsset: string): string {
  return asset === usdcAsset ? MAINNET_USDC_ASSET : asset;
}

function explorerUrl(txHash: string, config: NetworkConfig): string | null {
  return config.explorers.near ? txExplorerUrl(txHash, config) : null;
}

/**
 * Treasury as the agent can trade it: balances on intents.near, plus retained earnings counted as
 * USDC, because `agent_deposit_to_intents` can move them there before the swap.
 */
async function readHoldings(vaultId: string, state: VaultState) {
  const usdcAsset = `nep141:${state.usdc_token}`;
  const assets: [string, string, string] = [BTC_ASSET, SOL_ASSET, usdcAsset];
  const tokens = await getTokens();
  const onIntents: Record<string, bigint> = {};
  const holdings = await Promise.all(
    assets.map(async (asset): Promise<TreasuryHolding> => {
      const market = tokens.find((t) => t.assetId === marketAsset(asset, usdcAsset));
      if (!market) throw new ApiError(502, `1Click lists no token ${marketAsset(asset, usdcAsset)}`);
      let balance: string;
      try {
        balance = await intentsBalance(state.intents_contract, vaultId, asset);
      } catch (error) {
        if (error instanceof NearViewError) {
          throw new ApiError(502, `Cannot read ${asset} balance on ${state.intents_contract}: ${error.message}`);
        }
        throw error;
      }
      onIntents[asset] = BigInt(balance);
      const depositable = asset === usdcAsset ? BigInt(state.retained_earnings) : 0n;
      return { asset, balance: BigInt(balance) + depositable, decimals: market.decimals, priceMicroUsd: priceMicroUsd(market) };
    }),
  );
  return { holdings: holdings as [TreasuryHolding, TreasuryHolding, TreasuryHolding], usdcAsset, onIntents };
}

/** An intent the vault signed can settle until its deadline; a second one would repeat the same trade. */
function assertNoLiveIntent(state: VaultState): void {
  if (Date.now() <= state.latest_intent_deadline_ms) {
    throw new ApiError(
      409,
      `An intent the vault signed is live until ${new Date(state.latest_intent_deadline_ms).toISOString()}. It can still settle, so no second one is signed before then.`,
    );
  }
}

function assertAgentCanAct(state: VaultState, operator: string | null): void {
  if (!isFree(state.encumbrance) || state.in_transit) {
    throw new ApiError(409, 'The vault is encumbered or in transit, so the agent is frozen');
  }
  if (operator !== null && state.policy.operator !== operator) {
    throw new ApiError(409, `The vault's operator is ${state.policy.operator}, not this server's ${operator}`);
  }
}

async function chooseModel(state: VaultState): Promise<string> {
  const preferred = await pickDefaultModel();
  if (state.policy.tee_models.includes(preferred) && directEndpointFor(preferred)) return preferred;
  const allowed = state.policy.tee_models.find((model) => directEndpointFor(model));
  if (!allowed) {
    throw new ApiError(409, `The vault allows models ${JSON.stringify(state.policy.tee_models)}, none with a known direct host`);
  }
  return allowed;
}

type PricedQuote =
  | { kind: 'quote'; minBuyAmount: bigint; source: 'solver_relay' | '1click_dry_quote'; relay: SolverQuote | null }
  | { kind: 'none'; source: string; reason: string; correlationId?: string };

/**
 * Mainnet: the solver relay, whose offer the signed `token_diff` must match exactly. Elsewhere: a
 * 1Click dry quote prices the proposal, since no solver serves testnet or sandbox tokens.
 */
async function priceSwap(mainnet: boolean, usdcAsset: string, sellToken: string, buyToken: string, sellAmount: bigint): Promise<PricedQuote> {
  if (mainnet) {
    for (const minDeadlineMs of SOLVER_MIN_DEADLINES_MS) {
      const best = bestSolverQuote(
        await solverQuote({ assetIn: sellToken, assetOut: buyToken, exactAmountIn: sellAmount.toString(), minDeadlineMs }),
      );
      if (best) return { kind: 'quote', minBuyAmount: BigInt(best.amount_out), source: 'solver_relay', relay: best };
    }
    return { kind: 'none', source: 'solver_relay', reason: `No solver quoted ${sellAmount} ${sellToken} to ${buyToken}` };
  }
  try {
    // Price read only: a dry quote commits nothing. INTENTS to INTENTS is the trade the vault would sign.
    const dry = await getQuote({
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: SLIPPAGE_BPS,
      originAsset: marketAsset(sellToken, usdcAsset),
      depositType: 'INTENTS',
      destinationAsset: marketAsset(buyToken, usdcAsset),
      amount: sellAmount.toString(),
      refundTo: 'intents.near',
      refundType: 'INTENTS',
      recipient: 'intents.near',
      recipientType: 'INTENTS',
      deadline: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
    });
    return { kind: 'quote', minBuyAmount: BigInt(dry.quote.minAmountOut ?? dry.quote.amountOut), source: '1click_dry_quote', relay: null };
  } catch (error) {
    if (error instanceof OneClickError && /no liquidity/i.test(error.message)) {
      return { kind: 'none', source: '1click_dry_quote', reason: error.message, correlationId: error.correlationId };
    }
    throw error;
  }
}

interface StepTx {
  tx_hash: string;
  explorer_url: string | null;
}

export async function POST(request: Request): Promise<NextResponse> {
  let lockedVault: string | null = null;
  try {
    enforceRateLimit(request, RATE_LIMIT);
    const { token_id, dry_run, next_asset_if_unquoted } = await parseJsonBody(request, Body);
    enforceKeyedLimit(`rebalance:token:${token_id}`, PER_TOKEN_PER_MINUTE, `Company ${token_id} was rebalanced a moment ago`);
    const config = getNetworkConfig();
    const mainnet = config.network === 'mainnet';
    const executionEnabled = !mainnet || process.env.INCORPR_ALLOW_MAINNET_REBALANCE === 'true';

    // Refuse before any quote when a signing run could not complete anyway.
    if (!dry_run) {
      if (!executionEnabled) {
        throw new ApiError(403, 'Mainnet rebalance moves real funds. Set INCORPR_ALLOW_MAINNET_REBALANCE=true to enable it.');
      }
      if (!teeConfigured()) throw new TeeApiKeyMissingError();
    }

    const company = await new RegistryClient().getCompany(token_id);
    if (!company) throw new ApiError(404, `Company ${token_id} does not exist`);
    const vault = new VaultClient(company.vault);
    if (!dry_run) {
      if (executing.has(company.vault)) throw new ApiError(409, `A rebalance of ${company.vault} is already running`);
      executing.add(company.vault);
      lockedVault = company.vault;
    }
    let state = await vault.getState();
    assertAgentCanAct(state, null);
    if (!dry_run) assertNoLiveIntent(state);

    // Target comes from chain, not the caller, so calling this route can only move a treasury toward
    // what its charter already says, inside the vault's caps and floors.
    const { holdings, usdcAsset, onIntents } = await readHoldings(company.vault, state);
    const capRemaining = epochCapRemaining(state, Date.now());
    const planFor = (excludeBuy: string[]) =>
      planRebalance({ holdings, targetBps: company.target_bps, minDriftBps: MIN_DRIFT_BPS, capRemaining, excludeBuy });

    // The most underweight asset first; with next_asset_if_unquoted, the next one when nobody quotes it.
    const excluded: string[] = [];
    let plan: RebalancePlan = planFor(excluded);
    let priced: PricedQuote | null = null;
    let floor = 0n;
    const skipped: { buy_token: string; reason: string }[] = [];
    while (plan.kind === 'swap') {
      if (!state.policy.allowed_tokens.includes(plan.sell.asset) || !state.policy.allowed_tokens.includes(plan.buy.asset)) {
        throw new ApiError(409, `The vault's allowlist does not include both ${plan.sell.asset} and ${plan.buy.asset}`);
      }
      const planFloor = priceFloorMinBuy(state, plan.sell.asset, plan.buy.asset, plan.sellAmount);
      if (planFloor === null) throw new ApiError(409, `The vault has no price floor for ${plan.sell.asset} to ${plan.buy.asset}`);
      floor = planFloor;
      priced = await priceSwap(mainnet, usdcAsset, plan.sell.asset, plan.buy.asset, plan.sellAmount);
      if (priced.kind === 'quote') break;
      if (!next_asset_if_unquoted) break;
      skipped.push({ buy_token: plan.buy.asset, reason: priced.reason });
      excluded.push(plan.buy.asset);
      const next = planFor(excluded);
      if (next.kind === 'noop') break;
      plan = next;
    }
    if (plan.kind === 'noop') {
      return NextResponse.json({
        state: 'noop',
        reason: plan.reason,
        drift_bps: plan.driftBps,
        total_micro_usd: plan.totalMicroUsd,
        skipped,
      });
    }
    const sellToken = plan.sell.asset;
    const buyToken = plan.buy.asset;
    const planned = {
      sell_token: sellToken,
      sell_amount: plan.sellAmount.toString(),
      buy_token: buyToken,
      price_floor_min_buy: floor.toString(),
      drift_bps: plan.driftBps,
      total_micro_usd: plan.totalMicroUsd,
      capped_by_epoch_limit: plan.cappedByEpochLimit,
      on_intents: (onIntents[sellToken] ?? 0n).toString(),
      retained_earnings: state.retained_earnings,
    };
    if (!priced || priced.kind === 'none') {
      // No market is an answer, not a failure: the plan is still shown, nothing is signed.
      return NextResponse.json({
        state: 'no_quote',
        quote_source: priced?.source ?? 'none',
        reason: priced?.kind === 'none' ? priced.reason : 'no quote',
        correlation_id: priced?.kind === 'none' ? (priced.correlationId ?? null) : null,
        planned,
        skipped,
      });
    }
    if (priced.minBuyAmount < floor) {
      throw new ApiError(409, `The live quote of ${priced.minBuyAmount} is below the price floor of ${floor}`);
    }
    let quote = {
      source: priced.source,
      amount_in: plan.sellAmount.toString(),
      amount_out: priced.minBuyAmount.toString(),
      quote_hash: priced.relay?.quote_hash ?? null,
      expiration_time: priced.relay?.expiration_time ?? null,
      floor_min_buy: floor.toString(),
    };
    const nonce = mainnet ? buildIntentNonce(await currentSalt(state.intents_contract), Date.now() + NONCE_TTL_MS) : randomNonce();
    let proposal: SwapProposal = {
      sell_token: sellToken,
      sell_amount: plan.sellAmount.toString(),
      buy_token: buyToken,
      min_buy_amount: priced.minBuyAmount.toString(),
      nonce_b64: nonce,
    };
    let summaryOfPlan = {
      proposal,
      quote_source: priced.source,
      quote,
      price_floor_min_buy: floor.toString(),
      drift_bps: plan.driftBps,
      total_micro_usd: plan.totalMicroUsd,
      capped_by_epoch_limit: plan.cappedByEpochLimit,
      skipped,
      execution_enabled: executionEnabled,
    };
    if (dry_run) return NextResponse.json({ state: 'dry_run', ...summaryOfPlan });

    // ---------------------------------------------------------------- execution
    const operator = operatorAccountId();
    assertAgentCanAct(state, operator);
    if (state.policy.tee_prompt_hash !== treasuryPromptHash()) {
      throw new ApiError(
        409,
        `The vault pins prompt hash ${state.policy.tee_prompt_hash || '(none)'}, this server's prompt hashes to ${treasuryPromptHash()}`,
      );
    }
    const send = async <T,>(call: ContractCall, gasTgas: number) => {
      const result = await operatorCall<T>({ ...call, gas: tgas(gasTgas) });
      return { ...result, explorer_url: explorerUrl(result.txHash, config) };
    };

    // a: the vault's intents key on intents.near.
    let keyTx: StepTx | null = null;
    if (!state.intents_key_registered) {
      const result = await send<string>(vault.setupIntentsKey(), REBALANCE_GAS_TGAS.setupIntentsKey);
      keyTx = { tx_hash: result.txHash, explorer_url: result.explorer_url };
      state = await vault.getState();
      if (!state.intents_key_registered) throw new ApiError(502, `setup_intents_key did not register the key. Transaction ${result.txHash}.`);
    }
    const intentsKey = state.intents_key as string;
    if (!(await intentsHasPublicKey(state.intents_contract, company.vault, intentsKey))) {
      throw new ApiError(409, `${state.intents_contract} does not list the vault key ${intentsKey}`);
    }

    // b: enough USDC on intents.near. Only a USDC sale can draw on retained earnings.
    let depositTx: (StepTx & { amount: string }) | null = null;
    const held = onIntents[sellToken] ?? 0n;
    if (held < plan.sellAmount) {
      if (sellToken !== usdcAsset) throw new ApiError(409, `The vault holds ${held} ${sellToken} on intents.near, less than ${plan.sellAmount}`);
      const amount = plan.sellAmount - held;
      const result = await send<string>(vault.agentDepositToIntents(amount.toString()), REBALANCE_GAS_TGAS.deposit);
      depositTx = { tx_hash: result.txHash, explorer_url: result.explorer_url, amount: amount.toString() };
      const now = BigInt(await intentsBalance(state.intents_contract, company.vault, sellToken));
      if (now < plan.sellAmount) throw new ApiError(502, `After the deposit the vault holds ${now} on intents.near. Transaction ${result.txHash}.`);
      state = await vault.getState();
    }

    // d again: the deposit and key transactions each wait for finality, which can take most of a
    // short solver offer's life. Price the same trade again when they ran or the offer is short.
    const quoteLife = () => (priced?.kind === 'quote' && priced.relay ? Date.parse(priced.relay.expiration_time) - Date.now() : Infinity);
    if (keyTx || depositTx || quoteLife() < MIN_QUOTE_LIFE_MS + TEE_STEP_BUDGET_MS) {
      const again = await priceSwap(mainnet, usdcAsset, sellToken, buyToken, plan.sellAmount);
      if (again.kind === 'none') {
        return NextResponse.json({
          state: 'no_quote',
          quote_source: again.source,
          reason: `After the setup transactions: ${again.reason}`,
          correlation_id: again.correlationId ?? null,
          setup: { intents_key: keyTx, deposit: depositTx },
          planned,
          skipped,
        });
      }
      if (again.minBuyAmount < floor) {
        throw new ApiError(409, `The fresh quote of ${again.minBuyAmount} is below the price floor of ${floor}`);
      }
      priced = again;
      quote = {
        ...quote,
        source: again.source,
        amount_out: again.minBuyAmount.toString(),
        quote_hash: again.relay?.quote_hash ?? null,
        expiration_time: again.relay?.expiration_time ?? null,
      };
      proposal = { ...proposal, min_buy_amount: again.minBuyAmount.toString() };
      summaryOfPlan = { ...summaryOfPlan, proposal, quote_source: again.source, quote };
    }
    const pricedQuote = priced;

    // c: balances before.
    const watched = [sellToken, buyToken];
    const before = await intentsBalances(state.intents_contract, company.vault, watched);

    // e: TEE approval of the exact request the vault will hash.
    const model = await chooseModel(state);
    const context = { vaultAccount: company.vault, treasuryEpoch: state.treasury_epoch, ownerGeneration: state.owner_generation };
    const local = buildSwapTeeRequest(context, proposal, model, TREASURY_SYSTEM_PROMPT);
    const onChain = await vault.swapTeeRequest(proposal, model, TREASURY_SYSTEM_PROMPT);
    if (local.body !== onChain.body || local.proposal_hash !== onChain.proposal_hash) {
      throw new ApiError(500, 'The local TEE request differs from the vault view. Refusing to spend API credits on it.');
    }
    const inference = await runInference(onChain.body);
    if (new TextEncoder().encode(inference.responseBody).length > MAX_TEE_RESPONSE_BYTES) {
      throw new ApiError(502, 'The TEE response is larger than the vault accepts');
    }
    const decision = parseApproval(inference.responseBody, onChain.proposal_hash);
    const setup = { intents_key: keyTx, deposit: depositTx };
    if (!decision.approved) {
      return NextResponse.json(
        { state: 'rejected', reason: decision.reason, model_output: decision.modelOutput, chat_id: inference.chatId, setup, ...summaryOfPlan },
        { status: 422 },
      );
    }
    const verification = await verifyChat(inference);
    const verificationSummary = summarizeVerification(verification);
    if (verificationSummary.failed.length > 0) {
      return NextResponse.json(
        {
          error: { code: 'tee_verification_failed', message: `TEE verification failed: ${verificationSummary.failed.join(', ')}` },
          chat_id: inference.chatId,
          verification,
          verification_summary: verificationSummary,
        },
        { status: 502 },
      );
    }
    if (verification.signatureKind !== 'provider_tee') {
      throw new ApiError(502, `The vault needs a provider_tee signature, got ${verification.signatureKind}`);
    }
    if (!verification.recoveredAddress || !state.policy.tee_signers.includes(verification.recoveredAddress)) {
      throw new ApiError(
        409,
        `TEE signer ${verification.recoveredAddress} is not in the vault's tee_signers. The shareholder sets these with set_tee_signers.`,
      );
    }
    const tee: TeeProof = {
      text: verification.signedText,
      signature_hex: verification.signature.replace(/^0x/i, ''),
      response_body: inference.responseBody,
      system_prompt: TREASURY_SYSTEM_PROMPT,
    };
    const teeSummary = {
      chat_id: inference.chatId,
      model,
      proposal_hash: onChain.proposal_hash,
      signer: verification.recoveredAddress,
      signer_in_policy: true,
      verification,
      verification_summary: verificationSummary,
    };

    // f: the vault runs its firewall again, signs through the MPC signer and returns the intent.
    if (pricedQuote.relay && Date.parse(pricedQuote.relay.expiration_time) - Date.now() < MIN_QUOTE_LIFE_MS) {
      return NextResponse.json(
        { state: 'quote_expired', reason: 'The solver offer expires too soon to sign and publish. Nothing was signed.', setup, tee: teeSummary, ...summaryOfPlan },
        { status: 409 },
      );
    }
    assertNoLiveIntent(await vault.getState());
    const signedCall = await send<SignedIntent>(vault.agentSwapIntent(proposal, tee), REBALANCE_GAS_TGAS.swap);
    const signedIntent = signedCall.value;
    if (!signedIntent) throw new ApiError(502, `agent_swap_intent returned no intent. Transaction ${signedCall.txHash}.`);
    const check = checkSignedSwapIntent(signedIntent, {
      vault: company.vault,
      intentsContract: state.intents_contract,
      intentsKey,
      proposal,
      nowMs: Date.now(),
    });
    const sign = {
      tx_hash: signedCall.txHash,
      explorer_url: signedCall.explorer_url,
      signed_intent: signedIntent,
      nep413_hash: check.nep413HashB58,
      signature_verifies: check.ok,
      failures: check.failures,
    };
    const signedBody = { setup, tee: teeSummary, firewall: 'passed: agent_swap_intent succeeded', sign, ...summaryOfPlan };

    // g: publish and wait for settlement (mainnet only).
    if (!mainnet) {
      return NextResponse.json({
        state: 'signed',
        ...signedBody,
        relay: { state: 'not_submitted', reason: 'intents.near and its solver relay settle on mainnet only' },
        balances: { before, after: null },
      });
    }
    if (!check.ok) {
      return NextResponse.json(
        { state: 'signed', ...signedBody, relay: { state: 'not_submitted', reason: `local checks failed: ${check.failures.join('; ')}` }, balances: { before, after: null } },
        { status: 502 },
      );
    }
    // The nonce and spend are already consumed on-chain, so the signed intent is returned either way.
    let publish: PublishIntentResult;
    try {
      publish = await publishIntent(buildPublishIntentPayload(signedIntent, [quote.quote_hash as string]));
    } catch (error) {
      return NextResponse.json({
        state: 'signed',
        ...signedBody,
        relay: { state: 'failed', error: error instanceof Error ? error.message : String(error) },
        balances: { before, after: null },
      });
    }
    if (publish.status !== 'OK') {
      return NextResponse.json({ state: 'signed', ...signedBody, relay: { state: 'failed', error: publish.reason }, balances: { before, after: null } });
    }
    const status: IntentStatus = await waitForIntent(publish.intent_hash, { timeoutMs: SETTLE_WAIT_MS });
    const after = status.status === 'SETTLED' ? await intentsBalances(state.intents_contract, company.vault, watched) : null;
    return NextResponse.json({
      state: status.status === 'SETTLED' ? 'settled' : 'published',
      ...signedBody,
      relay: {
        state: 'published',
        intent_hash: publish.intent_hash,
        status: status.status,
        status_details: status.status_details,
        settlement_tx: status.tx_hash,
        settlement_explorer_url: status.tx_hash ? explorerUrl(status.tx_hash, config) : null,
      },
      balances: { before, after },
    });
  } catch (error) {
    return errorResponse(error);
  } finally {
    if (lockedVault) executing.delete(lockedVault);
  }
}

/** The prompt and hash a shareholder compares with `tee_prompt_hash`, and whether this server may execute. */
export async function GET(): Promise<NextResponse> {
  const config = getNetworkConfig();
  return NextResponse.json({
    system_prompt: TREASURY_SYSTEM_PROMPT,
    prompt_sha256: treasuryPromptHash(),
    network: config.network,
    execution_enabled: config.network !== 'mainnet' || process.env.INCORPR_ALLOW_MAINNET_REBALANCE === 'true',
    tee_configured: teeConfigured(),
  });
}
