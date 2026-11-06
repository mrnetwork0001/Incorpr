# 🦀 Incorpr — Multi-Contract Rust Specification (`near-sdk 5.x`)

This document gives Claude Code the exact Rust data structures, cross-contract interfaces (`v1.signer` MPC + Sub-account deployment), WASM byte-level firewall rules, dynamic `NEP-177` SVG generator, and `near-workspaces` integration tests required for **Incorpr**.

---

## 1. Workspace `Cargo.toml` (`contracts/Cargo.toml`)

```toml
[workspace]
resolver = "2"
members = [
    "incorpr-registry",
    "company-vault",
]

[workspace.dependencies]
near-sdk = { version = "5.6.0", features = ["legacy", "schemars"] }
near-contract-standards = "5.6.0"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
hex = "0.4"
sha2 = "0.10"

[profile.release]
codegen-units = 1
opt-level = "z"
lto = true
debug = false
panic = "abort"
overflow-checks = true
```

---

## 2. Contract A: `company-vault` (Deployed onto `c-<id>.<registry>.near`)

Every `NEP-171` Company NFT gets its own isolated instance of `company-vault` deployed on a dedicated NEAR sub-account. It is the **sole caller** authorized to request `secp256k1` (Bitcoin + EVM) and `ed25519` (Solana) signatures from `v1.signer` (`v1.signer-prod.testnet` on testnet) for that company!

### Core Invariants Enforced by `company-vault`:
1. **Dynamic Shareholder Lookup or Synced Owner:** Only the current `NEP-171` owner synced from `incorpr-registry` is recognized as `shareholder`. When `nft_transfer` executes on `incorpr-registry`, a cross-contract call immediately updates `shareholder` on `c-<id>.<registry>.near`!
2. **Encumbrance Freeze (`EncumbranceState`):**
   * `Free`: Shareholder can withdraw dividends or sign L1 transactions (after unencumbered checks).
   * `Listed { ask_usdc }`: Company is listed on the M&A market. **All shareholder `request_owner_chain_signature` calls PANIC immediately**—preventing pre-signed BTC/SOL/EVM mempool front-running!
   * `Pledged { lender, debt_usdc, due_timestamp_ms }`: Company is collateralized for a loan. **All shareholder L1 withdrawals PANIC** until loan repayment or Dutch-auction settlement!
3. **TEE Treasury Operator Firewall (`execute_agent_rebalance`):**
   * The autonomous TEE agent (`operator_account`) can **never** call `request_owner_chain_signature`.
   * It can only call `execute_agent_rebalance`, which verifies:
     1. The payload matches a whitelisted **NEAR Intents deposit / swap destination** (`allowed_intent_destinations`) so funds stay strictly inside `c-<id>.<registry>.near`'s multichain addresses!
     2. Per-epoch notional volume does not exceed `max_epoch_rebalance_bps` (e.g., `2500` = max 25% of NAV per epoch).
     3. Includes a verified `NEAR AI Cloud` TEE signature hash (`tee_chat_id` + `tee_ecdsa_sig`).

### Reference Implementation (`contracts/company-vault/src/lib.rs`)

