//! NEP-171/177/178/181/199 registry of company charters, with an M&A market and a credit desk.
//! Cross-contract steps are separate receipts, so every market path follows one order: set the
//! token lock, call the vault, act in the callback only on success, clear the lock on failure.
//! Each callback is followed by a watcher receipt. If the callback itself failed after the vault
//! accepted, the watcher marks the token for `resync_vault_owner`.
//! See docs/ARCHITECTURE.md section 5.

mod charter;

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::{NftMint, NftTransfer};
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

use charter::{charter_data_uri, charter_svg, current_revenue_30d};

const VAULT_WASM: &[u8] = include_bytes!("../../res/company_vault.wasm");

/// State stored on the vault account, beyond its code, that incorporation pays for up front. With
/// the operating balance this covers the largest policy and full payment and nonce logs.
const VAULT_STATE_BYTES: u128 = 64_000;
/// Free balance left on the vault for payment records, nonces and 1 yocto fees.
const VAULT_OPERATING_BALANCE: NearToken = NearToken::from_millinear(500);
/// Upper bound on the registry storage one company uses. The measured amount is what is kept.
const TOKEN_STORAGE_ESTIMATE: NearToken = NearToken::from_millinear(50);
/// Kept on top of the measured amount: one owner-index entry for a later owner and a margin for
/// settlement records.
const TOKEN_SETTLEMENT_RESERVE_BYTES: u128 = 1_024;
/// Free balance below which new listings, sales and pledges are refused, so settlements already
/// running can still record failed payouts. Repayments, bids and claims are not refused: they free
/// more storage than they use, and refusing them could force a default.
const REGISTRY_RESERVE: NearToken = NearToken::from_millinear(500);
/// NEP-145 minimum. Covers the lender's own balance entry.
const STORAGE_ACCOUNT_MIN: NearToken = NearToken::from_millinear(2);
/// Locked per live offer. Covers the offer, its index entry, the loan it can become and one
/// pending-withdrawal entry. Unlocked when the offer is cancelled or evicted or the loan closes.
const OFFER_STORAGE: NearToken = NearToken::from_micronear(10_240);
/// `storage_balance_bounds.min` of the NEAR USDC contract.
const FT_REGISTRATION: NearToken = NearToken::from_micronear(1_250);

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

const BPS_DENOMINATOR: u128 = 10_000;
const MAX_ROYALTY_BPS: u16 = 1_000;
const MAX_TEXT_LEN: usize = 64;
const MAX_OFFERS_PER_TOKEN: usize = 32;
const MIN_OFFER_PRINCIPAL: u128 = 1_000_000;
/// Bounds the NEP-178 map that settlement callbacks read.
const MAX_APPROVALS_PER_TOKEN: usize = 16;
/// A memo is logged in the callback, after the vault call. Over the log limit it would abort it.
const MAX_MEMO_LEN: usize = 256;
const MAX_TRANSFER_MSG_LEN: usize = 4_096;
const MIN_COMPUTE_RESERVE_BPS: u16 = 100;
/// Largest callback result the watcher passes on: a `Payout` with two entries.
const MAX_SETTLEMENT_RESULT_BYTES: usize = 512;

const GAS_VAULT_NEW: Gas = Gas::from_tgas(30);
const GAS_ON_CREATED: Gas = Gas::from_tgas(40);
const GAS_REFUND_HOP: Gas = Gas::from_tgas(5);
const GAS_FT_REGISTER: Gas = Gas::from_tgas(10);
const GAS_VAULT_SYNC: Gas = Gas::from_tgas(15);
const GAS_VAULT_FINISHED: Gas = Gas::from_tgas(10);
const GAS_CB_SIMPLE: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_ON_PAYOUT: Gas = Gas::from_tgas(8);
const GAS_FAIL: Gas = Gas::from_tgas(2);
const GAS_WATCH: Gas = Gas::from_tgas(8);
const GAS_NFT_ON_TRANSFER: Gas = Gas::from_tgas(35);
const GAS_NFT_RESOLVE: Gas = Gas::from_tgas(40);
const GAS_CB_TRANSFER_CALL: Gas = Gas::from_tgas(100);
// Static gas a callback schedules (finish: 15 + 10, payout: 20 + 8) plus 10 for its own work with
// a full approvals map.
const GAS_CB_FINISH: Gas = Gas::from_tgas(35);
const GAS_CB_ONE_PAYOUT: Gas = Gas::from_tgas(40);
const GAS_CB_FINISH_ONE_PAYOUT: Gas = Gas::from_tgas(65);
const GAS_CB_FINISH_TWO_PAYOUTS: Gas = Gas::from_tgas(95);
const GAS_CB_FINISH_THREE_PAYOUTS: Gas = Gas::from_tgas(125);

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    NftOwners,
    NftMetadata,
    NftEnumeration,
    NftApprovals,
    Companies,
    Offers,
    OffersByToken,
    Loans,
    PendingWithdrawals,
    StorageAccounts,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Encumbrance {
    Free,
    Listed { ask: U128 },
    Pledged { lender: AccountId, debt: U128, due_ms: u64 },
}

#[near(serializers = [json])]
pub struct RegistryInit {
    pub owner: AccountId,
    pub usdc_token: AccountId,
    pub mpc_contract: AccountId,
    pub intents_contract: AccountId,
    pub btc_hrp: String,
    pub default_operator: AccountId,
    pub compute_payee: AccountId,
    pub allowed_tokens: Vec<String>,
    pub epoch_caps: Vec<(String, U128)>,
    pub tee_signers: Vec<String>,
    pub tee_models: Vec<String>,
    pub tee_prompt_hash: String,
    pub price_floors: Vec<PriceFloor>,
    pub auction_duration_ms: u64,
}

/// Same fields as the vault's `PriceFloor`, which validates them.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceFloor {
    pub sell_token: String,
    pub buy_token: String,
    pub min_buy: U128,
    pub per_sell: U128,
}

/// Same fields as the vault's `PledgeTerms`, which enforces them when the pledge lands.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PledgeTerms {
    pub min_retained: Option<U128>,
    pub required_epoch: Option<u32>,
}

/// NEP-145.
#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

/// NEP-145.
#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct StorageAccount {
    total: u128,
    locked_offers: u32,
}

