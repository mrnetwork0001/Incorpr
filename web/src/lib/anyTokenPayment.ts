// Paying a company in a token other than USDC, through NEAR Intents 1Click. Mainnet only: 1Click
// and intents.near have no testnet deployment, so on testnet customers pay Test USDC directly with
// `payForService` (actions.ts).
//
// Why two paths, and why two steps is the default: see the header of intentsQuotes.ts.
//
// Flow, both paths:
//   prepareAnyTokenPayment   reads the vault price, picks a call id, gets a live 1Click quote through
//                            /api/intents (which re-checks a direct quote against chain state)
//   executeAnyTokenPayment   sends the deposit from the wallet when the origin token lives on NEAR,
//                            tells 1Click about it, follows /v0/status to a terminal state, then
//                            (two steps) pays the vault from the delivered USDC, and in every case
//                            reads `get_payment` to decide whether revenue is booked.
// For an origin asset on another chain (BTC, SOL, EVM): call `executeAnyTokenPayment` first when
// `depositCalls` is set (two steps: it registers the payer on USDC, which must happen before 1Click
// delivers), then send `amountIn` to `depositAddress` from the wallet on that chain. The status poll
// in `executeAnyTokenPayment` waits for the deposit; `externalDepositTxHash` lets 1Click find it sooner.

import { ActionRefusedError, newCallSalt, payForService, registrationIfMissing, type PayResult, type TxSender } from './actions';
import { VaultClient, ftCalls, ftViews, serviceCallId, vaultAccountFor, type ContractCall, type Payment } from './contracts';
import {
  TERMINAL_STATUSES,
  buildSelfDeliveryQuote,
  buildVaultPaymentQuote,
  nep141Contract,
  type ExecutionStatus,
  type OneClickToken,
  type QuoteResponse,
  type StatusResponse,
} from './intentsQuotes';
import { getNetworkConfig, requireRegistryId } from './near';

export type AnyTokenMode = 'two_step' | 'direct';

export interface PrepareParams {
  tokenId: string;
  input: string;
  /** From GET /api/intents?op=tokens. */
  origin: OneClickToken;
  /** Where 1Click returns the origin asset if it cannot fill. Defaults to the payer's NEAR account for NEAR tokens. */
  refundTo?: string;
  mode?: AnyTokenMode;
  salt?: string;
  slippageBps?: number;
  /** For `nep141:wrap.near`: wrap this much native NEAR first. */
  wrapNative?: boolean;
  apiBase?: string;
  registryId?: string;
}

export interface AnyTokenPaymentPlan {
  mode: AnyTokenMode;
  tokenId: string;
  vault: string;
  input: string;
  salt: string;
  callId: string;
  /** micro-USDC the vault charges per call now. */
  price: string;
  quote: QuoteResponse;
  depositAddress: string;
  depositMemo: string | null;
  /** Origin units to send to `depositAddress`. */
  amountIn: string;
  /** Wallet calls that make the deposit, or null when the origin asset is not on NEAR. */
  depositCalls: ContractCall[] | null;
}

export interface AnyTokenPaymentResult {
  status: ExecutionStatus;
  /** Hashes of every NEAR transaction this flow signed, in order. */
  txHashes: string[];
  callId: string;
  salt: string;
  /** True only when the vault holds a payment record for `callId`. */
  booked: boolean;
  payment: Payment | null;
  /** Two-step path only: the vault payment made from the delivered USDC. */
  vaultPayment: PayResult | null;
  oneClick: StatusResponse | null;
}

async function api<T>(apiBase: string, init: RequestInit & { query?: Record<string, string> }): Promise<T> {
  const url = new URL('/api/intents', apiBase);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init.body,
    cache: 'no-store',
  });
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `/api/intents answered HTTP ${res.status}`);
  return body;
}

function defaultApiBase(): string {
  if (typeof window !== 'undefined') return window.location.origin;
  throw new Error('apiBase is required outside the browser');
}

export function anyTokenPaymentsAvailable(): { available: true } | { available: false; reason: string } {
  return getNetworkConfig().network === 'mainnet'
    ? { available: true }
    : {
        available: false,
        reason: 'NEAR Intents and 1Click settle on mainnet only. On testnet, pay in Test USDC with ft_transfer_call.',
      };
}

