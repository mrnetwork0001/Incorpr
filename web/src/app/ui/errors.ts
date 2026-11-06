// One sentence per contract error code, for TxResult and Toast. Codes come from the panics in
// contracts/company-vault and contracts/incorpr-registry (docs/ARCHITECTURE.md). Unknown codes get a
// generic sentence that still names the code.

const SENTENCES: Record<string, string> = {
  // Encumbrance and the pre-signed transaction rule
  ERR_RAW_SIGNATURES_THIS_EPOCH:
    'The vault signed a raw L1 payload this epoch, so it cannot be listed or pledged. Rotate the treasury epoch first.',
  ERR_UNEXPIRED_SIGNED_INTENTS: 'An intent the vault signed has not reached its deadline yet. Wait up to five minutes and retry.',
  ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN: 'Signing is frozen while the company is listed, pledged or changing hands.',
  ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN: 'Dividend claims are frozen while the company is listed, pledged or changing hands.',
  ERR_ACCOUNT_ENCUMBERED_POLICY_FROZEN: 'Policy changes are frozen while the company is listed, pledged or changing hands.',
  ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN: 'The treasury agent is frozen while the company is listed, pledged or changing hands.',
  ERR_ACCOUNT_ENCUMBERED_SYNC: 'The vault is listed, pledged or in transit, so it refused the owner update.',
  ERR_TOKEN_ENCUMBERED: 'The company is listed or pledged, so it cannot be transferred or approved.',
  ERR_TOKEN_SETTLING: 'Another market call on this company is still settling. Retry after it finishes.',
  ERR_VAULT_FREEZE_FAILED: 'The vault refused the freeze, so nothing moved.',
  ERR_VAULT_UNFREEZE_FAILED: 'The vault refused the unfreeze, so the company is still listed or pledged.',
  ERR_VAULT_SYNC_FAILED: 'The vault did not accept the new owner. Anyone can call resync_vault_owner to repair it.',
  ERR_STALE_SYNC: 'The vault already holds a newer owner update than this one.',

  // Ownership and roles
  ERR_NOT_TOKEN_OWNER: 'The connected account does not own this company.',
  ERR_ONLY_CURRENT_SHAREHOLDER: 'Only the current shareholder can call this.',
  ERR_ONLY_TEE_TREASURY_AGENT: 'Only the company operator can call this.',
  ERR_ONLY_REGISTRY: 'Only the registry can call this on the vault.',
  ERR_ONLY_REGISTRY_OWNER: 'Only the registry owner can call this.',
  ERR_ONLY_COMPANY_VAULT: "Only the company's own vault can report its metrics.",
  ERR_BUYER_IS_SELLER: 'The buyer is the seller.',
  ERR_RECEIVER_IS_OWNER: 'The receiver already owns this company.',

  // Market and credit
  ERR_TOKEN_NOT_FOUND: 'No company with this token id exists on the registry.',
  ERR_TOKEN_NOT_LISTED: 'The company is not listed for sale.',
  ERR_LISTING_CHANGED: 'The listing changed after you read it. Your payment was refunded.',
  ERR_AMOUNT_BELOW_ASK: 'The payment is below the ask. It was refunded.',
  ERR_AMOUNT_BELOW_DEBT: 'The repayment is below the outstanding debt. It was refunded.',
  ERR_AMOUNT_BELOW_AUCTION_PRICE: 'The bid is below the current auction price. It was refunded.',
  ERR_INVALID_ASK: 'The ask must be a positive USDC amount.',
  ERR_OFFER_NOT_FOUND: 'That loan offer no longer exists.',
  ERR_OFFER_SETTLING: 'That offer is being accepted in another transaction.',
  ERR_NOT_OFFER_LENDER: 'Only the lender who posted this offer can cancel it.',
  ERR_NOT_LOAN_LENDER: 'Only the lender on this loan can claim the collateral.',
  ERR_TOO_MANY_OFFERS: 'This company has 32 offers and yours is not larger than the smallest.',
  ERR_PLEDGE_TERMS_NOT_MET: "The company no longer meets the lender's terms, so the offer cannot be accepted.",
  ERR_NO_LOAN: 'There is no loan against this company.',
  ERR_LOAN_NOT_DUE: 'The loan is not due yet.',
  ERR_AUCTION_NOT_STARTED: 'The default auction has not started. It opens once the loan is past due and someone calls start_auction.',
  ERR_AUCTION_ALREADY_STARTED: 'The default auction has already started.',
  ERR_AUCTION_STILL_OPEN: 'The auction window is still open.',
  ERR_AUCTION_CLOSED: 'The auction window has closed.',
  ERR_INVALID_OFFER: 'The offer terms are invalid.',
  ERR_INVALID_TERM: 'The loan term is out of range.',
  ERR_REGISTRY_RESERVE_LOW: 'The registry is below its 0.5 NEAR reserve, so it refuses new listings, purchases and loans until it is topped up.',
  ERR_SETTLEMENT_FAILED: 'A settlement step failed. The company is locked until anyone calls resync_vault_owner.',
  ERR_NOTHING_PENDING: 'There is no pending payout for this account.',
  ERR_STORAGE_DEPOSIT_REQUIRED: 'Prepay offer storage on the registry first. The principal was refunded.',
  ERR_STORAGE_DEPOSIT_TOO_LOW: 'The attached storage deposit is too low.',
  ERR_STORAGE_NOT_REGISTERED: 'This account has no storage registered on the registry.',
  ERR_STORAGE_OFFERS_LOCKED: 'Storage is locked by open offers. Cancel them first.',

  // Treasury agent firewall and TEE approval
  ERR_FIREWALL_BLOCKED_TOKEN: "The token is not on the shareholder's allow list.",
  ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION: "The destination is not the company's own current-epoch address.",
  ERR_FIREWALL_EPOCH_CAP_EXCEEDED: 'The 24-hour spend cap for this token is used up.',
  ERR_FIREWALL_PRICE_BELOW_FLOOR: "The swap rate is below the shareholder's price floor.",
  ERR_FIREWALL_NO_PRICE_FLOOR: 'The shareholder has set no price floor for this pair.',
  ERR_FIREWALL_INVALID_PROPOSAL: 'The proposal fields are invalid.',
  ERR_NONCE_USED: 'This nonce was already used.',
  ERR_TOO_MANY_LIVE_NONCES: 'The vault holds 32 live nonces. Retry in a few minutes.',
  ERR_MISSING_TEE_ATTESTATION: 'The TEE approval is missing.',
  ERR_TEE_NOT_APPROVED: 'The attested model did not approve this proposal.',
  ERR_TEE_SIGNATURE_UNTRUSTED: 'The TEE signature recovers to a key the shareholder does not trust.',
  ERR_TEE_MODEL_NOT_ALLOWED: 'The model is not on the allowed list.',
  ERR_TEE_PROMPT_NOT_PINNED: 'The system prompt does not match the pinned hash.',
  ERR_TEE_APPROVAL_EXPIRED: 'The TEE approval is more than 10 minutes old, or dated ahead of block time.',
  ERR_TEE_REQUEST_MISMATCH: 'The signed request does not match the one the vault wrote.',
  ERR_TEE_RESPONSE_MISMATCH: 'The signed response does not match the response body.',
  ERR_TEE_TEXT_FORMAT: 'The TEE signature text is not in the model:request:response form.',

  // Payments, dividends, inputs
  ERR_PAYMENT_NOT_FOUND: 'No payment with this call id is recorded on the vault.',
  ERR_PAYMENT_ALREADY_SERVED: 'This paid call was already served.',
  ERR_INSUFFICIENT_RETAINED_EARNINGS: 'Retained earnings are lower than the amount requested.',
  ERR_INSUFFICIENT_COMPUTE_RESERVE: 'The compute reserve is lower than the bill.',
  ERR_INSUFFICIENT_DEPOSIT: 'The attached NEAR deposit is too low.',
  ERR_SIGNATURE_REQUIRES_DEPOSIT: 'A signature request needs at least 1 yoctoNEAR attached.',
  ERR_INSUFFICIENT_GAS_FOR_SIGNATURE: 'Not enough gas was attached for the MPC signature.',
  ERR_MPC_SIGNATURE_FAILED: 'The MPC signer did not return a signature.',
  ERR_INVALID_AMOUNT: 'The amount must be greater than zero.',
  ERR_INVALID_PRICE: 'The price per call must be greater than zero.',
  ERR_INVALID_NAME: 'The company name is invalid.',
  ERR_INVALID_ROYALTY: 'The founder royalty is above 10%.',
  ERR_INVALID_RESERVE: 'The compute reserve must be between 1% and 100%.',
  ERR_INVALID_TARGET_ALLOCATION: 'The BTC, SOL and USDC targets must add up to 100%.',
  ERR_INVALID_POLICY: 'The policy is invalid.',
  ERR_INVALID_MSG: 'The transfer message is not one the receiver accepts.',
  ERR_INVALID_SUBPATH: 'A subpath is 1 to 32 characters of a-z, 0-9 and hyphen.',
};

/** The first `ERR_` code in a string, or null. */
export function extractErrorCode(text: string): string | null {
  return /ERR_[A-Z0-9_]+/.exec(text)?.[0] ?? null;
}

export function errorSentence(code: string): string {
  return SENTENCES[code] ?? `The contract rejected the call with ${code}.`;
}