impl StorageAccount {
    fn available(&self) -> u128 {
        let locked = STORAGE_ACCOUNT_MIN.as_yoctonear()
            + self.locked_offers as u128 * OFFER_STORAGE.as_yoctonear();
        self.total.saturating_sub(locked)
    }
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Incorporate {
    pub name: String,
    pub service_template: String,
    pub price_micro_usdc: U128,
    pub target_bps: [u16; 3],
    pub founder_royalty_bps: u16,
    pub compute_reserve_bps: u16,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Company {
    pub name: String,
    pub service_template: String,
    pub price_micro_usdc: U128,
    pub target_bps: [u16; 3],
    pub founder: AccountId,
    pub founder_royalty_bps: u16,
    pub compute_reserve_bps: u16,
    pub vault: AccountId,
    pub created_ms: u64,
    pub gross: U128,
    pub retained: U128,
    /// Snapshot from the last report, as of `metrics_ms`. The vault's `revenue_30d` is exact.
    pub revenue_30d: U128,
    pub calls: u64,
    /// 0 until the first report.
    pub metrics_ms: u64,
    pub encumbrance: Encumbrance,
    pub settling: bool,
    /// Set when a settlement could not finish on the vault or its callback failed. The lock stays
    /// on until `resync_vault_owner` succeeds, so owner and shareholder are never used while they
    /// differ.
    pub needs_resync: bool,
    /// A buyer names this in its `acquire` message. Unlisting and relisting both change it.
    pub sync_nonce: u64,
}

#[near(serializers = [json])]
pub struct CompanyView {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    #[serde(flatten)]
    pub company: Company,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Offer {
    pub id: u64,
    pub token_id: TokenId,
    pub lender: AccountId,
    pub principal: U128,
    pub repay_amount: U128,
    pub term_ms: u64,
    pub settling: bool,
    pub terms: Option<PledgeTerms>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Loan {
    pub token_id: TokenId,
    pub lender: AccountId,
    pub borrower: AccountId,
    pub principal: U128,
    pub debt: U128,
    pub due_ms: u64,
    pub auction_start_ms: Option<u64>,
}

#[near(serializers = [json])]
pub struct ListingView {
    pub token_id: TokenId,
    pub seller: AccountId,
    pub ask: U128,
    pub sync_nonce: u64,
}

/// NEP-199.
#[near(serializers = [json])]
pub struct Payout {
    pub payout: HashMap<AccountId, U128>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", tag = "action", rename_all = "snake_case")]
enum FtAction {
    Acquire { token_id: TokenId, expected_sync_nonce: u64 },
    FundOffer {
        token_id: TokenId,
        repay_amount: U128,
        term_ms: u64,
        #[serde(default)]
        terms: Option<PledgeTerms>,
    },
    Repay { token_id: TokenId },
    Bid { token_id: TokenId },
}

#[ext_contract(ext_vault)]
#[allow(dead_code)]
trait Vault {
    fn sync_owner(&mut self, new_shareholder: AccountId, sync_nonce: u64, require_clean: Option<bool>);
    fn begin_transit(&mut self, sync_nonce: u64);
    fn apply_encumbrance(
        &mut self,
        new_shareholder: AccountId,
        state: Encumbrance,
        sync_nonce: u64,
        terms: Option<PledgeTerms>,
    );
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_nft_receiver)]
#[allow(dead_code)]
trait NftReceiver {
    fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: TokenId,
        msg: String,
    ) -> PromiseOrValue<bool>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    usdc_token: AccountId,
    mpc_contract: AccountId,
    intents_contract: AccountId,
    btc_hrp: String,
    default_operator: AccountId,
    compute_payee: AccountId,
    allowed_tokens: Vec<String>,
    epoch_caps: Vec<(String, U128)>,
    tee_signers: Vec<String>,
    tee_models: Vec<String>,
    tee_prompt_hash: String,
    price_floors: Vec<PriceFloor>,
    auction_duration_ms: u64,

    tokens: NonFungibleToken,
    next_token_id: u64,
    companies: LookupMap<TokenId, Company>,
    next_offer_id: u64,
    offers: LookupMap<u64, Offer>,
    offers_by_token: LookupMap<TokenId, Vec<u64>>,
    loans: LookupMap<TokenId, Loan>,
    pending_withdrawals: LookupMap<AccountId, u128>,
    storage_accounts: LookupMap<AccountId, StorageAccount>,
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "incorpr", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

/// `TooLong` means a success with a non-empty body: the value itself is not read here.
fn last_promise_succeeded() -> bool {
    matches!(env::promise_result_checked(0, 0), Ok(_) | Err(PromiseError::TooLong(_)))
}

fn vault_funding() -> u128 {
    env::storage_byte_cost().as_yoctonear() * (VAULT_WASM.len() as u128 + VAULT_STATE_BYTES)
        + VAULT_OPERATING_BALANCE.as_yoctonear()
}

fn required_deposit() -> u128 {
    vault_funding() + TOKEN_STORAGE_ESTIMATE.as_yoctonear() + FT_REGISTRATION.as_yoctonear()
}

fn free_balance() -> u128 {
    env::account_balance()
        .as_yoctonear()
        .saturating_sub(env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128)
}

fn valid_text(text: &str) -> bool {
    !text.is_empty() && text.len() <= MAX_TEXT_LEN && !text.chars().any(char::is_control)
}

fn ft_register_args(account: &AccountId) -> Vec<u8> {
    json!({"account_id": account, "registration_only": true}).to_string().into_bytes()
}

#[near]
impl Registry {
    #[init]
    pub fn new(args: RegistryInit) -> Self {
        require!(args.btc_hrp == "bc" || args.btc_hrp == "tb", "ERR_INVALID_BTC_HRP");
        require!(args.auction_duration_ms > 0, "ERR_INVALID_AUCTION_DURATION");
        // The registry must hold a USDC account to receive `ft_transfer_call`.
        Promise::new(args.usdc_token.clone())
            .function_call(
                "storage_deposit",
                ft_register_args(&env::current_account_id()),
                FT_REGISTRATION,
                GAS_FT_REGISTER,
            )
            .detach();
        Self {
            owner: args.owner.clone(),
            usdc_token: args.usdc_token,
            mpc_contract: args.mpc_contract,
            intents_contract: args.intents_contract,
            btc_hrp: args.btc_hrp,
            default_operator: args.default_operator,
            compute_payee: args.compute_payee,
            allowed_tokens: args.allowed_tokens,
            epoch_caps: args.epoch_caps,
            tee_signers: args.tee_signers,
            tee_models: args.tee_models,
            tee_prompt_hash: args.tee_prompt_hash,
            price_floors: args.price_floors,
            auction_duration_ms: args.auction_duration_ms,
            tokens: NonFungibleToken::new(
                StorageKey::NftOwners,
                args.owner,
                Some(StorageKey::NftMetadata),
                Some(StorageKey::NftEnumeration),
                Some(StorageKey::NftApprovals),
            ),
            next_token_id: 1,
            companies: LookupMap::new(StorageKey::Companies),
            next_offer_id: 1,
            offers: LookupMap::new(StorageKey::Offers),
            offers_by_token: LookupMap::new(StorageKey::OffersByToken),
            loans: LookupMap::new(StorageKey::Loans),
            pending_withdrawals: LookupMap::new(StorageKey::PendingWithdrawals),
            storage_accounts: LookupMap::new(StorageKey::StorageAccounts),
        }
    }

    // ---------------------------------------------------------------- Incorporation

    /// Batch: create the sub-account, fund it, deploy the vault, call `new`. No access key is
    /// added. The NFT is minted in the callback only after the batch succeeds.
    #[payable]
    pub fn incorporate_company(&mut self, args: Incorporate) -> Promise {
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= required_deposit(), "ERR_INSUFFICIENT_DEPOSIT");
        require!(valid_text(&args.name), "ERR_INVALID_NAME");
        require!(valid_text(&args.service_template), "ERR_INVALID_SERVICE");
        require!(args.price_micro_usdc.0 > 0, "ERR_INVALID_PRICE");
        require!(args.founder_royalty_bps <= MAX_ROYALTY_BPS, "ERR_INVALID_ROYALTY");
        require!(
            (MIN_COMPUTE_RESERVE_BPS..=10_000).contains(&args.compute_reserve_bps),
            "ERR_INVALID_RESERVE"
        );
        require!(
            args.target_bps.iter().map(|b| *b as u32).sum::<u32>() == 10_000,
            "ERR_INVALID_TARGET_ALLOCATION"
        );

        let founder = env::predecessor_account_id();
        let token_id = self.next_token_id.to_string();
        self.next_token_id += 1;
        let vault = self.vault_account(&token_id);
        let funding = vault_funding();
        let init = json!({"args": {
            "token_id": token_id,
            "registry": env::current_account_id(),
            "shareholder": founder,
            "founder": founder,
            "founder_royalty_bps": args.founder_royalty_bps,
            "operator": self.default_operator,
            "compute_payee": self.compute_payee,
            "mpc_contract": self.mpc_contract,
            "intents_contract": self.intents_contract,
            "usdc_token": self.usdc_token,
            "btc_hrp": self.btc_hrp,
            "price_micro_usdc": args.price_micro_usdc,
            "compute_reserve_bps": args.compute_reserve_bps,
            "allowed_tokens": self.allowed_tokens,
            "epoch_caps": self.epoch_caps,
            "tee_signers": self.tee_signers,
            "tee_models": self.tee_models,
            "tee_prompt_hash": self.tee_prompt_hash,
            "price_floors": self.price_floors,
        }});
        Promise::new(vault)
            .create_account()
            .transfer(NearToken::from_yoctonear(funding))
            .deploy_contract(VAULT_WASM.to_vec())
            .function_call("new", init.to_string().into_bytes(), NO_DEPOSIT, GAS_VAULT_NEW)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_CREATED)
                    .with_unused_gas_weight(0)
                    .on_company_created(
                        token_id,
                        founder,
                        args,
                        U128(attached),
                        U128(funding),
                    ),
            )
    }

    #[private]
    pub fn on_company_created(
        &mut self,
        token_id: TokenId,
        founder: AccountId,
        args: Incorporate,
        attached: U128,
        funding: U128,
    ) -> PromiseOrValue<Option<TokenId>> {
        if !last_promise_succeeded() {
            // The funding transfer returns to this account as a system refund in a sibling
            // receipt. Pay the founder one hop later, once it has landed.
            emit("incorporation_failed", json!({"token_id": token_id, "founder": founder}));
            return Self::ext(env::current_account_id())
                .with_static_gas(GAS_REFUND_HOP)
                .with_unused_gas_weight(0)
                .refund_failed_incorporation(founder, attached)
                .into();
        }

        let storage_before = env::storage_usage();
        let vault = self.vault_account(&token_id);
        let metadata = TokenMetadata {
            title: Some(args.name.clone()),
            description: Some(args.service_template.clone()),
            media: None,
            media_hash: None,
            copies: Some(1),
            issued_at: Some(env::block_timestamp_ms().to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: None,
            reference: None,
            reference_hash: None,
        };
        self.tokens.internal_mint_with_refund(token_id.clone(), founder.clone(), Some(metadata), None);
        self.companies.insert(
            token_id.clone(),
            Company {
                name: args.name,
                service_template: args.service_template,
                price_micro_usdc: args.price_micro_usdc,
                target_bps: args.target_bps,
                founder: founder.clone(),
                founder_royalty_bps: args.founder_royalty_bps,
                compute_reserve_bps: args.compute_reserve_bps,
                vault: vault.clone(),
                created_ms: env::block_timestamp_ms(),
                gross: U128(0),
                retained: U128(0),
                revenue_30d: U128(0),
                calls: 0,
                metrics_ms: 0,
                encumbrance: Encumbrance::Free,
                settling: false,
                needs_resync: false,
                sync_nonce: 0,
            },
        );
        self.companies.flush();
        let storage_used = env::storage_usage() - storage_before;

        NftMint { owner_id: &founder, token_ids: &[&token_id], memo: None }.emit();
        emit("company_incorporated", json!({"token_id": token_id, "vault": vault, "founder": founder}));

        // The vault needs a USDC account before any customer can pay it.
        Promise::new(self.usdc_token.clone())
            .function_call(
                "storage_deposit",
                ft_register_args(&vault),
                FT_REGISTRATION,
                GAS_FT_REGISTER,
            )
            .detach();

        let kept = funding.0
            + env::storage_byte_cost().as_yoctonear()
                * (storage_used as u128 + TOKEN_SETTLEMENT_RESERVE_BYTES)
            + FT_REGISTRATION.as_yoctonear();
        if let Some(excess) = attached.0.checked_sub(kept).filter(|e| *e > 0) {
            Promise::new(founder).transfer(NearToken::from_yoctonear(excess)).detach();
        }
        PromiseOrValue::Value(Some(token_id))
    }

    #[private]
    pub fn refund_failed_incorporation(&mut self, founder: AccountId, amount: U128) -> Option<TokenId> {
        Promise::new(founder).transfer(NearToken::from_yoctonear(amount.0)).detach();
        None
    }

    /// Only the company's own vault can report. Revenue never comes from an operator or owner.
    pub fn report_metrics(
        &mut self,
        token_id: TokenId,
        gross: U128,
        retained: U128,
        revenue_30d: U128,
        calls: u64,
    ) {
        let company = self
            .companies
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("ERR_TOKEN_NOT_FOUND"));
        require!(env::predecessor_account_id() == company.vault, "ERR_ONLY_COMPANY_VAULT");
        company.gross = gross;
        company.retained = retained;
        company.revenue_30d = revenue_30d;
        company.calls = calls;
        company.metrics_ms = env::block_timestamp_ms();
        emit(
            "metrics_reported",
            json!({"token_id": token_id, "gross": gross, "retained": retained, "revenue_30d": revenue_30d, "calls": calls}),
        );
    }

    /// Applies to companies incorporated after this call. Existing vaults keep their values.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn set_default_policy(
        &mut self,
        default_operator: AccountId,
        compute_payee: AccountId,
        allowed_tokens: Vec<String>,
        epoch_caps: Vec<(String, U128)>,
        tee_signers: Vec<String>,
        tee_models: Vec<String>,
        tee_prompt_hash: String,
        price_floors: Vec<PriceFloor>,
    ) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "ERR_ONLY_REGISTRY_OWNER");
        self.default_operator = default_operator;
        self.compute_payee = compute_payee;
        self.allowed_tokens = allowed_tokens;
        self.epoch_caps = epoch_caps;
        self.tee_signers = tee_signers;
        self.tee_models = tee_models;
        self.tee_prompt_hash = tee_prompt_hash;
        self.price_floors = price_floors;
        emit("default_policy_set", json!({"operator": self.default_operator}));
    }

    // ---------------------------------------------------------------- NEP-171 core

    /// The receiver holds the vault as soon as the sync lands, so an approved account moving the
    /// token needs clean keys. An owner's direct transfer rotates dirty keys instead; see the vault.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) -> Promise {
        assert_one_yocto();
        let sender_id = env::predecessor_account_id();
        let owner = self.authorize_transfer(&sender_id, &receiver_id, &token_id, approval_id, memo.as_deref());
        let (vault, nonce) = self.next_sync(&token_id);
        ext_vault::ext(vault)
            .with_static_gas(GAS_VAULT_SYNC)
            .with_unused_gas_weight(0)
            .sync_owner(receiver_id.clone(), nonce, Some(sender_id != owner))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_SIMPLE)
                    .with_unused_gas_weight(0)
                    .on_transfer_synced(sender_id, receiver_id, token_id.clone(), memo),
            )
            .then(Self::watch(token_id, None))
    }

    /// The vault stays in transit through the receiver call. The receiver gets shareholder rights
    /// only if it keeps the token, and the sender cannot use them meanwhile.
    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        assert_one_yocto();
        require!(msg.len() <= MAX_TRANSFER_MSG_LEN, "ERR_MSG_TOO_LONG");
        let sender_id = env::predecessor_account_id();
        self.authorize_transfer(&sender_id, &receiver_id, &token_id, approval_id, memo.as_deref());
        self.begin_transit_call(&token_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_TRANSFER_CALL)
                    .with_unused_gas_weight(1)
                    .on_transfer_call_synced(sender_id, receiver_id, token_id.clone(), memo, msg),
            )
            .then(Self::watch(token_id, None))
    }

    pub fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        let metadata = self.tokens.token_metadata_by_id.as_ref().and_then(|m| m.get(&token_id));
        let approved_account_ids =
            self.tokens.approvals_by_id.as_ref().map(|a| a.get(&token_id).unwrap_or_default());
        Some(self.with_charter(Token { token_id, owner_id, metadata, approved_account_ids }))
    }

    #[private]
    pub fn on_transfer_synced(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        memo: Option<String>,
    ) -> PromiseOrValue<bool> {
        if !last_promise_succeeded() {
            self.clear_lock(&token_id);
            return Self::fail_visibly("ERR_VAULT_SYNC_FAILED");
        }
        self.finish_transfer(&token_id, &receiver_id, Some(&sender_id), memo.as_deref());
        self.clear_lock(&token_id);
        PromiseOrValue::Value(true)
    }

    #[private]
    pub fn on_transfer_call_synced(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        if !last_promise_succeeded() {
            self.clear_lock(&token_id);
            return Self::fail_visibly("ERR_VAULT_SYNC_FAILED");
        }
        // The lock and the vault's transit stay on through the receiver call and the resolve step.
        let (previous_owner, approvals) =
            self.finish_transfer(&token_id, &receiver_id, Some(&sender_id), memo.as_deref());
        ext_nft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_NFT_ON_TRANSFER)
            .with_unused_gas_weight(1)
            .nft_on_transfer(sender_id, previous_owner.clone(), token_id.clone(), msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_NFT_RESOLVE)
                    .with_unused_gas_weight(0)
                    .nft_resolve_transfer(previous_owner, receiver_id, token_id, approvals),
            )
            .into()
    }

    /// NEP-171 resolver. A revert moves the token back. Either way the vault leaves transit with
    /// the final owner, and a shareholder who got the token back keeps its policy.
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> Promise {
        let must_revert = match env::promise_result_checked(0, 16) {
            Ok(value) => serde_json::from_slice::<bool>(&value).unwrap_or(true),
            Err(_) => true,
        };
        let final_owner = if must_revert {
            self.tokens.internal_transfer_unguarded(&token_id, &receiver_id, &previous_owner_id);
            if let (Some(by_id), Some(approvals)) =
                (self.tokens.approvals_by_id.as_mut(), approved_account_ids)
            {
                by_id.insert(&token_id, &approvals);
            }
            NftTransfer {
                old_owner_id: &receiver_id,
                new_owner_id: &previous_owner_id,
                token_ids: &[&token_id],
                authorized_id: None,
                memo: None,
            }
            .emit();
            previous_owner_id
        } else {
            receiver_id
        };
        self.apply_encumbrance_call(&token_id, &final_owner, Encumbrance::Free, None).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_VAULT_FINISHED)
                .with_unused_gas_weight(0)
                .on_transfer_call_finished(token_id, !must_revert),
        )
    }

    #[private]
    pub fn on_transfer_call_finished(&mut self, token_id: TokenId, kept: bool) -> bool {
        self.on_vault_finished(token_id);
        kept
    }

    /// Last step of a settlement whose token and funds have already moved.
    #[private]
    pub fn on_vault_finished(&mut self, token_id: TokenId) -> bool {
        let ok = last_promise_succeeded();
        if ok {
            self.clear_lock(&token_id);
        } else {
            self.expect_company_mut(&token_id).needs_resync = true;
            emit("vault_resync_required", json!({"token_id": token_id}));
        }
        ok
    }

    /// Runs after a callback that does not take a NEP-141 refund. A callback that failed while the
    /// lock is on left the vault ahead of the registry; state changes it made have rolled back.
    #[private]
    pub fn on_settlement_checked(
        &mut self,
        token_id: TokenId,
        offer_id: Option<u64>,
    ) -> PromiseOrValue<Value> {
        match env::promise_result_checked(0, MAX_SETTLEMENT_RESULT_BYTES) {
            Ok(value) => PromiseOrValue::Value(serde_json::from_slice(&value).unwrap_or(Value::Null)),
            Err(PromiseError::TooLong(_)) => PromiseOrValue::Value(Value::Null),
            Err(_) => {
                self.mark_stuck(&token_id, offer_id);
                Self::fail_visibly("ERR_SETTLEMENT_FAILED")
            }
        }
    }

    /// Same, for a callback whose result is the amount to refund. A failed callback paid nothing
    /// out, so the whole amount goes back.
    #[private]
    pub fn on_ft_settlement_checked(&mut self, token_id: TokenId, amount: U128) -> U128 {
        match env::promise_result_checked(0, MAX_SETTLEMENT_RESULT_BYTES) {
            Ok(value) => serde_json::from_slice(&value).unwrap_or(amount),
            Err(_) => {
                self.mark_stuck(&token_id, None);
                amount
            }
        }
    }

    /// Recovers a token marked `needs_resync` by writing the registry's current owner and state to
    /// the vault. Anyone can call it.
    pub fn resync_vault_owner(&mut self, token_id: TokenId) -> Promise {
        let company = self.expect_company(&token_id);
        require!(company.needs_resync, "ERR_RESYNC_NOT_REQUIRED");
        let state = company.encumbrance.clone();
        let owner = self.expect_owner(&token_id);
        let call = self.apply_encumbrance_call(&token_id, &owner, state, None);
        let nonce = self.expect_company(&token_id).sync_nonce;
        call.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CB_SIMPLE)
                .with_unused_gas_weight(0)
                .on_resync(token_id, nonce),
        )
    }

    /// Concurrent resyncs are all accepted, and only the newest may release the lock: an older one
    /// finishing later must not clear a lock that a transfer taken since then is holding.
    #[private]
    pub fn on_resync(&mut self, token_id: TokenId, nonce: u64) -> bool {
        let ok = last_promise_succeeded();
        let company = self.expect_company_mut(&token_id);
        if ok && company.needs_resync && company.sync_nonce == nonce {
            company.needs_resync = false;
            company.settling = false;
            emit("vault_resynced", json!({"token_id": token_id}));
        }
        ok
    }

    // ---------------------------------------------------------------- NEP-177 and NEP-181

    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Incorpr Company Charters".to_string(),
            symbol: "INCORPR".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens
            .nft_tokens(from_index, limit)
            .into_iter()
            .map(|t| self.with_charter(t))
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
            .into_iter()
            .map(|t| self.with_charter(t))
            .collect()
    }

    // ---------------------------------------------------------------- NEP-178

    /// Capped and refused on an encumbered token. Settlement callbacks read this map after the
    /// vault has moved, so its size must not be under the control of a seller or borrower.
    #[payable]
    pub fn nft_approve(
        &mut self,
        token_id: TokenId,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        let company = self.expect_company(&token_id);
        require!(!company.settling, "ERR_TOKEN_SETTLING");
        require!(company.encumbrance == Encumbrance::Free, "ERR_TOKEN_ENCUMBERED");
        let approvals = self
            .tokens
            .approvals_by_id
            .as_ref()
            .and_then(|by_id| by_id.get(&token_id))
            .unwrap_or_default();
        require!(
            approvals.len() < MAX_APPROVALS_PER_TOKEN || approvals.contains_key(&account_id),
            "ERR_TOO_MANY_APPROVALS"
        );
        emit("approval_set", json!({"token_id": token_id, "account_id": account_id}));
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    pub fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.assert_not_settling(&token_id);
        emit("approval_revoked", json!({"token_id": token_id, "account_id": account_id}));
        self.tokens.nft_revoke(token_id, account_id);
    }

    #[payable]
    pub fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.assert_not_settling(&token_id);
        emit("approvals_revoked", json!({"token_id": token_id}));
        self.tokens.nft_revoke_all(token_id);
    }

    pub fn nft_is_approved(
        &self,
        token_id: TokenId,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        self.tokens.nft_is_approved(token_id, approved_account_id, approval_id)
    }

    // ---------------------------------------------------------------- NEP-199

    pub fn nft_payout(&self, token_id: TokenId, balance: U128, max_len_payout: Option<u32>) -> Payout {
        let company = self.expect_company(&token_id);
        require!(company.encumbrance == Encumbrance::Free, "ERR_TOKEN_ENCUMBERED");
        self.compute_payout(&token_id, balance, max_len_payout)
    }

    #[payable]
    pub fn nft_transfer_payout(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        balance: U128,
        max_len_payout: Option<u32>,
    ) -> Promise {
        assert_one_yocto();
        let sender_id = env::predecessor_account_id();
        // Computed against the current owner before the lock and the vault call.
        let payout = self.compute_payout(&token_id, balance, max_len_payout);
        self.authorize_transfer(&sender_id, &receiver_id, &token_id, approval_id, memo.as_deref());
        self.begin_transit_call(&token_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_FINISH)
                    .with_unused_gas_weight(0)
                    .on_transfer_payout_synced(sender_id, receiver_id, token_id.clone(), memo, payout),
            )
            .then(Self::watch(token_id, None))
    }

    #[private]
    pub fn on_transfer_payout_synced(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        memo: Option<String>,
        payout: Payout,
    ) -> PromiseOrValue<Payout> {
        if !last_promise_succeeded() {
            self.clear_lock(&token_id);
            return Self::fail_visibly("ERR_VAULT_SYNC_FAILED");
        }
        self.finish_transfer(&token_id, &receiver_id, Some(&sender_id), memo.as_deref());
        self.finish_vault(&token_id, &receiver_id, Encumbrance::Free);
        PromiseOrValue::Value(payout)
    }

    // ---------------------------------------------------------------- M&A market

    #[payable]
    pub fn list_company(&mut self, token_id: TokenId, ask: U128) -> Promise {
        assert_one_yocto();
        require!(ask.0 > 0, "ERR_INVALID_ASK");
        let owner = self.assert_owner_of_free_token(&token_id);
        require!(free_balance() >= REGISTRY_RESERVE.as_yoctonear(), "ERR_REGISTRY_RESERVE_LOW");
        self.expect_company_mut(&token_id).settling = true;
        self.apply_encumbrance_call(&token_id, &owner, Encumbrance::Listed { ask }, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_SIMPLE)
                    .with_unused_gas_weight(0)
                    .on_listing_frozen(token_id.clone(), ask),
            )
            .then(Self::watch(token_id, None))
    }

    /// The listing activates here and only here, after the vault accepted the freeze.
    #[private]
    pub fn on_listing_frozen(&mut self, token_id: TokenId, ask: U128) -> PromiseOrValue<bool> {
        self.clear_lock(&token_id);
        if !last_promise_succeeded() {
            emit("listing_failed", json!({"token_id": token_id}));
            return Self::fail_visibly("ERR_VAULT_FREEZE_FAILED");
        }
        self.expect_company_mut(&token_id).encumbrance = Encumbrance::Listed { ask };
        emit("company_listed", json!({"token_id": token_id, "ask": ask}));
        PromiseOrValue::Value(true)
    }

    #[payable]
    pub fn unlist_company(&mut self, token_id: TokenId) -> Promise {
        assert_one_yocto();
        let owner = self.expect_owner(&token_id);
        require!(env::predecessor_account_id() == owner, "ERR_NOT_TOKEN_OWNER");
        self.assert_not_settling(&token_id);
        require!(
            matches!(self.expect_company(&token_id).encumbrance, Encumbrance::Listed { .. }),
            "ERR_TOKEN_NOT_LISTED"
        );
        self.expect_company_mut(&token_id).settling = true;
        self.begin_transit_call(&token_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_FINISH)
                    .with_unused_gas_weight(0)
                    .on_unlisted(token_id.clone(), owner),
            )
            .then(Self::watch(token_id, None))
    }

    #[private]
    pub fn on_unlisted(&mut self, token_id: TokenId, owner: AccountId) -> PromiseOrValue<bool> {
        if !last_promise_succeeded() {
            self.clear_lock(&token_id);
            return Self::fail_visibly("ERR_VAULT_UNFREEZE_FAILED");
        }
        self.expect_company_mut(&token_id).encumbrance = Encumbrance::Free;
        self.finish_vault(&token_id, &owner, Encumbrance::Free);
        emit("company_unlisted", json!({"token_id": token_id}));
        PromiseOrValue::Value(true)
    }

    // ---------------------------------------------------------------- USDC entry point

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.usdc_token {
            return PromiseOrValue::Value(amount);
        }
        let Ok(action) = serde_json::from_str::<FtAction>(&msg) else {
            return Self::refund(amount, "ERR_INVALID_MSG");
        };
        match action {
            FtAction::Acquire { token_id, expected_sync_nonce } => {
                self.handle_acquire(sender_id, amount, token_id, expected_sync_nonce)
            }
            FtAction::FundOffer { token_id, repay_amount, term_ms, terms } => {
                self.handle_fund_offer(sender_id, amount, token_id, repay_amount, term_ms, terms)
            }
            FtAction::Repay { token_id } => self.handle_repay(sender_id, amount, token_id),
            FtAction::Bid { token_id } => self.handle_bid(sender_id, amount, token_id),
        }
    }

    /// Returning the amount makes `ft_resolve_transfer` give the buyer's funds back when the
    /// vault refused. On success the buyer becomes shareholder in the last step, after it has paid.
    #[private]
    pub fn on_acquire_settled(
        &mut self,
        token_id: TokenId,
        buyer: AccountId,
        seller: AccountId,
        ask: U128,
        amount: U128,
    ) -> U128 {
        if !last_promise_succeeded() {
            self.clear_lock(&token_id);
            emit("acquisition_failed", json!({"token_id": token_id, "buyer": buyer}));
            return amount;
        }
        self.finish_transfer(&token_id, &buyer, None, Some("acquisition"));
        let (founder, royalty_bps) = {
            let company = self.expect_company_mut(&token_id);
            company.encumbrance = Encumbrance::Free;
            (company.founder.clone(), company.founder_royalty_bps)
        };
        let royalty = ask.0 * royalty_bps as u128 / BPS_DENOMINATOR;
        self.pay_out(&founder, royalty);
        self.pay_out(&seller, ask.0 - royalty);
        self.finish_vault(&token_id, &buyer, Encumbrance::Free);
        emit(
            "company_acquired",
            json!({"token_id": token_id, "buyer": buyer, "seller": seller, "price": ask, "royalty": U128(royalty)}),
        );
        U128(amount.0 - ask.0)
    }

    // ---------------------------------------------------------------- Credit desk

    /// Freezes the vault first; the principal moves only in the callback.
    #[payable]
    pub fn accept_offer(&mut self, offer_id: u64) -> Promise {
        assert_one_yocto();
        let offer = self.expect_offer(offer_id);
        require!(!offer.settling, "ERR_OFFER_SETTLING");
        let owner = self.assert_owner_of_free_token(&offer.token_id);
        require!(free_balance() >= REGISTRY_RESERVE.as_yoctonear(), "ERR_REGISTRY_RESERVE_LOW");
        let due_ms = env::block_timestamp_ms()
            .checked_add(offer.term_ms)
            .unwrap_or_else(|| env::panic_str("ERR_INVALID_TERM"));
        let token_id = offer.token_id.clone();
        self.expect_company_mut(&token_id).settling = true;
        self.offers.insert(offer_id, Offer { settling: true, ..offer.clone() });
        let state = Encumbrance::Pledged {
            lender: offer.lender.clone(),
            debt: offer.repay_amount,
            due_ms,
        };
        self.apply_encumbrance_call(&token_id, &owner, state, offer.terms)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_ONE_PAYOUT)
                    .with_unused_gas_weight(0)
                    .on_pledge_frozen(offer_id, owner, due_ms),
            )
            .then(Self::watch(token_id, Some(offer_id)))
    }

    #[private]
    pub fn on_pledge_frozen(
        &mut self,
        offer_id: u64,
        borrower: AccountId,
        due_ms: u64,
    ) -> PromiseOrValue<bool> {
        let offer = self.expect_offer(offer_id);
        let token_id = offer.token_id.clone();
        self.clear_lock(&token_id);
        if !last_promise_succeeded() {
            self.offers.insert(offer_id, Offer { settling: false, ..offer });
            emit("pledge_failed", json!({"token_id": token_id, "offer_id": offer_id}));
            return Self::fail_visibly("ERR_VAULT_FREEZE_FAILED");
        }
        self.remove_offer(offer_id, &token_id);
        self.expect_company_mut(&token_id).encumbrance = Encumbrance::Pledged {
            lender: offer.lender.clone(),
            debt: offer.repay_amount,
            due_ms,
        };
        self.loans.insert(
            token_id.clone(),
            Loan {
                token_id: token_id.clone(),
                lender: offer.lender.clone(),
                borrower: borrower.clone(),
                principal: offer.principal,
                debt: offer.repay_amount,
                due_ms,
                auction_start_ms: None,
            },
        );
        self.pay_out(&borrower, offer.principal.0);
        emit(
            "loan_opened",
            json!({"token_id": token_id, "lender": offer.lender, "borrower": borrower, "principal": offer.principal, "debt": offer.repay_amount, "due_ms": due_ms}),
        );
        PromiseOrValue::Value(true)
    }

    #[payable]
    pub fn cancel_offer(&mut self, offer_id: u64) {
        assert_one_yocto();
        let offer = self.expect_offer(offer_id);
        require!(env::predecessor_account_id() == offer.lender, "ERR_NOT_OFFER_LENDER");
        require!(!offer.settling, "ERR_OFFER_SETTLING");
        self.remove_offer(offer_id, &offer.token_id);
        self.unlock_offer_storage(&offer.lender);
        self.pay_out(&offer.lender, offer.principal.0);
        emit("offer_cancelled", json!({"offer_id": offer_id, "token_id": offer.token_id}));
    }

    #[private]
    pub fn on_repay_settled(
        &mut self,
        token_id: TokenId,
        payer: AccountId,
        amount: U128,
        debt: U128,
    ) -> U128 {
        if !last_promise_succeeded() {
            self.clear_lock(&token_id);
            emit("repay_failed", json!({"token_id": token_id, "payer": payer}));
            return amount;
        }
        let loan = self.loans.remove(&token_id).unwrap_or_else(|| env::panic_str("ERR_NO_LOAN"));
        self.expect_company_mut(&token_id).encumbrance = Encumbrance::Free;
        self.unlock_offer_storage(&loan.lender);
        self.pay_out(&loan.lender, debt.0);
        self.finish_vault(&token_id, &loan.borrower, Encumbrance::Free);
        emit("loan_repaid", json!({"token_id": token_id, "payer": payer, "debt": debt}));
        U128(amount.0 - debt.0)
    }

    /// Anyone, once the loan is past due.
    pub fn start_auction(&mut self, token_id: TokenId) {
        self.assert_not_settling(&token_id);
        let loan = self.loans.get_mut(&token_id).unwrap_or_else(|| env::panic_str("ERR_NO_LOAN"));
        let now = env::block_timestamp_ms();
        require!(now > loan.due_ms, "ERR_LOAN_NOT_DUE");
        require!(loan.auction_start_ms.is_none(), "ERR_AUCTION_ALREADY_STARTED");
        loan.auction_start_ms = Some(now);
        emit("auction_started", json!({"token_id": token_id, "start_ms": now}));
    }

    #[private]
    pub fn on_bid_settled(
        &mut self,
        token_id: TokenId,
        bidder: AccountId,
        price: U128,
        amount: U128,
    ) -> U128 {
        if !last_promise_succeeded() {
            self.clear_lock(&token_id);
            emit("bid_failed", json!({"token_id": token_id, "bidder": bidder}));
            return amount;
        }
        let loan = self.loans.remove(&token_id).unwrap_or_else(|| env::panic_str("ERR_NO_LOAN"));
        self.finish_transfer(&token_id, &bidder, None, Some("auction"));
        let (founder, royalty_bps) = {
            let company = self.expect_company_mut(&token_id);
            company.encumbrance = Encumbrance::Free;
            (company.founder.clone(), company.founder_royalty_bps)
        };
        let to_lender = price.0.min(loan.debt.0);
        let remainder = price.0 - to_lender;
        let royalty = remainder * royalty_bps as u128 / BPS_DENOMINATOR;
        self.pay_out(&loan.lender, to_lender);
        self.pay_out(&founder, royalty);
        self.pay_out(&loan.borrower, remainder - royalty);
        self.unlock_offer_storage(&loan.lender);
        self.finish_vault(&token_id, &bidder, Encumbrance::Free);
        emit(
            "auction_settled",
            json!({"token_id": token_id, "bidder": bidder, "price": price, "to_lender": U128(to_lender), "royalty": U128(royalty)}),
        );
        U128(amount.0 - price.0)
    }

    #[payable]
    pub fn claim_defaulted_collateral(&mut self, token_id: TokenId) -> Promise {
        assert_one_yocto();
        self.assert_not_settling(&token_id);
        let loan = self.expect_loan(&token_id);
        require!(env::predecessor_account_id() == loan.lender, "ERR_NOT_LOAN_LENDER");
        let start = loan.auction_start_ms.unwrap_or_else(|| env::panic_str("ERR_AUCTION_NOT_STARTED"));
        require!(
            env::block_timestamp_ms() > start + self.auction_duration_ms,
            "ERR_AUCTION_STILL_OPEN"
        );
        self.expect_company_mut(&token_id).settling = true;
        self.begin_transit_call(&token_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_FINISH)
                    .with_unused_gas_weight(0)
                    .on_collateral_claimed(token_id.clone()),
            )
            .then(Self::watch(token_id, None))
    }

    #[private]
    pub fn on_collateral_claimed(&mut self, token_id: TokenId) -> PromiseOrValue<bool> {
        if !last_promise_succeeded() {
            self.clear_lock(&token_id);
            return Self::fail_visibly("ERR_VAULT_UNFREEZE_FAILED");
        }
        let loan = self.loans.remove(&token_id).unwrap_or_else(|| env::panic_str("ERR_NO_LOAN"));
        self.finish_transfer(&token_id, &loan.lender, None, Some("collateral_claim"));
        self.expect_company_mut(&token_id).encumbrance = Encumbrance::Free;
        self.unlock_offer_storage(&loan.lender);
        self.finish_vault(&token_id, &loan.lender, Encumbrance::Free);
        emit("collateral_claimed", json!({"token_id": token_id, "lender": loan.lender}));
        PromiseOrValue::Value(true)
    }

    // ---------------------------------------------------------------- NEP-145, credit desk only

    /// Prepays offer storage, because `ft_transfer_call` cannot carry NEAR. Each live offer locks
    /// `offer_storage_cost()`.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let attached = env::attached_deposit().as_yoctonear();
        let min = STORAGE_ACCOUNT_MIN.as_yoctonear();
        let existing = self.storage_accounts.get(&account).cloned();
        let (credit, refund) = match (&existing, registration_only.unwrap_or(false)) {
            (Some(_), true) => (0, attached),
            (None, true) => {
                require!(attached >= min, "ERR_STORAGE_DEPOSIT_TOO_LOW");
                (min, attached - min)
            }
            (None, false) => {
                require!(attached >= min, "ERR_STORAGE_DEPOSIT_TOO_LOW");
                (attached, 0)
            }
            (Some(_), false) => (attached, 0),
        };
        let mut entry = existing.unwrap_or(StorageAccount { total: 0, locked_offers: 0 });
        entry.total += credit;
        let balance = StorageBalance { total: U128(entry.total), available: U128(entry.available()) };
        emit("storage_deposit", json!({"account": account, "amount": U128(credit)}));
        self.storage_accounts.insert(account, entry);
        if refund > 0 {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
        balance
    }

    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let entry = self
            .storage_accounts
            .get_mut(&account)
            .unwrap_or_else(|| env::panic_str("ERR_STORAGE_NOT_REGISTERED"));
        let available = entry.available();
        let amount = amount.map_or(available, |a| a.0);
        require!(amount <= available, "ERR_STORAGE_AMOUNT_TOO_HIGH");
        entry.total -= amount;
        let balance = StorageBalance { total: U128(entry.total), available: U128(entry.available()) };
        emit("storage_withdraw", json!({"account": account, "amount": U128(amount)}));
        if amount > 0 {
            Promise::new(account).transfer(NearToken::from_yoctonear(amount)).detach();
        }
        balance
    }

    /// `force` is refused: an entry with locked offers backs storage already in use.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        require!(!force.unwrap_or(false), "ERR_STORAGE_FORCE_NOT_SUPPORTED");
        let account = env::predecessor_account_id();
        let Some(entry) = self.storage_accounts.get(&account).cloned() else {
            return false;
        };
        require!(entry.locked_offers == 0, "ERR_STORAGE_OFFERS_LOCKED");
        self.storage_accounts.remove(&account);
        emit("storage_unregister", json!({"account": account, "amount": U128(entry.total)}));
        Promise::new(account).transfer(NearToken::from_yoctonear(entry.total)).detach();
        true
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(STORAGE_ACCOUNT_MIN.as_yoctonear()), max: None }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.storage_accounts
            .get(&account_id)
            .map(|e| StorageBalance { total: U128(e.total), available: U128(e.available()) })
    }

    pub fn offer_storage_cost(&self) -> U128 {
        U128(OFFER_STORAGE.as_yoctonear())
    }

    // ---------------------------------------------------------------- Payout plumbing

    #[payable]
    pub fn withdraw_pending(&mut self) -> Promise {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let amount = self
            .pending_withdrawals
            .remove(&account)
            .filter(|a| *a > 0)
            .unwrap_or_else(|| env::panic_str("ERR_NOTHING_PENDING"));
        emit("pending_withdrawn", json!({"account": account, "amount": U128(amount)}));
        self.ft_transfer_promise(&account, amount)
    }

    #[private]
    pub fn on_payout(&mut self, account: AccountId, amount: U128) -> bool {
        let ok = last_promise_succeeded();
        if ok {
            emit("payout_paid", json!({"account": account, "amount": amount}));
        } else {
            let current = self.pending_withdrawals.get(&account).copied().unwrap_or(0);
            self.pending_withdrawals.insert(account.clone(), current + amount.0);
            emit("payout_pending", json!({"account": account, "amount": amount}));
        }
        ok
    }

    /// Target of a chained call that surfaces a settlement failure as a failed transaction. The
    /// callback that schedules it commits the lock release first.
    #[private]
    pub fn fail_settlement(&self, reason: String) {
        env::panic_str(&reason);
    }

    // ---------------------------------------------------------------- Views

    pub fn get_company(&self, token_id: TokenId) -> Option<CompanyView> {
        let mut company = self.companies.get(&token_id)?.clone();
        company.revenue_30d = current_revenue_30d(&company);
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        Some(CompanyView { token_id, owner_id, company })
    }

    /// `from` is a zero-based index over token ids in incorporation order.
    pub fn list_companies(&self, from: Option<u64>, limit: Option<u64>) -> Vec<CompanyView> {
        let start = from.unwrap_or(0) + 1;
        let limit = limit.unwrap_or(50).min(100);
        (start..self.next_token_id)
            .filter_map(|id| self.get_company(id.to_string()))
            .take(limit as usize)
            .collect()
    }

    pub fn get_offers(&self, token_id: TokenId) -> Vec<Offer> {
        self.offers_by_token
            .get(&token_id)
            .map(|ids| ids.iter().filter_map(|id| self.offers.get(id).cloned()).collect())
            .unwrap_or_default()
    }

    pub fn get_loan(&self, token_id: TokenId) -> Option<Loan> {
        self.loans.get(&token_id).cloned()
    }

    pub fn get_listing(&self, token_id: TokenId) -> Option<ListingView> {
        let company = self.companies.get(&token_id)?;
        match company.encumbrance {
            Encumbrance::Listed { ask } => Some(ListingView {
                seller: self.tokens.owner_by_id.get(&token_id)?,
                ask,
                sync_nonce: company.sync_nonce,
                token_id,
            }),
            _ => None,
        }
    }

    /// `None` until an auction is running. After the window closes this returns the floor.
    pub fn auction_price(&self, token_id: TokenId) -> Option<U128> {
        let loan = self.loans.get(&token_id)?;
        let start = loan.auction_start_ms?;
        Some(U128(self.dutch_price(loan.debt.0, start)))
    }

    pub fn pending_withdrawal(&self, account_id: AccountId) -> U128 {
        U128(self.pending_withdrawals.get(&account_id).copied().unwrap_or(0))
    }

    /// Minimum attached deposit for `incorporate_company`. The excess is refunded.
    pub fn incorporation_cost(&self) -> U128 {
        U128(required_deposit())
    }
}

