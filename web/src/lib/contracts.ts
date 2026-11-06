// Typed clients for incorpr-registry and company-vault. Every amount is a U128 decimal string.
// Method names, argument names, deposits and payable flags are checked against
// contracts/res/*_abi.json in tests/contracts.abi.test.ts.
//
// Views return parsed JSON. Change methods return a `ContractCall`, which the browser sends through
// the wallet (`useWallet().sender`, see actions.ts) and the server through the operator (`operatorCall`).
//
// Not wrapped, because only a contract can call them: vault `new`, `sync_owner`, `begin_transit`,
// `apply_encumbrance` and `ft_on_transfer` (registry only, or the USDC token), registry
// `report_metrics` (the company's vault only), every `#[private]` callback, and both `ft_on_transfer`
// entry points, which are reached through `usdcCalls` below.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { requireRegistryId, viewFunction, type ViewOptions } from './near';

export type U128 = string;

export type EncumbranceState =
  | 'Free'
  | { Listed: { ask: U128 } }
  | { Pledged: { lender: string; debt: U128; due_ms: number } };

export interface PriceFloor {
  sell_token: string;
  buy_token: string;
  min_buy: U128;
  per_sell: U128;
}

export interface PledgeTerms {
  min_retained?: U128 | null;
  required_epoch?: number | null;
}

export interface Policy {
  operator: string;
  allowed_tokens: string[];
  epoch_caps: [string, U128][];
  tee_signers: string[];
  tee_models: string[];
  tee_prompt_hash: string;
  price_floors: PriceFloor[];
}

export interface TreasuryAddresses {
  epoch: number;
  btc: string;
  evm: string;
  sol: string;
  secp256k1_key: string;
  ed25519_key: string;
}

export interface Payment {
  /** The account that called `ft_transfer_call`. A 1Click or intents.near delivery records intents.near. */
  payer: string;
  amount: U128;
  served: boolean;
  tee_chat_id?: string | null;
}

export interface PaymentStats {
  records: number;
  total_amount: U128;
  served_amount: U128;
  distinct_payers: number;
  largest_payer_amount: U128;
}

export interface VaultState {
  token_id: string;
  registry: string;
  shareholder: string;
  founder: string;
  founder_royalty_bps: number;
  compute_payee: string;
  mpc_contract: string;
  intents_contract: string;
  usdc_token: string;
  btc_hrp: string;
  price_micro_usdc: U128;
  compute_reserve_bps: number;
  policy: Policy;
  default_policy: Policy;
  encumbrance: EncumbranceState;
  in_transit: boolean;
  sync_nonce: number;
  owner_generation: number;
  treasury_epoch: number;
  raw_sigs_this_epoch: number;
  addresses?: TreasuryAddresses | null;
  intents_key?: string | null;
  intents_key_registered: boolean;
  latest_intent_deadline_ms: number;
  gross_revenue: U128;
  related_party_revenue: U128;
  compute_reserve: U128;
  retained_earnings: U128;
  revenue_30d: U128;
  api_calls_served: number;
  dividends_paid: U128;
  compute_paid: U128;
  deposited_to_intents: U128;
  spend_window: number;
  spent_this_window: [string, U128][];
  payment_records: number;
  free_near_balance: U128;
}

export interface SwapProposal {
  sell_token: string;
  sell_amount: U128;
  buy_token: string;
  min_buy_amount: U128;
  nonce_b64: string;
}

export interface WithdrawProposal {
  token: string;
  amount: U128;
  destination: string;
  chain: 'btc' | 'sol' | 'evm';
  nonce_b64: string;
}

export interface TeeProof {
  text: string;
  signature_hex: string;
  response_body: string;
  system_prompt: string;
}

export interface TeeRequest {
  body: string;
  proposal_hash: string;
}

/** Ready for `execute_intents` or the solver relay. */
export interface SignedIntent {
  standard: 'nep413';
  payload: { message: string; nonce: string; recipient: string };
  public_key: string;
  signature: string;
}

