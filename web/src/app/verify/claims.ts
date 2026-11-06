import type { Evidence, EvidenceTx } from './sources';

// Each claim the landing page makes, the contract methods that implement it, the tests that prove it,
// and which entries of docs/evidence/<network>.json show it on a live network. Test names are looked
// up in the contract sources at render, so a renamed or deleted test shows as missing.

export interface EvidenceQuery {
  /** Transaction steps written by scripts/deploy.mjs and scripts/demo.mjs. */
  steps?: string[];
  /** Only transactions calling one of these methods. */
  methods?: string[];
  /** Only transactions that failed with one of these codes. */
  errors?: string[];
  teeCalls?: boolean;
  teeDeploy?: boolean;
  quotes?: boolean;
  bitcoin?: boolean;
}

export type LiveCheckId = 'vault-keys' | 'vault-code' | 'vault-addresses' | 'charter-hash' | 'protocol';

export interface Claim {
  id: string;
  /** The claim as the landing page states it. */
  claim: string;
  /** Where it is made. */
  source: string;
  methods: string[];
  tests: string[];
  evidence: EvidenceQuery;
  live?: LiveCheckId;
  /** A limit or scope note, stated plainly. */
  note?: string;
}

export const CLAIMS: Claim[] = [
  {
    id: 'keyless',
    claim: 'The sub-account has no access keys, so there is no seed phrase for a seller to keep.',
    source: 'Hero',
    methods: ['incorporate_company'],
    tests: ['test_incorporate_spawns_subaccount_and_mints_nep171'],
    evidence: { steps: ['deploy'], methods: ['incorporate_company'] },
    live: 'vault-keys',
  },
  {
    id: 'vault-code',
    claim: 'Each vault runs the code the registry embeds, and has no upgrade method.',
    source: 'Built on: NEAR sub-accounts',
    methods: ['incorporate_company'],
    tests: ['test_incorporate_spawns_subaccount_and_mints_nep171'],
    evidence: { steps: ['deploy'], methods: ['incorporate_company'] },
    live: 'vault-code',
  },
  {
    id: 'mint-after-deploy',
    claim: 'The NFT is minted only if the vault deploys. A failed deployment refunds the deposit.',
    source: 'How it works: Incorporate',
    methods: ['incorporate_company', 'on_company_created'],
    tests: ['test_incorporation_validation_and_failed_batch_refund', 'test_sync_is_refused_on_an_encumbered_vault_and_mint_event_is_exact'],
    evidence: { steps: ['deploy'], methods: ['incorporate_company'] },
  },
  {
    id: 'addresses',
    claim: 'Bitcoin, EVM and Solana addresses are derived on-chain from the MPC signer. The vault composes every derivation path.',
    source: 'Built on: Chain Signatures',
    methods: ['refresh_treasury_keys', 'rotate_treasury_epoch'],
    tests: [
      'test_refresh_treasury_keys_matches_independent_derivation',
      'test_live_testnet_key_vector_with_independent_libraries',
      'bip173_mainnet_and_testnet_vectors',
      'live_testnet_key_addresses',
      'stale_key_derivation_after_rotation_is_ignored',
    ],
    evidence: { steps: ['deploy'], methods: ['refresh_treasury_keys'], bitcoin: true },
    live: 'vault-addresses',
  },
  {
    id: 'revenue',
    claim: 'Revenue is booked from USDC transfers. No account can report revenue.',
    source: 'The problem',
    methods: ['ft_on_transfer', 'report_metrics'],
    tests: [
      'test_revenue_split_refunds_and_related_party',
      'test_operator_cannot_credit_revenue_and_metrics_only_from_vault',
      'test_vault_keeps_accepting_revenue_at_record_capacity',
      'test_registry_metrics_follow_deposits_and_are_dated',
    ],
    evidence: { steps: ['pay'] },
    note: "30-day revenue is not sybil-resistant: only the current shareholder's own payments are excluded.",
  },
  {
    id: 'service',
    claim: 'The service route checks the on-chain payment before it runs inference.',
    source: 'How it works: Earn',
    methods: ['get_payment', 'record_service_call'],
    tests: ['test_operator_cannot_credit_revenue_and_metrics_only_from_vault', 'test_seller_operator_cannot_act_while_encumbered'],
    evidence: { steps: ['serve'], teeCalls: true },
  },
  {
    id: 'freeze-signing',
    claim: 'Raw L1 signing by the shareholder is frozen while the company is listed or pledged.',
    source: 'Company state',
    methods: ['request_shareholder_signature', 'sign_legacy_epoch', 'rotate_treasury_epoch'],
    tests: [
      'test_anti_rug_encumbrance_freezes_seller_mpc_signing',
      'test_credit_offer_accept_repay_cycle',
      'test_transfer_call_gives_no_vault_rights_until_kept_and_revert_changes_nothing',
    ],
    evidence: { steps: ['rug-listed', 'rug-pledged'], errors: ['ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN'] },
  },
  {
    id: 'freeze-dividends',
    claim: 'Dividend claims are frozen while the company is listed or pledged.',
    source: 'Company state',
    methods: ['claim_dividends'],
    tests: ['test_dividends_bounded_frozen_and_restored', 'test_failed_bid_callback_refunds_gives_no_rights_and_can_be_recovered'],
    evidence: { steps: ['rug-listed', 'rug-pledged', 'dividends'], methods: ['claim_dividends'] },
  },
  {
    id: 'freeze-transfer',
    claim: 'A direct NFT transfer is refused while the company is listed or pledged.',
    source: 'Company state',
    methods: ['nft_transfer', 'nft_transfer_payout'],
    tests: ['test_credit_offer_accept_repay_cycle', 'test_nft_transfer_syncs_vault_and_approvals_clear', 'test_nep199_payout_respects_royalty_and_encumbrance'],
    evidence: { steps: ['rug-listed', 'rug-pledged'], errors: ['ERR_TOKEN_ENCUMBERED'] },
  },
  {
    id: 'freeze-policy',
    claim: 'Policy changes, operator changes and agent swaps are frozen while the company is listed or pledged.',
    source: 'Company state',
    methods: ['set_policy', 'set_operator', 'agent_swap_intent', 'agent_withdraw_intent'],
    tests: [
      'test_new_shareholder_gets_charter_policy_not_seller_policy',
      'test_withdraw_intent_frozen_while_listed_and_pledged',
      'test_pledge_obeys_the_same_freeze_rules_as_listing',
    ],
    evidence: {},
  },
  {
    id: 'presigned',
    claim: 'A company that signed any raw payload this epoch cannot be listed or pledged until the shareholder rotates to new addresses.',
    source: 'Security model: pre-signed transaction rule',
    methods: ['request_shareholder_signature', 'list_company', 'accept_offer', 'rotate_treasury_epoch'],
    tests: [
      'test_listing_requires_clean_epoch_and_rotation_changes_addresses',
      'test_signature_raced_before_freeze_fails_listing_and_leaves_no_lock',
      'test_sale_paths_refuse_dirty_keys_and_owner_transfer_rotates',
      'test_pledge_obeys_the_same_freeze_rules_as_listing',
    ],
    evidence: { steps: ['btc-send'] },
  },
  {
    id: 'intent-deadline',
    claim: 'An agent intent that has not reached its deadline blocks listing, pledging and every change of owner.',
    source: 'Security model',
    methods: ['agent_swap_intent', 'list_company', 'nft_transfer'],
    tests: ['test_unexpired_agent_intent_blocks_encumbrance_until_deadline', 'test_unexpired_intent_blocks_every_owner_change'],
    evidence: {},
  },
  {
    id: 'acquire',
    claim:
      'On purchase, shareholder rights are suspended, the NFT and funds move, the founder royalty is paid, and only then does the buyer become shareholder. If the vault step fails, the buyer is refunded.',
    source: 'How it works: Sell',
    methods: ['list_company', 'ft_on_transfer {"action":"acquire"}', 'begin_transit', 'apply_encumbrance'],
    tests: [
      'test_atomic_ma_acquisition_flips_shareholder_and_pays_royalty',
      'test_acquire_is_bound_to_the_listing_the_buyer_read',
      'test_vault_failure_leaves_no_stuck_lock_and_refunds_via_resolve',
      'test_failed_bid_callback_refunds_gives_no_rights_and_can_be_recovered',
    ],
    evidence: { steps: ['list', 'buy'] },
  },
  {
    id: 'credit',
    claim: 'When the owner accepts a loan, the vault freezes first and the principal is sent second. Repayment unfreezes it.',
    source: 'How it works: Finance',
    methods: ['ft_on_transfer {"action":"fund_offer"}', 'accept_offer', 'ft_on_transfer {"action":"repay"}'],
    tests: ['test_credit_offer_accept_repay_cycle', 'test_lender_terms_refuse_a_stripped_company', 'test_offers_pay_their_own_storage'],
    evidence: { steps: ['lend', 'borrow', 'repay'] },
  },
  {
    id: 'auction',
    claim: 'After a default, a Dutch auction runs from 200% down to 50% of the debt. With no bid, the lender can claim the company.',
    source: 'How it works: Finance',
    methods: ['start_auction', 'ft_on_transfer {"action":"bid"}', 'claim_defaulted_collateral'],
    tests: [
      'test_default_dutch_auction_bid_pays_lender_royalty_borrower',
      'test_no_bid_lender_claims_collateral',
      'test_auction_vault_failure_refunds_bidder_and_keeps_loan',
    ],
    evidence: {},
  },
  {
    id: 'firewall',
    claim: "The operator sends structured fields and never bytes to sign. A withdrawal can only go to the company's own addresses.",
    source: 'Security model: agent firewall',
    methods: ['agent_withdraw_intent', 'agent_swap_intent'],
    tests: [
      'test_firewall_blocks_prompt_injected_agent_drain',
      'test_firewall_tokens_and_epoch_caps',
      'test_price_floor_bounds_a_swap_even_with_a_valid_approval',
    ],
    evidence: { steps: ['rebalance'], quotes: true },
    note: 'Rebalance execution is not in this release. The live record holds dry 1Click quotes only.',
  },
  {
    id: 'tee',
    claim: 'The vault recovers the TEE signer with ecrecover before it acts on an approval.',
    source: 'Built on: NEAR AI Cloud',
    methods: ['agent_swap_intent', 'agent_withdraw_intent', 'swap_tee_request'],
    tests: [
      'test_tee_proof_checks_and_onchain_ecrecover',
      'test_tee_approval_is_bound_to_the_pinned_request',
      'test_only_an_exact_approve_message_counts',
      'test_approval_lifetime_binding_to_vault_epoch_and_owner',
    ],
    evidence: { teeDeploy: true },
    note: 'A compromised operator can resubmit until a nondeterministic model approves. The epoch cap and price floor bound the loss per window.',
  },
  {
    id: 'charter-operator',
    claim: 'A listed or pledged company keeps taking payments and serving calls. Only the charter operator can serve calls or pay compute then.',
    source: 'Company state',
    methods: ['ft_on_transfer', 'record_service_call', 'pay_compute_bill'],
    tests: ['test_seller_operator_cannot_act_while_encumbered', 'test_compute_bill_only_from_reserve_to_payee_and_intents_deposit'],
    evidence: {},
  },
  {
    id: 'registry-role',
    claim: "The registry updates the vault's owner and encumbrance. It cannot sign anything on the vault's behalf.",
    source: 'Security model: who can do what',
    methods: ['sync_owner', 'begin_transit', 'apply_encumbrance'],
    tests: ['test_role_separation_and_registry_only_sync', 'test_sync_is_refused_on_an_encumbered_vault_and_mint_event_is_exact'],
    evidence: {},
  },
  {
    id: 'charter',
    claim: 'The token media is an on-chain SVG charter, and media_hash is its sha256.',
    source: 'Built on: NEP-177 on-chain SVG charter',
    methods: ['nft_token'],
    tests: ['test_media_hash_is_the_hash_of_the_rendered_charter', 'date_known_instants'],
    evidence: {},
    live: 'charter-hash',
  },
  {
    id: 'runtime',
    claim: "The contracts link on mainnet's runtime.",
    source: 'Build status',
    methods: [],
    tests: ['test_mainnet_runtime_cannot_link_universal_state_init_import'],
    evidence: {},
    live: 'protocol',
    note: 'The sandbox suite pins protocol 87. Mainnet moved to protocol 88 on 2026-11-06; the deploy and demo scripts were rehearsed on a protocol-88 sandbox, the cargo suite was not.',
  },
];