// Internal helpers.
impl Registry {
    fn vault_account(&self, token_id: &str) -> AccountId {
        format!("c-{token_id}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("ERR_INVALID_VAULT_ACCOUNT"))
    }

    fn expect_company(&self, token_id: &TokenId) -> &Company {
        self.companies.get(token_id).unwrap_or_else(|| env::panic_str("ERR_TOKEN_NOT_FOUND"))
    }

    fn expect_company_mut(&mut self, token_id: &TokenId) -> &mut Company {
        self.companies.get_mut(token_id).unwrap_or_else(|| env::panic_str("ERR_TOKEN_NOT_FOUND"))
    }

    fn expect_owner(&self, token_id: &TokenId) -> AccountId {
        self.tokens
            .owner_by_id
            .get(token_id)
            .unwrap_or_else(|| env::panic_str("ERR_TOKEN_NOT_FOUND"))
    }

    fn expect_offer(&self, offer_id: u64) -> Offer {
        self.offers
            .get(&offer_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("ERR_OFFER_NOT_FOUND"))
    }

    fn expect_loan(&self, token_id: &TokenId) -> Loan {
        self.loans.get(token_id).cloned().unwrap_or_else(|| env::panic_str("ERR_NO_LOAN"))
    }

    fn assert_not_settling(&self, token_id: &TokenId) {
        require!(!self.expect_company(token_id).settling, "ERR_TOKEN_SETTLING");
    }

    fn assert_owner_of_free_token(&self, token_id: &TokenId) -> AccountId {
        let owner = self.expect_owner(token_id);
        require!(env::predecessor_account_id() == owner, "ERR_NOT_TOKEN_OWNER");
        let company = self.expect_company(token_id);
        require!(!company.settling, "ERR_TOKEN_SETTLING");
        require!(company.encumbrance == Encumbrance::Free, "ERR_TOKEN_ENCUMBERED");
        owner
    }

    fn clear_lock(&mut self, token_id: &TokenId) {
        self.expect_company_mut(token_id).settling = false;
    }

    fn next_sync(&mut self, token_id: &TokenId) -> (AccountId, u64) {
        let company = self.expect_company_mut(token_id);
        company.sync_nonce += 1;
        (company.vault.clone(), company.sync_nonce)
    }

    fn apply_encumbrance_call(
        &mut self,
        token_id: &TokenId,
        new_shareholder: &AccountId,
        state: Encumbrance,
        terms: Option<PledgeTerms>,
    ) -> Promise {
        let (vault, nonce) = self.next_sync(token_id);
        ext_vault::ext(vault)
            .with_static_gas(GAS_VAULT_SYNC)
            .with_unused_gas_weight(0)
            .apply_encumbrance(new_shareholder.clone(), state, nonce, terms)
    }

    fn begin_transit_call(&mut self, token_id: &TokenId) -> Promise {
        let (vault, nonce) = self.next_sync(token_id);
        ext_vault::ext(vault)
            .with_static_gas(GAS_VAULT_SYNC)
            .with_unused_gas_weight(0)
            .begin_transit(nonce)
    }

    /// Ends a settlement whose token and funds have moved: the vault leaves transit under its final
    /// holder and the lock clears. A failure here is retried through `resync_vault_owner`.
    fn finish_vault(&mut self, token_id: &TokenId, holder: &AccountId, state: Encumbrance) {
        self.apply_encumbrance_call(token_id, holder, state, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_VAULT_FINISHED)
                    .with_unused_gas_weight(0)
                    .on_vault_finished(token_id.clone()),
            )
            .detach();
    }

