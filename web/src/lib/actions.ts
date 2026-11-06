// Owner, buyer, lender and customer actions, signed by the connected wallet.
//
// Each action reads the chain state it needs (price, ask, sync nonce, debt), builds the calls with
// contracts.ts, sends them through a `TxSender`, then reads state again to report what happened.
// A successful `ft_transfer_call` transaction can still mean the receiver refused and refunded, so
// the outcome fields (`booked`, `acquired`, `funded`, `repaid`, ...) come from contract state, never
// from the transaction status alone. When the registry refunded, `refusal` carries the ERR_ code it
// logged.
//
// Pre-checks throw `ActionRefusedError` before anything is signed, for conditions that would only
// waste a transaction fee (wrong owner, not listed, dirty epoch). The encumbrance freeze on the
// shareholder methods (claim dividends, sign, rotate) is deliberately not pre-checked: the vault
// refuses on-chain with ERR_ACCOUNT_ENCUMBERED_*, and that failed transaction is the evidence the
// cockpit shows.
//
// Errors: `describeActionError(error)` turns anything an action throws into
// `{ code, message, kind, raw, txHash }` for the UI.
//
// Browser: `useWallet().sender` (wallet.tsx). Tests: a near-api-js Account wrapped as a TxSender.

import {
  RegistryClient,
  SIGNATURE_DEPOSIT,
  VaultClient,
  ftCalls,
  ftViews,
  isFree,
  serviceCallId,
  usdcCalls,
  vaultAccountFor,
  type CompanyView,
  type ContractCall,
  type Incorporate,
  type ListingView,
  type Loan,
  type Offer,
  type Payment,
  type PledgeTerms,
  type TreasuryAddresses,
  type U128,
  type VaultState,
} from './contracts';
import { requireRegistryId } from './near';
import { TransactionFailedError, describeContractError, type ContractError, type TxResult } from './txOutcome';

/** Signs and sends each call as its own transaction, in order, and returns one result per call. */
export interface TxSender {
  accountId: string;
  send(calls: ContractCall[]): Promise<TxResult[]>;
}

