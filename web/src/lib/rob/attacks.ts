// "Rob this company": the attack transactions the /rob page sends, and the vault checks that stop
// them. Client-safe: no secrets, no I/O. The server side is in ./server.ts.

/** Each kind is one real transaction against the house company's vault. */
export type AttackKind = 'stranger_sign' | 'agent_withdraw' | 'agent_dump' | 'replay_chat' | 'forged_approval' | 'owner_claim';

export const ATTACK_ORDER: readonly AttackKind[] = [
  'stranger_sign',
  'agent_withdraw',
  'agent_dump',
  'replay_chat',
  'forged_approval',
  'owner_claim',
];

export type Actor = 'stranger' | 'operator' | 'owner';

export interface AttackInfo {
  /** Short line for the attempt list. */
  title: string;
  actor: Actor;
  method: string;
  /** What the attacker is trying to do, in one or two sentences. */
  story: string;
}

export const ATTACKS: Record<AttackKind, AttackInfo> = {
  stranger_sign: {
    title: 'A stranger asks the MPC network to sign a Bitcoin spend',
    actor: 'stranger',
    method: 'request_shareholder_signature',
    story:
      'The rob account, which does not own the company, asks the vault to have v1.signer sign a 32-byte Bitcoin sighash with the treasury key.',
  },
  agent_withdraw: {
    title: 'The agent withdraws the BTC treasury to an outside address',
    actor: 'operator',
    method: 'agent_withdraw_intent',
    story:
      "The operator key, which relays the treasury agent, asks the vault to sign a NEAR Intents withdrawal of the day's BTC allowance to the visitor's address.",
  },
  agent_dump: {
    title: "The agent sells the day's USDC allowance for 1 satoshi",
    actor: 'operator',
    method: 'agent_swap_intent',
    story: 'A colluding solver would fill this swap and keep the difference. The operator proposes it as a normal rebalance.',
  },
  replay_chat: {
    title: "The operator presents the agent's signed chat reply as its approval",
    actor: 'operator',
    method: 'agent_swap_intent',
    story:
      'The reply in the chat panel is signed inside a NEAR AI Cloud TEE. The operator submits that signed reply, unchanged, as the TEE proof for a swap.',
  },
  forged_approval: {
    title: 'The operator forges a complete TEE approval with its own key',
    actor: 'operator',
    method: 'agent_swap_intent',
    story:
      'The operator rebuilds the exact request the vault expects, writes "APPROVE <proposal_hash>" as the reply, dates it now and signs it with a key it generated.',
  },
  owner_claim: {
    title: 'The owner drains retained earnings while the company is listed or pledged',
    actor: 'owner',
    method: 'claim_dividends',
    story:
      'The NFT owner tries to take the cash out after a buyer or lender has priced the company. The amount is above retained earnings, so the call cannot pay out in any state.',
  },
};

/** One vault check, in the order the contract runs it. */
export interface VaultCheck {
  what: string;
  codes: string[];
}

export interface GuardedMethod {
  method: string;
  /** Who may call it at all. */
  caller: string;
  checks: VaultCheck[];
}

const NONCE_CHECK: VaultCheck = {
  what: 'The intent nonce is 32 bytes, unused, and fewer than 32 approvals are live',
  codes: ['ERR_INVALID_NONCE', 'ERR_TOO_MANY_LIVE_NONCES', 'ERR_NONCE_USED'],
};

const TEE_CHECKS: VaultCheck[] = [
  { what: 'The proof has signed text, a signature, the response body and the system prompt', codes: ['ERR_MISSING_TEE_ATTESTATION'] },
  { what: 'Prompt and response fit the size limits', codes: ['ERR_TEE_PROOF_TOO_LARGE'] },
  { what: 'The signed text is model:request_hash:response_hash', codes: ['ERR_TEE_TEXT_FORMAT'] },
  { what: 'The model is on the policy', codes: ['ERR_TEE_MODEL_NOT_ALLOWED'] },
  { what: 'sha256 of the system prompt equals the pinned prompt hash', codes: ['ERR_TEE_PROMPT_NOT_PINNED'] },
  { what: 'The reply is exactly "APPROVE <proposal_hash>" for this proposal', codes: ['ERR_TEE_NOT_APPROVED'] },
  { what: 'The reply is at most 10 minutes old and not dated in the future', codes: ['ERR_TEE_APPROVAL_EXPIRED'] },
  { what: 'The signed response hash is sha256 of the response body', codes: ['ERR_TEE_RESPONSE_MISMATCH'] },
  { what: 'The signed request hash is sha256 of the request the vault builds itself', codes: ['ERR_TEE_REQUEST_MISMATCH'] },
  { what: 'The signature recovers to a TEE signer pinned from attestation', codes: ['ERR_TEE_SIGNATURE_UNTRUSTED'] },
];

/**
 * The checks in contracts/company-vault/src/lib.rs, in execution order. A transaction fails at the
 * first one it does not pass. tests/rob.checks.test.ts compares this list with the Rust source.
 */