    fn watch(token_id: TokenId, offer_id: Option<u64>) -> Promise {
        Self::ext(env::current_account_id())
            .with_static_gas(GAS_WATCH)
            .with_unused_gas_weight(0)
            .on_settlement_checked(token_id, offer_id)
    }

    fn watch_ft(token_id: TokenId, amount: U128) -> Promise {
        Self::ext(env::current_account_id())
            .with_static_gas(GAS_WATCH)
            .with_unused_gas_weight(0)
            .on_ft_settlement_checked(token_id, amount)
    }

    /// Writes only flags that already exist, so it needs no new storage.
    fn mark_stuck(&mut self, token_id: &TokenId, offer_id: Option<u64>) {
        let company = self.expect_company_mut(token_id);
        if company.settling {
            company.needs_resync = true;
            emit("vault_resync_required", json!({"token_id": token_id}));
        }
        if let Some(offer) = offer_id.and_then(|id| self.offers.get_mut(&id)) {
            offer.settling = false;
        }
    }

    /// Checks authorization and takes the lock. Returns the current owner.
    fn authorize_transfer(
        &mut self,
        sender_id: &AccountId,
        receiver_id: &AccountId,
        token_id: &TokenId,
        approval_id: Option<u64>,
        memo: Option<&str>,
    ) -> AccountId {
        require!(memo.is_none_or(|m| m.len() <= MAX_MEMO_LEN), "ERR_MEMO_TOO_LONG");
        let owner = self.expect_owner(token_id);
        let company = self.expect_company(token_id);
        require!(!company.settling, "ERR_TOKEN_SETTLING");
        require!(company.encumbrance == Encumbrance::Free, "ERR_TOKEN_ENCUMBERED");
        require!(*receiver_id != owner, "ERR_RECEIVER_IS_OWNER");
        if *sender_id != owner {
            let approved = self
                .tokens
                .approvals_by_id
                .as_ref()
                .and_then(|by_id| by_id.get(token_id))
                .and_then(|approvals| approvals.get(sender_id).copied());
            match approved {
                Some(actual) => {
                    require!(
                        approval_id.is_none_or(|given| given == actual),
                        "ERR_APPROVAL_ID_MISMATCH"
                    );
                }
                None => env::panic_str("ERR_NOT_APPROVED"),
            }
        }
        self.expect_company_mut(token_id).settling = true;
        owner
    }

