// Reads a NEAR FinalExecutionOutcome the same way for the wallet (browser) and the operator (server),
// and turns a failure into the contract's ERR_ code plus one plain sentence for the UI.
// No imports with side effects: safe in either bundle.

// ---------------------------------------------------------------------------- Contract errors

/**
 * One sentence per error code in contracts/incorpr-registry, contracts/company-vault and the Test USDC
 * double. tests/lib.unit.test.ts checks that every `"ERR_..."` string in the Rust sources is listed.
 */
export const CONTRACT_ERRORS: Record<string, string> = {
  // Encumbrance freeze (vault)
  ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN: 'The company is listed or pledged, so its treasury agent cannot move funds.',
  ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN: 'The company is listed or pledged, so dividends cannot be claimed until it is free.',
  ERR_ACCOUNT_ENCUMBERED_POLICY_FROZEN: 'The company is listed or pledged, so its policy cannot change until it is free.',
  ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN: 'The company is listed or pledged, so its treasury keys cannot sign until it is free.',
  ERR_ACCOUNT_ENCUMBERED_SYNC: 'The vault is listed or pledged and refused an ownership change.',
  ERR_RAW_SIGNATURES_THIS_EPOCH:
    'The vault signed raw payloads this epoch. Rotate the treasury epoch before listing, pledging or transferring.',
  ERR_UNEXPIRED_SIGNED_INTENTS: 'A treasury intent signed by the agent has not expired yet. Try again after its deadline.',
  ERR_PLEDGE_TERMS_NOT_MET: "The company no longer meets the lender's terms (retained earnings or treasury epoch).",
  // Market and NFT (registry)
  ERR_TOKEN_ENCUMBERED: 'The company is listed or pledged, so the NFT cannot move or be listed again.',
  ERR_TOKEN_SETTLING: 'Another settlement for this company is still running. Try again in a few seconds.',
  ERR_TOKEN_NOT_FOUND: 'No company exists with this token id.',
  ERR_TOKEN_NOT_LISTED: 'The company is not listed for sale.',
  ERR_NOT_TOKEN_OWNER: 'Only the NFT owner can do this.',
  ERR_RECEIVER_IS_OWNER: 'The receiver already owns this company.',
  ERR_NOT_APPROVED: 'This account is not approved to transfer the NFT.',
  ERR_APPROVAL_ID_MISMATCH: 'The approval id does not match the current approval.',
  ERR_TOO_MANY_APPROVALS: 'The NFT has the maximum number of approvals. Revoke one first.',
  ERR_MEMO_TOO_LONG: 'The memo is longer than 256 bytes.',
  ERR_MSG_TOO_LONG: 'The message is longer than 4096 bytes.',
  ERR_PAYOUT_TOO_LONG: 'The payout has more entries than max_len_payout allows.',
  ERR_INVALID_ASK: 'The asking price must be above zero.',
  ERR_AMOUNT_BELOW_ASK: 'The payment is below the asking price. The USDC was refunded.',
  ERR_LISTING_CHANGED: 'The listing changed after you read it. The USDC was refunded; reload and try again.',
  ERR_BUYER_IS_SELLER: 'The seller cannot buy their own listing. The USDC was refunded.',
  ERR_REGISTRY_RESERVE_LOW: 'The registry is below its NEAR reserve and refuses new listings, sales and pledges.',
  ERR_VAULT_FREEZE_FAILED: "The company's vault refused the freeze, so nothing changed.",
  ERR_VAULT_UNFREEZE_FAILED: "The company's vault refused the release, so nothing changed.",
  ERR_VAULT_SYNC_FAILED: "The company's vault did not accept the new owner. The registry marked it for resync.",
  ERR_SETTLEMENT_FAILED: 'A settlement step failed. The registry marked the company for resync.',
  ERR_RESYNC_NOT_REQUIRED: 'The vault and the registry already agree on the owner.',
  ERR_INVALID_MSG: 'The ft_transfer_call message is not one the registry accepts. The USDC was refunded.',
  ERR_INVALID_VAULT_ACCOUNT: 'The vault account name for this token is invalid.',
  // Credit desk (registry)
  ERR_INVALID_OFFER:
    'The offer needs a principal of at least 1 USDC, a repay amount at least the principal and a term above zero. The USDC was refunded.',
  ERR_TOO_MANY_OFFERS: 'This company has 32 open offers and yours is not larger than the smallest. The USDC was refunded.',
  ERR_OFFER_NOT_FOUND: 'The offer does not exist or was already accepted or cancelled.',
  ERR_OFFER_SETTLING: 'The offer is being accepted right now.',
  ERR_NOT_OFFER_LENDER: 'Only the lender who made the offer can cancel it.',
  ERR_INVALID_TERM: 'The loan term is too long.',
  ERR_NO_LOAN: 'This company has no open loan.',
  ERR_AMOUNT_BELOW_DEBT: 'The repayment is below the debt. The USDC was refunded.',
  ERR_LOAN_NOT_DUE: 'The loan is not past due yet, so no auction can start.',
  ERR_AUCTION_ALREADY_STARTED: 'The auction for this loan has already started.',
  ERR_AUCTION_NOT_STARTED: 'No auction has started for this loan.',
  ERR_AUCTION_STILL_OPEN: 'The auction is still open. The lender can claim the company after it closes.',
  ERR_AUCTION_CLOSED: 'The auction has closed. The USDC was refunded.',
  ERR_AMOUNT_BELOW_AUCTION_PRICE: 'The bid is below the current auction price. The USDC was refunded.',
  ERR_NOT_LOAN_LENDER: 'Only the lender can claim the collateral.',
  ERR_NOTHING_PENDING: 'Nothing is waiting to be withdrawn for this account.',
  // NEP-145 storage (registry)
  ERR_STORAGE_DEPOSIT_REQUIRED: 'Register storage on the registry first (storage_deposit). The USDC was refunded.',
  ERR_STORAGE_DEPOSIT_TOO_LOW: 'The storage deposit is below the registry minimum.',
  ERR_STORAGE_AMOUNT_TOO_HIGH: 'The withdrawal is larger than the available storage balance.',
  ERR_STORAGE_NOT_REGISTERED: 'This account has no storage registration on the registry.',
  ERR_STORAGE_OFFERS_LOCKED: 'This account has open offers. Cancel them before unregistering.',
  ERR_STORAGE_FORCE_NOT_SUPPORTED: 'Forced unregistration is not supported.',
  // Incorporation (registry)
  ERR_INSUFFICIENT_DEPOSIT: 'The attached NEAR is below incorporation_cost().',
  ERR_INVALID_NAME: 'The name must be 1 to 64 characters with no control characters.',
  ERR_INVALID_SERVICE: 'The service description must be 1 to 64 characters with no control characters.',
  ERR_INVALID_PRICE: 'The price per call must be above zero.',
  ERR_INVALID_ROYALTY: 'The founder royalty can be at most 10% (1000 bps).',
  ERR_INVALID_RESERVE: 'The compute reserve must be between 1% and 100% (100 to 10000 bps).',
  ERR_INVALID_TARGET_ALLOCATION: 'The BTC, SOL and USDC targets must add up to 100% (10000 bps).',
  ERR_INVALID_BTC_HRP: 'The Bitcoin address prefix must be bc or tb.',
  ERR_INVALID_AUCTION_DURATION: 'The auction duration must be above zero.',
  // Access
  ERR_ONLY_CURRENT_SHAREHOLDER: "Only the company's current shareholder (the NFT owner) can do this.",
  ERR_ONLY_TEE_TREASURY_AGENT: "Only the company's operator can do this.",
  ERR_ONLY_REGISTRY: 'Only the registry can call this.',
  ERR_ONLY_REGISTRY_OWNER: 'Only the registry owner can do this.',
  ERR_ONLY_COMPANY_VAULT: "Only the company's own vault can report metrics.",
  ERR_STALE_SYNC: 'The vault already applied a newer registry update.',
  // Revenue, dividends, compute (vault)
  ERR_INVALID_AMOUNT: 'The amount must be above zero.',
  ERR_INSUFFICIENT_RETAINED_EARNINGS: 'The amount is more than the retained earnings.',
  ERR_INSUFFICIENT_COMPUTE_RESERVE: 'The amount is more than the compute reserve.',
  ERR_PAYMENT_NOT_FOUND: 'The vault has no payment for this call id.',
  ERR_PAYMENT_ALREADY_SERVED: 'This paid call was already served.',
  ERR_INVALID_CHAT_ID: 'The TEE chat id is empty or too long.',
  // Signing (vault)
  ERR_SIGNATURE_REQUIRES_DEPOSIT: 'Attach at least 1 yoctoNEAR for the MPC signer fee.',
  ERR_INSUFFICIENT_GAS_FOR_SIGNATURE: 'Not enough gas is left for the MPC signer. Send the call with 300 TGas.',
  ERR_INVALID_PAYLOAD:
    'The payload must be hex: exactly 32 bytes for secp256k1, 32 to 1232 bytes for ed25519.',
  ERR_INVALID_DOMAIN: 'The signature domain must be 0 (secp256k1) or 1 (ed25519).',
  ERR_INVALID_SUBPATH: 'The key subpath must be 1 to 32 characters of a-z, 0-9 and -.',
  ERR_NOT_A_LEGACY_EPOCH: 'That epoch is not earlier than the current treasury epoch.',
  ERR_MPC_DERIVATION_FAILED: 'The MPC signer did not return a derived key.',
  ERR_MPC_KEY_FORMAT: 'The MPC signer returned a key in an unexpected format.',
  ERR_MPC_SIGNATURE_FAILED: 'The MPC signer did not return a signature.',
  ERR_MPC_SIGNATURE_FORMAT: 'The MPC signer returned a signature in an unexpected format.',
  // Treasury agent firewall (vault)
  ERR_FIREWALL_BLOCKED_TOKEN: "The token is not on the company's allowed list.",
  ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION: 'The withdrawal destination is not a treasury address of this vault.',
  ERR_FIREWALL_EPOCH_CAP_EXCEEDED: "The swap exceeds this window's spending cap for the token.",
  ERR_FIREWALL_INVALID_PROPOSAL: 'The proposal is malformed (same token on both sides or a zero amount).',
  ERR_FIREWALL_NO_PRICE_FLOOR: 'No price floor is set for this token pair.',
  ERR_FIREWALL_PRICE_BELOW_FLOOR: 'The swap price is below the price floor.',
  ERR_INVALID_POLICY: 'The policy has too many entries or an invalid value.',
  ERR_INVALID_NONCE: 'The intent nonce must be 32 bytes, base64.',
  ERR_NONCE_USED: 'This intent nonce was already used.',
  ERR_TOO_MANY_LIVE_NONCES: 'Too many signed intents are still live. Wait for some to expire.',
  ERR_INTENT_ENCODING: 'The intent could not be encoded.',
  ERR_INTENTS_KEY_NOT_SET: 'The vault has no intents key yet. Call setup_intents_key first.',
  ERR_INTENTS_KEY_REGISTRATION_FAILED: 'The intents contract did not register the vault key.',
  // TEE proof (vault)
  ERR_MISSING_TEE_ATTESTATION: 'The TEE proof is incomplete.',
  ERR_TEE_APPROVAL_EXPIRED: 'The TEE approval is too old or dated in the future.',
  ERR_TEE_MODEL_NOT_ALLOWED: 'The TEE model is not on the company policy.',
  ERR_TEE_NOT_APPROVED: 'The TEE model did not approve the proposal.',
  ERR_TEE_PROMPT_NOT_PINNED: 'The system prompt does not match the pinned prompt hash.',
  ERR_TEE_PROOF_TOO_LARGE: 'The TEE proof is too large.',
  ERR_TEE_REQUEST_ENCODING: 'The TEE request could not be encoded.',
  ERR_TEE_REQUEST_MISMATCH: 'The signed TEE request does not match this proposal.',
  ERR_TEE_RESPONSE_MISMATCH: 'The signed TEE response does not match the response body.',
  ERR_TEE_SIGNATURE_UNTRUSTED: 'The TEE signature is not from a signer on the company policy.',
  ERR_TEE_TEXT_FORMAT: 'The signed TEE text is malformed.',
  // Test USDC double (testnet and sandbox only)
  ERR_MINT_LIMIT: 'Test USDC mints at most a fixed amount per call.',
};

