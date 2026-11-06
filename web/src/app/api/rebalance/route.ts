import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, enforceKeyedLimit, enforceRateLimit, errorResponse, parseJsonBody } from '@/lib/api';
import {
  RegistryClient,
  VaultClient,
  isFree,
  type SignedIntent,
  type SwapProposal,
  type TeeProof,
  type VaultState,
} from '@/lib/contracts';
import { getNetworkConfig, NearViewError, txExplorerUrl } from '@/lib/near';
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
  publishIntent,
  randomNonce,
  solverQuote,
  type OneClickToken,
  type PublishIntentResult,
} from '@/lib/nearIntents';
import { operatorAccountId, operatorCall } from '@/lib/operator';
import {
  TREASURY_SYSTEM_PROMPT,
  buildSwapTeeRequest,
  epochCapRemaining,
  parseApproval,
  planRebalance,
  priceFloorMinBuy,
  treasuryPromptHash,
  type TreasuryHolding,
} from '@/lib/rebalance';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const RATE_LIMIT = { route: 'rebalance', perIpPerMinute: 6, globalPerMinute: 20 };
const PER_TOKEN_PER_MINUTE = 2;
const MIN_DRIFT_BPS = 200;
const SLIPPAGE_BPS = 100;
const MAX_TEE_RESPONSE_BYTES = 16_384;
/** Must outlast the vault's 300 s intent deadline, or `intents.near` refuses the nonce. */
const NONCE_TTL_MS = 15 * 60_000;
const SOLVER_MIN_DEADLINE_MS = 300_000;

const BTC_ASSET = 'nep141:btc.omft.near';
const SOL_ASSET = 'nep141:sol.omft.near';

const Body = z.strictObject({
  token_id: z.string().regex(/^\d{1,20}$/, 'must be a decimal token id'),
  dry_run: z.boolean().optional(),
});

function priceMicroUsd(token: OneClickToken): bigint {
  return BigInt(Math.round(token.price * 1_000_000));
}

/** Testnet USDC has no 1Click market, so it prices as mainnet USDC. BTC and SOL ids are the same on both. */
function marketAsset(asset: string, usdcAsset: string): string {
  return asset === usdcAsset ? MAINNET_USDC_ASSET : asset;
}

async function readHoldings(vaultId: string, state: VaultState) {
  const usdcAsset = `nep141:${state.usdc_token}`;
  const assets: [string, string, string] = [BTC_ASSET, SOL_ASSET, usdcAsset];
  const tokens = await getTokens();
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
      return { asset, balance: BigInt(balance), decimals: market.decimals, priceMicroUsd: priceMicroUsd(market) };
    }),
  );
  return { holdings: holdings as [TreasuryHolding, TreasuryHolding, TreasuryHolding], usdcAsset };
}

function assertAgentCanAct(state: VaultState, operator: string | null): void {
  if (!isFree(state.encumbrance) || state.in_transit) {
    throw new ApiError(409, 'The vault is encumbered or in transit, so the agent is frozen');
  }
  if (operator !== null && state.policy.operator !== operator) {
    throw new ApiError(409, `The vault's operator is ${state.policy.operator}, not this server's ${operator}`);
  }
  if (!state.intents_key_registered) {
    throw new ApiError(409, 'The vault has no intents key. Anyone can call setup_intents_key.');
  }
}

