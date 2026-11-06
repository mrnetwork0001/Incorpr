import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, enforceRateLimit, errorResponse, parseJsonBody, parseValue } from '@/lib/api';
import { getNetworkConfig, requireRegistryId } from '@/lib/near';
import {
  assertRecipientIsVault,
  getQuote,
  getStatus,
  getTokens,
  submitDeposit,
  vaultPaymentState,
  type QuoteRequest,
} from '@/lib/nearIntents';
import { vaultAccountFor } from '@/lib/contracts';

export const dynamic = 'force-dynamic';

const RATE_LIMIT = { route: 'intents', perIpPerMinute: 60, globalPerMinute: 600 };

const amount = z.string().regex(/^\d{1,40}$/, 'must be an integer amount in base units');
const asset = z.string().min(1).max(128);
const account = z.string().min(1).max(128);
const destinationKinds = z.enum(['DESTINATION_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']);
const originKinds = z.enum(['ORIGIN_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']);

const Quote = z.strictObject({
  op: z.literal('quote'),
  dry: z.boolean(),
  swapType: z.enum(['EXACT_INPUT', 'EXACT_OUTPUT', 'FLEX_INPUT']),
  slippageTolerance: z.number().int().min(0).max(1_000),
  originAsset: asset,
  depositType: originKinds,
  destinationAsset: asset,
  amount,
  refundTo: account,
  refundType: originKinds,
  recipient: account,
  recipientType: destinationKinds,
  deadline: z.iso.datetime(),
  quoteWaitingTimeMs: z.number().int().min(0).max(10_000).optional(),
  customRecipientMsg: z.string().max(256).optional(),
});

const DepositSubmit = z.strictObject({
  op: z.literal('deposit_submit'),
  txHash: z.string().min(1).max(128),
  depositAddress: account,
  nearSenderAccount: account.optional(),
  memo: z.string().max(128).optional(),
});

const Post = z.discriminatedUnion('op', [Quote, DepositSubmit]);

const StatusQuery = z.strictObject({
  op: z.literal('status'),
  depositAddress: account,
  depositMemo: z.string().max(128).optional(),
});

const TokensQuery = z.strictObject({ op: z.literal('tokens') });
/** Booked means the vault holds a record for the call id. Read from chain, never from 1Click. */
const VaultPaymentQuery = z.strictObject({
  op: z.literal('vault_payment'),
  token_id: z.string().regex(/^\d{1,20}$/, 'must be a decimal token id'),
  call_id: z.string().min(1).max(64),
});
const Get = z.discriminatedUnion('op', [TokensQuery, StatusQuery, VaultPaymentQuery]);

async function guardVaultPayment(quote: QuoteRequest): Promise<void> {
  if (quote.customRecipientMsg === undefined) return;
  if (getNetworkConfig().network !== 'mainnet') {
    throw new ApiError(422, 'customRecipientMsg settles on mainnet only. Preview a testnet payment without it.');
  }
  let callId: unknown;
  try {
    callId = (JSON.parse(quote.customRecipientMsg) as { call_id?: unknown }).call_id;
  } catch {
    callId = undefined;
  }
  if (typeof callId !== 'string' || callId.length === 0 || callId.length > 64) {
    throw new ApiError(422, 'customRecipientMsg must be {"call_id":"<1..64 chars>"}');
  }
  if (quote.recipientType !== 'DESTINATION_CHAIN') {
    throw new ApiError(422, 'customRecipientMsg needs recipientType DESTINATION_CHAIN');
  }
  // Any other swap type can deliver less than `amount`. The vault refunds an underpayment to the
  // solver that delivered it, not to the customer.
  if (quote.swapType !== 'EXACT_OUTPUT') {
    throw new ApiError(422, 'customRecipientMsg needs swapType EXACT_OUTPUT, so the vault receives the full price');
  }
  await assertRecipientIsVault({
    recipient: quote.recipient,
    destinationAsset: quote.destinationAsset,
    amount: quote.amount,
    callId,
    registryId: requireRegistryId(),
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, RATE_LIMIT);
    const query = parseValue(Object.fromEntries(new URL(request.url).searchParams), Get);
    if (query.op === 'tokens') return NextResponse.json({ tokens: await getTokens() });
    if (query.op === 'vault_payment') {
      const vault = vaultAccountFor(query.token_id, requireRegistryId());
      return NextResponse.json({ vault, call_id: query.call_id, ...(await vaultPaymentState(vault, query.call_id)) });
    }
    return NextResponse.json(await getStatus(query.depositAddress, query.depositMemo));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, RATE_LIMIT);
    const body = await parseJsonBody(request, Post);
    if (body.op === 'deposit_submit') {
      const { op: _op, ...deposit } = body;
      return NextResponse.json(await submitDeposit(deposit));
    }
    const { op: _op, ...quote } = body;
    if (!quote.dry && getNetworkConfig().network !== 'mainnet') {
      throw new ApiError(422, '1Click settles on mainnet only, so a testnet deployment serves dry quotes');
    }
    await guardVaultPayment(quote);
    return NextResponse.json(await getQuote(quote));
  } catch (error) {
    return errorResponse(error);
  }
}