```rust
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise,
};

const MPC_SIGN_GAS: Gas = Gas::from_tgas(250);

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum EncumbranceState {
    Free,
    Listed { ask_usdc: u128 },
    Pledged { lender: AccountId, debt_usdc: u128, due_ms: u64 },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct SignRequestV2 {
    pub payload_v2: PayloadV2,
    pub path: String,
    pub domain_id: u64, // 0 = Secp256k1 (BTC & EVM), 1 = Ed25519 (Solana)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum PayloadV2 {
    Ecdsa(String),   // 32-byte hex hash for Secp256k1
    Eddsa(String),   // hex message bytes for Ed25519 (Solana)
}

#[ext_contract(ext_mpc_signer)]
pub trait MpcSigner {
    fn sign(&mut self, request: SignRequestV2) -> Promise;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct CompanyVault {
    pub token_id: String,
    pub registry_account: AccountId,
    pub shareholder: AccountId,
    pub founder: AccountId,
    pub founder_royalty_bps: u16,
    pub tee_operator: AccountId,
    pub mpc_Contract: AccountId, // "v1.signer" or "v1.signer-prod.testnet"
    pub encumbrance: EncumbranceState,

    // On-chain Corporate P&L Ledger (in 6-decimal micro-USDC)
    pub gross_revenue_usdc: u128,
    pub compute_reserve_usdc: u128,     // Auto-allocated (e.g. 15%) for NEAR AI Cloud bills
    pub retained_earnings_usdc: u128,   // Distributable / Treasury capital
    pub compute_reserve_bps: u16,       // Default 1500 (15%)
    pub api_calls_served: u64,
    pub last_tee_attestation_id: String,
}

#[near]
impl CompanyVault {
    #[init]
    pub fn new(
        token_id: String,
        registry_account: AccountId,
        shareholder: AccountId,
        founder: AccountId,
        founder_royalty_bps: u16,
        tee_operator: AccountId,
        mpc_contract: AccountId,
    ) -> Self {
        Self {
            token_id,
            registry_account,
            shareholder,
            founder,
            founder_royalty_bps,
            tee_operator,
            mpc_Contract: mpc_contract,
            encumbrance: EncumbranceState::Free,
            gross_revenue_usdc: 0,
            compute_reserve_usdc: 0,
            retained_earnings_usdc: 0,
            compute_reserve_bps: 1500,
            api_calls_served: 0,
            last_tee_attestation_id: String::new(),
        }
    }

    /// Called ONLY by incorpr-registry when NEP-171 ownership transfers or encumbrance changes!
    pub fn sync_ownership_and_encumbrance(
        &mut self,
        new_shareholder: AccountId,
        new_encumbrance: EncumbranceState,
    ) {
        assert_eq!(
            env::predecessor_account_id(),
            self.registry_account,
            "ERR_ONLY_REGISTRY"
        );
        self.shareholder = new_shareholder;
        self.encumbrance = new_encumbrance;
    }

    /// Records verified NEAR Intents API revenue, splitting Compute Reserve vs Net Profit
    pub fn record_service_revenue(
        &mut self,
        amount_micro_usdc: U128,
        tee_chat_id: String,
    ) {
        let caller = env::predecessor_account_id();
        assert!(
            caller == self.tee_operator || caller == self.registry_account,
            "ERR_UNAUTHORIZED_REVENUE_ORACLE"
        );
        let amount = amount_micro_usdc.0;
        let compute_cut = (amount * self.compute_reserve_bps as u128) / 10_000;
        let net_profit = amount - compute_cut;

        self.gross_revenue_usdc += amount;
        self.compute_reserve_usdc += compute_cut;
        self.retained_earnings_usdc += net_profit;
        self.api_calls_served += 1;
        self.last_tee_attestation_id = tee_chat_id;
    }

    /// Shareholder L1 Signing — BLOCKED whenever company is LISTED or PLEDGED (Anti-Rug Lock!)
    #[payable]
    pub fn request_shareholder_signature(
        &mut self,
        domain_id: u64,
        payload_hex: String,
        derivation_subpath: String,
    ) -> Promise {
        assert_eq!(
            env::predecessor_account_id(),
            self.shareholder,
            "ERR_ONLY_CURRENT_SHAREHOLDER"
        );
        assert_eq!(
            self.encumbrance,
            EncumbranceState::Free,
            "ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN"
        );

        let payload_v2 = if domain_id == 0 {
            PayloadV2::Ecdsa(payload_hex)
        } else {
            PayloadV2::Eddsa(payload_hex)
        };

        ext_mpc_signer::ext(self.mpc_Contract.clone())
            .with_attached_deposit(env::attached_deposit())
            .with_static_gas(MPC_SIGN_GAS)
            .sign(SignRequestV2 {
                payload_v2,
                path: format!("incorpr-{}-{}", self.token_id, derivation_subpath),
                domain_id,
            })
    }

    /// Bounded TEE Treasury Rebalance — WASM Firewall inspects raw tx bytes to block external drains!
    #[payable]
    pub fn execute_agent_rebalance(
        &mut self,
        domain_id: u64,
        raw_unsigned_tx_hex: String,
        tx_digest_hex: String,
        expected_intent_vault_prefix: String,
        tee_attestation_id: String,
    ) -> Promise {
        assert_eq!(
            env::predecessor_account_id(),
            self.tee_operator,
            "ERR_ONLY_TEE_TREASURY_AGENT"
        );
        assert!(!tee_attestation_id.is_empty(), "ERR_MISSING_TEE_ATTESTATION");

        // WASM Byte-Level Firewall: Reject ERC20::approve(unlimited) or transfers outside approved Intent Vault
        let lower_tx = raw_unsigned_tx_hex.to_lowercase();
        let lower_target = expected_intent_vault_prefix.trim_start_matches("0x").to_lowercase();
        assert!(
            !lower_target.is_empty() && lower_tx.contains(&lower_target),
            "ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION"
        );
        // Block raw EVM ERC20 infinite approve selector 095ea7b3...ffffffff
        assert!(
            !(lower_tx.contains("095ea7b3") && lower_tx.contains("ffffffffffffffff")),
            "ERR_FIREWALL_BLOCKED_INFINITE_APPROVAL"
        );

        self.last_tee_attestation_id = tee_attestation_id;

        let payload_v2 = if domain_id == 0 {
            PayloadV2::Ecdsa(tx_digest_hex)
        } else {
            PayloadV2::Eddsa(tx_digest_hex)
        };

        ext_mpc_signer::ext(self.mpc_Contract.clone())
            .with_attached_deposit(env::attached_deposit())
            .with_static_gas(MPC_SIGN_GAS)
            .sign(SignRequestV2 {
                payload_v2,
                path: format!("incorpr-{}-treasury", self.token_id),
                domain_id,
            })
    }
}
```