async function chooseModel(state: VaultState): Promise<string> {
  const preferred = await pickDefaultModel();
  if (state.policy.tee_models.includes(preferred)) return preferred;
  const allowed = state.policy.tee_models.find((model) => directEndpointFor(model));
  if (!allowed) {
    throw new ApiError(409, `The vault allows models ${JSON.stringify(state.policy.tee_models)}, none with a known direct host`);
  }
  return allowed;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, RATE_LIMIT);
    const { token_id, dry_run } = await parseJsonBody(request, Body);
    enforceKeyedLimit(`rebalance:token:${token_id}`, PER_TOKEN_PER_MINUTE, `Company ${token_id} was rebalanced a moment ago`);
    const config = getNetworkConfig();
    const mainnet = config.network === 'mainnet';

    // Refuse before any quote when a signing run could not complete anyway.
    if (!dry_run) {
      if (mainnet && process.env.INCORPR_ALLOW_MAINNET_REBALANCE !== 'true') {
        throw new ApiError(403, 'Mainnet rebalance moves real funds. Set INCORPR_ALLOW_MAINNET_REBALANCE=true to enable it.');
      }
      if (!teeConfigured()) throw new TeeApiKeyMissingError();
    }

    const company = await new RegistryClient().getCompany(token_id);
    if (!company) throw new ApiError(404, `Company ${token_id} does not exist`);
    const vault = new VaultClient(company.vault);
    const state = await vault.getState();
    assertAgentCanAct(state, null);

    // Target comes from chain, not the caller, so calling this route can only move a treasury toward
    // what its charter already says, inside the vault's caps and floors.
    const { holdings } = await readHoldings(company.vault, state);
    const plan = planRebalance({
      holdings,
      targetBps: company.target_bps,
      minDriftBps: MIN_DRIFT_BPS,
      capRemaining: epochCapRemaining(state, Date.now()),
    });
    if (plan.kind === 'noop') {
      return NextResponse.json({
        state: 'noop',
        reason: plan.reason,
        drift_bps: plan.driftBps,
        total_micro_usd: plan.totalMicroUsd,
      });
    }

    const sellToken = plan.sell.asset;
    const buyToken = plan.buy.asset;
    if (!state.policy.allowed_tokens.includes(sellToken) || !state.policy.allowed_tokens.includes(buyToken)) {
      throw new ApiError(409, `The vault's allowlist does not include both ${sellToken} and ${buyToken}`);
    }
    const floor = priceFloorMinBuy(state, sellToken, buyToken, plan.sellAmount);
    if (floor === null) throw new ApiError(409, `The vault has no price floor for ${sellToken} to ${buyToken}`);

    // A token_diff settles only against a solver quoting the exact amount, so on mainnet the solver's
    // amount is the minimum. Testnet has no solvers, so a dry 1Click quote prices the proposal.
    const planned = {
      sell_token: sellToken,
      sell_amount: plan.sellAmount.toString(),
      buy_token: buyToken,
      price_floor_min_buy: floor.toString(),
      drift_bps: plan.driftBps,
      total_micro_usd: plan.totalMicroUsd,
      capped_by_epoch_limit: plan.cappedByEpochLimit,
    };
    // No market for the pair is an answer, not a failure: the plan is still shown, nothing is signed.
    const noQuote = (source: string, reason: string, correlationId?: string) =>
      NextResponse.json({ state: 'no_quote', quote_source: source, reason, correlation_id: correlationId ?? null, planned });

    let minBuyAmount: bigint;
    let quoteHash: string | null = null;
    let quoteSource: string;
    if (mainnet) {
      const best = bestSolverQuote(
        await solverQuote({
          assetIn: sellToken,
          assetOut: buyToken,
          exactAmountIn: plan.sellAmount.toString(),
          minDeadlineMs: SOLVER_MIN_DEADLINE_MS,
        }),
      );
      if (!best) return noQuote('solver_relay', `No solver quoted ${plan.sellAmount} ${sellToken} to ${buyToken}`);
      minBuyAmount = BigInt(best.amount_out);
      quoteHash = best.quote_hash;
      quoteSource = 'solver_relay';
    } else {
      const usdcAsset = `nep141:${state.usdc_token}`;
      // Price read only: a dry quote commits nothing, and 1Click needs a valid mainnet account here.
      // INTENTS to INTENTS is the trade the vault would sign: a token_diff between intents balances.
      let dry;
      try {
        dry = await getQuote({
          dry: true,
          swapType: 'EXACT_INPUT',
          slippageTolerance: SLIPPAGE_BPS,
          originAsset: marketAsset(sellToken, usdcAsset),
          depositType: 'INTENTS',
          destinationAsset: marketAsset(buyToken, usdcAsset),
          amount: plan.sellAmount.toString(),
          refundTo: 'intents.near',
          refundType: 'INTENTS',
          recipient: 'intents.near',
          recipientType: 'INTENTS',
          deadline: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
        });
      } catch (error) {
        if (error instanceof OneClickError && /no liquidity/i.test(error.message)) {
          return noQuote('1click_dry_quote', error.message, error.correlationId);
        }
        throw error;
      }
      minBuyAmount = BigInt(dry.quote.minAmountOut ?? dry.quote.amountOut);
      quoteSource = '1click_dry_quote';
    }
    if (minBuyAmount < floor) {
      throw new ApiError(409, `The live quote of ${minBuyAmount} is below the price floor of ${floor}`);
    }

    let nonce: string;
    if (mainnet) {
      nonce = buildIntentNonce(await currentSalt(state.intents_contract), Date.now() + NONCE_TTL_MS);
    } else {
      nonce = randomNonce();
    }

    const proposal: SwapProposal = {
      sell_token: sellToken,
      sell_amount: plan.sellAmount.toString(),
      buy_token: buyToken,
      min_buy_amount: minBuyAmount.toString(),
      nonce_b64: nonce,
    };
    const summaryOfPlan = {
      proposal,
      quote_source: quoteSource,
      price_floor_min_buy: floor.toString(),
      drift_bps: plan.driftBps,
      total_micro_usd: plan.totalMicroUsd,
      capped_by_epoch_limit: plan.cappedByEpochLimit,
    };
    if (dry_run) return NextResponse.json({ state: 'dry_run', ...summaryOfPlan });

    assertAgentCanAct(state, operatorAccountId());
    if (state.policy.tee_prompt_hash !== treasuryPromptHash()) {
      throw new ApiError(
        409,
        `The vault pins prompt hash ${state.policy.tee_prompt_hash || '(none)'}, this server's prompt hashes to ${treasuryPromptHash()}`,
      );
    }

    const model = await chooseModel(state);
    const context = {
      vaultAccount: company.vault,
      treasuryEpoch: state.treasury_epoch,
      ownerGeneration: state.owner_generation,
    };
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
    if (!decision.approved) {
      return NextResponse.json(
        {
          state: 'rejected',
          reason: decision.reason,
          model_output: decision.modelOutput,
          chat_id: inference.chatId,
          ...summaryOfPlan,
        },
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
    const { txHash, value: signedIntent } = await operatorCall<SignedIntent>(vault.agentSwapIntent(proposal, tee));
    if (!signedIntent) throw new ApiError(502, `agent_swap_intent returned no intent. Transaction ${txHash}.`);

    let submission:
      | { state: 'not_submitted'; reason: string }
      | { state: 'published'; result: PublishIntentResult }
      | { state: 'failed'; error: string };
    if (!mainnet) {
      submission = { state: 'not_submitted', reason: 'intents.near and its solver relay settle on mainnet only' };
    } else {
      // The nonce and spend are already consumed on-chain, so the signed intent is returned either way.
      try {
        const result = await publishIntent(buildPublishIntentPayload(signedIntent, [quoteHash as string]));
        submission = { state: 'published', result };
      } catch (error) {
        submission = { state: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    }

    return NextResponse.json({
      state: 'signed',
      ...summaryOfPlan,
      signed_intent: signedIntent,
      tx_hash: txHash,
      explorer_url: txExplorerUrl(txHash),
      chat_id: inference.chatId,
      model,
      verification,
      verification_summary: verificationSummary,
      submission,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The prompt and hash a shareholder compares with `tee_prompt_hash`. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    system_prompt: TREASURY_SYSTEM_PROMPT,
    prompt_sha256: treasuryPromptHash(),
    network: getNetworkConfig().network,
  });
}