    /// Moves the token and clears NEP-178 approvals. Approval changes are rejected while the lock
    /// is on, so the authorization from `authorize_transfer` still holds.
    fn finish_transfer(
        &mut self,
        token_id: &TokenId,
        receiver_id: &AccountId,
        sender_id: Option<&AccountId>,
        memo: Option<&str>,
    ) -> (AccountId, Option<HashMap<AccountId, u64>>) {
        let owner = self.expect_owner(token_id);
        let approvals = self
            .tokens
            .approvals_by_id
            .as_mut()
            .map(|by_id| by_id.remove(token_id).unwrap_or_default());
        self.tokens.internal_transfer_unguarded(token_id, &owner, receiver_id);
        NftTransfer {
            old_owner_id: &owner,
            new_owner_id: receiver_id,
            token_ids: &[token_id],
            authorized_id: sender_id.filter(|s| **s != owner).map(|s| s.as_ref()),
            memo,
        }
        .emit();
        (owner, approvals)
    }

    fn with_charter(&self, mut token: Token) -> Token {
        if let (Some(company), Some(metadata)) =
            (self.companies.get(&token.token_id), token.metadata.as_mut())
        {
            let svg = charter_svg(&token.token_id, company, &token.owner_id);
            metadata.media_hash = Some(env::sha256(svg.as_bytes()).into());
            metadata.media = Some(charter_data_uri(&svg));
        }
        token
    }