export type ErrorKind =
  /** A contract panicked with an ERR_ code, or refused and refunded with one. */
  | 'contract'
  /** NEP-141 token errors, NEAR balance, deposit, gas and missing accounts. */
  | 'chain'
  /** The user closed or rejected the wallet prompt. Nothing was sent. */
  | 'rejected'
  | 'unknown';

export interface ContractError {
  /** The contract's ERR_ code, or null when the failure does not name one. */
  code: string | null;
  /** One sentence for the UI. */
  message: string;
  kind: ErrorKind;
  /** The failure as the chain or wallet reported it, truncated to 500 characters. */
  raw: string;
}

/** Failures without an ERR_ code: the NEP-141 standard, the NEAR runtime and wallet prompts. */
const CHAIN_PATTERNS: [RegExp, ErrorKind, string][] = [
  [/user (rejected|cancell?ed|closed)|rejected by user|request rejected/i, 'rejected', 'The wallet request was rejected. Nothing was sent.'],
  [/Requires attached deposit of exactly 1 yoctoNEAR/i, 'chain', 'This call needs exactly 1 yoctoNEAR attached.'],
  [/Requires attached deposit of at least 1 yoctoNEAR/i, 'chain', 'This call needs at least 1 yoctoNEAR attached.'],
  [/The account doesn't have enough balance|Not enough balance/i, 'chain', 'The account does not hold enough of this token.'],
  [/is not registered/i, 'chain', 'An account in this transfer has no storage deposit on the token.'],
  [/Exceeded the prepaid gas|GasExceeded|GasLimitExceeded/i, 'chain', 'The transaction ran out of gas.'],
  [/NotEnoughBalance|LackBalanceForState|InsufficientStake/i, 'chain', 'The account does not hold enough NEAR for this transaction.'],
  [/AccountDoesNotExist|ReceiverMismatch|does not exist/i, 'chain', 'An account in this transaction does not exist.'],
  [/MethodNotFound|CodeDoesNotExist|CompilationError/i, 'chain', 'The contract or method is not deployed at that account.'],
  [/InvalidNonce|Expired|InvalidTxError/i, 'chain', 'The network rejected the transaction. Try again.'],
];

function rawText(failure: unknown): string {
  if (typeof failure === 'string') return failure;
  if (failure instanceof Error) return failure.message;
  try {
    return JSON.stringify(failure) ?? String(failure);
  } catch {
    return String(failure);
  }
}

/** The ERR_ code a failure names, or null. */
export function errorCode(failure: unknown): string | null {
  return /ERR_[A-Z0-9_]+/.exec(rawText(failure))?.[0] ?? null;
}

/**
 * Turns a receipt `Failure`, a panic message, a wallet error or a bare ERR_ code into a code and a
 * sentence. Unknown ERR_ codes keep their code with a generic sentence.
 */
export function describeContractError(failure: unknown): ContractError {
  const raw = rawText(failure).slice(0, 500);
  const code = errorCode(raw);
  if (code) {
    return { code, kind: 'contract', raw, message: CONTRACT_ERRORS[code] ?? `The contract refused with ${code}.` };
  }
  for (const [pattern, kind, message] of CHAIN_PATTERNS) {
    if (pattern.test(raw)) return { code: null, kind, message, raw };
  }
  return { code: null, kind: 'unknown', message: 'The transaction failed.', raw };
}

/** Kept for operator.ts and api.ts: the ERR_ code when the failure names one, else the raw text. */
export function failureReason(failure: unknown): string {
  return errorCode(failure) ?? rawText(failure).slice(0, 500);
}

export class TransactionFailedError extends Error {
  /** The contract's ERR_ code, or null. */
  readonly code: string | null;
  readonly error: ContractError;

  constructor(
    readonly txHash: string,
    /** The contract's ERR_ code when the failure names one, otherwise the raw failure, truncated. */
    readonly reason: string,
    error?: ContractError,
  ) {
    super(`Transaction ${txHash} failed: ${reason}`);
    this.name = 'TransactionFailedError';
    this.error = error ?? describeContractError(reason);
    this.code = this.error.code;
  }
}

// ---------------------------------------------------------------------------- Outcomes

export interface TxResult<T = unknown> {
  txHash: string;
  /** The JSON the transaction's last receipt returned, or null when it returned nothing. */
  value: T | null;
  /**
   * Set when the transaction succeeded but a contract refused and refunded on the way, which the
   * registry logs as a bare ERR_ code (for example ERR_LISTING_CHANGED on an `acquire`). The vault's
   * `ft_on_transfer` refunds without a log; read `get_payment` for that case.
   */
  refusal?: ContractError | null;
}

interface ReceiptOutcomeLike {
  id?: string;
  outcome?: { logs?: string[]; status?: unknown; executor_id?: string };
}

export interface OutcomeLike {
  status: unknown;
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string };
  receipts_outcome?: ReceiptOutcomeLike[];
}