export const GUARDED_METHODS: GuardedMethod[] = [
  {
    method: 'agent_withdraw_intent',
    caller: 'policy operator',
    checks: [
      { what: 'Caller is the policy operator', codes: ['ERR_ONLY_TEE_TREASURY_AGENT'] },
      { what: 'Company is FREE: not listed, pledged or changing hands', codes: ['ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN'] },
      { what: 'Token is on the allowed list', codes: ['ERR_FIREWALL_BLOCKED_TOKEN'] },
      { what: 'Amount is above zero', codes: ['ERR_FIREWALL_INVALID_PROPOSAL'] },
      { what: 'Token is a bridged token (nep141:<chain>.omft.near) on a known chain', codes: ['ERR_FIREWALL_BLOCKED_TOKEN'] },
      { what: 'Destination is this vault’s own treasury address on that chain', codes: ['ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION'] },
      { what: 'The token withdraws to the same chain as the destination', codes: ['ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION'] },
      { what: 'Amount fits the 24-hour spend cap for the token', codes: ['ERR_FIREWALL_EPOCH_CAP_EXCEEDED'] },
      NONCE_CHECK,
      ...TEE_CHECKS,
    ],
  },
  {
    method: 'agent_swap_intent',
    caller: 'policy operator',
    checks: [
      { what: 'Caller is the policy operator', codes: ['ERR_ONLY_TEE_TREASURY_AGENT'] },
      { what: 'Company is FREE: not listed, pledged or changing hands', codes: ['ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN'] },
      { what: 'Both tokens are on the allowed list', codes: ['ERR_FIREWALL_BLOCKED_TOKEN'] },
      { what: 'Two different tokens and amounts above zero', codes: ['ERR_FIREWALL_INVALID_PROPOSAL'] },
      { what: 'Sell amount fits the 24-hour spend cap for the token', codes: ['ERR_FIREWALL_EPOCH_CAP_EXCEEDED'] },
      { what: 'The pair has a price floor', codes: ['ERR_FIREWALL_NO_PRICE_FLOOR'] },
      { what: 'The swap pays at least the floor price', codes: ['ERR_FIREWALL_PRICE_BELOW_FLOOR'] },
      NONCE_CHECK,
      ...TEE_CHECKS,
    ],
  },
  {
    method: 'request_shareholder_signature',
    caller: 'current shareholder',
    checks: [
      { what: 'Caller is the current shareholder (the NFT owner)', codes: ['ERR_ONLY_CURRENT_SHAREHOLDER'] },
      { what: 'Company is FREE: not listed, pledged or changing hands', codes: ['ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN'] },
      { what: 'Key subpath is 1 to 32 characters of a-z, 0-9 and -', codes: ['ERR_INVALID_SUBPATH'] },
      { what: 'At least 1 yoctoNEAR attached for the signer fee', codes: ['ERR_SIGNATURE_REQUIRES_DEPOSIT'] },
      { what: 'Payload is hex of the right length for the domain', codes: ['ERR_INVALID_PAYLOAD', 'ERR_INVALID_DOMAIN'] },
    ],
  },
  {
    method: 'claim_dividends',
    caller: 'current shareholder',
    checks: [
      { what: 'Caller is the current shareholder (the NFT owner)', codes: ['ERR_ONLY_CURRENT_SHAREHOLDER'] },
      { what: 'Company is FREE: not listed, pledged or changing hands', codes: ['ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN'] },
      { what: 'Amount is above zero and at most retained earnings', codes: ['ERR_INVALID_AMOUNT', 'ERR_INSUFFICIENT_RETAINED_EARNINGS'] },
    ],
  },
];

/** Loose shape check for a visitor-supplied Bitcoin address. The vault compares strings, not formats. */
export function isBtcAddressShape(value: string): boolean {
  return /^(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{11,87}$/.test(value) || /^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(value);
}

// ---------------------------------------------------------------------------- Results

/**
 * - rejected: the transaction exists on-chain and failed.
 * - succeeded: the transaction exists and did not fail. Reported as is.
 * - pending: the transaction was sent and has a hash, but its outcome was not read in time.
 * - not_sent: no transaction exists. `reason` says why. Never shown as an attempt that happened.
 */
export type AttemptStatus = 'rejected' | 'succeeded' | 'pending' | 'not_sent';

export interface AttemptResult {
  id: string;
  kind: AttackKind;
  title: string;
  method: string;
  signer: string | null;
  receiver: string | null;
  /** Short, human-readable summary of the arguments. */
  args: string;
  status: AttemptStatus;
  txHash: string | null;
  errorCode: string | null;
  sentence: string;
  explorerUrl: string | null;
  network: string;
  at: string;
}

/** A rejected-on-purpose transaction from docs/evidence/<network>.json, written by scripts/demo.mjs. */
export interface EvidenceAttempt {
  step: string;
  purpose: string;
  method: string;
  signer: string;
  receiver: string;
  txHash: string;
  errorCode: string | null;
  explorerUrl: string | null;
  at: string;
}

export interface TeeReplyInfo {
  /** The reply's signature could be fetched and checked. */
  available: boolean;
  reason?: string;
  signingAddress?: string;
  signedText?: string;
  /** Request hash, response hash and EIP-191 recovery checks against the exact bytes. */
  checks?: Record<string, boolean | string>;
  /** The signing address is one of the TEE signers the vault's policy pins. */
  pinnedByVault?: boolean | null;
}

export interface ChatReply {
  chatId: string;
  model: string;
  content: string;
  tee: TeeReplyInfo;
}

export interface RobTargetView {
  network: string;
  tokenId: string;
  registryId: string | null;
  problem: string | null;
  company: {
    name: string;
    vault: string;
    owner: string;
    encumbrance: 'FREE' | 'LISTED' | 'PLEDGED';
    inTransit: boolean;
    operator: string;
    treasuryEpoch: number;
    btc: string | null;
    evm: string | null;
    sol: string | null;
    teeSigners: string[];
    teeModels: string[];
    retainedMicroUsdc: string;
  } | null;
  robAccount: string | null;
  operatorAccount: string | null;
  ownerKeyAccount: string | null;
  chatAvailable: boolean;
  chatProblem: string | null;
  attemptsProblem: string | null;
}