export interface CompanyView {
  token_id: string;
  owner_id: string;
  name: string;
  service_template: string;
  price_micro_usdc: U128;
  /** BTC, SOL, USDC. Sums to 10000. */
  target_bps: [number, number, number];
  founder: string;
  founder_royalty_bps: number;
  compute_reserve_bps: number;
  vault: string;
  created_ms: number;
  gross: U128;
  retained: U128;
  /** Snapshot as of `metrics_ms`. `VaultClient.revenue30d` is exact. */
  revenue_30d: U128;
  calls: number;
  metrics_ms: number;
  encumbrance: EncumbranceState;
  settling: boolean;
  needs_resync: boolean;
  sync_nonce: number;
}

export interface Offer {
  id: number;
  token_id: string;
  lender: string;
  principal: U128;
  repay_amount: U128;
  term_ms: number;
  settling: boolean;
  terms?: PledgeTerms | null;
}

export interface Loan {
  token_id: string;
  lender: string;
  borrower: string;
  principal: U128;
  debt: U128;
  due_ms: number;
  auction_start_ms?: number | null;
}

export interface ListingView {
  token_id: string;
  seller: string;
  ask: U128;
  sync_nonce: number;
}

export interface StorageBalance {
  total: U128;
  available: U128;
}

/** NEP-177 token metadata. `*_hash` fields are base64 strings. */
export interface TokenMetadata {
  title?: string | null;
  description?: string | null;
  media?: string | null;
  media_hash?: string | null;
  copies?: number | null;
  issued_at?: string | null;
  expires_at?: string | null;
  starts_at?: string | null;
  updated_at?: string | null;
  extra?: string | null;
  reference?: string | null;
  reference_hash?: string | null;
}

export interface NftToken {
  token_id: string;
  owner_id: string;
  metadata?: TokenMetadata | null;
  approved_account_ids?: Record<string, number> | null;
}

export interface NftContractMetadata {
  spec: string;
  name: string;
  symbol: string;
  icon?: string | null;
  base_uri?: string | null;
  reference?: string | null;
  reference_hash?: string | null;
}

/** Argument of registry `new`. Used by deploy scripts; the web app never initializes a contract. */
export interface RegistryInit {
  owner: string;
  usdc_token: string;
  mpc_contract: string;
  intents_contract: string;
  btc_hrp: string;
  default_operator: string;
  compute_payee: string;
  allowed_tokens: string[];
  epoch_caps: [string, U128][];
  tee_signers: string[];
  tee_models: string[];
  tee_prompt_hash: string;
  price_floors: PriceFloor[];
  auction_duration_ms: number;
}

export interface DefaultPolicy {
  default_operator: string;
  compute_payee: string;
  allowed_tokens: string[];
  epoch_caps: [string, U128][];
  tee_signers: string[];
  tee_models: string[];
  tee_prompt_hash: string;
  price_floors: PriceFloor[];
}

export interface Incorporate {
  name: string;
  service_template: string;
  price_micro_usdc: U128;
  target_bps: [number, number, number];
  founder_royalty_bps: number;
  compute_reserve_bps: number;
}

export interface ContractCall {
  contractId: string;
  methodName: string;
  args: Record<string, unknown>;
  /** yoctoNEAR. */
  deposit: string;
  /** Gas units. */
  gas: string;
}

const tgas = (n: number): string => `${n}000000000000`;
export const ONE_YOCTO = '1';
/**
 * `v1.signer` 3.17.0 (mainnet, read 2026-11-06) and `v1.signer-prod.testnet` charge 1 yoctoNEAR per
 * `sign`; the vault forwards the caller's whole deposit. Pass more only if the signer raises its fee.
 */
export const SIGNATURE_DEPOSIT = ONE_YOCTO;

/** A full transaction's gas: settlement paths schedule several callbacks, and `sign` needs the rest. */
const GAS_MAX = tgas(300);
const GAS_DEFAULT = tgas(30);
const GAS_FT_CALL = tgas(300);

function call(
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  gas: string = GAS_DEFAULT,
  deposit = '0',
): ContractCall {
  return { contractId, methodName, args, gas, deposit };
}