export async function prepareAnyTokenPayment(sender: TxSender, params: PrepareParams): Promise<AnyTokenPaymentPlan> {
  const availability = anyTokenPaymentsAvailable();
  if (!availability.available) throw new ActionRefusedError(availability.reason);
  const mode = params.mode ?? 'two_step';
  const apiBase = params.apiBase ?? defaultApiBase();
  const registryId = params.registryId ?? requireRegistryId();
  const vaultId = vaultAccountFor(params.tokenId, registryId);
  const vault = new VaultClient(vaultId, { finality: 'optimistic' });
  const state = await vault.getState();
  const usdcAsset = `nep141:${state.usdc_token}`;
  if (params.origin.assetId === usdcAsset) {
    throw new ActionRefusedError('This is the vault USDC itself. Pay it directly with payForService.');
  }

  const salt = params.salt ?? newCallSalt();
  const callId = serviceCallId(params.input, salt);
  if (await vault.getPayment(callId)) throw new ActionRefusedError(`Call id ${callId} is already paid`);

  const originContract = params.origin.blockchain === 'near' ? nep141Contract(params.origin.assetId) : null;
  const refundTo = params.refundTo ?? (originContract ? sender.accountId : undefined);
  if (!refundTo) throw new ActionRefusedError(`Give a ${params.origin.blockchain} refund address for ${params.origin.symbol}`);

  const common = {
    dry: false,
    originAsset: params.origin.assetId,
    usdcAsset,
    amount: state.price_micro_usdc,
    refundTo,
    slippageBps: params.slippageBps,
  };
  const request =
    mode === 'direct'
      ? buildVaultPaymentQuote({ ...common, vault: vaultId, callId })
      : buildSelfDeliveryQuote({ ...common, payer: sender.accountId });
  const quote = await api<QuoteResponse>(apiBase, { method: 'POST', body: JSON.stringify({ op: 'quote', ...request }) });
  const depositAddress = quote.quote.depositAddress;
  if (!depositAddress) throw new Error('1Click returned no deposit address');

  let depositCalls: ContractCall[] | null = null;
  // Two steps: intents.near sends nothing and refunds nothing to an account with no storage deposit.
  const payerRegistration = mode === 'two_step' ? await registrationIfMissing(state.usdc_token, sender.accountId) : [];
  if (originContract) {
    const { min } = await ftViews.storageBalanceBounds(originContract);
    depositCalls = [
      ...payerRegistration,
      ...(params.wrapNative && originContract === 'wrap.near'
        ? [...(await registrationIfMissing(originContract, sender.accountId)), ftCalls.nearDeposit(originContract, quote.quote.amountIn)]
        : []),
      ftCalls.storageDeposit(originContract, depositAddress, min),
      ftCalls.ftTransfer(originContract, depositAddress, quote.quote.amountIn, quote.quote.depositMemo ?? undefined),
    ];
  } else if (payerRegistration.length > 0) {
    depositCalls = payerRegistration;
  }

  return {
    mode,
    tokenId: params.tokenId,
    vault: vaultId,
    input: params.input,
    salt,
    callId,
    price: state.price_micro_usdc,
    quote,
    depositAddress,
    depositMemo: quote.quote.depositMemo ?? null,
    amountIn: quote.quote.amountIn,
    depositCalls,
  };
}

export interface ExecuteOptions {
  apiBase?: string;
  registryId?: string;
  /** Origin-chain transaction that paid `depositAddress`, for assets not on NEAR. Speeds up detection. */
  externalDepositTxHash?: string;
  onStatus?: (status: ExecutionStatus) => void;
  timeoutMs?: number;
  pollMs?: number;
}

export async function executeAnyTokenPayment(
  sender: TxSender,
  plan: AnyTokenPaymentPlan,
  options: ExecuteOptions = {},
): Promise<AnyTokenPaymentResult> {
  const apiBase = options.apiBase ?? defaultApiBase();
  const txHashes: string[] = [];

  let depositTxHash = options.externalDepositTxHash;
  if (plan.depositCalls && plan.depositCalls.length > 0) {
    const results = await sender.send(plan.depositCalls);
    txHashes.push(...results.map((r) => r.txHash));
    const transfer = plan.depositCalls.findIndex((c) => c.methodName === 'ft_transfer');
    if (transfer >= 0) depositTxHash = results[transfer]?.txHash;
  }
  if (depositTxHash) {
    await api(apiBase, {
      method: 'POST',
      body: JSON.stringify({
        op: 'deposit_submit',
        txHash: depositTxHash,
        depositAddress: plan.depositAddress,
        ...(plan.depositCalls ? { nearSenderAccount: sender.accountId } : {}),
        ...(plan.depositMemo ? { memo: plan.depositMemo } : {}),
      }),
    });
  }

  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  let oneClick: StatusResponse | null = null;
  for (;;) {
    oneClick = await api<StatusResponse>(apiBase, {
      query: { op: 'status', depositAddress: plan.depositAddress, ...(plan.depositMemo ? { depositMemo: plan.depositMemo } : {}) },
    });
    options.onStatus?.(oneClick.status);
    if (TERMINAL_STATUSES.includes(oneClick.status)) break;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 5_000));
  }

  let vaultPayment: PayResult | null = null;
  if (oneClick.status === 'SUCCESS' && plan.mode === 'two_step') {
    vaultPayment = await payForService(sender, { tokenId: plan.tokenId, input: plan.input, salt: plan.salt }, { registryId: options.registryId });
    txHashes.push(...vaultPayment.txHashes);
  }

  // Booked is decided by the vault's record alone, whatever 1Click reported.
  const booked = await api<{ booked: boolean; payment: Payment | null }>(apiBase, {
    query: { op: 'vault_payment', token_id: plan.tokenId, call_id: plan.callId },
  });
  return {
    status: oneClick.status,
    txHashes,
    callId: plan.callId,
    salt: plan.salt,
    booked: booked.booked,
    payment: booked.payment,
    vaultPayment,
    oneClick,
  };
}