/** The action was not sent, because chain state says it would fail. Nothing was signed. */
export class ActionRefusedError extends Error {
  constructor(
    message: string,
    /** The ERR_ code the contract would have answered with, when there is one. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ActionRefusedError';
  }
}

export interface ActionError extends ContractError {
  /** The failed transaction, or null when nothing was sent. */
  txHash: string | null;
}

/**
 * One shape for every failure an action can throw: a pre-check refusal, a failed transaction (with
 * its root-cause ERR_ code), a wallet rejection or redirect, or a network error.
 */
export function describeActionError(error: unknown): ActionError {
  if (error instanceof TransactionFailedError) return { ...error.error, txHash: error.txHash };
  if (error instanceof ActionRefusedError) {
    return { code: error.code, message: error.message, kind: 'contract', raw: error.message, txHash: null };
  }
  if (error instanceof Error && error.name === 'WalletRedirectError') {
    return { code: null, message: error.message, kind: 'unknown', raw: error.message, txHash: null };
  }
  return { ...describeContractError(error), txHash: null };
}

export interface ActionOptions {
  registryId?: string;
}

// Reads after a transaction use optimistic finality: the wallet may return before the block is final.
const LATEST = { finality: 'optimistic' } as const;

function registryOf(options: ActionOptions): RegistryClient {
  return new RegistryClient(options.registryId ?? requireRegistryId(), LATEST);
}

function vaultOf(registry: RegistryClient, tokenId: string): VaultClient {
  return new VaultClient(vaultAccountFor(tokenId, registry.registryId), LATEST);
}

function hashes(results: TxResult[]): string[] {
  return results.map((r) => r.txHash);
}

function last<T>(results: TxResult[]): TxResult<T> {
  const result = results[results.length - 1];
  if (!result) throw new Error('The wallet returned no transaction result');
  return result as TxResult<T>;
}

function refusalOf(results: TxResult[]): ContractError | null {
  return results.find((r) => r.refusal)?.refusal ?? null;
}

async function requireCompany(registry: RegistryClient, tokenId: string): Promise<CompanyView> {
  const company = await registry.getCompany(tokenId);
  if (!company) throw new ActionRefusedError(`Company ${tokenId} does not exist on ${registry.registryId}`, 'ERR_TOKEN_NOT_FOUND');
  return company;
}

/** A NEP-145 registration for `accountId` on `token`, or nothing when it already has one. */
export async function registrationIfMissing(token: string, accountId: string): Promise<ContractCall[]> {
  if (await ftViews.storageBalanceOf(token, accountId, LATEST)) return [];
  const { min } = await ftViews.storageBalanceBounds(token, LATEST);
  return [ftCalls.storageDeposit(token, accountId, min)];
}

async function requireBalance(token: string, accountId: string, amount: bigint, purpose: string): Promise<void> {
  const balance = BigInt(await ftViews.balanceOf(token, accountId, LATEST));
  if (balance < amount) {
    throw new ActionRefusedError(`${purpose} needs ${amount} of ${token}; ${accountId} holds ${balance}`);
  }
}

function requireOwner(company: CompanyView, accountId: string): void {
  if (company.owner_id !== accountId) {
    throw new ActionRefusedError(`Company ${company.token_id} is owned by ${company.owner_id}, not ${accountId}`, 'ERR_NOT_TOKEN_OWNER');
  }
}

function requireNotSettling(company: CompanyView): void {
  if (company.settling) {
    throw new ActionRefusedError(`Company ${company.token_id} has a settlement running. Try again in a few seconds.`, 'ERR_TOKEN_SETTLING');
  }
}

/** Raw signatures this epoch, or a live agent intent, make the vault refuse a freeze or transfer. */
function requireCleanKeys(state: VaultState, verb: string): void {
  if (state.raw_sigs_this_epoch > 0) {
    throw new ActionRefusedError(
      `The vault signed raw payloads this epoch. Rotate the treasury epoch before ${verb}.`,
      'ERR_RAW_SIGNATURES_THIS_EPOCH',
    );
  }
  if (state.latest_intent_deadline_ms >= Date.now()) {
    const at = new Date(state.latest_intent_deadline_ms).toISOString();
    throw new ActionRefusedError(
      `A treasury intent signed by the agent is live until ${at}. Try ${verb} after that.`,
      'ERR_UNEXPIRED_SIGNED_INTENTS',
    );
  }
}

// ---------------------------------------------------------------------------- Founder

export interface IncorporateResult {
  txHashes: string[];
  tokenId: string;
  vault: string;
  /** yoctoNEAR attached: `incorporation_cost()`. The registry refunds what it did not use. */
  deposit: U128;
  company: CompanyView;
}

const MAX_TEXT_BYTES = 64;

function validText(text: string): boolean {
  // The registry counts UTF-8 bytes and rejects any control character.
  const bytes = new TextEncoder().encode(text).length;
  // eslint-disable-next-line no-control-regex
  return bytes > 0 && bytes <= MAX_TEXT_BYTES && !/[\u0000-\u001f\u007f-\u009f]/.test(text);
}

/** The registry's own checks on `incorporate_company`, run before signing. Returns the ERR_ code, or null. */
export function validateIncorporate(args: Incorporate): string | null {
  if (!validText(args.name)) return 'ERR_INVALID_NAME';
  if (!validText(args.service_template)) return 'ERR_INVALID_SERVICE';
  if (!/^[0-9]+$/.test(args.price_micro_usdc) || BigInt(args.price_micro_usdc) === 0n) return 'ERR_INVALID_PRICE';
  if (!Number.isInteger(args.founder_royalty_bps) || args.founder_royalty_bps < 0 || args.founder_royalty_bps > 1_000) {
    return 'ERR_INVALID_ROYALTY';
  }
  if (!Number.isInteger(args.compute_reserve_bps) || args.compute_reserve_bps < 100 || args.compute_reserve_bps > 10_000) {
    return 'ERR_INVALID_RESERVE';
  }
  const targets = args.target_bps;
  if (targets.length !== 3 || targets.some((b) => !Number.isInteger(b) || b < 0 || b > 10_000) || targets[0] + targets[1] + targets[2] !== 10_000) {
    return 'ERR_INVALID_TARGET_ALLOCATION';
  }
  return null;
}

/**
 * Mints the company NFT and creates `c-<id>.<registry>` with its vault. Attaches `incorporation_cost()`
 * (4.59454 NEAR with the current vault wasm); the registry refunds about 0.03 NEAR of it.
 */
export async function incorporate(sender: TxSender, args: Incorporate, options: ActionOptions = {}): Promise<IncorporateResult> {
  const invalid = validateIncorporate(args);
  if (invalid) throw new ActionRefusedError(describeContractError(invalid).message, invalid);
  const registry = registryOf(options);
  const deposit = await registry.incorporationCost();
  const results = await sender.send([registry.incorporateCompany(args, deposit)]);
  const done = last<string | null>(results);
  // `on_company_created` returns null when the account batch failed; the deposit was refunded.
  if (typeof done.value !== 'string') {
    throw new TransactionFailedError(done.txHash, 'incorporation_failed', {
      code: null,
      kind: 'contract',
      message: 'The registry could not create the company account and refunded the deposit.',
      raw: JSON.stringify(done.value),
    });
  }
  const company = await requireCompany(registry, done.value);
  return { txHashes: hashes(results), tokenId: done.value, vault: company.vault, deposit, company };
}

// ---------------------------------------------------------------------------- Sale

export interface ListResult {
  txHashes: string[];
  listing: ListingView | null;
  listed: boolean;
}

/**
 * Freezes the vault as Listed at `ask` micro-USDC. Registers the seller on USDC first if needed, so
 * the sale proceeds can be paid to them rather than parked in `pending_withdrawal`.
 */
export async function listCompany(sender: TxSender, tokenId: string, ask: U128, options: ActionOptions = {}): Promise<ListResult> {
  if (!/^[0-9]+$/.test(ask) || BigInt(ask) === 0n) throw new ActionRefusedError('The ask must be above zero', 'ERR_INVALID_ASK');
  const registry = registryOf(options);
  const company = await requireCompany(registry, tokenId);
  requireOwner(company, sender.accountId);
  requireNotSettling(company);
  if (!isFree(company.encumbrance)) {
    throw new ActionRefusedError(`Company ${tokenId} is already listed or pledged`, 'ERR_TOKEN_ENCUMBERED');
  }
  const state = await vaultOf(registry, tokenId).getState();
  requireCleanKeys(state, 'listing');
  const calls = [...(await registrationIfMissing(state.usdc_token, sender.accountId)), registry.listCompany(tokenId, ask)];
  const results = await sender.send(calls);
  const listing = await registry.getListing(tokenId);
  return { txHashes: hashes(results), listing, listed: listing !== null && listing.ask === ask };
}

export interface UnlistResult {
  txHashes: string[];
  unlisted: boolean;
}

export async function unlistCompany(sender: TxSender, tokenId: string, options: ActionOptions = {}): Promise<UnlistResult> {
  const registry = registryOf(options);
  const company = await requireCompany(registry, tokenId);
  requireOwner(company, sender.accountId);
  requireNotSettling(company);
  if (isFree(company.encumbrance) || !('Listed' in company.encumbrance)) {
    throw new ActionRefusedError(`Company ${tokenId} is not listed`, 'ERR_TOKEN_NOT_LISTED');
  }
  const results = await sender.send([registry.unlistCompany(tokenId)]);
  const after = await requireCompany(registry, tokenId);
  return { txHashes: hashes(results), unlisted: isFree(after.encumbrance) && (await registry.getListing(tokenId)) === null };
}

export interface BuyResult {
  txHashes: string[];
  /** True when the registry now records the buyer as owner. */
  acquired: boolean;
  price: U128;
  owner: string | null;
  /** Why the registry refunded, when it did (ERR_LISTING_CHANGED, ERR_AMOUNT_BELOW_ASK, ...). */
  refusal: ContractError | null;
}

/**
 * Pays the ask in USDC with `usdc.ft_transfer_call(registry, ask, {"action":"acquire","token_id",
 * "expected_sync_nonce"})`. The registry settles atomically: it moves the NFT and the vault's
 * shareholder and pays the seller and the founder royalty, or refunds the buyer in full. The sync
 * nonce makes a purchase against a listing that changed after it was read refund instead of settle.
 */
export async function buyCompany(sender: TxSender, tokenId: string, options: ActionOptions = {}): Promise<BuyResult> {
  const registry = registryOf(options);
  const listing = await registry.getListing(tokenId);
  if (!listing) throw new ActionRefusedError(`Company ${tokenId} is not listed`, 'ERR_TOKEN_NOT_LISTED');
  if (listing.seller === sender.accountId) {
    throw new ActionRefusedError('The seller cannot buy their own listing', 'ERR_BUYER_IS_SELLER');
  }
  const state = await vaultOf(registry, tokenId).getState();
  await requireBalance(state.usdc_token, sender.accountId, BigInt(listing.ask), 'This purchase');
  const results = await sender.send([
    usdcCalls.acquire(state.usdc_token, registry.registryId, listing.ask, tokenId, listing.sync_nonce),
  ]);
  const token = await registry.nftToken(tokenId);
  const acquired = token?.owner_id === sender.accountId;
  return {
    txHashes: hashes(results),
    acquired,
    price: listing.ask,
    owner: token?.owner_id ?? null,
    refusal: acquired ? null : refusalOf(results),
  };
}

// ---------------------------------------------------------------------------- Credit

export interface FundOfferParams {
  tokenId: string;
  /** micro-USDC sent now, paid to the borrower on `accept_offer`. At least 1,000,000. */
  principal: U128;
  /** micro-USDC owed at `due`. At least `principal`. */
  repayAmount: U128;
  termMs: number;
  terms?: PledgeTerms;
}

export interface FundOfferResult {
  txHashes: string[];
  /** The offer the registry now holds for this lender, or null when it refunded the transfer. */
  offer: Offer | null;
  refusal: ContractError | null;
}

/**
 * Lender side. Tops up the lender's registry storage to cover one offer (`offer_storage_cost`), then
 * escrows the principal with `usdc.ft_transfer_call(registry, principal, {"action":"fund_offer",...})`.
 */
export async function fundOffer(sender: TxSender, params: FundOfferParams, options: ActionOptions = {}): Promise<FundOfferResult> {
  const principal = BigInt(params.principal);
  if (principal < 1_000_000n || BigInt(params.repayAmount) < principal || !(params.termMs > 0)) {
    throw new ActionRefusedError(describeContractError('ERR_INVALID_OFFER').message, 'ERR_INVALID_OFFER');
  }
  const registry = registryOf(options);
  await requireCompany(registry, params.tokenId);
  const state = await vaultOf(registry, params.tokenId).getState();
  await requireBalance(state.usdc_token, sender.accountId, principal, 'This offer');

  const [need, bounds, storage, before] = await Promise.all([
    registry.offerStorageCost(),
    registry.storageBalanceBounds(),
    registry.storageBalanceOf(sender.accountId),
    registry.getOffers(params.tokenId),
  ]);
  const calls: ContractCall[] = [];
  const available = storage ? BigInt(storage.available) : 0n;
  if (!storage) {
    calls.push(registry.storageDeposit((BigInt(bounds.min) + BigInt(need)).toString()));
  } else if (available < BigInt(need)) {
    calls.push(registry.storageDeposit((BigInt(need) - available).toString()));
  }
  calls.push(
    usdcCalls.fundOffer(
      state.usdc_token,
      registry.registryId,
      params.principal,
      params.tokenId,
      params.repayAmount,
      params.termMs,
      params.terms,
    ),
  );
  const results = await sender.send(calls);
  const known = new Set(before.map((o) => o.id));
  const offer =
    (await registry.getOffers(params.tokenId)).find(
      (o) => !known.has(o.id) && o.lender === sender.accountId && o.principal === params.principal,
    ) ?? null;
  return { txHashes: hashes(results), offer, refusal: offer ? null : refusalOf(results) };
}

export async function cancelOffer(sender: TxSender, tokenId: string, offerId: number, options: ActionOptions = {}) {
  const registry = registryOf(options);
  const offer = (await registry.getOffers(tokenId)).find((o) => o.id === offerId);
  if (!offer) throw new ActionRefusedError(`Offer ${offerId} is not open on company ${tokenId}`, 'ERR_OFFER_NOT_FOUND');
  if (offer.lender !== sender.accountId) {
    throw new ActionRefusedError(`Offer ${offerId} belongs to ${offer.lender}`, 'ERR_NOT_OFFER_LENDER');
  }
  const results = await sender.send([registry.cancelOffer(offerId)]);
  const open = (await registry.getOffers(tokenId)).some((o) => o.id === offerId);
  return { txHashes: hashes(results), cancelled: !open };
}

export interface BorrowResult {
  txHashes: string[];
  loan: Loan | null;
  borrowed: boolean;
}

/**
 * Owner side. Freezes the vault as Pledged and receives the principal in USDC. Registers the owner
 * on USDC first if needed, or the principal would land in `pending_withdrawal`.
 */
export async function acceptOffer(sender: TxSender, tokenId: string, offerId: number, options: ActionOptions = {}): Promise<BorrowResult> {
  const registry = registryOf(options);
  const company = await requireCompany(registry, tokenId);
  requireOwner(company, sender.accountId);
  requireNotSettling(company);
  if (!isFree(company.encumbrance)) {
    throw new ActionRefusedError(`Company ${tokenId} is already listed or pledged`, 'ERR_TOKEN_ENCUMBERED');
  }
  const offer = (await registry.getOffers(tokenId)).find((o) => o.id === offerId);
  if (!offer) throw new ActionRefusedError(`Offer ${offerId} is not open on company ${tokenId}`, 'ERR_OFFER_NOT_FOUND');
  if (offer.settling) throw new ActionRefusedError(`Offer ${offerId} is being accepted right now`, 'ERR_OFFER_SETTLING');
  const state = await vaultOf(registry, tokenId).getState();
  requireCleanKeys(state, 'pledging');
  const calls = [...(await registrationIfMissing(state.usdc_token, sender.accountId)), registry.acceptOffer(offerId)];
  const results = await sender.send(calls);
  const loan = await registry.getLoan(tokenId);
  return { txHashes: hashes(results), loan, borrowed: loan !== null && loan.borrower === sender.accountId };
}

export interface RepayResult {
  txHashes: string[];
  debt: U128;
  repaid: boolean;
  refusal: ContractError | null;
}

/**
 * Pays the full debt with `usdc.ft_transfer_call(registry, debt, {"action":"repay","token_id"})`.
 * Anyone may repay; the vault unfreezes when the registry records the repayment.
 */
export async function repayLoan(sender: TxSender, tokenId: string, options: ActionOptions = {}): Promise<RepayResult> {
  const registry = registryOf(options);
  const loan = await registry.getLoan(tokenId);
  if (!loan) throw new ActionRefusedError(`Company ${tokenId} has no loan`, 'ERR_NO_LOAN');
  const state = await vaultOf(registry, tokenId).getState();
  await requireBalance(state.usdc_token, sender.accountId, BigInt(loan.debt), 'Repayment');
  const results = await sender.send([usdcCalls.repay(state.usdc_token, registry.registryId, loan.debt, tokenId)]);
  const repaid = (await registry.getLoan(tokenId)) === null;
  return { txHashes: hashes(results), debt: loan.debt, repaid, refusal: repaid ? null : refusalOf(results) };
}

/** Permissionless once the loan is past `due_ms`. Starts the Dutch auction. */
export async function startAuction(sender: TxSender, tokenId: string, options: ActionOptions = {}) {
  const registry = registryOf(options);
  const loan = await registry.getLoan(tokenId);
  if (!loan) throw new ActionRefusedError(`Company ${tokenId} has no loan`, 'ERR_NO_LOAN');
  if (loan.auction_start_ms != null) throw new ActionRefusedError('The auction has already started', 'ERR_AUCTION_ALREADY_STARTED');
  if (Date.now() <= loan.due_ms) {
    throw new ActionRefusedError(`The loan is due at ${new Date(loan.due_ms).toISOString()}`, 'ERR_LOAN_NOT_DUE');
  }
  const results = await sender.send([registry.startAuction(tokenId)]);
  return { txHashes: hashes(results), price: await registry.auctionPrice(tokenId) };
}

/**
 * Bids the current Dutch auction price with `usdc.ft_transfer_call(registry, price, {"action":"bid",
 * "token_id"})`. The price only falls, so the excess over the price at execution is returned.
 */
export async function bidAuction(sender: TxSender, tokenId: string, options: ActionOptions = {}): Promise<BuyResult> {
  const registry = registryOf(options);
  const price = await registry.auctionPrice(tokenId);
  if (price === null) throw new ActionRefusedError(`Company ${tokenId} has no running auction`, 'ERR_AUCTION_NOT_STARTED');
  const state = await vaultOf(registry, tokenId).getState();
  await requireBalance(state.usdc_token, sender.accountId, BigInt(price), 'This bid');
  const results = await sender.send([usdcCalls.bid(state.usdc_token, registry.registryId, price, tokenId)]);
  const token = await registry.nftToken(tokenId);
  const acquired = token?.owner_id === sender.accountId;
  return { txHashes: hashes(results), acquired, price, owner: token?.owner_id ?? null, refusal: acquired ? null : refusalOf(results) };
}

/**
 * Lender side, after default: once the auction window closed with no bid, moves the NFT and the
 * vault to the lender. Needs `auction_start_ms + auction_duration_ms` to have passed.
 */
export async function claimDefaultedCollateral(sender: TxSender, tokenId: string, options: ActionOptions = {}) {
  const registry = registryOf(options);
  const loan = await registry.getLoan(tokenId);
  if (!loan) throw new ActionRefusedError(`Company ${tokenId} has no loan`, 'ERR_NO_LOAN');
  if (loan.lender !== sender.accountId) throw new ActionRefusedError(`The lender is ${loan.lender}`, 'ERR_NOT_LOAN_LENDER');
  if (loan.auction_start_ms == null) {
    throw new ActionRefusedError('No auction has started. Start it once the loan is past due.', 'ERR_AUCTION_NOT_STARTED');
  }
  const results = await sender.send([registry.claimDefaultedCollateral(tokenId)]);
  const token = await registry.nftToken(tokenId);
  return { txHashes: hashes(results), claimed: token?.owner_id === sender.accountId };
}

/** Pays out USDC the registry could not transfer earlier (receiver not registered, for example). */
export async function withdrawPending(sender: TxSender, options: ActionOptions = {}) {
  const registry = registryOf(options);
  const pending = await registry.pendingWithdrawal(sender.accountId);
  // The registry panics with ERR_NOTHING_PENDING, which would cost the user a transaction fee.
  if (pending === '0') {
    throw new ActionRefusedError(`${sender.accountId} has nothing pending on ${registry.registryId}`, 'ERR_NOTHING_PENDING');
  }
  const results = await sender.send([registry.withdrawPending()]);
  return { txHashes: hashes(results), stillPending: await registry.pendingWithdrawal(sender.accountId) };
}

// ---------------------------------------------------------------------------- Shareholder

export interface DividendResult {
  txHashes: string[];
  /** True when the vault's `dividends_paid` grew by `amount`. A failed transfer restores retained earnings. */
  paid: boolean;
  amount: U128;
}

/**
 * `vault.claim_dividends({amount})` with 1 yoctoNEAR. Registers the shareholder on USDC first if
 * needed. While the company is listed or pledged the vault refuses on-chain with
 * ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN (thrown as TransactionFailedError with the hash).
 */
export async function claimDividends(sender: TxSender, tokenId: string, amount: U128, options: ActionOptions = {}): Promise<DividendResult> {
  const registry = registryOf(options);
  const vault = vaultOf(registry, tokenId);
  const before = await vault.getState();
  if (before.shareholder !== sender.accountId) {
    throw new ActionRefusedError(`The shareholder of company ${tokenId} is ${before.shareholder}`, 'ERR_ONLY_CURRENT_SHAREHOLDER');
  }
  if (!/^[0-9]+$/.test(amount) || BigInt(amount) === 0n) throw new ActionRefusedError('The amount must be above zero', 'ERR_INVALID_AMOUNT');
  if (BigInt(amount) > BigInt(before.retained_earnings)) {
    throw new ActionRefusedError(`Retained earnings are ${before.retained_earnings}, less than ${amount}`, 'ERR_INSUFFICIENT_RETAINED_EARNINGS');
  }
  const calls = [...(await registrationIfMissing(before.usdc_token, sender.accountId)), vault.claimDividends(amount)];
  const results = await sender.send(calls);
  const after = await vault.getState();
  return {
    txHashes: hashes(results),
    paid: BigInt(after.dividends_paid) - BigInt(before.dividends_paid) === BigInt(amount),
    amount,
  };
}

export interface RawSignatureParams {
  tokenId: string;
  /** 0: secp256k1 (BTC, EVM). 1: ed25519 (Solana). */
  domainId: 0 | 1;
  /** Domain 0: 32-byte digest, 64 hex characters. Domain 1: message bytes, 32 to 1232. */
  payloadHex: string;
  /** `[a-z0-9-]{1,32}`. `treasury` signs for the addresses in `treasury_addresses()`. */
  subpath: string;
  /** yoctoNEAR forwarded to the signer. Defaults to SIGNATURE_DEPOSIT (1 yocto). */
  deposit?: U128;
}

export interface RawSignatureResult {
  txHashes: string[];
  /** The `v1.signer` response, as the vault returned it. */
  signature: unknown;
  epochDirty: boolean;
}

/**
 * `vault.request_shareholder_signature` with 300 TGas: signs a raw payload with the vault's MPC key
 * at path `incorpr-<token>-e<epoch>-<subpath>`. This marks the epoch dirty: the company cannot be
 * listed or pledged until `rotateTreasuryEpoch`, because a signed but unbroadcast transaction could
 * move treasury funds after a sale.
 */
export async function requestRawSignature(
  sender: TxSender,
  params: RawSignatureParams,
  options: ActionOptions = {},
): Promise<RawSignatureResult> {
  const registry = registryOf(options);
  const hex = /^(?:[0-9a-fA-F]{2})+$/.test(params.payloadHex) ? params.payloadHex.length / 2 : -1;
  if (params.domainId === 0 && hex !== 32) {
    throw new ActionRefusedError('A secp256k1 payload is a 32-byte digest: 64 hex characters', 'ERR_INVALID_PAYLOAD');
  }
  if (params.domainId === 1 && (hex < 32 || hex > 1232)) {
    throw new ActionRefusedError('An ed25519 payload is 32 to 1232 bytes of hex', 'ERR_INVALID_PAYLOAD');
  }
  if (!/^[a-z0-9-]{1,32}$/.test(params.subpath)) {
    throw new ActionRefusedError('subpath must match [a-z0-9-]{1,32}', 'ERR_INVALID_SUBPATH');
  }
  const vault = vaultOf(registry, params.tokenId);
  const results = await sender.send([
    vault.requestShareholderSignature(params.domainId, params.payloadHex, params.subpath, params.deposit ?? SIGNATURE_DEPOSIT),
  ]);
  const signed = last<unknown>(results);
  return { txHashes: hashes(results), signature: signed.value, epochDirty: (await vault.getState()).raw_sigs_this_epoch > 0 };
}

export interface TreasuryKeysResult {
  txHashes: string[];
  epoch: number;
  addresses: TreasuryAddresses | null;
}

/**
 * `vault.rotate_treasury_epoch()` with 1 yoctoNEAR: moves the treasury to fresh addresses (a new
 * derivation epoch) and clears the dirty flag. Shareholder only, and only while the company is free.
 */
export async function rotateTreasuryEpoch(sender: TxSender, tokenId: string, options: ActionOptions = {}): Promise<TreasuryKeysResult> {
  const registry = registryOf(options);
  const vault = vaultOf(registry, tokenId);
  const before = await vault.getState();
  if (before.shareholder !== sender.accountId) {
    throw new ActionRefusedError(`The shareholder of company ${tokenId} is ${before.shareholder}`, 'ERR_ONLY_CURRENT_SHAREHOLDER');
  }
  const results = await sender.send([vault.rotateTreasuryEpoch()]);
  const state = await vault.getState();
  return { txHashes: hashes(results), epoch: state.treasury_epoch, addresses: state.addresses ?? null };
}

/**
 * `vault.refresh_treasury_keys()`, permissionless, no deposit: asks the MPC signer for the current
 * epoch's BTC/EVM (secp256k1) and SOL (ed25519) keys and stores the addresses. Use it when
 * `get_state().addresses` is null, for example after a rotation whose derivation did not land.
 */
export async function refreshTreasuryKeys(sender: TxSender, tokenId: string, options: ActionOptions = {}): Promise<TreasuryKeysResult> {
  const registry = registryOf(options);
  const vault = vaultOf(registry, tokenId);
  const results = await sender.send([vault.refreshTreasuryKeys()]);
  const state = await vault.getState();
  return { txHashes: hashes(results), epoch: state.treasury_epoch, addresses: state.addresses ?? null };
}

// ---------------------------------------------------------------------------- Customer

/** Random 128-bit salt, hex. The payer keeps it: only the payer can then present the input. */
export function newCallSalt(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PayResult {
  txHashes: string[];
  callId: string;
  salt: string;
  amount: U128;
  /** True only when the vault holds a payment record for `callId` from this payer. */
  booked: boolean;
  payment: Payment | null;
}

/**
 * Pays one service call at the vault's current price with `usdc.ft_transfer_call(vault, price,
 * {"call_id"})` and 1 yoctoNEAR, then reads `get_payment` to confirm the vault booked it. The vault
 * refunds without a log when the price changed or the call id is taken, so `booked` is the answer.
 * Then send `{token_id, call_id, salt, input}` to /api/run-service.
 */
export async function payForService(
  sender: TxSender,
  params: { tokenId: string; input: string; salt?: string },
  options: ActionOptions = {},
): Promise<PayResult> {
  const registry = registryOf(options);
  const vault = vaultOf(registry, params.tokenId);
  const state = await vault.getState();
  const salt = params.salt ?? newCallSalt();
  const callId = serviceCallId(params.input, salt);
  if (await vault.getPayment(callId)) throw new ActionRefusedError(`Call id ${callId} is already paid`);
  const amount = state.price_micro_usdc;
  await requireBalance(state.usdc_token, sender.accountId, BigInt(amount), 'This call');
  const results = await sender.send([usdcCalls.payForService(state.usdc_token, vault.vaultId, amount, callId)]);
  const payment = await vault.getPayment(callId);
  return {
    txHashes: hashes(results),
    callId,
    salt,
    amount,
    booked: payment !== null && payment.payer === sender.accountId && payment.amount === amount,
    payment,
  };
}
