//! Per-company vault, deployed on `c-<id>.<registry>` with no access keys and no upgrade method.
//! See docs/ARCHITECTURE.md sections 2-4.

pub mod chain;

use near_sdk::base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

use chain::*;

const EPOCH_MS: u64 = 86_400_000;
const DAY_MS: u64 = 86_400_000;
const MAX_INTENT_TTL_MS: u64 = 300_000;
const BPS_DENOMINATOR: u128 = 10_000;
const MAX_POLICY_ENTRIES: usize = 32;
const MAX_FIELD_LEN: usize = 128;
const MAX_TEE_MODELS: usize = 8;
const MAX_PRICE_FLOORS: usize = 16;
/// Lower bound on `compute_reserve_bps`, so recycling a payment through dividends always costs
/// something. It does not stop a seller inflating `revenue_30d` through sybil payers.
const MIN_COMPUTE_RESERVE_BPS: u16 = 100;

/// The newest payment records kept on-chain. Older ones survive only as `payment_received` events.
const MAX_PAYMENT_RECORDS: u64 = 128;
/// Nonces of proofs that are still inside their approval window.
const MAX_LIVE_NONCES: u64 = 32;
/// Pruned nonces per call. Above one, so the log shrinks whenever old entries have expired.
const NONCE_PRUNE_STEPS: u32 = 2;

/// Age limit on a TEE approval, read from the `created` field the TEE signed over.
const MAX_APPROVAL_AGE_S: u64 = 600;
const MAX_APPROVAL_CLOCK_SKEW_S: u64 = 60;
const MAX_TEE_PROMPT_BYTES: usize = 4_096;
const MAX_TEE_RESPONSE_BYTES: usize = 16_384;

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(80);
const GAS_FT_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_REPORT_METRICS: Gas = Gas::from_tgas(8);
const GAS_DERIVE_MIN: Gas = Gas::from_tgas(30);
const GAS_KEYS_CALLBACK: Gas = Gas::from_tgas(25);
const GAS_ADD_PUBLIC_KEY: Gas = Gas::from_tgas(15);
const GAS_ADD_KEY_CALLBACK: Gas = Gas::from_tgas(5);
const GAS_SIGN_CALLBACK: Gas = Gas::from_tgas(15);
/// Spent by the calling receipt after the forwarded amount is computed.
const GAS_SIGN_OVERHEAD: Gas = Gas::from_tgas(5);
/// Below this the live signer rejects or times out `sign`.
const GAS_MPC_SIGN_MIN: Gas = Gas::from_tgas(50);

const DOMAIN_SECP256K1: u64 = 0;
const DOMAIN_ED25519: u64 = 1;
const EDDSA_MAX_PAYLOAD_BYTES: usize = 1232;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Payments,
    UsedNonces,
    PaymentLog,
    NonceLog,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum EncumbranceState {
    Free,
    Listed { ask: U128 },
    Pledged { lender: AccountId, debt: U128, due_ms: u64 },
}

#[near(serializers = [json])]
pub struct VaultInit {
    pub token_id: String,
    pub registry: AccountId,
    pub shareholder: AccountId,
    pub founder: AccountId,
    pub founder_royalty_bps: u16,
    pub operator: AccountId,
    pub compute_payee: AccountId,
    pub mpc_contract: AccountId,
    pub intents_contract: AccountId,
    pub usdc_token: AccountId,
    pub btc_hrp: String,
    pub price_micro_usdc: U128,
    pub compute_reserve_bps: u16,
    pub allowed_tokens: Vec<String>,
    pub epoch_caps: Vec<(String, U128)>,
    pub tee_signers: Vec<String>,
    pub tee_models: Vec<String>,
    pub tee_prompt_hash: String,
    pub price_floors: Vec<PriceFloor>,
}

/// A swap of `sell_token` for `buy_token` must promise at least `min_buy` buy units for every
/// `per_sell` sell units, in base units. A shareholder-set bound, not an oracle price.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceFloor {
    pub sell_token: String,
    pub buy_token: String,
    pub min_buy: U128,
    pub per_sell: U128,
}

/// A lender's conditions on the company it priced, checked when the pledge lands.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PledgeTerms {
    pub min_retained: Option<U128>,
    pub required_epoch: Option<u32>,
}