export interface KeyRow {
  holder: string;
  account: string;
  can: string[];
  never: string[];
  /** What this holder's power rests on, when that is a trust assumption rather than code. */
  trust?: string;
}

/** docs/ARCHITECTURE.md section 1, by key holder. */
export const KEY_HOLDERS: KeyRow[] = [
  {
    holder: 'Owner (shareholder)',
    account: 'nft_token(id).owner_id',
    can: [
      'claim_dividends, request_shareholder_signature and rotate_treasury_epoch while FREE',
      'set_operator, set_policy, set_tee_policy, set_price_floors while FREE',
      'list_company, accept_offer (borrow), nft_transfer',
    ],
    never: [
      'Sign, claim or change policy while LISTED, PLEDGED or in transit',
      'Add an access key to the vault or replace its code',
      'List or pledge with raw signatures taken this epoch',
    ],
  },
  {
    holder: 'Operator (TEE agent relay)',
    account: 'vault policy.operator',
    can: [
      'record_service_call for a payment that exists and is unserved',
      'pay_compute_bill from the reserve to compute_payee',
      'agent_swap_intent and agent_withdraw_intent inside policy, with a TEE approval',
    ],
    never: [
      'Supply bytes to sign or write the model prompt',
      "Choose a withdrawal destination other than the company's own addresses",
      'Report revenue, or use the agent methods while encumbered',
    ],
  },
  {
    holder: 'Registry',
    account: 'the registry contract',
    can: ['sync_owner, begin_transit and apply_encumbrance on its own vaults', 'Hold the NFT, the listing book and the loan book'],
    never: ["Sign anything on the vault's behalf", 'Move vault USDC or call the shareholder methods'],
    trust:
      'The registry account itself keeps a full access key on the deployer machine, so its code can be redeployed until that key is deleted (docs/DEPLOY.md). The live check above counts its keys.',
  },
  {
    holder: 'Buyer',
    account: 'any account',
    can: ['Pay the ask with ft_transfer_call {"action":"acquire"} and receive the company'],
    never: ['Hold shareholder rights before the payment settles', 'Buy a listing that changed after it was read: refunded with ERR_LISTING_CHANGED'],
  },
  {
    holder: 'Lender',
    account: 'any account',
    can: ['fund_offer and cancel_offer', 'start_auction after due_ms, claim_defaulted_collateral after a no-bid auction'],
    never: ['Touch vault funds or request a signature', 'Claim the company before the loan is due and the auction window has closed'],
  },
  {
    holder: 'MPC signer',
    account: 'v1.signer / v1.signer-prod.testnet',
    can: ["Sign on paths incorpr-<id>-... when the vault itself calls sign, since the vault's account id is the derivation predecessor"],
    never: ['Be asked by another account for the vault keys: a different caller derives different keys'],
    trust: 'A threshold of colluding MPC nodes could sign anything. That is the trust assumption of Chain Signatures.',
  },
];

/** Transactions in the evidence log that show this claim on a live network. */
export function matchingTransactions(evidence: Pick<Evidence, 'transactions'>, claim: Claim): EvidenceTx[] {
  const { steps, methods, errors } = claim.evidence;
  if (!steps?.length) return [];
  return evidence.transactions.filter(
    (t) =>
      steps.includes(t.step) &&
      (!methods?.length || methods.includes(t.method)) &&
      (!errors?.length || (t.error != null && errors.includes(t.error))),
  );
}

export function hasAnyEvidenceSource(claim: Claim): boolean {
  const e = claim.evidence;
  return Boolean(e.steps?.length || e.teeCalls || e.teeDeploy || e.quotes || e.bitcoin);
}
