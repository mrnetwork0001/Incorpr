// 1Click request and response types, and pure quote builders. No network and no secrets, so the
// browser can build a quote and send it to /api/intents, which checks it and forwards it.
//
// PAYING A COMPANY IN A TOKEN OTHER THAN USDC
//
// A vault books revenue only in its `ft_on_transfer`, which the token calls on `ft_transfer_call`.
// A plain `ft_transfer` to the vault moves the funds but books nothing, and the vault has no method
// to claim them afterwards. Two paths reach `ft_on_transfer`:
//
// 1. Direct (`buildVaultPaymentQuote`). 1Click's `customRecipientMsg` makes its withdrawal from
//    intents.near an `ft_transfer_call`. Checked against the deployed code: intents.near is
//    near/intents rev 16d04f6 (`contract_source_metadata`), where `do_ft_withdraw` calls
//    `ft_transfer_call` when `msg` is set and `ft_resolve_withdraw` credits any amount the receiver
//    returned to the withdrawing account. Consequences, all visible on-chain:
//    - the vault records `payer = intents.near`, not the customer;
//    - if the vault refuses (price changed, call id already paid), the refund goes to 1Click's
//      intents account, not the customer. `assertRecipientIsVault` checks every refusal condition
//      before the quote, but a race between that check and delivery cannot be excluded;
//    - 1Click marks the field HIGHLY EXPERIMENTAL.
// 2. Two steps (`buildSelfDeliveryQuote`, the default). 1Click delivers exactly the price in USDC
//    to the customer's own NEAR account, then the customer's wallet pays the vault with
//    `ft_transfer_call`. A refusal refunds the customer, and the vault records the customer as
//    payer, so its related-party check applies. It costs one more wallet confirmation.
//
// In both cases revenue counts as booked only once `get_payment(call_id)` on the vault returns a
// record. A 1Click status of SUCCESS is not enough.

export type SwapType = 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT' | 'ANY_INPUT';
export type DepositType = 'ORIGIN_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
export type RefundType = 'ORIGIN_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
export type RecipientType = 'DESTINATION_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';

export const MAINNET_USDC_ASSET = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
}

export interface QuoteRequest {
  dry: boolean;
  swapType: SwapType;
  slippageTolerance: number;
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: RefundType;
  recipient: string;
  recipientType: RecipientType;
  deadline: string;
  quoteWaitingTimeMs?: number;
  customRecipientMsg?: string;
  referral?: string;
  sessionId?: string;
  connectedWallets?: string[];
}

export interface QuoteDetails {
  depositAddress?: string;
  depositMemo?: string | null;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn?: string;
  maxAmountIn?: string;
  amountOut: string;
  amountOutFormatted: string;
  /** Display only. Never use a `*Usd` field in logic. */
  amountOutUsd: string;
  minAmountOut?: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
}

export interface QuoteResponse {
  correlationId?: string;
  timestamp: string;
  signature?: string;
  quoteRequest: QuoteRequest;
  quote: QuoteDetails;
}

export type ExecutionStatus =
  | 'KNOWN_DEPOSIT_TX'
  | 'PENDING_DEPOSIT'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED';

export const TERMINAL_STATUSES: readonly ExecutionStatus[] = ['SUCCESS', 'REFUNDED', 'FAILED'];

export interface StatusResponse {
  correlationId: string;
  status: ExecutionStatus;
  updatedAt: string;
  quoteResponse: QuoteResponse;
  swapDetails: Record<string, unknown>;
}

export function vaultPaymentMsg(callId: string): string {
  return JSON.stringify({ call_id: callId });
}

interface PaymentQuoteParams {
  dry: boolean;
  /** 1Click asset id the customer pays with, from GET /v0/tokens. */
  originAsset: string;
  /** `nep141:<vault usdc_token>`. */
  usdcAsset: string;
  /** Exact USDC to deliver, normally the vault's `price_micro_usdc`. */
  amount: string;
  /** Where 1Click returns the origin asset if the swap fails. An origin-chain address or NEAR account. */
  refundTo: string;
  slippageBps?: number;
  ttlMs?: number;
  refundType?: RefundType;
  depositType?: DepositType;
}

function exactOutputQuote(params: PaymentQuoteParams, recipient: string, customRecipientMsg?: string): QuoteRequest {
  return {
    dry: params.dry,
    // EXACT_OUTPUT: any other type can deliver less than the price, which the vault would refuse.
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: params.slippageBps ?? 100,
    originAsset: params.originAsset,
    depositType: params.depositType ?? 'ORIGIN_CHAIN',
    destinationAsset: params.usdcAsset,
    amount: params.amount,
    refundTo: params.refundTo,
    refundType: params.refundType ?? 'ORIGIN_CHAIN',
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + (params.ttlMs ?? 15 * 60_000)).toISOString(),
    ...(customRecipientMsg === undefined ? {} : { customRecipientMsg }),
  };
}

/**
 * Path 1, direct: delivers exactly `amount` USDC to the vault through `ft_on_transfer`. The server
 * runs `assertRecipientIsVault` on every quote that sets `customRecipientMsg`.
 */
export function buildVaultPaymentQuote(params: PaymentQuoteParams & { vault: string; callId: string }): QuoteRequest {
  return exactOutputQuote(params, params.vault, vaultPaymentMsg(params.callId));
}

/**
 * Path 2, step 1: delivers exactly `amount` USDC to the payer's own NEAR account with a plain
 * `ft_transfer`. The payer must already hold a storage deposit on the USDC token, or intents.near
 * sends nothing and refunds nothing (its `FtWithdraw.msg` documentation says so).
 */
export function buildSelfDeliveryQuote(params: PaymentQuoteParams & { payer: string }): QuoteRequest {
  return exactOutputQuote(params, params.payer);
}

/** `nep141:<contract>` to `<contract>`, or null for an asset that is not a NEAR NEP-141 token. */
export function nep141Contract(assetId: string): string | null {
  return assetId.startsWith('nep141:') ? assetId.slice('nep141:'.length) : null;
}