export function isFree(state: EncumbranceState): state is 'Free' {
  return state === 'Free';
}

/** Vault account for a token: `c-<id>.<registry>`. */
export function vaultAccountFor(tokenId: string, registryId: string = requireRegistryId()): string {
  return `c-${tokenId}.${registryId}`;
}

/** The operator a vault accepts for service calls now: its charter operator while encumbered or in transit. */
export function serviceOperator(state: VaultState): string {
  return isFree(state.encumbrance) && !state.in_transit ? state.policy.operator : state.default_policy.operator;
}

/**
 * Call ids are public as soon as the payment lands, so the id commits to the input: only the payer,
 * who holds the salt, can present an input that the service route accepts for this payment.
 */
export function serviceCallId(input: string, salt: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${salt}:${input}`)));
}

export class RegistryClient {
  constructor(
    readonly registryId: string = requireRegistryId(),
    private readonly options: ViewOptions = {},
  ) {}

  private view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return viewFunction<T>(this.registryId, method, args, this.options);
  }

  getCompany = (tokenId: string) => this.view<CompanyView | null>('get_company', { token_id: tokenId });
  listCompanies = (from?: number, limit?: number) =>
    this.view<CompanyView[]>('list_companies', { from: from ?? null, limit: limit ?? null });
  getOffers = (tokenId: string) => this.view<Offer[]>('get_offers', { token_id: tokenId });
  getLoan = (tokenId: string) => this.view<Loan | null>('get_loan', { token_id: tokenId });
  getListing = (tokenId: string) => this.view<ListingView | null>('get_listing', { token_id: tokenId });
  auctionPrice = (tokenId: string) => this.view<U128 | null>('auction_price', { token_id: tokenId });
  pendingWithdrawal = (accountId: string) => this.view<U128>('pending_withdrawal', { account_id: accountId });
  incorporationCost = () => this.view<U128>('incorporation_cost');
  offerStorageCost = () => this.view<U128>('offer_storage_cost');
  storageBalanceOf = (accountId: string) =>
    this.view<StorageBalance | null>('storage_balance_of', { account_id: accountId });
  storageBalanceBounds = () => this.view<{ min: U128; max?: U128 | null }>('storage_balance_bounds');
  nftMetadata = () => this.view<NftContractMetadata>('nft_metadata');
  nftSupplyForOwner = (accountId: string) => this.view<U128>('nft_supply_for_owner', { account_id: accountId });
  nftIsApproved = (tokenId: string, approvedAccountId: string, approvalId?: number) =>
    this.view<boolean>('nft_is_approved', {
      token_id: tokenId,
      approved_account_id: approvedAccountId,
      approval_id: approvalId ?? null,
    });
  nftToken = (tokenId: string) => this.view<NftToken | null>('nft_token', { token_id: tokenId });
  nftTotalSupply = () => this.view<U128>('nft_total_supply');
  nftTokens = (fromIndex?: string, limit?: number) =>
    this.view<NftToken[]>('nft_tokens', { from_index: fromIndex ?? null, limit: limit ?? null });
  nftTokensForOwner = (accountId: string, fromIndex?: string, limit?: number) =>
    this.view<NftToken[]>('nft_tokens_for_owner', {
      account_id: accountId,
      from_index: fromIndex ?? null,
      limit: limit ?? null,
    });
  nftPayout = (tokenId: string, balance: U128, maxLenPayout?: number) =>
    this.view<{ payout: Record<string, U128> }>('nft_payout', {
      token_id: tokenId,
      balance,
      max_len_payout: maxLenPayout ?? null,
    });

  // Change methods.

  /** `deposit` must be at least `incorporationCost()`. The excess is refunded. */
  incorporateCompany = (args: Incorporate, deposit: U128) =>
    call(this.registryId, 'incorporate_company', { args }, GAS_MAX, deposit);
  listCompany = (tokenId: string, ask: U128) =>
    call(this.registryId, 'list_company', { token_id: tokenId, ask }, GAS_MAX, ONE_YOCTO);
  unlistCompany = (tokenId: string) =>
    call(this.registryId, 'unlist_company', { token_id: tokenId }, GAS_MAX, ONE_YOCTO);
  acceptOffer = (offerId: number) =>
    call(this.registryId, 'accept_offer', { offer_id: offerId }, GAS_MAX, ONE_YOCTO);
  cancelOffer = (offerId: number) =>
    call(this.registryId, 'cancel_offer', { offer_id: offerId }, tgas(60), ONE_YOCTO);
  startAuction = (tokenId: string) => call(this.registryId, 'start_auction', { token_id: tokenId });
  claimDefaultedCollateral = (tokenId: string) =>
    call(this.registryId, 'claim_defaulted_collateral', { token_id: tokenId }, GAS_MAX, ONE_YOCTO);
  withdrawPending = () => call(this.registryId, 'withdraw_pending', {}, tgas(60), ONE_YOCTO);
  resyncVaultOwner = (tokenId: string) =>
    call(this.registryId, 'resync_vault_owner', { token_id: tokenId }, tgas(100));
  nftTransfer = (receiverId: string, tokenId: string, memo?: string, approvalId?: number) =>
    call(
      this.registryId,
      'nft_transfer',
      { receiver_id: receiverId, token_id: tokenId, approval_id: approvalId ?? null, memo: memo ?? null },
      tgas(100),
      ONE_YOCTO,
    );
  /** Refused with ERR_TOKEN_ENCUMBERED while the token is listed or pledged. */
  nftTransferCall = (receiverId: string, tokenId: string, msg: string, memo?: string, approvalId?: number) =>
    call(
      this.registryId,
      'nft_transfer_call',
      { receiver_id: receiverId, token_id: tokenId, approval_id: approvalId ?? null, memo: memo ?? null, msg },
      GAS_MAX,
      ONE_YOCTO,
    );
  nftTransferPayout = (
    receiverId: string,
    tokenId: string,
    balance: U128,
    maxLenPayout?: number,
    memo?: string,
    approvalId?: number,
  ) =>
    call(
      this.registryId,
      'nft_transfer_payout',
      {
        receiver_id: receiverId,
        token_id: tokenId,
        approval_id: approvalId ?? null,
        memo: memo ?? null,
        balance,
        max_len_payout: maxLenPayout ?? null,
      },
      tgas(150),
      ONE_YOCTO,
    );
  /** The deposit pays the approval's storage; the excess is refunded. */
  nftApprove = (tokenId: string, accountId: string, msg?: string, deposit: U128 = '10000000000000000000000') =>
    call(this.registryId, 'nft_approve', { token_id: tokenId, account_id: accountId, msg: msg ?? null }, tgas(100), deposit);
  nftRevoke = (tokenId: string, accountId: string) =>
    call(this.registryId, 'nft_revoke', { token_id: tokenId, account_id: accountId }, GAS_DEFAULT, ONE_YOCTO);
  nftRevokeAll = (tokenId: string) =>
    call(this.registryId, 'nft_revoke_all', { token_id: tokenId }, GAS_DEFAULT, ONE_YOCTO);
  /** Prepays lender storage. A `fund_offer` without it is refunded with ERR_STORAGE_DEPOSIT_REQUIRED. */
  storageDeposit = (deposit: U128, accountId?: string) =>
    call(this.registryId, 'storage_deposit', { account_id: accountId ?? null, registration_only: null }, GAS_DEFAULT, deposit);
  storageWithdraw = (amount?: U128) =>
    call(this.registryId, 'storage_withdraw', { amount: amount ?? null }, GAS_DEFAULT, ONE_YOCTO);
  /** Refused with ERR_STORAGE_OFFERS_LOCKED while the account has open offers. `force` is not supported. */
  storageUnregister = () => call(this.registryId, 'storage_unregister', { force: null }, GAS_DEFAULT, ONE_YOCTO);

  /** Registry owner only. Applies to companies incorporated afterwards. */
  setDefaultPolicy = (policy: DefaultPolicy) =>
    call(this.registryId, 'set_default_policy', { ...policy }, GAS_DEFAULT, ONE_YOCTO);
}

export class VaultClient {
  constructor(
    readonly vaultId: string,
    private readonly options: ViewOptions = {},
  ) {}

  private view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return viewFunction<T>(this.vaultId, method, args, this.options);
  }

  getState = () => this.view<VaultState>('get_state');
  getPayment = (callId: string) => this.view<Payment | null>('get_payment', { call_id: callId });
  treasuryAddresses = () => this.view<TreasuryAddresses | null>('treasury_addresses');
  revenue30d = () => this.view<U128>('revenue_30d');
  paymentStats = () => this.view<PaymentStats>('payment_stats');
  swapTeeRequest = (p: SwapProposal, model: string, systemPrompt: string) =>
    this.view<TeeRequest>('swap_tee_request', { p, model, system_prompt: systemPrompt });
  withdrawTeeRequest = (p: WithdrawProposal, model: string, systemPrompt: string) =>
    this.view<TeeRequest>('withdraw_tee_request', { p, model, system_prompt: systemPrompt });

  // Operator.
  recordServiceCall = (callId: string, teeChatId: string) =>
    call(this.vaultId, 'record_service_call', { call_id: callId, tee_chat_id: teeChatId }, tgas(40));
  payComputeBill = (amount: U128) => call(this.vaultId, 'pay_compute_bill', { amount }, tgas(100));
  agentDepositToIntents = (amount: U128) =>
    call(this.vaultId, 'agent_deposit_to_intents', { amount }, tgas(150));
  agentSwapIntent = (p: SwapProposal, tee: TeeProof) =>
    call(this.vaultId, 'agent_swap_intent', { p, tee }, GAS_MAX);
  agentWithdrawIntent = (p: WithdrawProposal, tee: TeeProof) =>
    call(this.vaultId, 'agent_withdraw_intent', { p, tee }, GAS_MAX);

  // Shareholder.
  claimDividends = (amount: U128) =>
    call(this.vaultId, 'claim_dividends', { amount }, tgas(100), ONE_YOCTO);
  /**
   * Domain 0 (secp256k1, BTC/EVM): `payloadHex` is the 32-byte digest. Domain 1 (ed25519, Solana):
   * the message, 32 to 1232 bytes. Marks the epoch dirty, which blocks list and pledge until
   * `rotateTreasuryEpoch`. 300 TGas: the vault forwards all but 5 TGas to the signer and needs 50.
   */
  requestShareholderSignature = (domainId: 0 | 1, payloadHex: string, subpath: string, deposit: U128 = SIGNATURE_DEPOSIT) =>
    call(
      this.vaultId,
      'request_shareholder_signature',
      { domain_id: domainId, payload_hex: payloadHex, subpath },
      GAS_MAX,
      deposit,
    );
  signLegacyEpoch = (epoch: number, domainId: 0 | 1, payloadHex: string, subpath: string, deposit: U128 = SIGNATURE_DEPOSIT) =>
    call(
      this.vaultId,
      'sign_legacy_epoch',
      { epoch, domain_id: domainId, payload_hex: payloadHex, subpath },
      GAS_MAX,
      deposit,
    );
  rotateTreasuryEpoch = () => call(this.vaultId, 'rotate_treasury_epoch', {}, tgas(150), ONE_YOCTO);
  setOperator = (account: string) => call(this.vaultId, 'set_operator', { account }, GAS_DEFAULT, ONE_YOCTO);
  setTeeSigners = (addresses: string[]) =>
    call(this.vaultId, 'set_tee_signers', { addresses }, GAS_DEFAULT, ONE_YOCTO);
  setPolicy = (allowedTokens: string[], epochCaps: [string, U128][]) =>
    call(this.vaultId, 'set_policy', { allowed_tokens: allowedTokens, epoch_caps: epochCaps }, GAS_DEFAULT, ONE_YOCTO);
  setTeePolicy = (models: string[], promptHash: string) =>
    call(this.vaultId, 'set_tee_policy', { models, prompt_hash: promptHash }, GAS_DEFAULT, ONE_YOCTO);
  setPriceFloors = (floors: PriceFloor[]) =>
    call(this.vaultId, 'set_price_floors', { floors }, GAS_DEFAULT, ONE_YOCTO);

  // Permissionless.
  refreshTreasuryKeys = () => call(this.vaultId, 'refresh_treasury_keys', {}, tgas(150));
  setupIntentsKey = () => call(this.vaultId, 'setup_intents_key', {}, tgas(150));
  refreshMetrics = () => call(this.vaultId, 'refresh_metrics', {}, tgas(40));
}

function ftTransferCall(token: string, receiverId: string, amount: U128, msg: string): ContractCall {
  return call(token, 'ft_transfer_call', { receiver_id: receiverId, amount, msg }, GAS_FT_CALL, ONE_YOCTO);
}

/** Generic NEP-141 and NEP-145 calls on any token. */
export const ftCalls = {
  /**
   * `registration_only: true`, so an account that is already registered gets the deposit back.
   * `deposit` is the token's `storage_balance_bounds().min` (0.00125 NEAR for native USDC).
   */
  storageDeposit: (token: string, accountId: string, deposit: U128) =>
    call(token, 'storage_deposit', { account_id: accountId, registration_only: true }, GAS_DEFAULT, deposit),
  /** Plain transfer. The receiver's `ft_on_transfer` does not run, so a vault would not book it. */
  ftTransfer: (token: string, receiverId: string, amount: U128, memo?: string) =>
    call(token, 'ft_transfer', { receiver_id: receiverId, amount, memo: memo ?? null }, GAS_DEFAULT, ONE_YOCTO),
  ftTransferCall,
  /** wrap.near: NEAR in, wNEAR out, 1:1. */
  nearDeposit: (wrapToken: string, yocto: U128) => call(wrapToken, 'near_deposit', {}, GAS_DEFAULT, yocto),
};

/** NEP-141 calls on the USDC token. Test USDC on testnet; both pay through `ft_on_transfer`. */
export const usdcCalls = {
  /**
   * Pays a company for one service call. `callId` comes from `serviceCallId`. The vault books it
   * only when `amount >= price_micro_usdc` and the call id is unused; otherwise it returns the full
   * amount and the transaction still succeeds. Read `getPayment(callId)` to know which happened.
   */
  payForService: (token: string, vault: string, amount: U128, callId: string) =>
    ftTransferCall(token, vault, amount, JSON.stringify({ call_id: callId })),
  acquire: (token: string, registry: string, amount: U128, tokenId: string, expectedSyncNonce: number) =>
    ftTransferCall(
      token,
      registry,
      amount,
      JSON.stringify({ action: 'acquire', token_id: tokenId, expected_sync_nonce: expectedSyncNonce }),
    ),
  fundOffer: (
    token: string,
    registry: string,
    amount: U128,
    tokenId: string,
    repayAmount: U128,
    termMs: number,
    terms?: PledgeTerms,
  ) =>
    ftTransferCall(
      token,
      registry,
      amount,
      JSON.stringify({
        action: 'fund_offer',
        token_id: tokenId,
        repay_amount: repayAmount,
        term_ms: termMs,
        ...(terms ? { terms } : {}),
      }),
    ),
  repay: (token: string, registry: string, amount: U128, tokenId: string) =>
    ftTransferCall(token, registry, amount, JSON.stringify({ action: 'repay', token_id: tokenId })),
  bid: (token: string, registry: string, amount: U128, tokenId: string) =>
    ftTransferCall(token, registry, amount, JSON.stringify({ action: 'bid', token_id: tokenId })),
};

export const ftViews = {
  balanceOf: (token: string, accountId: string, options?: ViewOptions) =>
    viewFunction<U128>(token, 'ft_balance_of', { account_id: accountId }, options),
  storageBalanceOf: (token: string, accountId: string, options?: ViewOptions) =>
    viewFunction<StorageBalance | null>(token, 'storage_balance_of', { account_id: accountId }, options),
  storageBalanceBounds: (token: string, options?: ViewOptions) =>
    viewFunction<{ min: U128; max?: U128 | null }>(token, 'storage_balance_bounds', {}, options),
};