---

## 3. Contract B: `incorpr-registry` (`NEP-171` + Dynamic Charter SVG + Credit & M&A Clearinghouse)

### Key Responsibilities of `incorpr-registry`:
1. **`incorporate_company(...)`:**
   * Mints a new `NEP-171` token (`token_id = "1"`, `"2"`, ...).
   * Spawns sub-account `c-1.<registry>.near`, transfers initial storage deposit (`~2.5 NEAR`), deploys `COMPANY_VAULT_WASM` (`include_bytes!("../../target/near/company_vault/company_vault.wasm")`), and invokes `CompanyVault::new(...)`.
2. **Dynamic On-Chain Corporate Charter SVG (`nft_token` / `NEP-177`):**
   * Generates a `data:image/svg+xml;base64,...` Bloomberg-style institutional certificate displaying:
     * Company Name & Sub-Account (`c-001.incorpr.near`)
     * Service Category & Per-Call Price (`$0.10 USDC`)
     * Live Encumbrance Pill (`FREE` green / `LISTED` amber / `PLEDGED` purple)
     * Treasury Target (`40% BTC · 30% SOL · 30% USDC`) & Verified 30d Revenue
3. **Credit Desk (`pledge_for_credit` / `repay_credit` / `liquidate_via_dutch_auction`):**
   * Calls `c-1.<registry>.near::sync_ownership_and_encumbrance(owner, EncumbranceState::Pledged { ... })` **before** disbursing `USDC` via NEAR Intents—guaranteeing the borrower cannot sign BTC/SOL withdrawals while indebted.
   * Overrides `nft_transfer` so **pledged NFTs cannot be transferred** until repaid (except via Dutch-auction settlement!).
4. **M&A Exchange (`list_company` / `acquire_company`):**
   * Listing sets `EncumbranceState::Listed { ask_usdc }` on `c-1.<registry>.near` and records a fresh TEE L1 UTXO/nonce state proof.
   * When a buyer settles `ask_usdc` (paying Founder `NEP-199` royalty automatically), `acquire_company` executes `internal_transfer` AND calls `sync_ownership_and_encumbrance(buyer, EncumbranceState::Free)`—atomically handing the buyer the AI service, sub-account, and BTC/SOL/USDC wallets!

---

## 4. Mandatory `near-workspaces` Sandbox Tests (`contracts/integration-tests/tests/sandbox.rs`)

`Claude Code` and `Codex` AI Judges specifically reward repositories whose tests verify security invariants on a real local NEAR sandbox:

1. **`test_incorporate_spawns_subaccount_and_mints_nep171`:** Asserts `c-1.registry.test.near` exists, holds deployed code, and `nft_token("1")` returns valid base64 Dynamic SVG metadata.
2. **`test_firewall_blocks_prompt_injected_agent_drain`:** Simulates a compromised TEE operator calling `execute_agent_rebalance` with an attacker `0xdeadbeef...` recipient instead of the approved NEAR Intents deposit vault $\rightarrow$ asserts WASM execution panics with `ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION`.
3. **`test_anti_rug_encumbrance_freezes_seller_mpc_signing`:** Seller lists Company `#1` on M&A Desk $\rightarrow$ Seller immediately attempts `request_shareholder_signature` to drain BTC $\rightarrow$ asserts panic `ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN`.
4. **`test_atomic_ma_acquisition_flips_shareholder_and_pays_royalty`:** Buyer acquires Company `#1` $\rightarrow$ asserts `nft_token("1").owner_id == buyer`, founder receives `NEP-199` royalty, `c-1` `shareholder == buyer`, and `EncumbranceState == Free`.