function decodeBase64(text: string): string {
  if (typeof atob === 'function') {
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(text, 'base64').toString();
}

export function outcomeHash(outcome: OutcomeLike): string {
  const hash = outcome.transaction?.hash ?? outcome.transaction_outcome?.id;
  if (!hash) throw new Error('The outcome carries no transaction hash');
  return hash;
}

/** Every log line, in receipt order. */
export function outcomeLogs(outcome: OutcomeLike): string[] {
  return (outcome.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []);
}

/**
 * The earliest failed receipt that names an ERR_ code. A registry settlement that the vault refused
 * fails visibly as ERR_VAULT_FREEZE_FAILED; the vault's own code (ERR_RAW_SIGNATURES_THIS_EPOCH, for
 * example) is the cause and is in an earlier receipt.
 */
export function rootCauseFailure(outcome: OutcomeLike): ContractError | null {
  for (const receipt of outcome.receipts_outcome ?? []) {
    const status = receipt.outcome?.status as { Failure?: unknown } | undefined;
    if (status && typeof status === 'object' && status.Failure !== undefined && errorCode(status.Failure)) {
      return describeContractError(status.Failure);
    }
  }
  return null;
}

/** A refund logged as a bare ERR_ code by a successful receipt, or null. */
export function loggedRefusal(outcome: OutcomeLike): ContractError | null {
  const line = outcomeLogs(outcome).find((log) => /^ERR_[A-Z0-9_]+$/.test(log.trim()));
  return line ? describeContractError(line.trim()) : null;
}

/**
 * Throws `TransactionFailedError` on a failed transaction, with the root-cause ERR_ code. A success
 * says only that no receipt panicked on the main path: an `ft_transfer_call` the receiver refused
 * also succeeds, with the amount refunded (see `refusal`). Callers that care read contract state.
 */
export function parseOutcome<T = unknown>(outcome: OutcomeLike): TxResult<T> {
  const txHash = outcomeHash(outcome);
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown } | string;
  if (typeof status === 'string') {
    throw new TransactionFailedError(txHash, `transaction status ${status}`);
  }
  if (status.Failure !== undefined) {
    const error = rootCauseFailure(outcome) ?? describeContractError(status.Failure);
    throw new TransactionFailedError(txHash, error.code ?? failureReason(status.Failure), error);
  }
  if (status.SuccessValue === undefined) {
    throw new TransactionFailedError(txHash, 'transaction has not finished');
  }
  const refusal = loggedRefusal(outcome);
  const raw = status.SuccessValue ? decodeBase64(status.SuccessValue) : '';
  const base = refusal ? { txHash, refusal } : { txHash };
  if (!raw) return { ...base, value: null };
  try {
    return { ...base, value: JSON.parse(raw) as T };
  } catch {
    // near-sdk contracts return JSON; anything else is passed through as text.
    return { ...base, value: raw as T };
  }
}

/**
 * Polls our own RPC until `txHash` is FINAL and returns its parsed result. Wallets differ in what
 * they return: MyNearWallet fetches the outcome with `waitUntil: NONE`, which may predate execution.
 */
export async function awaitFinalTransaction<T = unknown>(
  txHash: string,
  signerId: string,
  { timeoutMs = 120_000, provider }: { timeoutMs?: number; provider?: TxStatusProvider } = {},
): Promise<TxResult<T>> {
  const rpc = provider ?? (await import('./near')).getProvider();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const outcome = await rpc.viewTransactionStatus({ txHash, accountId: signerId, waitUntil: 'FINAL' });
      return parseOutcome<T>(outcome as OutcomeLike);
    } catch (error) {
      if (error instanceof TransactionFailedError) throw error;
      // Not yet visible to this node, or the RPC's own wait timed out. Both resolve on a later poll.
      if (Date.now() > deadline) {
        throw new Error(`Transaction ${txHash} was sent but is not final after ${timeoutMs / 1000} s. Check it on the explorer.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
}

export interface TxStatusProvider {
  viewTransactionStatus(params: { txHash: string; accountId: string; waitUntil: 'FINAL' }): Promise<unknown>;
}