/// Agent-facing configuration. A new shareholder starts from the values fixed at incorporation,
/// so a seller cannot hand a buyer an operator or TEE signer of their own choosing.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub operator: AccountId,
    pub allowed_tokens: Vec<String>,
    pub epoch_caps: Vec<(String, U128)>,
    pub tee_signers: Vec<String>,
    /// Model ids an approval may come from. An empty list refuses every approval.
    pub tee_models: Vec<String>,
    /// Lowercase hex sha256 of the system prompt. Empty refuses every approval.
    pub tee_prompt_hash: String,
    /// A pair with no floor cannot be swapped.
    pub price_floors: Vec<PriceFloor>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Payment {
    pub payer: AccountId,
    pub amount: U128,
    pub served: bool,
    pub tee_chat_id: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct TreasuryAddresses {
    pub epoch: u32,
    pub btc: String,
    pub evm: String,
    pub sol: String,
    pub secp256k1_key: String,
    pub ed25519_key: String,
}

#[near(serializers = [json])]
pub struct SwapProposal {
    pub sell_token: String,
    pub sell_amount: U128,
    pub buy_token: String,
    pub min_buy_amount: U128,
    pub nonce_b64: String,
}

#[near(serializers = [json])]
pub struct WithdrawProposal {
    pub token: String,
    pub amount: U128,
    pub destination: String,
    pub chain: String,
    pub nonce_b64: String,
}

#[near(serializers = [json])]
pub struct TeeProof {
    pub text: String,
    pub signature_hex: String,
    pub response_body: String,
    /// Its sha256 must equal `tee_prompt_hash`.
    pub system_prompt: String,
}

/// The exact bytes the operator must send to NEAR AI for a proposal, and the hash the model must
/// answer with.
#[near(serializers = [json])]
pub struct TeeRequest {
    pub body: String,
    pub proposal_hash: String,
}

/// Measured over the payment records still on-chain. Sybil payers can make these look healthy too.
#[near(serializers = [json])]
pub struct PaymentStats {
    pub records: u64,
    pub total_amount: U128,
    pub served_amount: U128,
    pub distinct_payers: u64,
    pub largest_payer_amount: U128,
}

#[near(serializers = [json])]
pub struct SignedIntentPayload {
    pub message: String,
    pub nonce: String,
    pub recipient: String,
}

/// Ready for `execute_intents` or the solver relay.
#[near(serializers = [json])]
pub struct SignedIntent {
    pub standard: String,
    pub payload: SignedIntentPayload,
    pub public_key: String,
    pub signature: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct PaymentMsg {
    call_id: String,
}

/// `v1.signer` response for domain 1: `{"scheme":"Ed25519","signature":[...64 bytes]}`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Ed25519Response {
    signature: Vec<u8>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct ChatRequest<'a> {
    model: &'a str,
    messages: [ChatMessage<'a>; 2],
    stream: bool,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct ChatMessage<'a> {
    role: &'static str,
    content: &'a str,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChatResponse {
    created: u64,
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChatChoiceMessage {
    content: Option<String>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct IntentMessage<'a, I: Serialize> {
    signer_id: &'a AccountId,
    deadline: &'a str,
    intents: [I; 1],
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct TokenDiffIntent<'a> {
    intent: &'static str,
    diff: std::collections::BTreeMap<&'a str, String>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtWithdrawIntent<'a> {
    intent: &'static str,
    token: &'a str,
    receiver_id: &'a str,
    amount: String,
    memo: String,
}

#[near(serializers = [json])]
pub struct VaultView {
    pub token_id: String,
    pub registry: AccountId,
    pub shareholder: AccountId,
    pub founder: AccountId,
    pub founder_royalty_bps: u16,
    pub compute_payee: AccountId,
    pub mpc_contract: AccountId,
    pub intents_contract: AccountId,
    pub usdc_token: AccountId,
    pub btc_hrp: String,
    pub price_micro_usdc: U128,
    pub compute_reserve_bps: u16,
    pub policy: Policy,
    pub default_policy: Policy,
    pub encumbrance: EncumbranceState,
    pub in_transit: bool,
    pub sync_nonce: u64,
    pub owner_generation: u64,
    pub treasury_epoch: u32,
    pub raw_sigs_this_epoch: u64,
    pub addresses: Option<TreasuryAddresses>,
    pub intents_key: Option<String>,
    pub intents_key_registered: bool,
    pub latest_intent_deadline_ms: u64,
    pub gross_revenue: U128,
    pub related_party_revenue: U128,
    pub compute_reserve: U128,
    pub retained_earnings: U128,
    pub revenue_30d: U128,
    pub api_calls_served: u64,
    pub dividends_paid: U128,
    pub compute_paid: U128,
    pub deposited_to_intents: U128,
    pub spend_window: u64,
    pub spent_this_window: Vec<(String, U128)>,
    pub payment_records: u64,
    /// Account balance above what its storage requires. A plain NEAR transfer tops it up.
    pub free_near_balance: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct CompanyVault {
    token_id: String,
    registry: AccountId,
    shareholder: AccountId,
    founder: AccountId,
    founder_royalty_bps: u16,
    compute_payee: AccountId,
    mpc_contract: AccountId,
    intents_contract: AccountId,
    usdc_token: AccountId,
    btc_hrp: String,
    price_micro_usdc: u128,
    compute_reserve_bps: u16,

    policy: Policy,
    default_policy: Policy,

    encumbrance: EncumbranceState,
    /// Set by the registry while a sale or transfer-call settles. Nobody can use shareholder or
    /// agent rights until the registry names the final holder.
    in_transit: bool,
    sync_nonce: u64,
    /// Incremented on each change of shareholder. Part of every proposal hash.
    owner_generation: u64,

    treasury_epoch: u32,
    raw_sigs_this_epoch: u64,
    addresses: Option<TreasuryAddresses>,
    intents_key: Option<String>,
    intents_key_registered: bool,
    latest_intent_deadline_ms: u64,

    gross_revenue: u128,
    related_party_revenue: u128,
    compute_reserve: u128,
    retained_earnings: u128,
    api_calls_served: u64,
    dividends_paid: u128,
    compute_paid: u128,
    deposited_to_intents: u128,
    /// (day number, unrelated-party revenue). Holds at most 30 entries.
    daily_revenue: Vec<(u64, u128)>,
    payments: LookupMap<String, Payment>,
    payment_log: LookupMap<u64, String>,
    payment_log_head: u64,
    payment_log_tail: u64,

    spend_window: u64,
    spent_this_window: Vec<(String, u128)>,
    used_nonces: LookupSet<[u8; 32]>,
    nonce_log: LookupMap<u64, (u64, [u8; 32])>,
    nonce_log_head: u64,
    nonce_log_tail: u64,
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "incorpr-vault", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

/// `TooLong` means a success with a non-empty body: the value itself is not read here.
fn last_promise_succeeded() -> bool {
    matches!(env::promise_result_checked(0, 0), Ok(_) | Err(PromiseError::TooLong(_)))
}

fn normalize_signers(addresses: Vec<String>) -> Vec<String> {
    require!(addresses.len() <= MAX_POLICY_ENTRIES, "ERR_INVALID_POLICY");
    addresses
        .into_iter()
        .map(|a| {
            let lower = a.to_ascii_lowercase();
            let body = lower.strip_prefix("0x").unwrap_or_else(|| env::panic_str("ERR_INVALID_POLICY"));
            require!(
                body.len() == 40 && hex_decode(body).is_some(),
                "ERR_INVALID_POLICY"
            );
            lower
        })
        .collect()
}

fn check_policy_lists(allowed_tokens: &[String], epoch_caps: &[(String, U128)]) {
    require!(
        allowed_tokens.len() <= MAX_POLICY_ENTRIES && epoch_caps.len() <= MAX_POLICY_ENTRIES,
        "ERR_INVALID_POLICY"
    );
    let valid = |t: &String| !t.is_empty() && t.len() <= MAX_FIELD_LEN;
    require!(
        allowed_tokens.iter().all(valid) && epoch_caps.iter().all(|(t, _)| valid(t)),
        "ERR_INVALID_POLICY"
    );
}

fn check_tee_policy(models: &[String], prompt_hash: &str) {
    require!(
        models.len() <= MAX_TEE_MODELS
            && models.iter().all(|m| !m.is_empty() && m.len() <= MAX_FIELD_LEN && !m.contains(':')),
        "ERR_INVALID_POLICY"
    );
    let valid_hash = prompt_hash.is_empty()
        || (prompt_hash.len() == 64
            && prompt_hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    require!(valid_hash, "ERR_INVALID_POLICY");
}

fn check_price_floors(floors: &[PriceFloor]) {
    require!(floors.len() <= MAX_PRICE_FLOORS, "ERR_INVALID_POLICY");
    let valid = |t: &str| !t.is_empty() && t.len() <= MAX_FIELD_LEN;
    require!(
        floors.iter().all(|f| valid(&f.sell_token)
            && valid(&f.buy_token)
            && f.min_buy.0 > 0
            && f.per_sell.0 > 0),
        "ERR_INVALID_POLICY"
    );
}

/// Full 256-bit product as (high, low) limbs. Token amounts in base units overflow u128 once
/// multiplied, especially for 24-decimal tokens.
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    const LOW: u128 = u64::MAX as u128;
    let (a_hi, a_lo) = (a >> 64, a & LOW);
    let (b_hi, b_lo) = (b >> 64, b & LOW);
    let low = a_lo * b_lo;
    let mid_a = a_hi * b_lo + (low >> 64);
    let mid_b = a_lo * b_hi + (mid_a & LOW);
    ((a_hi * b_hi) + (mid_a >> 64) + (mid_b >> 64), (mid_b << 64) | (low & LOW))
}

fn check_subpath(subpath: &str) {
    require!(
        !subpath.is_empty()
            && subpath.len() <= 32
            && subpath.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'),
        "ERR_INVALID_SUBPATH"
    );
}

/// Chain a NEP-141 bridged token (`nep141:<prefix>[-<addr>].omft.near`) withdraws to, or `None` if
/// the token has no bridge contract that honours `WITHDRAW_TO`.
fn omft_chain(contract: &str) -> Option<&'static str> {
    let stem = contract.strip_suffix(".omft.near")?;
    let prefix = stem.split('-').next()?;
    match prefix {
        "btc" => Some("btc"),
        "sol" => Some("sol"),
        "eth" | "base" | "arb" | "gnosis" | "bera" | "plasma" | "hood" => Some("evm"),
        _ => None,
    }
}

fn swap_fields(p: &SwapProposal) -> String {
    [
        p.sell_token.as_str(),
        &p.sell_amount.0.to_string(),
        p.buy_token.as_str(),
        &p.min_buy_amount.0.to_string(),
    ]
    .join(":")
}

fn withdraw_fields(p: &WithdrawProposal) -> String {
    [p.token.as_str(), &p.amount.0.to_string(), p.destination.as_str(), p.chain.as_str()].join(":")
}

fn decode_nonce(nonce_b64: &str) -> [u8; 32] {
    BASE64
        .decode(nonce_b64)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .unwrap_or_else(|| env::panic_str("ERR_INVALID_NONCE"))
}

#[near]
impl CompanyVault {
    #[init]
    pub fn new(args: VaultInit) -> Self {
        require!(args.founder_royalty_bps <= 1_000, "ERR_INVALID_ROYALTY");
        require!(
            (MIN_COMPUTE_RESERVE_BPS..=10_000).contains(&args.compute_reserve_bps),
            "ERR_INVALID_RESERVE"
        );
        require!(args.btc_hrp == "bc" || args.btc_hrp == "tb", "ERR_INVALID_BTC_HRP");
        require!(args.price_micro_usdc.0 > 0, "ERR_INVALID_PRICE");
        check_policy_lists(&args.allowed_tokens, &args.epoch_caps);
        check_tee_policy(&args.tee_models, &args.tee_prompt_hash);
        check_price_floors(&args.price_floors);
        let policy = Policy {
            operator: args.operator,
            allowed_tokens: args.allowed_tokens,
            epoch_caps: args.epoch_caps,
            tee_signers: normalize_signers(args.tee_signers),
            tee_models: args.tee_models,
            tee_prompt_hash: args.tee_prompt_hash,
            price_floors: args.price_floors,
        };
        Self {
            token_id: args.token_id,
            registry: args.registry,
            shareholder: args.shareholder,
            founder: args.founder,
            founder_royalty_bps: args.founder_royalty_bps,
            compute_payee: args.compute_payee,
            mpc_contract: args.mpc_contract,
            intents_contract: args.intents_contract,
            usdc_token: args.usdc_token,
            btc_hrp: args.btc_hrp,
            price_micro_usdc: args.price_micro_usdc.0,
            compute_reserve_bps: args.compute_reserve_bps,
            default_policy: policy.clone(),
            policy,
            encumbrance: EncumbranceState::Free,
            in_transit: false,
            sync_nonce: 0,
            owner_generation: 0,
            treasury_epoch: 0,
            raw_sigs_this_epoch: 0,
            addresses: None,
            intents_key: None,
            intents_key_registered: false,
            latest_intent_deadline_ms: 0,
            gross_revenue: 0,
            related_party_revenue: 0,
            compute_reserve: 0,
            retained_earnings: 0,
            api_calls_served: 0,
            dividends_paid: 0,
            compute_paid: 0,
            deposited_to_intents: 0,
            daily_revenue: Vec::new(),
            payments: LookupMap::new(StorageKey::Payments),
            payment_log: LookupMap::new(StorageKey::PaymentLog),
            payment_log_head: 0,
            payment_log_tail: 0,
            spend_window: 0,
            spent_this_window: Vec::new(),
            used_nonces: LookupSet::new(StorageKey::UsedNonces),
            nonce_log: LookupMap::new(StorageKey::NonceLog),
            nonce_log_head: 0,
            nonce_log_tail: 0,
        }
    }

    // ---------------------------------------------------------------- Registry only

    /// A direct change of shareholder, used by `nft_transfer`. `require_clean` is set when an
    /// approved account moves the token, which is how a marketplace sells it: raw signatures in
    /// the current epoch then refuse the sale. Without it, a dirty epoch rotates in
    /// `set_shareholder`, and the receiver starts on keys that have never signed.
    pub fn sync_owner(
        &mut self,
        new_shareholder: AccountId,
        sync_nonce: u64,
        require_clean: Option<bool>,
    ) {
        self.assert_registry_nonce(sync_nonce);
        require!(
            self.encumbrance == EncumbranceState::Free && !self.in_transit,
            "ERR_ACCOUNT_ENCUMBERED_SYNC"
        );
        if new_shareholder != self.shareholder {
            if require_clean == Some(true) {
                require!(self.raw_sigs_this_epoch == 0, "ERR_RAW_SIGNATURES_THIS_EPOCH");
            }
            require!(now_ms() > self.latest_intent_deadline_ms, "ERR_UNEXPIRED_SIGNED_INTENTS");
        }
        self.set_shareholder(new_shareholder);
        emit("owner_synced", json!({"shareholder": self.shareholder, "sync_nonce": sync_nonce}));
    }

    /// First step of a settlement. From here until `apply_encumbrance` names the final holder, no
    /// account has shareholder or agent rights, so a settlement that fails midway hands nothing to
    /// anyone. Refuses dirty keys and unexpired intents the same way a freeze does.
    pub fn begin_transit(&mut self, sync_nonce: u64) {
        self.assert_registry_nonce(sync_nonce);
        require!(self.raw_sigs_this_epoch == 0, "ERR_RAW_SIGNATURES_THIS_EPOCH");
        require!(now_ms() > self.latest_intent_deadline_ms, "ERR_UNEXPIRED_SIGNED_INTENTS");
        self.in_transit = true;
        emit("transit_begun", json!({"sync_nonce": sync_nonce}));
    }

    /// Section 3 is enforced here, when the freeze lands: a signature raced in between the
    /// registry call and this receipt makes the listing or pledge fail. Ends any transit.
    pub fn apply_encumbrance(
        &mut self,
        new_shareholder: AccountId,
        state: EncumbranceState,
        sync_nonce: u64,
        terms: Option<PledgeTerms>,
    ) {
        self.assert_registry_nonce(sync_nonce);
        if state != EncumbranceState::Free {
            require!(self.raw_sigs_this_epoch == 0, "ERR_RAW_SIGNATURES_THIS_EPOCH");
            require!(now_ms() > self.latest_intent_deadline_ms, "ERR_UNEXPIRED_SIGNED_INTENTS");
        }
        if let Some(terms) = terms {
            require!(
                terms.min_retained.is_none_or(|min| self.retained_earnings >= min.0)
                    && terms.required_epoch.is_none_or(|epoch| self.treasury_epoch == epoch),
                "ERR_PLEDGE_TERMS_NOT_MET"
            );
        }
        self.set_shareholder(new_shareholder);
        self.encumbrance = state;
        self.in_transit = false;
        emit(
            "encumbrance_applied",
            json!({"shareholder": self.shareholder, "state": self.encumbrance, "sync_nonce": sync_nonce}),
        );
    }

    // ---------------------------------------------------------------- Revenue

    /// NEP-141 receiver. The only path that books revenue.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        if env::predecessor_account_id() != self.usdc_token {
            return amount;
        }
        let call_id = match serde_json::from_str::<PaymentMsg>(&msg) {
            Ok(m) if !m.call_id.is_empty() && m.call_id.len() <= 64 => m.call_id,
            _ => return amount,
        };
        if amount.0 < self.price_micro_usdc || self.payments.contains_key(&call_id) {
            return amount;
        }

        let reserve_cut = amount.0 * self.compute_reserve_bps as u128 / BPS_DENOMINATOR;
        self.compute_reserve += reserve_cut;
        self.retained_earnings += amount.0 - reserve_cut;

        let related_party = sender_id == self.shareholder;
        if related_party {
            self.related_party_revenue += amount.0;
        } else {
            self.gross_revenue += amount.0;
            self.add_daily_revenue(amount.0);
        }
        emit(
            "payment_received",
            json!({"call_id": call_id, "payer": sender_id, "amount": amount, "related_party": related_party}),
        );
        self.store_payment(call_id, Payment { payer: sender_id, amount, served: false, tee_chat_id: None });
        self.notify_registry();
        U128(0)
    }

    // ---------------------------------------------------------------- Operator

    pub fn record_service_call(&mut self, call_id: String, tee_chat_id: String) {
        self.assert_service_operator();
        require!(!tee_chat_id.is_empty() && tee_chat_id.len() <= MAX_FIELD_LEN, "ERR_INVALID_CHAT_ID");
        let payment = self
            .payments
            .get_mut(&call_id)
            .unwrap_or_else(|| env::panic_str("ERR_PAYMENT_NOT_FOUND"));
        require!(!payment.served, "ERR_PAYMENT_ALREADY_SERVED");
        payment.served = true;
        payment.tee_chat_id = Some(tee_chat_id.clone());
        self.api_calls_served += 1;
        emit("service_call_recorded", json!({"call_id": call_id, "tee_chat_id": tee_chat_id}));
        self.notify_registry();
    }

    /// Allowed while encumbered: a listed or pledged company keeps paying its compute bills, and
    /// the funds can only reach the `compute_payee` fixed at incorporation.
    pub fn pay_compute_bill(&mut self, amount: U128) -> Promise {
        self.assert_service_operator();
        require!(amount.0 > 0, "ERR_INVALID_AMOUNT");
        require!(amount.0 <= self.compute_reserve, "ERR_INSUFFICIENT_COMPUTE_RESERVE");
        self.compute_reserve -= amount.0;
        self.ft_transfer(&self.compute_payee.clone(), amount)
            .then(self.ft_callback().on_compute_paid(amount))
    }

    pub fn agent_deposit_to_intents(&mut self, amount: U128) -> Promise {
        self.assert_operator();
        self.assert_agent_not_frozen();
        require!(amount.0 > 0, "ERR_INVALID_AMOUNT");
        require!(amount.0 <= self.retained_earnings, "ERR_INSUFFICIENT_RETAINED_EARNINGS");
        self.retained_earnings -= amount.0;
        let args = json!({
            "receiver_id": self.intents_contract,
            "amount": amount,
            "msg": env::current_account_id(),
        });
        Promise::new(self.usdc_token.clone())
            .function_call_weight(
                "ft_transfer_call",
                args.to_string().into_bytes(),
                ONE_YOCTO,
                GAS_FT_TRANSFER_CALL,
                GasWeight(1),
            )
            .then(self.ft_callback().on_intents_deposit(amount))
    }

    pub fn agent_swap_intent(&mut self, p: SwapProposal, tee: TeeProof) -> Promise {
        self.assert_operator();
        self.assert_agent_not_frozen();
        self.assert_token_allowed(&p.sell_token);
        self.assert_token_allowed(&p.buy_token);
        require!(
            p.sell_token != p.buy_token && p.sell_amount.0 > 0 && p.min_buy_amount.0 > 0,
            "ERR_FIREWALL_INVALID_PROPOSAL"
        );
        self.charge_epoch_spend(&p.sell_token, p.sell_amount.0);
        self.assert_price_floor(&p);
        let nonce = self.consume_nonce(&p.nonce_b64);
        self.verify_tee_approval("swap", &swap_fields(&p), &p.nonce_b64, &tee);

        let deadline_ms = self.next_intent_deadline();
        let me = env::current_account_id();
        let mut diff = std::collections::BTreeMap::new();
        diff.insert(p.sell_token.as_str(), format!("-{}", p.sell_amount.0));
        diff.insert(p.buy_token.as_str(), p.min_buy_amount.0.to_string());
        let message = serde_json::to_string(&IntentMessage {
            signer_id: &me,
            deadline: &iso8601_ms(deadline_ms),
            intents: [TokenDiffIntent { intent: "token_diff", diff }],
        })
        .unwrap_or_else(|_| env::panic_str("ERR_INTENT_ENCODING"));
        self.sign_intent(message, nonce, p.nonce_b64)
    }

    pub fn agent_withdraw_intent(&mut self, p: WithdrawProposal, tee: TeeProof) -> Promise {
        self.assert_operator();
        self.assert_agent_not_frozen();
        self.assert_token_allowed(&p.token);
        require!(p.amount.0 > 0, "ERR_FIREWALL_INVALID_PROPOSAL");
        let contract = p
            .token
            .strip_prefix("nep141:")
            .unwrap_or_else(|| env::panic_str("ERR_FIREWALL_BLOCKED_TOKEN"))
            .to_string();
        let token_chain = omft_chain(&contract).unwrap_or_else(|| env::panic_str("ERR_FIREWALL_BLOCKED_TOKEN"));
        self.assert_own_address(&p.chain, &p.destination);
        require!(token_chain == p.chain, "ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION");
        self.charge_epoch_spend(&p.token, p.amount.0);
        let nonce = self.consume_nonce(&p.nonce_b64);
        self.verify_tee_approval("withdraw", &withdraw_fields(&p), &p.nonce_b64, &tee);

        let deadline_ms = self.next_intent_deadline();
        let me = env::current_account_id();
        let message = serde_json::to_string(&IntentMessage {
            signer_id: &me,
            deadline: &iso8601_ms(deadline_ms),
            intents: [FtWithdrawIntent {
                intent: "ft_withdraw",
                token: &contract,
                receiver_id: &contract,
                amount: p.amount.0.to_string(),
                memo: format!("WITHDRAW_TO:{}", p.destination),
            }],
        })
        .unwrap_or_else(|_| env::panic_str("ERR_INTENT_ENCODING"));
        self.sign_intent(message, nonce, p.nonce_b64)
    }

    // ---------------------------------------------------------------- Shareholder

    #[payable]
    pub fn claim_dividends(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        self.assert_shareholder();
        self.assert_free("ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN");
        require!(amount.0 > 0, "ERR_INVALID_AMOUNT");
        require!(amount.0 <= self.retained_earnings, "ERR_INSUFFICIENT_RETAINED_EARNINGS");
        self.retained_earnings -= amount.0;
        let shareholder = self.shareholder.clone();
        self.ft_transfer(&shareholder, amount)
            .then(self.ft_callback().on_dividends_paid(shareholder, amount))
    }

    /// Marks the current epoch dirty before calling the signer, so the company cannot be listed or
    /// pledged until the shareholder rotates to fresh addresses.
    #[payable]
    pub fn request_shareholder_signature(
        &mut self,
        domain_id: u64,
        payload_hex: String,
        subpath: String,
    ) -> Promise {
        self.assert_shareholder();
        self.assert_free("ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN");
        check_subpath(&subpath);
        self.raw_sigs_this_epoch += 1;
        emit(
            "raw_signature_requested",
            json!({"epoch": self.treasury_epoch, "domain_id": domain_id, "subpath": subpath}),
        );
        let path = self.epoch_path(self.treasury_epoch, &subpath);
        self.raw_sign(path, domain_id, payload_hex)
    }

    /// Reaches funds left on addresses from a previous epoch. Those funds are excluded from NAV,
    /// and these signatures do not dirty the current epoch.
    #[payable]
    pub fn sign_legacy_epoch(
        &mut self,
        epoch: u32,
        domain_id: u64,
        payload_hex: String,
        subpath: String,
    ) -> Promise {
        self.assert_shareholder();
        self.assert_free("ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN");
        require!(epoch < self.treasury_epoch, "ERR_NOT_A_LEGACY_EPOCH");
        check_subpath(&subpath);
        emit("legacy_signature_requested", json!({"epoch": epoch, "domain_id": domain_id, "subpath": subpath}));
        let path = self.epoch_path(epoch, &subpath);
        self.raw_sign(path, domain_id, payload_hex)
    }

    #[payable]
    pub fn rotate_treasury_epoch(&mut self) -> Promise {
        assert_one_yocto();
        self.assert_shareholder();
        self.assert_free("ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN");
        self.treasury_epoch += 1;
        self.raw_sigs_this_epoch = 0;
        self.addresses = None;
        emit("treasury_epoch_rotated", json!({"epoch": self.treasury_epoch}));
        self.refresh_treasury_keys()
    }

    #[payable]
    pub fn set_operator(&mut self, account: AccountId) {
        self.assert_policy_change();
        self.policy.operator = account;
        emit("operator_set", json!({"operator": self.policy.operator}));
    }

    #[payable]
    pub fn set_tee_signers(&mut self, addresses: Vec<String>) {
        self.assert_policy_change();
        self.policy.tee_signers = normalize_signers(addresses);
        emit("tee_signers_set", json!({"tee_signers": self.policy.tee_signers}));
    }

    #[payable]
    pub fn set_policy(&mut self, allowed_tokens: Vec<String>, epoch_caps: Vec<(String, U128)>) {
        self.assert_policy_change();
        check_policy_lists(&allowed_tokens, &epoch_caps);
        self.policy.allowed_tokens = allowed_tokens;
        self.policy.epoch_caps = epoch_caps;
        emit(
            "policy_set",
            json!({"allowed_tokens": self.policy.allowed_tokens, "epoch_caps": self.policy.epoch_caps}),
        );
    }

    #[payable]
    pub fn set_tee_policy(&mut self, models: Vec<String>, prompt_hash: String) {
        self.assert_policy_change();
        check_tee_policy(&models, &prompt_hash);
        self.policy.tee_models = models;
        self.policy.tee_prompt_hash = prompt_hash;
        emit(
            "tee_policy_set",
            json!({"tee_models": self.policy.tee_models, "tee_prompt_hash": self.policy.tee_prompt_hash}),
        );
    }

    #[payable]
    pub fn set_price_floors(&mut self, floors: Vec<PriceFloor>) {
        self.assert_policy_change();
        check_price_floors(&floors);
        self.policy.price_floors = floors;
        emit("price_floors_set", json!({"price_floors": self.policy.price_floors}));
    }

    // ---------------------------------------------------------------- Permissionless

    /// Pushes current metrics to the registry. The registry keeps a snapshot and cannot read the
    /// vault's 30-day window on its own, so a quiet company's charter goes stale until this runs.
    pub fn refresh_metrics(&mut self) {
        self.notify_registry();
    }

    pub fn refresh_treasury_keys(&mut self) -> Promise {
        let epoch = self.treasury_epoch;
        let path = self.epoch_path(epoch, "treasury");
        self.derive_key(&path, DOMAIN_SECP256K1)
            .and(self.derive_key(&path, DOMAIN_ED25519))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_KEYS_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_treasury_keys(epoch),
            )
    }

    /// Takes no key argument. Only the MPC-derived key for the intents path is ever registered.
    pub fn setup_intents_key(&mut self) -> PromiseOrValue<String> {
        if self.intents_key_registered {
            if let Some(key) = &self.intents_key {
                return PromiseOrValue::Value(key.clone());
            }
        }
        let path = self.intents_path();
        self.derive_key(&path, DOMAIN_ED25519)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ADD_PUBLIC_KEY.saturating_add(GAS_ADD_KEY_CALLBACK).saturating_add(Gas::from_tgas(10)))
                    .with_unused_gas_weight(0)
                    .on_intents_key_derived(),
            )
            .into()
    }

    // ---------------------------------------------------------------- Callbacks

    #[private]
    pub fn on_compute_paid(&mut self, amount: U128) -> bool {
        let ok = last_promise_succeeded();
        if ok {
            self.compute_paid += amount.0;
            emit("compute_bill_paid", json!({"payee": self.compute_payee, "amount": amount}));
        } else {
            self.compute_reserve += amount.0;
            emit("compute_bill_failed", json!({"amount": amount}));
        }
        ok
    }

    #[private]
    pub fn on_dividends_paid(&mut self, shareholder: AccountId, amount: U128) -> bool {
        let ok = last_promise_succeeded();
        if ok {
            self.dividends_paid += amount.0;
            emit("dividends_claimed", json!({"shareholder": shareholder, "amount": amount}));
        } else {
            self.retained_earnings += amount.0;
            emit("dividends_failed", json!({"shareholder": shareholder, "amount": amount}));
        }
        self.notify_registry();
        ok
    }

    /// `ft_transfer_call` returns the amount the receiver kept.
    #[private]
    pub fn on_intents_deposit(
        &mut self,
        amount: U128,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> U128 {
        let used = used.map(|u| u.0).unwrap_or(0).min(amount.0);
        let unused = amount.0 - used;
        self.retained_earnings += unused;
        self.deposited_to_intents += used;
        emit("intents_deposit", json!({"used": U128(used), "restored": U128(unused)}));
        self.notify_registry();
        U128(used)
    }

    #[private]
    pub fn on_treasury_keys(
        &mut self,
        epoch: u32,
        #[callback_result] secp256k1_key: Result<String, PromiseError>,
        #[callback_result] ed25519_key: Result<String, PromiseError>,
    ) -> Option<TreasuryAddresses> {
        if epoch != self.treasury_epoch {
            env::log_str("stale treasury key derivation ignored");
            return None;
        }
        let secp256k1_key =
            secp256k1_key.unwrap_or_else(|_| env::panic_str("ERR_MPC_DERIVATION_FAILED"));
        let ed25519_key =
            ed25519_key.unwrap_or_else(|_| env::panic_str("ERR_MPC_DERIVATION_FAILED"));
        let xy = parse_secp256k1_key(&secp256k1_key)
            .unwrap_or_else(|| env::panic_str("ERR_MPC_KEY_FORMAT"));
        let ed = parse_ed25519_key(&ed25519_key)
            .unwrap_or_else(|| env::panic_str("ERR_MPC_KEY_FORMAT"));
        let addresses = TreasuryAddresses {
            epoch,
            btc: btc_p2wpkh_address(&xy, &self.btc_hrp),
            evm: evm_address(&xy),
            sol: solana_address(&ed),
            secp256k1_key,
            ed25519_key,
        };
        emit("treasury_addresses_set", json!(addresses));
        self.addresses = Some(addresses.clone());
        Some(addresses)
    }

    #[private]
    pub fn on_intents_key_derived(
        &mut self,
        #[callback_result] key: Result<String, PromiseError>,
    ) -> Promise {
        let key = key.unwrap_or_else(|_| env::panic_str("ERR_MPC_DERIVATION_FAILED"));
        if parse_ed25519_key(&key).is_none() {
            env::panic_str("ERR_MPC_KEY_FORMAT");
        }
        self.intents_key = Some(key.clone());
        Promise::new(self.intents_contract.clone())
            .function_call_weight(
                "add_public_key",
                json!({"public_key": key}).to_string().into_bytes(),
                ONE_YOCTO,
                GAS_ADD_PUBLIC_KEY,
                GasWeight(0),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ADD_KEY_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_intents_key_added(),
            )
    }

    #[private]
    pub fn on_intents_key_added(&mut self) -> String {
        if !last_promise_succeeded() {
            env::panic_str("ERR_INTENTS_KEY_REGISTRATION_FAILED");
        }
        self.intents_key_registered = true;
        let key = self.intents_key.clone().unwrap_or_else(|| env::panic_str("ERR_INTENTS_KEY_NOT_SET"));
        emit("intents_key_registered", json!({"public_key": key}));
        key
    }

    #[private]
    pub fn on_intent_signed(
        &mut self,
        message: String,
        nonce_b64: String,
        #[callback_result] signature: Result<Value, PromiseError>,
    ) -> SignedIntent {
        let signature = signature.unwrap_or_else(|_| env::panic_str("ERR_MPC_SIGNATURE_FAILED"));
        let parsed: Ed25519Response = serde_json::from_value(signature)
            .unwrap_or_else(|_| env::panic_str("ERR_MPC_SIGNATURE_FORMAT"));
        require!(parsed.signature.len() == 64, "ERR_MPC_SIGNATURE_FORMAT");
        let public_key = self
            .intents_key
            .clone()
            .unwrap_or_else(|| env::panic_str("ERR_INTENTS_KEY_NOT_SET"));
        SignedIntent {
            standard: "nep413".to_string(),
            payload: SignedIntentPayload {
                message,
                nonce: nonce_b64,
                recipient: self.intents_contract.to_string(),
            },
            public_key,
            signature: format!("ed25519:{}", base58_encode(&parsed.signature)),
        }
    }

    // ---------------------------------------------------------------- Views

    pub fn get_state(&self) -> VaultView {
        VaultView {
            token_id: self.token_id.clone(),
            registry: self.registry.clone(),
            shareholder: self.shareholder.clone(),
            founder: self.founder.clone(),
            founder_royalty_bps: self.founder_royalty_bps,
            compute_payee: self.compute_payee.clone(),
            mpc_contract: self.mpc_contract.clone(),
            intents_contract: self.intents_contract.clone(),
            usdc_token: self.usdc_token.clone(),
            btc_hrp: self.btc_hrp.clone(),
            price_micro_usdc: U128(self.price_micro_usdc),
            compute_reserve_bps: self.compute_reserve_bps,
            policy: self.policy.clone(),
            default_policy: self.default_policy.clone(),
            encumbrance: self.encumbrance.clone(),
            in_transit: self.in_transit,
            sync_nonce: self.sync_nonce,
            owner_generation: self.owner_generation,
            treasury_epoch: self.treasury_epoch,
            raw_sigs_this_epoch: self.raw_sigs_this_epoch,
            addresses: self.addresses.clone(),
            intents_key: self.intents_key.clone(),
            intents_key_registered: self.intents_key_registered,
            latest_intent_deadline_ms: self.latest_intent_deadline_ms,
            gross_revenue: U128(self.gross_revenue),
            related_party_revenue: U128(self.related_party_revenue),
            compute_reserve: U128(self.compute_reserve),
            retained_earnings: U128(self.retained_earnings),
            revenue_30d: self.revenue_30d(),
            api_calls_served: self.api_calls_served,
            dividends_paid: U128(self.dividends_paid),
            compute_paid: U128(self.compute_paid),
            deposited_to_intents: U128(self.deposited_to_intents),
            spend_window: self.spend_window,
            spent_this_window: self
                .spent_this_window
                .iter()
                .map(|(t, a)| (t.clone(), U128(*a)))
                .collect(),
            payment_records: self.payment_log_tail - self.payment_log_head,
            free_near_balance: U128(
                env::account_balance().as_yoctonear().saturating_sub(
                    env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128,
                ),
            ),
        }
    }

    /// The exact request body for an `agent_swap_intent` approval. Hash it as sent.
    pub fn swap_tee_request(&self, p: SwapProposal, model: String, system_prompt: String) -> TeeRequest {
        self.tee_request("swap", &swap_fields(&p), &p.nonce_b64, &model, &system_prompt)
    }

    /// The exact request body for an `agent_withdraw_intent` approval. Hash it as sent.
    pub fn withdraw_tee_request(
        &self,
        p: WithdrawProposal,
        model: String,
        system_prompt: String,
    ) -> TeeRequest {
        self.tee_request("withdraw", &withdraw_fields(&p), &p.nonce_b64, &model, &system_prompt)
    }

    pub fn payment_stats(&self) -> PaymentStats {
        let mut totals: std::collections::BTreeMap<&AccountId, u128> = Default::default();
        let (mut total, mut served) = (0u128, 0u128);
        for seq in self.payment_log_head..self.payment_log_tail {
            let payment = self.payment_log.get(&seq).and_then(|id| self.payments.get(id));
            if let Some(payment) = payment {
                total += payment.amount.0;
                if payment.served {
                    served += payment.amount.0;
                }
                *totals.entry(&payment.payer).or_default() += payment.amount.0;
            }
        }
        PaymentStats {
            records: self.payment_log_tail - self.payment_log_head,
            total_amount: U128(total),
            served_amount: U128(served),
            distinct_payers: totals.len() as u64,
            largest_payer_amount: U128(totals.values().copied().max().unwrap_or(0)),
        }
    }

    pub fn get_payment(&self, call_id: String) -> Option<Payment> {
        self.payments.get(&call_id).cloned()
    }

    pub fn treasury_addresses(&self) -> Option<TreasuryAddresses> {
        self.addresses.clone()
    }

    pub fn revenue_30d(&self) -> U128 {
        let today = now_ms() / DAY_MS;
        let mut total = 0u128;
        for (day, amount) in &self.daily_revenue {
            if *day + 30 > today {
                total += amount;
            }
        }
        U128(total)
    }
}

// Internal helpers.
impl CompanyVault {
    fn assert_registry_nonce(&mut self, sync_nonce: u64) {
        require!(env::predecessor_account_id() == self.registry, "ERR_ONLY_REGISTRY");
        require!(sync_nonce > self.sync_nonce, "ERR_STALE_SYNC");
        self.sync_nonce = sync_nonce;
    }

    fn set_shareholder(&mut self, new_shareholder: AccountId) {
        if new_shareholder != self.shareholder {
            self.shareholder = new_shareholder;
            self.policy = self.default_policy.clone();
            self.owner_generation += 1;
            // The old shareholder may hold a signature for these keys.
            if self.raw_sigs_this_epoch > 0 {
                self.treasury_epoch += 1;
                self.raw_sigs_this_epoch = 0;
                self.addresses = None;
                emit("treasury_epoch_rotated", json!({"epoch": self.treasury_epoch}));
            }
        }
    }

    fn assert_shareholder(&self) {
        require!(env::predecessor_account_id() == self.shareholder, "ERR_ONLY_CURRENT_SHAREHOLDER");
    }

    fn assert_operator(&self) {
        require!(env::predecessor_account_id() == self.policy.operator, "ERR_ONLY_TEE_TREASURY_AGENT");
    }

    /// While encumbered or in transit, only the operator fixed at incorporation serves calls, so a
    /// seller's own operator cannot spend the reserve or inflate `api_calls_served` during a sale.
    fn assert_service_operator(&self) {
        let operator = if self.encumbrance == EncumbranceState::Free && !self.in_transit {
            &self.policy.operator
        } else {
            &self.default_policy.operator
        };
        require!(env::predecessor_account_id() == *operator, "ERR_ONLY_TEE_TREASURY_AGENT");
    }

    fn assert_free(&self, err: &str) {
        if self.encumbrance != EncumbranceState::Free || self.in_transit {
            env::panic_str(err);
        }
    }

    fn assert_agent_not_frozen(&self) {
        self.assert_free("ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN");
    }

    fn assert_policy_change(&self) {
        assert_one_yocto();
        self.assert_shareholder();
        self.assert_free("ERR_ACCOUNT_ENCUMBERED_POLICY_FROZEN");
    }

    fn assert_token_allowed(&self, token: &str) {
        require!(
            self.policy.allowed_tokens.iter().any(|t| t == token),
            "ERR_FIREWALL_BLOCKED_TOKEN"
        );
    }

    fn assert_price_floor(&self, p: &SwapProposal) {
        let floor = self
            .policy
            .price_floors
            .iter()
            .find(|f| f.sell_token == p.sell_token && f.buy_token == p.buy_token)
            .unwrap_or_else(|| env::panic_str("ERR_FIREWALL_NO_PRICE_FLOOR"));
        require!(
            mul_wide(p.min_buy_amount.0, floor.per_sell.0) >= mul_wide(p.sell_amount.0, floor.min_buy.0),
            "ERR_FIREWALL_PRICE_BELOW_FLOOR"
        );
    }

    fn assert_own_address(&self, chain: &str, destination: &str) {
        let own = self.addresses.as_ref().and_then(|a| match chain {
            "btc" => Some(&a.btc),
            "evm" => Some(&a.evm),
            "sol" => Some(&a.sol),
            _ => None,
        });
        require!(
            own.is_some_and(|addr| addr == destination),
            "ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION"
        );
    }

    /// Tokens without a cap entry have a cap of zero. Not refunded on signing failure.
    fn charge_epoch_spend(&mut self, token: &str, amount: u128) {
        let window = now_ms() / EPOCH_MS;
        if window != self.spend_window {
            self.spend_window = window;
            self.spent_this_window.clear();
        }
        let cap = self
            .policy
            .epoch_caps
            .iter()
            .find(|(t, _)| t == token)
            .map_or(0, |(_, cap)| cap.0);
        let position = self.spent_this_window.iter().position(|(t, _)| t == token);
        let spent = position.map_or(0, |i| self.spent_this_window[i].1) + amount;
        require!(spent <= cap, "ERR_FIREWALL_EPOCH_CAP_EXCEEDED");
        match position {
            Some(i) => self.spent_this_window[i].1 = spent,
            None => self.spent_this_window.push((token.to_string(), spent)),
        }
    }

    /// `intents.near` also tracks consumed nonces and, since its salted-nonce upgrade, expects the
    /// off-chain builder to lay out `nonce_b64` for the verifier's `current_salt`. To the vault the
    /// nonce is opaque: 32 bytes, not reused while a proof carrying it could still be accepted.
    fn consume_nonce(&mut self, nonce_b64: &str) -> [u8; 32] {
        let nonce = decode_nonce(nonce_b64);
        for _ in 0..NONCE_PRUNE_STEPS {
            if self.nonce_log_head == self.nonce_log_tail {
                break;
            }
            let Some((keep_until, old)) = self.nonce_log.get(&self.nonce_log_head).copied() else {
                break;
            };
            if keep_until >= now_ms() {
                break;
            }
            self.used_nonces.remove(&old);
            self.nonce_log.remove(&self.nonce_log_head);
            self.nonce_log_head += 1;
        }
        require!(self.nonce_log_tail - self.nonce_log_head < MAX_LIVE_NONCES, "ERR_TOO_MANY_LIVE_NONCES");
        require!(self.used_nonces.insert(nonce), "ERR_NONCE_USED");
        let keep_until = now_ms() + (MAX_APPROVAL_AGE_S + MAX_APPROVAL_CLOCK_SKEW_S) * 1_000;
        self.nonce_log.insert(self.nonce_log_tail, (keep_until, nonce));
        self.nonce_log_tail += 1;
        nonce
    }

    fn store_payment(&mut self, call_id: String, payment: Payment) {
        if self.payment_log_tail - self.payment_log_head >= MAX_PAYMENT_RECORDS {
            if let Some(oldest) = self.payment_log.remove(&self.payment_log_head) {
                self.payments.remove(&oldest);
            }
            self.payment_log_head += 1;
        }
        self.payment_log.insert(self.payment_log_tail, call_id.clone());
        self.payment_log_tail += 1;
        self.payments.insert(call_id, payment);
    }

    /// The vault writes the whole request, so the operator has no free text in front of the model
    /// and no parameter such as `logit_bias` to steer it with. The vault account pins the network
    /// and deployment. The epoch and owner generation end an approval on rotation or sale.
    fn tee_request(
        &self,
        kind: &str,
        fields: &str,
        nonce_b64: &str,
        model: &str,
        system_prompt: &str,
    ) -> TeeRequest {
        let preimage = format!(
            "incorpr:v2:{}:{}:{}:{kind}:{fields}:{nonce_b64}",
            env::current_account_id(),
            self.treasury_epoch,
            self.owner_generation,
        );
        let proposal_hash = hex_encode(&env::sha256_array(preimage.as_bytes()));
        let user = format!("{preimage}\nproposal_hash={proposal_hash}");
        let body = serde_json::to_string(&ChatRequest {
            model,
            messages: [
                ChatMessage { role: "system", content: system_prompt },
                ChatMessage { role: "user", content: &user },
            ],
            stream: false,
        })
        .unwrap_or_else(|_| env::panic_str("ERR_TEE_REQUEST_ENCODING"));
        TeeRequest { body, proposal_hash }
    }

    fn verify_tee_approval(&self, kind: &str, fields: &str, nonce_b64: &str, tee: &TeeProof) {
        require!(
            !tee.text.is_empty()
                && !tee.signature_hex.is_empty()
                && !tee.response_body.is_empty()
                && !tee.system_prompt.is_empty(),
            "ERR_MISSING_TEE_ATTESTATION"
        );
        require!(
            tee.system_prompt.len() <= MAX_TEE_PROMPT_BYTES
                && tee.response_body.len() <= MAX_TEE_RESPONSE_BYTES,
            "ERR_TEE_PROOF_TOO_LARGE"
        );
        // `{model_id}:{request_hash}:{response_hash}`, the form a model TEE signs.
        let signed: Vec<&str> = tee.text.split(':').collect();
        let [model, request_hash, response_hash] = signed[..] else {
            env::panic_str("ERR_TEE_TEXT_FORMAT")
        };
        require!(
            self.policy.tee_models.iter().any(|m| m == model),
            "ERR_TEE_MODEL_NOT_ALLOWED"
        );
        require!(
            !self.policy.tee_prompt_hash.is_empty()
                && hex_encode(&env::sha256_array(tee.system_prompt.as_bytes())) == self.policy.tee_prompt_hash,
            "ERR_TEE_PROMPT_NOT_PINNED"
        );
        let request = self.tee_request(kind, fields, nonce_b64, model, &tee.system_prompt);

        let response: Option<ChatResponse> = serde_json::from_str(&tee.response_body).ok();
        let approved = response.as_ref().is_some_and(|r| match &r.choices[..] {
            [only] => {
                only.message.content.as_deref().map(str::trim)
                    == Some(format!("APPROVE {}", request.proposal_hash).as_str())
            }
            _ => false,
        });
        require!(approved, "ERR_TEE_NOT_APPROVED");
        let created = response.map_or(0, |r| r.created);
        let now_s = now_ms() / 1_000;
        require!(
            created <= now_s + MAX_APPROVAL_CLOCK_SKEW_S && now_s <= created.saturating_add(MAX_APPROVAL_AGE_S),
            "ERR_TEE_APPROVAL_EXPIRED"
        );
        require!(
            response_hash == hex_encode(&env::sha256_array(tee.response_body.as_bytes())),
            "ERR_TEE_RESPONSE_MISMATCH"
        );
        require!(
            request_hash == hex_encode(&env::sha256_array(request.body.as_bytes())),
            "ERR_TEE_REQUEST_MISMATCH"
        );

        let signature: [u8; 65] = hex_decode(&tee.signature_hex)
            .and_then(|bytes| bytes.try_into().ok())
            .unwrap_or_else(|| env::panic_str("ERR_TEE_SIGNATURE_UNTRUSTED"));
        // Out-of-range values would abort the receipt in the host instead of reporting this error.
        let v = match signature[64] {
            0 | 27 => 0,
            1 | 28 => 1,
            _ => env::panic_str("ERR_TEE_SIGNATURE_UNTRUSTED"),
        };
        let sig_rs: [u8; 64] = signature[..64].try_into().unwrap_or_else(|_| env::abort());
        let recovered = env::ecrecover(&eip191_hash(&tee.text), &sig_rs, v, true)
            .unwrap_or_else(|| env::panic_str("ERR_TEE_SIGNATURE_UNTRUSTED"));
        let signer = evm_address(&recovered);
        require!(self.policy.tee_signers.contains(&signer), "ERR_TEE_SIGNATURE_UNTRUSTED");
    }

    fn next_intent_deadline(&mut self) -> u64 {
        let deadline_ms = now_ms() + MAX_INTENT_TTL_MS;
        self.latest_intent_deadline_ms = self.latest_intent_deadline_ms.max(deadline_ms);
        deadline_ms
    }

    fn sign_intent(&mut self, message: String, nonce: [u8; 32], nonce_b64: String) -> Promise {
        require!(self.intents_key_registered, "ERR_INTENTS_KEY_NOT_SET");
        let hash = nep413_hash(&message, &nonce, self.intents_contract.as_str());
        emit("intent_requested", json!({"message": message, "nonce": nonce_b64}));
        let reserve = GAS_SIGN_CALLBACK.saturating_add(GAS_SIGN_OVERHEAD);
        self.mpc_sign(self.intents_path(), DOMAIN_ED25519, hex_encode(&hash), ONE_YOCTO, reserve)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_SIGN_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_intent_signed(message, nonce_b64),
            )
    }

    fn raw_sign(&self, path: String, domain_id: u64, payload_hex: String) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit >= ONE_YOCTO, "ERR_SIGNATURE_REQUIRES_DEPOSIT");
        let bytes = hex_decode(&payload_hex).unwrap_or_else(|| env::panic_str("ERR_INVALID_PAYLOAD"));
        match domain_id {
            DOMAIN_SECP256K1 => require!(bytes.len() == 32, "ERR_INVALID_PAYLOAD"),
            DOMAIN_ED25519 => require!(
                bytes.len() >= 32 && bytes.len() <= EDDSA_MAX_PAYLOAD_BYTES,
                "ERR_INVALID_PAYLOAD"
            ),
            _ => env::panic_str("ERR_INVALID_DOMAIN"),
        }
        self.mpc_sign(path, domain_id, hex_encode(&bytes), deposit, GAS_SIGN_OVERHEAD)
    }

    /// Forwards everything left in the transaction except `reserve`, so the signer gets as much
    /// gas as a 300 TGas transaction allows while the callback keeps its share.
    fn mpc_sign(
        &self,
        path: String,
        domain_id: u64,
        payload_hex: String,
        deposit: NearToken,
        reserve: Gas,
    ) -> Promise {
        let payload = if domain_id == DOMAIN_SECP256K1 {
            json!({"Ecdsa": payload_hex})
        } else {
            json!({"Eddsa": payload_hex})
        };
        let args = json!({"request": {"path": path, "payload_v2": payload, "domain_id": domain_id}});
        let remaining = env::prepaid_gas().saturating_sub(env::used_gas());
        let forwarded = remaining.saturating_sub(reserve);
        require!(forwarded >= GAS_MPC_SIGN_MIN, "ERR_INSUFFICIENT_GAS_FOR_SIGNATURE");
        Promise::new(self.mpc_contract.clone()).function_call_weight(
            "sign",
            args.to_string().into_bytes(),
            deposit,
            forwarded,
            GasWeight(0),
        )
    }

    fn derive_key(&self, path: &str, domain_id: u64) -> Promise {
        let args = json!({
            "path": path,
            "predecessor": env::current_account_id(),
            "domain_id": domain_id,
        });
        Promise::new(self.mpc_contract.clone()).function_call_weight(
            "derived_public_key",
            args.to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_DERIVE_MIN,
            GasWeight(1),
        )
    }

    fn intents_path(&self) -> String {
        format!("incorpr-{}-intents", self.token_id)
    }

    fn epoch_path(&self, epoch: u32, subpath: &str) -> String {
        format!("incorpr-{}-e{}-{}", self.token_id, epoch, subpath)
    }

    fn ft_transfer(&self, receiver: &AccountId, amount: U128) -> Promise {
        Promise::new(self.usdc_token.clone()).function_call_weight(
            "ft_transfer",
            json!({"receiver_id": receiver, "amount": amount}).to_string().into_bytes(),
            ONE_YOCTO,
            GAS_FT_TRANSFER,
            GasWeight(0),
        )
    }

    fn ft_callback(&self) -> CompanyVaultExt {
        Self::ext(env::current_account_id()).with_static_gas(GAS_FT_CALLBACK).with_unused_gas_weight(0)
    }

    fn add_daily_revenue(&mut self, amount: u128) {
        let today = now_ms() / DAY_MS;
        self.daily_revenue.retain(|(day, _)| *day + 30 > today);
        match self.daily_revenue.iter_mut().find(|(day, _)| *day == today) {
            Some((_, total)) => *total += amount,
            None => self.daily_revenue.push((today, amount)),
        }
    }

    /// Detached: a failed report leaves the charter stale but must not undo a payment.
    fn notify_registry(&self) {
        let args = json!({
            "token_id": self.token_id,
            "gross": U128(self.gross_revenue),
            "retained": U128(self.retained_earnings),
            "revenue_30d": self.revenue_30d(),
            "calls": self.api_calls_served,
        });
        Promise::new(self.registry.clone())
            .function_call_weight(
                "report_metrics",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_REPORT_METRICS,
                GasWeight(0),
            )
            .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
    use near_sdk::test_vm_config;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn at(ms: u64, predecessor: &str) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("c-1.registry.near"))
            .predecessor_account_id(account(predecessor))
            .block_timestamp(ms * 1_000_000)
            .build());
    }

    fn vault() -> CompanyVault {
        at(1_000, "registry.near");
        CompanyVault::new(VaultInit {
            token_id: "1".to_string(),
            registry: account("registry.near"),
            shareholder: account("founder.near"),
            founder: account("founder.near"),
            founder_royalty_bps: 0,
            operator: account("operator.near"),
            compute_payee: account("payee.near"),
            mpc_contract: account("mpc.near"),
            intents_contract: account("intents.near"),
            usdc_token: account("usdc.near"),
            btc_hrp: "tb".to_string(),
            price_micro_usdc: U128(1),
            compute_reserve_bps: 1_000,
            allowed_tokens: vec!["t".to_string()],
            epoch_caps: vec![("t".to_string(), U128(100))],
            tee_signers: vec![],
            tee_models: vec![],
            tee_prompt_hash: String::new(),
            price_floors: vec![],
        })
    }

    #[test]
    fn revenue_30d_drops_a_day_once_it_is_30_days_old() {
        let mut v = vault();
        at(DAY_MS * 100, "usdc.near");
        v.ft_on_transfer(account("c.near"), U128(5), r#"{"call_id":"a"}"#.to_string());
        at(DAY_MS * 129 + 1, "x.near");
        assert_eq!(v.revenue_30d().0, 5);
        at(DAY_MS * 130, "x.near");
        assert_eq!(v.revenue_30d().0, 0);
    }

    #[test]
    fn spend_window_resets_after_epoch_ms() {
        let mut v = vault();
        at(EPOCH_MS * 3, "x.near");
        v.charge_epoch_spend("t", 100);
        at(EPOCH_MS * 4 - 1, "x.near");
        assert_eq!(v.spent_this_window[0].1, 100);
        at(EPOCH_MS * 4, "x.near");
        v.charge_epoch_spend("t", 100);
        assert_eq!(v.spent_this_window[0].1, 100);
    }

    #[test]
    #[should_panic(expected = "ERR_FIREWALL_EPOCH_CAP_EXCEEDED")]
    fn spend_window_does_not_reset_early() {
        let mut v = vault();
        at(EPOCH_MS * 3, "x.near");
        v.charge_epoch_spend("t", 100);
        at(EPOCH_MS * 4 - 1, "x.near");
        v.charge_epoch_spend("t", 1);
    }

    #[test]
    fn stale_key_derivation_after_rotation_is_ignored() {
        let mut v = vault();
        v.treasury_epoch = 1;
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(account("c-1.registry.near"))
                .predecessor_account_id(account("c-1.registry.near"))
                .build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed, PromiseResult::Failed],
        );
        // Epoch 0 keys land after the move to epoch 1. Failed results would panic if they were read.
        assert!(v.on_treasury_keys(0, Err(PromiseError::Failed), Err(PromiseError::Failed)).is_none());
        assert!(v.addresses.is_none());
    }

    #[test]
    fn mul_wide_matches_known_products() {
        assert_eq!(mul_wide(0, u128::MAX), (0, 0));
        assert_eq!(mul_wide(u128::MAX, 1), (0, u128::MAX));
        assert_eq!(mul_wide(u128::MAX, u128::MAX), (u128::MAX - 1, 1));
        assert_eq!(mul_wide(1 << 64, 1 << 64), (1, 0));
        assert_eq!(mul_wide((1 << 64) + 3, (1 << 64) + 5), (1, (8 << 64) + 15));
    }
}