    fn compute_payout(&self, token_id: &TokenId, balance: U128, max_len: Option<u32>) -> Payout {
        let owner = self.expect_owner(token_id);
        let company = self.expect_company(token_id);
        let royalty = balance.0 * company.founder_royalty_bps as u128 / BPS_DENOMINATOR;
        let mut payout = HashMap::new();
        payout.insert(owner.clone(), U128(balance.0 - royalty));
        if royalty > 0 {
            let entry = payout.entry(company.founder.clone()).or_insert(U128(0));
            entry.0 += royalty;
        }
        if let Some(max) = max_len {
            require!(payout.len() <= max as usize, "ERR_PAYOUT_TOO_LONG");
        }
        Payout { payout }
    }

    fn handle_acquire(
        &mut self,
        buyer: AccountId,
        amount: U128,
        token_id: TokenId,
        expected_sync_nonce: u64,
    ) -> PromiseOrValue<U128> {
        let Some(company) = self.companies.get(&token_id) else {
            return Self::refund(amount, "ERR_TOKEN_NOT_FOUND");
        };
        if company.settling {
            return Self::refund(amount, "ERR_TOKEN_SETTLING");
        }
        let Encumbrance::Listed { ask } = company.encumbrance else {
            return Self::refund(amount, "ERR_TOKEN_NOT_LISTED");
        };
        if company.sync_nonce != expected_sync_nonce {
            return Self::refund(amount, "ERR_LISTING_CHANGED");
        }
        if amount.0 < ask.0 {
            return Self::refund(amount, "ERR_AMOUNT_BELOW_ASK");
        }
        if free_balance() < REGISTRY_RESERVE.as_yoctonear() {
            return Self::refund(amount, "ERR_REGISTRY_RESERVE_LOW");
        }
        let seller = self.expect_owner(&token_id);
        if seller == buyer {
            return Self::refund(amount, "ERR_BUYER_IS_SELLER");
        }
        self.expect_company_mut(&token_id).settling = true;
        self.begin_transit_call(&token_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_FINISH_TWO_PAYOUTS)
                    .with_unused_gas_weight(0)
                    .on_acquire_settled(token_id.clone(), buyer, seller, ask, amount),
            )
            .then(Self::watch_ft(token_id, amount))
            .into()
    }

    fn handle_fund_offer(
        &mut self,
        lender: AccountId,
        amount: U128,
        token_id: TokenId,
        repay_amount: U128,
        term_ms: u64,
        terms: Option<PledgeTerms>,
    ) -> PromiseOrValue<U128> {
        if !self.companies.contains_key(&token_id) {
            return Self::refund(amount, "ERR_TOKEN_NOT_FOUND");
        }
        if amount.0 < MIN_OFFER_PRINCIPAL || repay_amount.0 < amount.0 || term_ms == 0 {
            return Self::refund(amount, "ERR_INVALID_OFFER");
        }
        let storage = self.storage_accounts.get(&lender).map_or(0, StorageAccount::available);
        if storage < OFFER_STORAGE.as_yoctonear() {
            return Self::refund(amount, "ERR_STORAGE_DEPOSIT_REQUIRED");
        }
        let full = self.offers_by_token.get(&token_id).is_some_and(|ids| ids.len() >= MAX_OFFERS_PER_TOKEN);
        if full {
            // A full book gives way to larger offers, so holding its slots costs real capital.
            let smallest = self
                .get_offers(token_id.clone())
                .into_iter()
                .filter(|o| !o.settling)
                .min_by_key(|o| o.principal.0);
            match smallest {
                Some(offer) if offer.principal.0 < amount.0 => {
                    self.remove_offer(offer.id, &token_id);
                    self.unlock_offer_storage(&offer.lender);
                    self.pay_out(&offer.lender, offer.principal.0);
                    emit("offer_evicted", json!({"offer_id": offer.id, "token_id": token_id}));
                }
                _ => return Self::refund(amount, "ERR_TOO_MANY_OFFERS"),
            }
        }
        if let Some(entry) = self.storage_accounts.get_mut(&lender) {
            entry.locked_offers += 1;
        }
        let id = self.next_offer_id;
        self.next_offer_id += 1;
        let mut ids = self.offers_by_token.get(&token_id).cloned().unwrap_or_default();
        ids.push(id);
        self.offers_by_token.insert(token_id.clone(), ids);
        self.offers.insert(
            id,
            Offer {
                id,
                token_id: token_id.clone(),
                lender: lender.clone(),
                principal: amount,
                repay_amount,
                term_ms,
                settling: false,
                terms,
            },
        );
        emit(
            "offer_funded",
            json!({"offer_id": id, "token_id": token_id, "lender": lender, "principal": amount, "repay_amount": repay_amount, "term_ms": term_ms}),
        );
        PromiseOrValue::Value(U128(0))
    }

    fn handle_repay(
        &mut self,
        payer: AccountId,
        amount: U128,
        token_id: TokenId,
    ) -> PromiseOrValue<U128> {
        let Some(loan) = self.loans.get(&token_id).cloned() else {
            return Self::refund(amount, "ERR_NO_LOAN");
        };
        if self.expect_company(&token_id).settling {
            return Self::refund(amount, "ERR_TOKEN_SETTLING");
        }
        if amount.0 < loan.debt.0 {
            return Self::refund(amount, "ERR_AMOUNT_BELOW_DEBT");
        }
        self.expect_company_mut(&token_id).settling = true;
        self.begin_transit_call(&token_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_FINISH_ONE_PAYOUT)
                    .with_unused_gas_weight(0)
                    .on_repay_settled(token_id.clone(), payer, amount, loan.debt),
            )
            .then(Self::watch_ft(token_id, amount))
            .into()
    }

    fn handle_bid(
        &mut self,
        bidder: AccountId,
        amount: U128,
        token_id: TokenId,
    ) -> PromiseOrValue<U128> {
        let Some(loan) = self.loans.get(&token_id).cloned() else {
            return Self::refund(amount, "ERR_NO_LOAN");
        };
        if self.expect_company(&token_id).settling {
            return Self::refund(amount, "ERR_TOKEN_SETTLING");
        }
        let Some(start) = loan.auction_start_ms else {
            return Self::refund(amount, "ERR_AUCTION_NOT_STARTED");
        };
        if env::block_timestamp_ms() > start + self.auction_duration_ms {
            return Self::refund(amount, "ERR_AUCTION_CLOSED");
        }
        let price = self.dutch_price(loan.debt.0, start);
        if amount.0 < price {
            return Self::refund(amount, "ERR_AMOUNT_BELOW_AUCTION_PRICE");
        }
        self.expect_company_mut(&token_id).settling = true;
        self.begin_transit_call(&token_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_FINISH_THREE_PAYOUTS)
                    .with_unused_gas_weight(0)
                    .on_bid_settled(token_id.clone(), bidder, U128(price), amount),
            )
            .then(Self::watch_ft(token_id, amount))
            .into()
    }

    /// Linear from 200% of debt to 50% of debt over `auction_duration_ms`.
    fn dutch_price(&self, debt: u128, start_ms: u64) -> u128 {
        let elapsed = (env::block_timestamp_ms() - start_ms).min(self.auction_duration_ms) as u128;
        let start_price = debt * 2;
        let floor = debt / 2;
        start_price - (start_price - floor) * elapsed / self.auction_duration_ms as u128
    }

    fn remove_offer(&mut self, offer_id: u64, token_id: &TokenId) {
        self.offers.remove(&offer_id);
        if let Some(ids) = self.offers_by_token.get_mut(token_id) {
            ids.retain(|id| *id != offer_id);
        }
    }

    /// Writes an existing entry only, so a settlement callback cannot run out of storage here.
    fn unlock_offer_storage(&mut self, lender: &AccountId) {
        if let Some(entry) = self.storage_accounts.get_mut(lender) {
            entry.locked_offers = entry.locked_offers.saturating_sub(1);
        }
    }

    fn ft_transfer_promise(&self, account: &AccountId, amount: u128) -> Promise {
        ext_ft::ext(self.usdc_token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .with_unused_gas_weight(0)
            .ft_transfer(account.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PAYOUT)
                    .with_unused_gas_weight(0)
                    .on_payout(account.clone(), U128(amount)),
            )
    }

    /// Detached: `on_payout` credits `pending_withdrawals` if the transfer fails, so a receiver
    /// that cannot accept USDC does not block a settlement.
    fn pay_out(&self, account: &AccountId, amount: u128) {
        if amount > 0 {
            self.ft_transfer_promise(account, amount).detach();
        }
    }

    fn refund(amount: U128, reason: &str) -> PromiseOrValue<U128> {
        env::log_str(reason);
        PromiseOrValue::Value(amount)
    }

    fn fail_visibly<T>(reason: &str) -> PromiseOrValue<T> {
        Self::ext(env::current_account_id())
            .with_static_gas(GAS_FAIL)
            .with_unused_gas_weight(0)
            .fail_settlement(reason.to_string())
            .into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn at(ms: u64, results: Vec<PromiseResult>) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(account("registry.near"))
                .predecessor_account_id(account("registry.near"))
                .block_timestamp(ms * 1_000_000)
                .build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            results,
        );
    }

    fn registry_with_company() -> Registry {
        at(1, vec![]);
        let mut registry = Registry::new(RegistryInit {
            owner: account("registry.near"),
            usdc_token: account("usdc.near"),
            mpc_contract: account("mpc.near"),
            intents_contract: account("intents.near"),
            btc_hrp: "tb".to_string(),
            default_operator: account("operator.near"),
            compute_payee: account("payee.near"),
            allowed_tokens: vec![],
            epoch_caps: vec![],
            tee_signers: vec![],
            tee_models: vec![],
            tee_prompt_hash: String::new(),
            price_floors: vec![],
            auction_duration_ms: 1,
        });
        registry.companies.insert(
            "1".to_string(),
            Company {
                name: "n".to_string(),
                service_template: "s".to_string(),
                price_micro_usdc: U128(1),
                target_bps: [10_000, 0, 0],
                founder: account("founder.near"),
                founder_royalty_bps: 0,
                compute_reserve_bps: 100,
                vault: account("c-1.registry.near"),
                created_ms: 1,
                gross: U128(0),
                retained: U128(0),
                revenue_30d: U128(0),
                calls: 0,
                metrics_ms: 0,
                encumbrance: Encumbrance::Free,
                settling: true,
                needs_resync: true,
                sync_nonce: 5,
            },
        );
        registry
    }

    #[test]
    fn an_older_resync_does_not_release_the_lock() {
        let mut registry = registry_with_company();
        at(2, vec![PromiseResult::Successful(vec![])]);
        registry.on_resync("1".to_string(), 4);
        let company = registry.expect_company(&"1".to_string());
        assert!(company.settling && company.needs_resync);

        at(3, vec![PromiseResult::Successful(vec![])]);
        registry.on_resync("1".to_string(), 5);
        let company = registry.expect_company(&"1".to_string());
        assert!(!company.settling && !company.needs_resync);
    }

    #[test]
    fn a_late_resync_does_not_release_a_lock_taken_afterwards() {
        let mut registry = registry_with_company();
        at(2, vec![PromiseResult::Successful(vec![])]);
        registry.on_resync("1".to_string(), 5);

        // A transfer takes the lock and moves the nonce on. The stale resync then lands.
        let company = registry.expect_company_mut(&"1".to_string());
        company.settling = true;
        company.sync_nonce = 6;
        at(3, vec![PromiseResult::Successful(vec![])]);
        registry.on_resync("1".to_string(), 4);
        assert!(registry.expect_company(&"1".to_string()).settling);
    }

    #[test]
    fn a_snapshot_with_no_report_for_30_days_reads_as_zero() {
        let mut registry = registry_with_company();
        const DAY: u64 = 86_400_000;
        at(DAY * 100, vec![]);
        let company = registry.expect_company_mut(&"1".to_string());
        company.revenue_30d = U128(5);
        company.metrics_ms = DAY * 100;
        let company = registry.expect_company(&"1".to_string()).clone();

        at(DAY * 129, vec![]);
        assert_eq!(current_revenue_30d(&company).0, 5);
        at(DAY * 130, vec![]);
        assert_eq!(current_revenue_30d(&company).0, 0);
    }
}
