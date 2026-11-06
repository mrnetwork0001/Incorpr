//! Transfer-path races: every asynchronous payout the vault or registry starts, with a sale, a
//! transfer or a pledge landing while that payout is still in flight.
//!
//! Each payout debits its ledger in the receipt that starts it and credits it back in a callback if
//! the transfer fails. A sale changes the shareholder in its own receipts. The tests submit both
//! transactions without waiting, read the block height of every receipt that matters, and check
//! the result for whichever order the chain produced. Where the contract's receipt chain makes an
//! interleaving impossible, the test asserts the ordering instead.
//!
//! Invariants checked after every scenario:
//! - the seller receives at most the dividends that accrued before the sale;
//! - the buyer can claim everything left in the company, including revenue booked mid-sale;
//! - the sum of all USDC balances equals the token's total supply (nothing lost or minted);
//! - registry owner, vault shareholder, encumbrance and sync nonce agree, and no lock is left;
//! - the vault's USDC balance equals `retained_earnings + compute_reserve`;
//! - a failed payout is credited back to the ledger it was debited from.
//!
//! Helpers are a copy of the subset of tests/sandbox.rs that these tests need, so the two files
//! compile and run independently. The node and protocol selection are the same:
//! INCORPR_SANDBOX_PROTOCOL=88 runs this file on the newer runtime.

use std::path::PathBuf;
use std::task::Poll;

use anyhow::{anyhow, Result};
use k256::ecdsa::SigningKey;
use near_workspaces::network::{Sandbox, ValidatorKey};
use near_workspaces::operations::{CallTransaction, TransactionStatus};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{CryptoHash, Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use rand_core::OsRng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sha3::Keccak256;

const USDC_ASSET: &str = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const BTC_ASSET: &str = "nep141:btc.omft.near";
const SOL_ASSET: &str = "nep141:sol.omft.near";
const ETH_ASSET: &str = "nep141:eth.omft.near";
const WRAP_ASSET: &str = "nep141:wrap.near";
const CAP: u128 = 1_000_000_000;

const TEST_MODEL: &str = "zai-org/GLM-4.6";
const TEST_PROMPT: &str = "You review treasury proposals. Reply exactly APPROVE <proposal_hash> or REJECT <proposal_hash>.";

const PRICE: u128 = 100_000;
const ROYALTY_BPS: u128 = 500;
const RESERVE_BPS: u128 = 1_500;
const AUCTION_MS: u64 = 120_000;

/// One customer payment: 150 000 to the compute reserve, 850 000 to retained earnings.
const PAYMENT: u128 = 1_000_000;
const PAYMENT_RETAINED: u128 = PAYMENT - PAYMENT * RESERVE_BPS / 10_000;
const PAYMENT_RESERVE: u128 = PAYMENT * RESERVE_BPS / 10_000;

/// Fresh companies a race test may use before it gives up on seeing the target interleaving.
const ATTEMPTS: usize = 4;

const MAX_GAS: Gas = Gas::from_tgas(300);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const FT_STORAGE: NearToken = NearToken::from_micronear(1_250);

fn wasm(name: &str) -> Result<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../res").join(format!("{name}.wasm"));
    std::fs::read(&path).map_err(|e| {
        anyhow!("{}: {e}. Run scripts/build-contracts.sh before cargo test.", path.display())
    })
}

/// Same node and default protocol as tests/sandbox.rs.
const MAINNET_NEARCORE: &str = "2.14.0";
const MAINNET_PROTOCOL: u32 = 87;

fn sandbox_protocol() -> Result<u32> {
    match std::env::var("INCORPR_SANDBOX_PROTOCOL") {
        Ok(v) if !v.trim().is_empty() => v
            .trim()
            .parse()
            .map_err(|e| anyhow!("INCORPR_SANDBOX_PROTOCOL must be a protocol version, got {v:?}: {e}")),
        _ => Ok(MAINNET_PROTOCOL),
    }
}

async fn mainnet_runtime_sandbox() -> Result<(near_sandbox::Sandbox, Worker<Sandbox>)> {
    let want = sandbox_protocol()?;
    let config = near_sandbox::SandboxConfig {
        additional_accounts: vec![near_sandbox::GenesisAccount::default_with_name("registrar".parse()?)],
        additional_genesis: Some(json!({ "protocol_version": want })),
        ..Default::default()
    };
    let node = near_sandbox::Sandbox::start_sandbox_with_config_and_version(config, MAINNET_NEARCORE)
        .await
        .map_err(|e| anyhow!("start sandbox {MAINNET_NEARCORE}: {e}"))?;
    let worker = near_workspaces::sandbox()
        .rpc_addr(&node.rpc_addr)
        .validator_key(ValidatorKey::HomeDir(node.home_dir.path().to_path_buf()))
        .await?;
    let protocol = worker.status().await?.protocol_version;
    anyhow::ensure!(protocol == want, "sandbox runs protocol {protocol}, want {want}");
    Ok((node, worker))
}

struct Env {
    worker: Worker<Sandbox>,
    _node: near_sandbox::Sandbox,
    root: Account,
    usdc: Contract,
    intents: Contract,
    registry: Contract,
    operator: Account,
    payee: Account,
    founder: Account,
}

async fn account(root: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

fn prompt_hash(prompt: &str) -> String {
    hex::encode(Sha256::digest(prompt.as_bytes()))
}

fn tee_address(key: &SigningKey) -> String {
    let point = key.verifying_key().to_encoded_point(false);
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    format!("0x{}", hex::encode(&hash[12..]))
}

fn floor(sell: &str, buy: &str) -> Value {
    json!({"sell_token": sell, "buy_token": buy, "min_buy": "1", "per_sell": "1000000"})
}

async fn setup() -> Result<Env> {
    let (node, worker) = mainnet_runtime_sandbox().await?;
    let root = worker.root_account()?;

    let usdc = account(&root, "usdc", 30).await?.deploy(&wasm("test_usdc")?).await?.into_result()?;
    usdc.call("new").transact().await?.into_result()?;
    let mpc = account(&root, "mpc", 30).await?.deploy(&wasm("mpc_signer_double")?).await?.into_result()?;
    mpc.call("new").transact().await?.into_result()?;
    let intents =
        account(&root, "intents", 30).await?.deploy(&wasm("intents_double")?).await?.into_result()?;
    intents.call("new").transact().await?.into_result()?;

    let operator = account(&root, "operator", 30).await?;
    let payee = account(&root, "payee", 30).await?;
    let founder = account(&root, "founder", 60).await?;

    let tee_key = SigningKey::random(&mut OsRng);
    let registry =
        account(&root, "registry", 50).await?.deploy(&wasm("incorpr_registry")?).await?.into_result()?;
    registry
        .call("new")
        .args_json(json!({"args": {
            "owner": registry.id(),
            "usdc_token": usdc.id(),
            "mpc_contract": mpc.id(),
            "intents_contract": intents.id(),
            "btc_hrp": "tb",
            "default_operator": operator.id(),
            "compute_payee": payee.id(),
            "allowed_tokens": [USDC_ASSET, BTC_ASSET, SOL_ASSET, ETH_ASSET, WRAP_ASSET],
            "epoch_caps": [
                [USDC_ASSET, CAP.to_string()],
                [BTC_ASSET, CAP.to_string()],
                [SOL_ASSET, CAP.to_string()],
                [ETH_ASSET, CAP.to_string()],
            ],
            "tee_signers": [tee_address(&tee_key)],
            "tee_models": [TEST_MODEL],
            "tee_prompt_hash": prompt_hash(TEST_PROMPT),
            "price_floors": [floor(USDC_ASSET, BTC_ASSET), floor(USDC_ASSET, SOL_ASSET)],
            "auction_duration_ms": AUCTION_MS,
        }}))
        .gas(MAX_GAS)
        .transact()
        .await?
        .into_result()?;

    let env = Env { worker, _node: node, root, usdc, intents, registry, operator, payee, founder };
    env.register(env.payee.id()).await?;
    env.register(env.intents.id()).await?;
    env.register(env.founder.id()).await?;
    Ok(env)
}

fn failure_text(outcome: &ExecutionFinalResult) -> String {
    format!("{:?}", outcome.failures())
}

#[track_caller]
fn assert_failed(outcome: &ExecutionFinalResult, needle: &str) {
    let text = failure_text(outcome);
    assert!(text.contains(needle), "expected a failure containing {needle}, got: {text}");
}

#[track_caller]
fn assert_ok(outcome: &ExecutionFinalResult) {
    assert!(outcome.failures().is_empty(), "unexpected failures: {}", failure_text(outcome));
}

/// The only failures are USDC transfers to accounts without a registration, which the registry
/// turns into `pending_withdrawals` credits.
#[track_caller]
fn assert_ok_but_unregistered_payouts(outcome: &ExecutionFinalResult) {
    for failure in outcome.failures() {
        let text = format!("{failure:?}");
        assert!(
            text.contains("is not registered") && failure.executor_id.as_str().starts_with("usdc."),
            "unexpected failure: {text}"
        );
    }
}

/// The price an `auction_settled` event records. The Dutch price falls between the bidder's read
/// and settlement; the registry refunds the difference.
fn auction_price_paid(bid: &ExecutionFinalResult) -> Result<u128> {
    let event = bid
        .logs()
        .iter()
        .find(|l| l.contains("auction_settled"))
        .and_then(|l| l.strip_prefix("EVENT_JSON:"))
        .map(serde_json::from_str::<Value>)
        .transpose()?
        .ok_or_else(|| anyhow!("no auction_settled event"))?;
    Ok(u128_of(&event["data"][0]["price"]))
}

fn u128_of(value: &Value) -> u128 {
    value.as_str().unwrap_or_else(|| panic!("not a U128 string: {value}")).parse().unwrap()
}

fn logged(outcome: &ExecutionFinalResult, needle: &str) -> bool {
    outcome.logs().iter().any(|l| l.contains(needle))
}

impl Env {
    async fn incorporate(&self, name: &str) -> Result<(String, AccountId)> {
        let cost: Value = self.registry.view("incorporation_cost").await?.json()?;
        let outcome = self
            .founder
            .call(self.registry.id(), "incorporate_company")
            .args_json(json!({"args": {
                "name": name,
                "service_template": "translate-v1",
                "price_micro_usdc": PRICE.to_string(),
                "target_bps": [4000, 3000, 3000],
                "founder_royalty_bps": ROYALTY_BPS as u16,
                "compute_reserve_bps": RESERVE_BPS as u16,
            }}))
            .deposit(NearToken::from_yoctonear(u128_of(&cost)))
            .gas(MAX_GAS)
            .transact()
            .await?;
        assert_ok(&outcome);
        let token_id: Option<String> = outcome.json()?;
        let token_id = token_id.ok_or_else(|| anyhow!("incorporation returned no token"))?;
        let vault: AccountId = format!("c-{token_id}.{}", self.registry.id()).parse()?;
        Ok((token_id, vault))
    }

    /// A company held by `holder` with one customer payment booked.
    async fn earning_company(&self, name: &str, holder: &Account, customer: &Account) -> Result<(String, AccountId)> {
        let (token_id, vault) = self.incorporate(name).await?;
        if holder.id() != self.founder.id() {
            assert_ok(&self.transfer_nft(&self.founder, holder.id(), &token_id).await?);
        }
        assert_ok(&self.pay(customer, &vault, PAYMENT, &format!("{name}-c0")).await?);
        assert_eq!(u128_of(&self.vault_state(&vault).await?["retained_earnings"]), PAYMENT_RETAINED);
        Ok((token_id, vault))
    }

    async fn acquire_msg(&self, token_id: &str) -> Result<String> {
        let nonce = self.company_view(token_id).await?["sync_nonce"].as_u64().unwrap();
        Ok(json!({"action": "acquire", "token_id": token_id, "expected_sync_nonce": nonce}).to_string())
    }

    async fn register(&self, id: &AccountId) -> Result<()> {
        self.root
            .call(self.usdc.id(), "storage_deposit")
            .args_json(json!({"account_id": id, "registration_only": true}))
            .deposit(FT_STORAGE)
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Removes a zero-balance USDC registration, so the next transfer to `who` fails.
    async fn unregister(&self, who: &Account) -> Result<()> {
        assert_eq!(self.balance(who.id()).await?, 0, "unregister needs a zero balance");
        who.call(self.usdc.id(), "storage_unregister")
            .args_json(json!({}))
            .deposit(ONE_YOCTO)
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn funded(&self, name: &str, usdc: u128) -> Result<Account> {
        let acct = account(&self.root, name, 30).await?;
        self.register(acct.id()).await?;
        if usdc > 0 {
            self.usdc
                .call("mint")
                .args_json(json!({"account_id": acct.id(), "amount": usdc.to_string()}))
                .transact()
                .await?
                .into_result()?;
        }
        Ok(acct)
    }

    async fn balance(&self, id: &AccountId) -> Result<u128> {
        let value: Value =
            self.usdc.view("ft_balance_of").args_json(json!({"account_id": id})).await?.json()?;
        Ok(u128_of(&value))
    }

    /// Every account that can hold USDC in a test must be listed, or this fails.
    async fn assert_conserved(&self, holders: &[&AccountId]) -> Result<()> {
        let supply: Value = self.usdc.view("ft_total_supply").await?.json()?;
        let mut sum = 0u128;
        let mut seen = std::collections::BTreeSet::new();
        for id in holders {
            if seen.insert(id.to_string()) {
                sum += self.balance(id).await?;
            }
        }
        assert_eq!(sum, u128_of(&supply), "USDC balances do not add up to the total supply");
        Ok(())
    }

    async fn pending(&self, id: &AccountId) -> Result<u128> {
        let value: Value =
            self.registry.view("pending_withdrawal").args_json(json!({"account_id": id})).await?.json()?;
        Ok(u128_of(&value))
    }

    fn ft_call_tx(&self, from: &Account, to: &AccountId, amount: u128, msg: String) -> CallTransaction {
        from.call(self.usdc.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id": to, "amount": amount.to_string(), "msg": msg}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
    }

    async fn ft_call(&self, from: &Account, to: &AccountId, amount: u128, msg: String) -> Result<ExecutionFinalResult> {
        Ok(self.ft_call_tx(from, to, amount, msg).transact().await?)
    }

    async fn pay(&self, from: &Account, vault: &AccountId, amount: u128, call_id: &str) -> Result<ExecutionFinalResult> {
        self.ft_call(from, vault, amount, json!({"call_id": call_id}).to_string()).await
    }

    async fn vault_state(&self, vault: &AccountId) -> Result<Value> {
        Ok(self.worker.view(vault, "get_state").await?.json()?)
    }

    async fn company_view(&self, token_id: &str) -> Result<Value> {
        Ok(self.registry.view("get_company").args_json(json!({"token_id": token_id})).await?.json()?)
    }

    async fn owner_of(&self, token_id: &str) -> Result<String> {
        let token: Value =
            self.registry.view("nft_token").args_json(json!({"token_id": token_id})).await?.json()?;
        Ok(token["owner_id"].as_str().unwrap().to_string())
    }

    async fn list(&self, who: &Account, token_id: &str, ask: u128) -> Result<ExecutionFinalResult> {
        Ok(list_tx(&self.registry, who, token_id, ask).transact().await?)
    }

    async fn transfer_nft(&self, from: &Account, to: &AccountId, token_id: &str) -> Result<ExecutionFinalResult> {
        Ok(from
            .call(self.registry.id(), "nft_transfer")
            .args_json(json!({"receiver_id": to, "token_id": token_id}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    async fn claim(&self, who: &Account, vault: &AccountId, amount: u128) -> Result<ExecutionFinalResult> {
        Ok(claim_tx(who, vault, amount).transact().await?)
    }

    async fn height(&self, block_hash: CryptoHash) -> Result<u64> {
        Ok(self.worker.view_block().block_hash(block_hash).await?.height())
    }

    /// Returns once the chain has produced `n` more blocks.
    async fn wait_blocks(&self, n: u64) -> Result<()> {
        let from = self.worker.view_block().await?.height();
        while self.worker.view_block().await?.height() < from + n {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        Ok(())
    }

    /// Waits for a transaction sent with `transact_async` and for every receipt it spawned.
    /// Awaiting a `TransactionStatus` returns as soon as the final status is known, which can be
    /// before detached receipts such as the registry's `ft_transfer` payouts and their `on_payout`
    /// callbacks have run. `transact()` does not have this gap, because `broadcast_tx_commit` waits
    /// for every receipt. This re-reads the outcome until it stops growing over several blocks.
    async fn settle(&self, tx: TransactionStatus) -> Result<ExecutionFinalResult> {
        let mut seen: Option<usize> = None;
        for _ in 0..600 {
            if let Poll::Ready(outcome) = tx.status().await? {
                let receipts = outcome.receipt_outcomes().len();
                if seen == Some(receipts) {
                    return Ok(outcome);
                }
                seen = Some(receipts);
                // A pending receipt runs one block after the receipt that created it.
                let from = self.worker.view_block().await?.height();
                while self.worker.view_block().await?.height() < from + 3 {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            } else {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        Err(anyhow!("transaction {:?} did not settle", tx.hash()))
    }

    /// Block height of the first receipt in `outcome` that `executor` ran and that logged `needle`.
    async fn receipt_height(&self, outcome: &ExecutionFinalResult, executor: &AccountId, needle: &str) -> Result<Option<u64>> {
        for receipt in outcome.receipt_outcomes() {
            if &receipt.executor_id == executor && receipt.logs.iter().any(|l| l.contains(needle)) {
                return Ok(Some(self.height(receipt.block_hash).await?));
            }
        }
        Ok(None)
    }

    /// Block height of the first receipt in `outcome` that ran on `executor`, logged or not.
    async fn first_height_on(&self, outcome: &ExecutionFinalResult, executor: &AccountId) -> Result<Option<u64>> {
        match outcome.receipt_outcomes().iter().find(|r| &r.executor_id == executor) {
            Some(receipt) => Ok(Some(self.height(receipt.block_hash).await?)),
            None => Ok(None),
        }
    }

    /// Block height of the receipt the transaction itself created, on `executor`.
    async fn entry_height(&self, outcome: &ExecutionFinalResult, executor: &AccountId) -> Result<u64> {
        let first = outcome
            .receipt_outcomes()
            .first()
            .ok_or_else(|| anyhow!("transaction produced no receipt"))?;
        assert_eq!(&first.executor_id, executor, "first receipt ran on another account");
        self.height(first.block_hash).await
    }

    /// Registry and vault agree on holder, state and nonce; nothing is locked or in transit; the
    /// vault's USDC equals its two ledgers. Returns the vault state.
    async fn assert_settled(&self, token_id: &str, vault: &AccountId) -> Result<Value> {
        let company = self.company_view(token_id).await?;
        let state = self.vault_state(vault).await?;
        assert_eq!(company["settling"], false, "registry lock left on: {company}");
        assert_eq!(company["needs_resync"], false, "registry needs a resync: {company}");
        assert_eq!(state["in_transit"], false, "vault left in transit: {state}");
        assert_eq!(state["shareholder"], company["owner_id"], "vault shareholder is not the NFT owner");
        assert_eq!(state["encumbrance"], company["encumbrance"], "registry and vault encumbrance differ");
        // The registry spends a nonce on every vault call, including one the vault refused and
        // rolled back, so the vault can trail it but never lead.
        assert!(
            state["sync_nonce"].as_u64() <= company["sync_nonce"].as_u64(),
            "vault sync nonce ahead of the registry: {} > {}",
            state["sync_nonce"],
            company["sync_nonce"]
        );
        let books = u128_of(&state["retained_earnings"]) + u128_of(&state["compute_reserve"]);
        assert_eq!(self.balance(vault).await?, books, "vault USDC differs from retained + reserve");
        Ok(state)
    }

    /// The current shareholder can take everything left; the named former holders cannot.
    async fn assert_only_holder_can_claim(&self, vault: &AccountId, holder: &Account, former: &[&Account]) -> Result<u128> {
        let retained = u128_of(&self.vault_state(vault).await?["retained_earnings"]);
        for who in former {
            assert_failed(&self.claim(who, vault, 1).await?, "ERR_ONLY_CURRENT_SHAREHOLDER");
        }
        if retained > 0 {
            let before = self.balance(holder.id()).await?;
            assert_ok(&self.claim(holder, vault, retained).await?);
            assert_eq!(self.balance(holder.id()).await? - before, retained);
        }
        assert_eq!(u128_of(&self.vault_state(vault).await?["retained_earnings"]), 0);
        Ok(retained)
    }
}

fn claim_tx(who: &Account, vault: &AccountId, amount: u128) -> CallTransaction {
    who.call(vault, "claim_dividends")
        .args_json(json!({"amount": amount.to_string()}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
}

fn list_tx(registry: &Contract, who: &Account, token_id: &str, ask: u128) -> CallTransaction {
    who.call(registry.id(), "list_company")
        .args_json(json!({"token_id": token_id, "ask": ask.to_string()}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
}

async fn approve(env: &Env, who: &Account, token_id: &str, spender: &AccountId) -> Result<()> {
    assert_ok(
        &who.call(env.registry.id(), "nft_approve")
            .args_json(json!({"token_id": token_id, "account_id": spender}))
            .deposit(NearToken::from_millinear(10))
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    Ok(())
}

async fn fund_offer(env: &Env, lender: &Account, token_id: &str, principal: u128, repay: u128, term_ms: u64, terms: Option<Value>) -> Result<u64> {
    assert_ok(
        &lender
            .call(env.registry.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_millinear(20))
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    let mut msg = json!({"action": "fund_offer", "token_id": token_id, "repay_amount": repay.to_string(), "term_ms": term_ms});
    if let Some(terms) = terms {
        msg["terms"] = terms;
    }
    assert_ok(&env.ft_call(lender, env.registry.id(), principal, msg.to_string()).await?);
    let offers: Vec<Value> = env.registry.view("get_offers").args_json(json!({"token_id": token_id})).await?.json()?;
    let offer = offers.last().ok_or_else(|| anyhow!("offer not stored"))?;
    assert_eq!(offer["lender"], lender.id().as_str());
    Ok(offer["id"].as_u64().unwrap())
}

fn accept_tx(env: &Env, who: &Account, offer_id: u64) -> CallTransaction {
    who.call(env.registry.id(), "accept_offer")
        .args_json(json!({"offer_id": offer_id}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
}

fn withdraw_pending_tx(env: &Env, who: &Account) -> CallTransaction {
    who.call(env.registry.id(), "withdraw_pending").deposit(ONE_YOCTO).gas(MAX_GAS)
}

async fn block_ms(env: &Env) -> Result<u64> {
    Ok(env.worker.view_block().await?.timestamp() / 1_000_000)
}

async fn advance_ms(env: &Env, ms: u64) -> Result<()> {
    let target = block_ms(env).await? + ms + 1;
    for _ in 0..200 {
        if block_ms(env).await? > target {
            return Ok(());
        }
        env.worker.fast_forward(ms / 1_000 + 20).await?;
    }
    Err(anyhow!("block time did not reach the target"))
}

fn order(label: &str, heights: &[(&str, Option<u64>)]) -> String {
    let parts: Vec<String> = heights
        .iter()
        .map(|(name, h)| format!("{name}={}", h.map_or("-".to_string(), |h| h.to_string())))
        .collect();
    format!("{label}: {}", parts.join(" "))
}

// ------------------------------------------------------------------- claim_dividends

/// A seller claims part of the retained earnings and an approved marketplace sells the company
/// with `nft_transfer_payout` in the same block. The claim's `ft_transfer` callback then runs while
/// the vault is in transit. The seller keeps only what it claimed before the sale; the buyer can
/// claim the rest and every payment after it.
#[tokio::test]
async fn test_claim_in_flight_when_a_marketplace_sale_lands() -> Result<()> {
    let env = setup().await?;
    let seller = env.funded("seller", 0).await?;
    let buyer = env.funded("buyer", 0).await?;
    let market = account(&env.root, "market", 10).await?;
    let customer = env.funded("customer", 40_000_000).await?;
    let claimed_part = 400_000u128;
    let mut holders = vec![
        seller.id().clone(), buyer.id().clone(), customer.id().clone(), env.founder.id().clone(),
        env.registry.id().clone(), env.payee.id().clone(), env.intents.id().clone(),
    ];

    let mut seen_in_transit = false;
    let mut log = Vec::new();
    for attempt in 0..ATTEMPTS {
        let (token_id, vault) = env.earning_company(&format!("payout-{attempt}"), &seller, &customer).await?;
        holders.push(vault.clone());
        approve(&env, &seller, &token_id, market.id()).await?;
        let seller_before = env.balance(seller.id()).await?;

        let claim = claim_tx(&seller, &vault, claimed_part).transact_async().await?;
        let sale = market
            .call(env.registry.id(), "nft_transfer_payout")
            .args_json(json!({"receiver_id": buyer.id(), "token_id": token_id, "balance": "10000000", "max_len_payout": 2}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact_async()
            .await?;
        let (claim, sale) = (env.settle(claim).await?, env.settle(sale).await?);

        // A dividend claim never blocks a sale: it does not dirty the keys.
        assert_ok(&sale);
        let payout: Value = sale.clone().json()?;
        assert_eq!(
            u128_of(&payout["payout"][seller.id().as_str()]),
            10_000_000 - 10_000_000 * ROYALTY_BPS / 10_000,
            "sale proceeds must name the seller"
        );

        let claim_at = env.entry_height(&claim, &vault).await?;
        let paid_at = env.receipt_height(&claim, &vault, "dividends_claimed").await?;
        let transit_at = env.receipt_height(&sale, &vault, "transit_begun").await?;
        let final_at = env.receipt_height(&sale, &vault, "encumbrance_applied").await?;
        log.push(order(&format!("attempt {attempt}"), &[
            ("claim", Some(claim_at)), ("claim_cb", paid_at), ("transit", transit_at), ("apply", final_at),
        ]));

        let seller_got = env.balance(seller.id()).await? - seller_before;
        if claim.failures().is_empty() {
            // The claim reached the vault first, while the seller was still shareholder.
            assert!(claim_at <= transit_at.unwrap(), "{log:?}");
            assert_eq!(seller_got, claimed_part);
            if let (Some(cb), Some(t), Some(f)) = (paid_at, transit_at, final_at) {
                if t < cb && cb < f {
                    seen_in_transit = true;
                }
            }
        } else {
            let text = failure_text(&claim);
            assert!(
                text.contains("ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN") || text.contains("ERR_ONLY_CURRENT_SHAREHOLDER"),
                "{text}"
            );
            assert_eq!(seller_got, 0);
        }

        let state = env.assert_settled(&token_id, &vault).await?;
        assert_eq!(state["shareholder"], buyer.id().as_str());
        assert_eq!(state["encumbrance"], "Free");
        assert_eq!(u128_of(&state["dividends_paid"]), seller_got);
        assert_eq!(u128_of(&state["retained_earnings"]), PAYMENT_RETAINED - seller_got);

        // Revenue after the sale is the buyer's, with what the seller left behind.
        assert_ok(&env.pay(&customer, &vault, PAYMENT, &format!("payout-{attempt}-after")).await?);
        let taken = env.assert_only_holder_can_claim(&vault, &buyer, &[&seller]).await?;
        assert_eq!(taken, 2 * PAYMENT_RETAINED - seller_got);
        let refs: Vec<&AccountId> = holders.iter().collect();
        env.assert_conserved(&refs).await?;
        if seen_in_transit {
            break;
        }
    }
    println!("{}", log.join("\n"));
    assert!(seen_in_transit, "no attempt ran the claim callback inside the sale's transit: {log:?}");
    Ok(())
}

/// The seller has no USDC registration, so its dividend transfer fails. The owner's own
/// `nft_transfer` lands between the claim and its callback. The callback credits the amount back to
/// `retained_earnings`, the ledger it came from, which the receiver now holds. The seller receives
/// nothing, and no USDC is lost. Unlike the registry, the vault keeps no per-account credit for a
/// failed dividend: the seller can only avoid this by keeping its USDC registration.
#[tokio::test]
async fn test_failed_claim_restores_to_the_company_after_an_owner_transfer() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 40_000_000).await?;
    let receiver = env.funded("receiver", 0).await?;
    let mut holders = vec![
        customer.id().clone(), receiver.id().clone(), env.founder.id().clone(),
        env.registry.id().clone(), env.payee.id().clone(), env.intents.id().clone(),
    ];

    let mut seen_between = false;
    let mut log = Vec::new();
    for attempt in 0..ATTEMPTS {
        let seller = account(&env.root, &format!("seller{attempt}"), 10).await?;
        holders.push(seller.id().clone());
        let (token_id, vault) = env.earning_company(&format!("restore-{attempt}"), &seller, &customer).await?;
        holders.push(vault.clone());

        let claim = claim_tx(&seller, &vault, PAYMENT_RETAINED).transact_async().await?;
        let gift = seller
            .call(env.registry.id(), "nft_transfer")
            .args_json(json!({"receiver_id": receiver.id(), "token_id": token_id}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact_async()
            .await?;
        let (claim, gift) = (env.settle(claim).await?, env.settle(gift).await?);
        assert_ok(&gift);

        let claim_at = env.entry_height(&claim, &vault).await?;
        let failed_at = env.receipt_height(&claim, &vault, "dividends_failed").await?;
        let synced_at = env.receipt_height(&gift, &vault, "owner_synced").await?;
        log.push(order(&format!("attempt {attempt}"), &[
            ("claim", Some(claim_at)), ("claim_cb", failed_at), ("sync_owner", synced_at),
        ]));

        if let Some(failed_at) = failed_at {
            assert_failed(&claim, "not registered");
            if claim_at < synced_at.unwrap() && synced_at.unwrap() < failed_at {
                seen_between = true;
            }
        } else {
            assert_failed(&claim, "ERR_ONLY_CURRENT_SHAREHOLDER");
        }

        let state = env.assert_settled(&token_id, &vault).await?;
        assert_eq!(state["shareholder"], receiver.id().as_str());
        assert_eq!(u128_of(&state["dividends_paid"]), 0);
        assert_eq!(u128_of(&state["retained_earnings"]), PAYMENT_RETAINED, "failed payout not credited back");
        assert_eq!(env.balance(seller.id()).await?, 0);
        assert!(logged(&gift, "owner_synced"));

        let taken = env.assert_only_holder_can_claim(&vault, &receiver, &[&seller]).await?;
        assert_eq!(taken, PAYMENT_RETAINED);
        let refs: Vec<&AccountId> = holders.iter().collect();
        env.assert_conserved(&refs).await?;
        if seen_between {
            break;
        }
    }
    println!("{}", log.join("\n"));
    assert!(seen_between, "no attempt landed the transfer between the claim and its callback: {log:?}");
    Ok(())
}

/// A seller claims and lists in the same block. The vault has no in-flight counter, so the freeze
/// can land while the dividend transfer is still out. That is safe: the claim debited
/// `retained_earnings` before the freeze, so the listing shows the company without the claimed
/// amount, and a failed transfer only adds back, into the company the buyer is acquiring.
///
/// The buyer's acquire is broadcast the moment the listing is active, while the claim may still be
/// in flight. Its `begin_transit` is at least two receipts after the registry activates the
/// listing, so on one shard the claim callback has so far resolved first; that is receipt timing,
/// not a contract check, and the test does not rely on it. Every balance and ledger assertion
/// below holds for either order, and the order seen is printed.
#[tokio::test]
async fn test_listing_with_a_claim_in_flight_is_safe_for_the_buyer() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 40_000_000).await?;
    let buyer = env.funded("buyer", 100_000_000).await?;
    let ask = 5_000_000u128;
    let mut holders = vec![
        customer.id().clone(), buyer.id().clone(), env.founder.id().clone(),
        env.registry.id().clone(), env.payee.id().clone(), env.intents.id().clone(),
    ];

    let mut log = Vec::new();
    // Registered seller (the claim pays) and unregistered seller (the claim fails and is restored
    // while the company is listed).
    for (variant, seller_registered) in [("pays", true), ("fails", false)] {
        let mut seen_frozen_in_flight = false;
        for attempt in 0..ATTEMPTS {
            let name = format!("{variant}{attempt}");
            let seller = if seller_registered {
                env.funded(&format!("s{name}"), 0).await?
            } else {
                account(&env.root, &format!("s{name}"), 10).await?
            };
            holders.push(seller.id().clone());
            let (token_id, vault) = env.earning_company(&format!("list-{name}"), &seller, &customer).await?;
            holders.push(vault.clone());

            let claim = claim_tx(&seller, &vault, PAYMENT_RETAINED).transact_async().await?;
            let listing = list_tx(&env.registry, &seller, &token_id, ask).transact_async().await?;
            let listing = env.settle(listing).await?;
            // The listing is never refused because of the claim.
            assert_ok(&listing);
            let listed = env.company_view(&token_id).await?;
            assert!(listed["encumbrance"]["Listed"].is_object(), "{listed}");
            // The buyer acquires as early as the registry allows, without waiting for the claim.
            let acquire = env
                .ft_call_tx(&buyer, env.registry.id(), ask, env.acquire_msg(&token_id).await?)
                .transact_async()
                .await?;
            let claim = env.settle(claim).await?;
            let acquired = env.settle(acquire).await?;

            let claim_at = env.entry_height(&claim, &vault).await?;
            let claim_cb = match env.receipt_height(&claim, &vault, "dividends_claimed").await? {
                Some(h) => Some(h),
                None => env.receipt_height(&claim, &vault, "dividends_failed").await?,
            };
            let frozen_at = env.receipt_height(&listing, &vault, "encumbrance_applied").await?;

            let claimed = if claim_cb.is_some() {
                if seller_registered {
                    assert_ok(&claim);
                    PAYMENT_RETAINED
                } else {
                    assert_failed(&claim, "not registered");
                    0
                }
            } else {
                // The freeze reached the vault first.
                assert_failed(&claim, "ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN");
                0
            };
            if let (Some(cb), Some(f)) = (claim_cb, frozen_at) {
                if claim_at < f && f < cb {
                    seen_frozen_in_flight = true;
                }
            }

            assert_ok_but_unregistered_payouts(&acquired);
            assert!(logged(&acquired, "company_acquired"), "{:?}", acquired.logs());
            let transit_at = env.receipt_height(&acquired, &vault, "transit_begun").await?.expect("no transit");
            let claim_cb_in_transit = claim_cb.map_or(false, |cb| cb >= transit_at);
            log.push(order(&format!("{variant} {attempt}{}", if claim_cb_in_transit { " (claim callback at or after transit)" } else { "" }), &[
                ("claim", Some(claim_at)), ("claim_cb", claim_cb), ("freeze", frozen_at), ("acquire_transit", Some(transit_at)),
            ]));

            let state = env.assert_settled(&token_id, &vault).await?;
            assert_eq!(state["shareholder"], buyer.id().as_str());
            assert_eq!(u128_of(&state["dividends_paid"]), claimed);
            let taken = env.assert_only_holder_can_claim(&vault, &buyer, &[&seller]).await?;
            assert_eq!(taken, PAYMENT_RETAINED - claimed);
            let proceeds = ask - ask * ROYALTY_BPS / 10_000;
            if seller_registered {
                assert_eq!(env.balance(seller.id()).await?, claimed + proceeds);
            } else {
                assert_eq!(env.pending(seller.id()).await?, proceeds);
            }
            let refs: Vec<&AccountId> = holders.iter().collect();
            env.assert_conserved(&refs).await?;
            if seen_frozen_in_flight {
                break;
            }
        }
        assert!(seen_frozen_in_flight, "{variant}: the freeze never landed with the claim in flight: {log:?}");
    }
    println!("{}", log.join("\n"));
    Ok(())
}

/// A borrower claims dividends and accepts a loan in the same block. The lender's terms name the
/// retained earnings it priced. The claim debits before the freeze lands, so the pledge is refused
/// with ERR_PLEDGE_TERMS_NOT_MET and the principal stays in the offer; if the freeze lands first,
/// the claim is refused. The lender never lends against less than its terms, and the borrower
/// never holds both the dividend and the principal. The test retries on a fresh company until the
/// freeze reaches the vault between the claim and the claim's callback, and fails if it never does.
#[tokio::test]
async fn test_pledge_with_a_claim_in_flight_honours_lender_terms() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 40_000_000).await?;
    let lender = env.funded("lender", 50_000_000).await?;
    let principal = 3_000_000u128;
    let mut holders = vec![
        customer.id().clone(), lender.id().clone(), env.founder.id().clone(),
        env.registry.id().clone(), env.payee.id().clone(), env.intents.id().clone(),
    ];

    let mut seen_refused = false;
    let mut log = Vec::new();
    for attempt in 0..ATTEMPTS {
        let borrower = env.funded(&format!("borrower{attempt}"), 0).await?;
        holders.push(borrower.id().clone());
        let (token_id, vault) = env.earning_company(&format!("pledge-{attempt}"), &borrower, &customer).await?;
        holders.push(vault.clone());
        let terms = json!({"min_retained": PAYMENT_RETAINED.to_string(), "required_epoch": null});
        let offer = fund_offer(&env, &lender, &token_id, principal, principal + 500_000, 3_600_000, Some(terms)).await?;
        let lender_before = env.balance(lender.id()).await?;

        let claim = claim_tx(&borrower, &vault, 300_000).transact_async().await?;
        let accept = accept_tx(&env, &borrower, offer).transact_async().await?;
        let (claim, accept) = (env.settle(claim).await?, env.settle(accept).await?);
        let claim_at = env.entry_height(&claim, &vault).await?;
        let claim_cb = env.receipt_height(&claim, &vault, "dividends_claimed").await?;
        let freeze_at = env.first_height_on(&accept, &vault).await?;
        // The case under test: the freeze reaches the vault after the claim debited and before the
        // claim's callback, so the dividend transfer is still out when the pledge is checked.
        let in_flight = matches!((claim_cb, freeze_at), (Some(cb), Some(f)) if claim_at < f && f < cb);
        log.push(order(&format!("attempt {attempt}{}", if in_flight { " (claim in flight at the freeze)" } else { "" }), &[
            ("claim", Some(claim_at)), ("freeze", freeze_at), ("claim_cb", claim_cb),
        ]));

        let state = env.assert_settled(&token_id, &vault).await?;
        if claim.failures().is_empty() {
            assert_failed(&accept, "ERR_VAULT_FREEZE_FAILED");
            assert!(logged(&accept, "pledge_failed"));
            assert_eq!(state["encumbrance"], "Free");
            assert_eq!(u128_of(&state["retained_earnings"]), PAYMENT_RETAINED - 300_000);
            assert_eq!(env.balance(borrower.id()).await?, 300_000, "borrower got the principal too");
            let offers: Vec<Value> = env.registry.view("get_offers").args_json(json!({"token_id": token_id})).await?.json()?;
            assert_eq!(offers.len(), 1);
            assert_eq!(offers[0]["settling"], false, "offer still locked after a refused pledge");
            assert_eq!(u128_of(&offers[0]["principal"]), principal);
            assert!(logged(&accept, "ERR_PLEDGE_TERMS_NOT_MET") || failure_text(&accept).contains("ERR_PLEDGE_TERMS_NOT_MET"));
            seen_refused = in_flight;
        } else {
            assert_failed(&claim, "ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN");
            assert_ok(&accept);
            assert!(state["encumbrance"]["Pledged"].is_object(), "{state}");
            assert_eq!(u128_of(&state["retained_earnings"]), PAYMENT_RETAINED);
            assert_eq!(env.balance(borrower.id()).await?, principal);
        }
        assert_eq!(env.balance(lender.id()).await?, lender_before);
        let refs: Vec<&AccountId> = holders.iter().collect();
        env.assert_conserved(&refs).await?;
        if seen_refused {
            break;
        }
    }
    println!("{}", log.join("\n"));
    assert!(seen_refused, "no attempt landed the freeze between the claim and its callback: {log:?}");
    Ok(())
}

// ------------------------------------------------------------------- revenue during a sale

/// A customer payment that arrives after the listing, or while the acquire is settling, is booked
/// to the company as unrelated revenue and accrues to the buyer. The seller cannot claim it while
/// listed or in transit, and has no rights after the sale.
#[tokio::test]
async fn test_customer_payment_mid_sale_is_booked_to_the_company_for_the_buyer() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 40_000_000).await?;
    let seller = env.funded("seller", 0).await?;
    let buyer = env.funded("buyer", 100_000_000).await?;
    let ask = 5_000_000u128;
    let mut holders = vec![
        customer.id().clone(), seller.id().clone(), buyer.id().clone(), env.founder.id().clone(),
        env.registry.id().clone(), env.payee.id().clone(), env.intents.id().clone(),
    ];

    // Listed: the payment is booked, and the seller cannot reach it.
    let (token_id, vault) = env.earning_company("listed-pay", &seller, &customer).await?;
    holders.push(vault.clone());
    assert_ok(&env.list(&seller, &token_id, ask).await?);
    let read = env.acquire_msg(&token_id).await?;
    assert_ok(&env.pay(&customer, &vault, PAYMENT, "listed-pay-mid").await?);
    assert_failed(&env.claim(&seller, &vault, 1).await?, "ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN");
    let state = env.vault_state(&vault).await?;
    assert_eq!(u128_of(&state["gross_revenue"]), 2 * PAYMENT);
    assert_eq!(u128_of(&state["related_party_revenue"]), 0);
    // A payment does not move the sync nonce, so the buyer's read still names the listing.
    assert_ok(&env.ft_call(&buyer, env.registry.id(), ask, read).await?);
    assert_eq!(env.owner_of(&token_id).await?, buyer.id().as_str());
    env.assert_settled(&token_id, &vault).await?;
    assert_eq!(env.assert_only_holder_can_claim(&vault, &buyer, &[&seller]).await?, 2 * PAYMENT_RETAINED);

    // In flight: the payment is sent one block after the acquire, aiming at the transit window.
    let mut seen_in_transit = false;
    let mut log = Vec::new();
    for attempt in 0..ATTEMPTS {
        let (token_id, vault) = env.earning_company(&format!("transit-pay-{attempt}"), &seller, &customer).await?;
        holders.push(vault.clone());
        assert_ok(&env.list(&seller, &token_id, ask).await?);
        let msg = env.acquire_msg(&token_id).await?;
        let buyer_before = env.balance(buyer.id()).await?;
        let acquire = env.ft_call_tx(&buyer, env.registry.id(), ask, msg).transact_async().await?;
        // Blocks to wait before paying, the expected transit window first.
        env.wait_blocks([2, 3, 1, 4][attempt]).await?;
        let payment = env
            .ft_call_tx(&customer, &vault, PAYMENT, json!({"call_id": format!("transit-pay-{attempt}-mid")}).to_string())
            .transact_async()
            .await?;
        let (acquire, payment) = (env.settle(acquire).await?, env.settle(payment).await?);
        assert_ok(&acquire);
        assert_ok(&payment);

        let paid_at = env.receipt_height(&payment, &vault, "payment_received").await?;
        let transit_at = env.receipt_height(&acquire, &vault, "transit_begun").await?;
        let final_at = env.receipt_height(&acquire, &vault, "encumbrance_applied").await?;
        log.push(order(&format!("attempt {attempt}"), &[("payment", paid_at), ("transit", transit_at), ("apply", final_at)]));
        if let (Some(p), Some(t), Some(f)) = (paid_at, transit_at, final_at) {
            if t < p && p < f {
                seen_in_transit = true;
            }
        }

        let state = env.assert_settled(&token_id, &vault).await?;
        assert_eq!(state["shareholder"], buyer.id().as_str());
        assert_eq!(u128_of(&state["gross_revenue"]), 2 * PAYMENT, "mid-sale payment not booked as revenue");
        assert_eq!(env.balance(buyer.id()).await?, buyer_before - ask);
        assert_eq!(env.assert_only_holder_can_claim(&vault, &buyer, &[&seller]).await?, 2 * PAYMENT_RETAINED);
        let refs: Vec<&AccountId> = holders.iter().collect();
        env.assert_conserved(&refs).await?;
        if seen_in_transit {
            break;
        }
    }
    println!("{}", log.join("\n"));
    assert!(seen_in_transit, "no payment landed inside the acquire's transit: {log:?}");
    Ok(())
}

// ------------------------------------------------------------------- pay_compute_bill

/// The charter operator pays a compute bill while the company is listed and a buyer's acquire is
/// settling. The payee cannot accept USDC, so the transfer fails and the callback credits
/// `compute_reserve`, which belongs to the company and so to the buyer. A seller-chosen operator
/// cannot spend the reserve while listed.
#[tokio::test]
async fn test_failed_compute_bill_during_a_sale_restores_the_reserve() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 40_000_000).await?;
    let seller = env.funded("seller", 0).await?;
    let buyer = env.funded("buyer", 100_000_000).await?;
    let seller_op = account(&env.root, "sellerop", 10).await?;
    let ask = 5_000_000u128;
    env.unregister(&env.payee).await?;
    let mut holders = vec![
        customer.id().clone(), seller.id().clone(), buyer.id().clone(), env.founder.id().clone(),
        env.registry.id().clone(), env.payee.id().clone(), env.intents.id().clone(),
    ];

    let mut seen_in_transit = false;
    let mut log = Vec::new();
    for attempt in 0..ATTEMPTS {
        let (token_id, vault) = env.earning_company(&format!("compute-{attempt}"), &seller, &customer).await?;
        holders.push(vault.clone());
        assert_ok(
            &seller.call(&vault, "set_operator").args_json(json!({"account": seller_op.id()})).deposit(ONE_YOCTO).transact().await?,
        );
        assert_ok(&env.list(&seller, &token_id, ask).await?);
        let bill = seller_op.call(&vault, "pay_compute_bill").args_json(json!({"amount": "100000"})).gas(MAX_GAS).transact().await?;
        assert_failed(&bill, "ERR_ONLY_TEE_TREASURY_AGENT");

        let msg = env.acquire_msg(&token_id).await?;
        let acquire = env.ft_call_tx(&buyer, env.registry.id(), ask, msg).transact_async().await?;
        env.wait_blocks([1, 2, 0, 3][attempt]).await?;
        let bill = env
            .operator
            .call(&vault, "pay_compute_bill")
            .args_json(json!({"amount": PAYMENT_RESERVE.to_string()}))
            .gas(MAX_GAS)
            .transact_async()
            .await?;
        let (acquire, bill) = (env.settle(acquire).await?, env.settle(bill).await?);
        assert_ok(&acquire);
        assert_failed(&bill, "not registered");

        let debit_at = env.entry_height(&bill, &vault).await?;
        let restore_at = env.receipt_height(&bill, &vault, "compute_bill_failed").await?;
        let transit_at = env.receipt_height(&acquire, &vault, "transit_begun").await?;
        let final_at = env.receipt_height(&acquire, &vault, "encumbrance_applied").await?;
        log.push(order(&format!("attempt {attempt}"), &[
            ("bill", Some(debit_at)), ("bill_cb", restore_at), ("transit", transit_at), ("apply", final_at),
        ]));
        if let (Some(r), Some(t), Some(f)) = (restore_at, transit_at, final_at) {
            if debit_at < f && t < r {
                seen_in_transit = true;
            }
        }

        let state = env.assert_settled(&token_id, &vault).await?;
        assert_eq!(state["shareholder"], buyer.id().as_str());
        assert_eq!(u128_of(&state["compute_reserve"]), PAYMENT_RESERVE, "failed bill not credited back");
        assert_eq!(u128_of(&state["compute_paid"]), 0);
        assert_eq!(state["policy"]["operator"], env.operator.id().as_str(), "buyer inherited the seller's operator");
        assert_eq!(env.balance(env.payee.id()).await?, 0);
        assert_eq!(env.assert_only_holder_can_claim(&vault, &buyer, &[&seller]).await?, PAYMENT_RETAINED);
        let refs: Vec<&AccountId> = holders.iter().collect();
        env.assert_conserved(&refs).await?;
        if seen_in_transit {
            break;
        }
    }
    println!("{}", log.join("\n"));
    assert!(seen_in_transit, "no bill callback landed after the sale reached the vault: {log:?}");
    Ok(())
}

// ------------------------------------------------------------------- agent_deposit_to_intents

/// The operator deposits retained earnings to the intents contract and the owner transfers the
/// company in the same block. The deposit's resolve chain is four receipts long, so it finishes
/// after the new shareholder is set. A refused deposit credits `retained_earnings` back for the
/// receiver; an accepted one sits in the vault's own intents balance, which the sender cannot reach.
#[tokio::test]
async fn test_intents_deposit_in_flight_when_an_owner_transfer_lands() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 40_000_000).await?;
    let receiver = env.funded("receiver", 0).await?;
    let amount = 500_000u128;
    let mut holders = vec![
        customer.id().clone(), receiver.id().clone(), env.founder.id().clone(),
        env.registry.id().clone(), env.payee.id().clone(), env.intents.id().clone(),
    ];

    let mut log = Vec::new();
    for (variant, reject) in [("refused", true), ("accepted", false)] {
        assert_ok(&env.intents.call("set_reject_deposits").args_json(json!({"reject": reject})).transact().await?);
        let mut seen_after_sync = false;
        for attempt in 0..ATTEMPTS {
            let seller = env.funded(&format!("s{variant}{attempt}"), 0).await?;
            holders.push(seller.id().clone());
            let (token_id, vault) = env.earning_company(&format!("deposit-{variant}-{attempt}"), &seller, &customer).await?;
            holders.push(vault.clone());

            let deposit = env
                .operator
                .call(&vault, "agent_deposit_to_intents")
                .args_json(json!({"amount": amount.to_string()}))
                .gas(MAX_GAS)
                .transact_async()
                .await?;
            let gift = seller
                .call(env.registry.id(), "nft_transfer")
                .args_json(json!({"receiver_id": receiver.id(), "token_id": token_id}))
                .deposit(ONE_YOCTO)
                .gas(MAX_GAS)
                .transact_async()
                .await?;
            let (deposit, gift) = (env.settle(deposit).await?, env.settle(gift).await?);
            assert_ok(&gift);

            let state = env.assert_settled(&token_id, &vault).await?;
            assert_eq!(state["shareholder"], receiver.id().as_str());
            // The operator here is the charter operator, which a change of shareholder keeps, and
            // an owner transfer never leaves the vault frozen, so the deposit runs in either order.
            assert_ok(&deposit);
            let debit_at = env.entry_height(&deposit, &vault).await?;
            let resolved_at = env.receipt_height(&deposit, &vault, "intents_deposit").await?;
            let synced_at = env.receipt_height(&gift, &vault, "owner_synced").await?;
            log.push(order(&format!("{variant} {attempt}"), &[
                ("deposit", Some(debit_at)), ("deposit_cb", resolved_at), ("sync_owner", synced_at),
            ]));
            if let (Some(r), Some(s)) = (resolved_at, synced_at) {
                if debit_at < s && s < r {
                    seen_after_sync = true;
                }
            }
            let used = if reject { 0 } else { amount };
            assert_eq!(u128_of(&state["deposited_to_intents"]), used);
            assert_eq!(u128_of(&state["retained_earnings"]), PAYMENT_RETAINED - used, "refused deposit not credited back");
            let on_intents: Value = env
                .intents
                .view("mt_balance_of")
                .args_json(json!({"account_id": vault, "token_id": format!("nep141:{}", env.usdc.id())}))
                .await?
                .json()?;
            assert_eq!(u128_of(&on_intents), used, "deposit not credited to the vault's own intents account");
            assert_eq!(env.balance(seller.id()).await?, 0);
            assert_eq!(env.assert_only_holder_can_claim(&vault, &receiver, &[&seller]).await?, PAYMENT_RETAINED - used);
            let refs: Vec<&AccountId> = holders.iter().collect();
            env.assert_conserved(&refs).await?;
            if seen_after_sync {
                break;
            }
        }
        assert!(seen_after_sync, "{variant}: the deposit never resolved after the transfer: {log:?}");
    }
    println!("{}", log.join("\n"));
    Ok(())
}

// ------------------------------------------------------------------- acquire payouts and refunds

/// Two buyers send an acquire for the same listing in the same block, one of them overpaying.
/// Exactly one buys. The other is refunded in full, the winner gets its excess back, the seller and
/// founder are paid once, and the registry ends holding nothing.
#[tokio::test]
async fn test_concurrent_acquires_settle_once_and_refund_the_rest() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 10_000_000).await?;
    let seller = env.funded("seller", 0).await?;
    let first = env.funded("first", 50_000_000).await?;
    let second = env.funded("second", 50_000_000).await?;
    let ask = 10_000_000u128;
    let (token_id, vault) = env.earning_company("double", &seller, &customer).await?;
    assert_ok(&env.list(&seller, &token_id, ask).await?);
    let founder_before = env.balance(env.founder.id()).await?;

    let msg = env.acquire_msg(&token_id).await?;
    let a = env.ft_call_tx(&first, env.registry.id(), ask + 2_000_000, msg.clone()).transact_async().await?;
    let b = env.ft_call_tx(&second, env.registry.id(), ask, msg).transact_async().await?;
    let (a, b) = (env.settle(a).await?, env.settle(b).await?);
    assert_ok(&a);
    assert_ok(&b);

    let owner = env.owner_of(&token_id).await?;
    let (winner, loser, loser_out) = if owner == first.id().as_str() {
        (&first, &second, &b)
    } else {
        assert_eq!(owner, second.id().as_str());
        (&second, &first, &a)
    };
    let refused = ["ERR_TOKEN_SETTLING", "ERR_TOKEN_NOT_LISTED", "ERR_LISTING_CHANGED"];
    assert!(refused.iter().any(|r| logged(loser_out, r)), "loser not refused: {:?}", loser_out.logs());
    assert_eq!(env.balance(winner.id()).await?, 50_000_000 - ask);
    assert_eq!(env.balance(loser.id()).await?, 50_000_000);
    let royalty = ask * ROYALTY_BPS / 10_000;
    assert_eq!(env.balance(seller.id()).await?, ask - royalty);
    assert_eq!(env.balance(env.founder.id()).await? - founder_before, royalty);
    assert_eq!(env.balance(env.registry.id()).await?, 0);
    let state = env.assert_settled(&token_id, &vault).await?;
    assert_eq!(state["shareholder"], winner.id().as_str());
    assert_eq!(env.assert_only_holder_can_claim(&vault, winner, &[&seller, loser]).await?, PAYMENT_RETAINED);
    env.assert_conserved(&[
        customer.id(), seller.id(), first.id(), second.id(), env.founder.id(), env.registry.id(),
        env.payee.id(), env.intents.id(), &vault,
    ])
    .await?;
    Ok(())
}

/// A seller without a USDC registration sells. Its proceeds transfer fails and is credited to
/// `pending_withdrawals` under the seller's account. The buyer resells at once. The
/// second sale pays the first buyer and leaves the first seller's credit untouched. Two
/// concurrent withdrawals pay the credit once.
#[tokio::test]
async fn test_failed_sale_payouts_stay_with_the_seller_through_a_resale() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 10_000_000).await?;
    let seller = account(&env.root, "seller", 10).await?;
    let buyer = env.funded("buyer", 50_000_000).await?;
    let next = env.funded("next", 50_000_000).await?;
    let (token_id, vault) = env.earning_company("resale", &seller, &customer).await?;
    let first_ask = 10_000_000u128;
    let second_ask = 12_000_000u128;
    let royalty = |ask: u128| ask * ROYALTY_BPS / 10_000;
    let founder_before = env.balance(env.founder.id()).await?;

    assert_ok(&env.list(&seller, &token_id, first_ask).await?);
    let sale = env.ft_call(&buyer, env.registry.id(), first_ask, env.acquire_msg(&token_id).await?).await?;
    assert_failed(&sale, "not registered");
    assert!(logged(&sale, "payout_pending"));
    assert_eq!(env.pending(seller.id()).await?, first_ask - royalty(first_ask));
    assert_eq!(env.balance(env.registry.id()).await?, first_ask - royalty(first_ask));
    env.assert_settled(&token_id, &vault).await?;

    // The buyer relists and sells before the first seller collects.
    assert_ok(&env.list(&buyer, &token_id, second_ask).await?);
    assert_ok(&env.ft_call(&next, env.registry.id(), second_ask, env.acquire_msg(&token_id).await?).await?);
    assert_eq!(env.balance(buyer.id()).await?, 50_000_000 - first_ask + second_ask - royalty(second_ask));
    assert_eq!(env.pending(buyer.id()).await?, 0);
    assert_eq!(env.pending(seller.id()).await?, first_ask - royalty(first_ask), "resale touched the seller's credit");
    assert_eq!(env.balance(env.founder.id()).await? - founder_before, royalty(first_ask) + royalty(second_ask));
    let state = env.assert_settled(&token_id, &vault).await?;
    assert_eq!(state["shareholder"], next.id().as_str());
    assert_eq!(env.assert_only_holder_can_claim(&vault, &next, &[&seller, &buyer]).await?, PAYMENT_RETAINED);

    // Two withdrawals in flight together pay once.
    env.register(seller.id()).await?;
    let w1 = withdraw_pending_tx(&env, &seller).transact_async().await?;
    let w2 = withdraw_pending_tx(&env, &seller).transact_async().await?;
    let (w1, w2) = (env.settle(w1).await?, env.settle(w2).await?);
    let paid = [&w1, &w2].iter().filter(|o| o.failures().is_empty()).count();
    assert_eq!(paid, 1, "{} / {}", failure_text(&w1), failure_text(&w2));
    let loser = if w1.failures().is_empty() { &w2 } else { &w1 };
    assert_failed(loser, "ERR_NOTHING_PENDING");
    assert_eq!(env.balance(seller.id()).await?, first_ask - royalty(first_ask));
    assert_eq!(env.pending(seller.id()).await?, 0);
    assert_eq!(env.balance(env.registry.id()).await?, 0);
    env.assert_conserved(&[
        customer.id(), seller.id(), buyer.id(), next.id(), env.founder.id(), env.registry.id(),
        env.payee.id(), env.intents.id(), &vault,
    ])
    .await?;
    Ok(())
}

// ------------------------------------------------------------------- credit desk payouts

/// The borrower has no USDC registration, so the loan principal payout fails into
/// `pending_withdrawals`. A third party sends the repayment right behind the accept, and it can
/// reach the registry while the principal transfer is still in flight. The lender has also
/// unregistered, so the repayment payout fails into its own credit. The borrower then sells the
/// company. Every credit stays with the account it was owed to, and the buyer gets only the
/// company.
#[tokio::test]
async fn test_principal_and_repayment_payouts_through_a_repay_and_a_sale() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 10_000_000).await?;
    let payer = env.funded("payer", 50_000_000).await?;
    let buyer = env.funded("buyer", 50_000_000).await?;
    let principal = 4_000_000u128;
    let debt = 4_400_000u128;
    let ask = 9_000_000u128;
    let mut holders = vec![
        customer.id().clone(), payer.id().clone(), buyer.id().clone(), env.founder.id().clone(),
        env.registry.id().clone(), env.payee.id().clone(), env.intents.id().clone(),
    ];

    let mut seen_repay_in_flight = false;
    let mut log = Vec::new();
    for attempt in 0..ATTEMPTS {
        let borrower = account(&env.root, &format!("borrower{attempt}"), 10).await?;
        let lender = env.funded(&format!("lender{attempt}"), principal).await?;
        holders.push(borrower.id().clone());
        holders.push(lender.id().clone());
        let (token_id, vault) = env.earning_company(&format!("loan-{attempt}"), &borrower, &customer).await?;
        holders.push(vault.clone());
        let offer = fund_offer(&env, &lender, &token_id, principal, debt, 3_600_000, None).await?;
        env.unregister(&lender).await?;
        let payer_before = env.balance(payer.id()).await?;

        let accept = accept_tx(&env, &borrower, offer).transact_async().await?;
        env.wait_blocks([2, 3, 1, 4][attempt]).await?;
        let repay = env
            .ft_call_tx(&payer, env.registry.id(), debt, json!({"action": "repay", "token_id": token_id}).to_string())
            .transact_async()
            .await?;
        let (accept, repay) = (env.settle(accept).await?, env.settle(repay).await?);
        assert!(logged(&accept, "loan_opened"), "{:?}", accept.logs());
        assert_failed(&accept, "not registered");
        assert_eq!(env.pending(borrower.id()).await?, principal);

        let opened_at = env.receipt_height(&accept, env.registry.id(), "loan_opened").await?.unwrap();
        let principal_cb = env.receipt_height(&accept, env.registry.id(), "payout_pending").await?.unwrap();
        let repay_at = env.first_height_on(&repay, env.registry.id()).await?.unwrap();
        log.push(order(&format!("attempt {attempt}"), &[
            ("loan_opened", Some(opened_at)), ("repay_at_registry", Some(repay_at)), ("principal_cb", Some(principal_cb)),
        ]));

        if logged(&repay, "loan_repaid") {
            if opened_at < repay_at && repay_at <= principal_cb {
                seen_repay_in_flight = true;
            }
            assert_failed(&repay, "not registered");
            assert_eq!(env.balance(payer.id()).await?, payer_before - debt);
            assert_eq!(env.pending(lender.id()).await?, debt);
        } else {
            // Reached the registry before the loan existed or while it was settling: refunded.
            assert!(
                ["ERR_NO_LOAN", "ERR_TOKEN_SETTLING"].iter().any(|r| logged(&repay, r)),
                "{:?}",
                repay.logs()
            );
            assert_eq!(env.balance(payer.id()).await?, payer_before);
            let again = env
                .ft_call(&payer, env.registry.id(), debt, json!({"action": "repay", "token_id": token_id}).to_string())
                .await?;
            assert!(logged(&again, "loan_repaid"));
            assert_eq!(env.pending(lender.id()).await?, debt);
        }
        let state = env.assert_settled(&token_id, &vault).await?;
        assert_eq!(state["encumbrance"], "Free");
        assert_eq!(state["shareholder"], borrower.id().as_str());

        // The borrower sells. Proceeds fail into its own credit as well.
        assert_ok(&env.list(&borrower, &token_id, ask).await?);
        let sold = env.ft_call(&buyer, env.registry.id(), ask, env.acquire_msg(&token_id).await?).await?;
        assert_ok_but_unregistered_payouts(&sold);
        assert!(logged(&sold, "company_acquired"), "{:?}", sold.logs());
        assert_eq!(env.pending(borrower.id()).await?, principal + ask - ask * ROYALTY_BPS / 10_000);
        assert_eq!(env.pending(lender.id()).await?, debt);
        assert_eq!(env.pending(buyer.id()).await?, 0);
        let state = env.assert_settled(&token_id, &vault).await?;
        assert_eq!(state["shareholder"], buyer.id().as_str());
        assert_eq!(env.assert_only_holder_can_claim(&vault, &buyer, &[&borrower]).await?, PAYMENT_RETAINED);

        // Each account collects exactly its own credit.
        for (who, owed) in [(&borrower, principal + ask - ask * ROYALTY_BPS / 10_000), (&lender, debt)] {
            env.register(who.id()).await?;
            assert_ok(&withdraw_pending_tx(&env, who).transact().await?);
            assert_eq!(env.balance(who.id()).await?, owed);
            assert_eq!(env.pending(who.id()).await?, 0);
        }
        assert_eq!(env.balance(env.registry.id()).await?, 0);
        let refs: Vec<&AccountId> = holders.iter().collect();
        env.assert_conserved(&refs).await?;
        if seen_repay_in_flight {
            break;
        }
    }
    println!("{}", log.join("\n"));
    assert!(seen_repay_in_flight, "the repayment never landed while the principal payout was out: {log:?}");
    Ok(())
}

/// Revenue that arrives while a company is pledged stays in the company. After a default the
/// winning bid pays the lender up to the debt, the founder's royalty on the remainder, and the
/// borrower the rest; the borrower has no USDC registration, so its share is credited to
/// `pending_withdrawals`. A dividend claim the borrower sends with the bid is refused. The bidder
/// can claim all retained earnings, including the pledge-period revenue.
#[tokio::test]
async fn test_auction_proceeds_and_pledge_period_revenue_reach_the_right_accounts() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 10_000_000).await?;
    let lender = env.funded("lender", 20_000_000).await?;
    let bidder = env.funded("bidder", 50_000_000).await?;
    let borrower = account(&env.root, "borrower", 10).await?;
    let principal = 5_000_000u128;
    let debt = 6_000_000u128;
    let (token_id, vault) = env.earning_company("auction", &borrower, &customer).await?;
    let offer = fund_offer(&env, &lender, &token_id, principal, debt, 1_000, None).await?;
    let accept = accept_tx(&env, &borrower, offer).transact().await?;
    assert!(logged(&accept, "loan_opened"));
    assert_eq!(env.pending(borrower.id()).await?, principal);
    assert_ok(&env.pay(&customer, &vault, PAYMENT, "auction-pledged").await?);
    assert_failed(&env.claim(&borrower, &vault, 1).await?, "ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN");

    advance_ms(&env, 2_000).await?;
    assert_ok(&env.operator.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?);
    let price: Value = env.registry.view("auction_price").args_json(json!({"token_id": token_id})).await?.json()?;
    let quoted = u128_of(&price);
    let founder_before = env.balance(env.founder.id()).await?;
    let lender_before = env.balance(lender.id()).await?;
    let bidder_before = env.balance(bidder.id()).await?;

    let bid = env
        .ft_call_tx(&bidder, env.registry.id(), quoted, json!({"action": "bid", "token_id": token_id}).to_string())
        .transact_async()
        .await?;
    let claim = claim_tx(&borrower, &vault, 1).transact_async().await?;
    let (bid, claim) = (env.settle(bid).await?, env.settle(claim).await?);
    let claim_text = failure_text(&claim);
    assert!(
        claim_text.contains("ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN") || claim_text.contains("ERR_ONLY_CURRENT_SHAREHOLDER"),
        "{claim_text}"
    );
    assert!(logged(&bid, "auction_settled"), "{:?}", bid.logs());
    let price = auction_price_paid(&bid)?;
    assert!(price <= quoted);
    let to_lender = price.min(debt);
    let remainder = price - to_lender;
    let royalty = remainder * ROYALTY_BPS / 10_000;

    assert_eq!(env.balance(bidder.id()).await?, bidder_before - price, "bidder excess not refunded");
    assert_eq!(env.balance(lender.id()).await? - lender_before, to_lender);
    assert_eq!(env.balance(env.founder.id()).await? - founder_before, royalty);
    assert_eq!(env.pending(borrower.id()).await?, principal + remainder - royalty);
    let state = env.assert_settled(&token_id, &vault).await?;
    assert_eq!(state["shareholder"], bidder.id().as_str());
    assert_eq!(state["encumbrance"], "Free");
    assert_eq!(env.assert_only_holder_can_claim(&vault, &bidder, &[&borrower]).await?, 2 * PAYMENT_RETAINED);
    assert_eq!(env.balance(env.registry.id()).await?, principal + remainder - royalty);
    env.assert_conserved(&[
        customer.id(), lender.id(), bidder.id(), borrower.id(), env.founder.id(), env.registry.id(),
        env.payee.id(), env.intents.id(), &vault,
    ])
    .await?;
    Ok(())
}

/// A lender cancels an offer while the borrower accepts it: first in the same block, then one
/// block later so the cancel reaches the registry while the accept's freeze is in flight. The
/// principal leaves the registry once, either back to the lender or out to the borrower, never
/// both, and an offer that is settling cannot be cancelled.
#[tokio::test]
async fn test_cancel_racing_accept_pays_the_principal_once() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 10_000_000).await?;
    let principal = 3_000_000u128;
    let mut holders = vec![
        customer.id().clone(), env.founder.id().clone(), env.registry.id().clone(),
        env.payee.id().clone(), env.intents.id().clone(),
    ];

    let mut log = Vec::new();
    let mut seen_settling = false;
    for (round, delay) in [0u64, 1, 2].into_iter().enumerate() {
        let borrower = env.funded(&format!("borrower{round}"), 0).await?;
        let lender = env.funded(&format!("lender{round}"), principal).await?;
        holders.push(borrower.id().clone());
        holders.push(lender.id().clone());
        let (token_id, vault) = env.earning_company(&format!("cancel-{round}"), &borrower, &customer).await?;
        holders.push(vault.clone());
        let offer = fund_offer(&env, &lender, &token_id, principal, principal + 300_000, 3_600_000, None).await?;
        assert_eq!(env.balance(lender.id()).await?, 0);

        let accept = accept_tx(&env, &borrower, offer).transact_async().await?;
        env.wait_blocks(delay).await?;
        let cancel = lender
            .call(env.registry.id(), "cancel_offer")
            .args_json(json!({"offer_id": offer}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact_async()
            .await?;
        let (accept, cancel) = (env.settle(accept).await?, env.settle(cancel).await?);
        let accept_at = env.entry_height(&accept, env.registry.id()).await?;
        let opened_at = env.receipt_height(&accept, env.registry.id(), "loan_opened").await?;
        let cancel_at = env.entry_height(&cancel, env.registry.id()).await?;
        log.push(order(&format!("round {round}"), &[
            ("accept", Some(accept_at)), ("loan_opened", opened_at), ("cancel", Some(cancel_at)),
        ]));

        let borrower_got = env.balance(borrower.id()).await?;
        let lender_got = env.balance(lender.id()).await?;
        if cancel.failures().is_empty() {
            assert!(logged(&cancel, "offer_cancelled"));
            assert_failed(&accept, "ERR_OFFER_NOT_FOUND");
            assert_eq!((borrower_got, lender_got), (0, principal));
            assert_eq!(env.vault_state(&vault).await?["encumbrance"], "Free");
        } else {
            let text = failure_text(&cancel);
            assert!(text.contains("ERR_OFFER_SETTLING") || text.contains("ERR_OFFER_NOT_FOUND"), "{text}");
            if text.contains("ERR_OFFER_SETTLING") {
                // Within one block the receipt order decides: the cancel saw the lock, so it ran
                // after the accept and before the pledge callback.
                assert!(accept_at <= cancel_at && opened_at.is_some_and(|o| cancel_at <= o), "{log:?}");
                seen_settling = true;
            }
            assert_ok(&accept);
            assert_eq!((borrower_got, lender_got), (principal, 0));
            assert!(env.vault_state(&vault).await?["encumbrance"]["Pledged"].is_object());
        }
        assert_eq!(env.balance(env.registry.id()).await?, 0, "principal left in the registry or paid twice");
        env.assert_settled(&token_id, &vault).await?;
        let refs: Vec<&AccountId> = holders.iter().collect();
        env.assert_conserved(&refs).await?;
    }
    println!("{}", log.join("\n"));
    assert!(seen_settling, "no cancel reached the registry while the accept was settling: {log:?}");
    Ok(())
}

/// After a default, the borrower's repayment and a bidder's bid are sent in the same block. One
/// settlement takes the lock; the other is refunded in full. The lender is paid the debt once, and
/// the company ends with exactly one of the two, consistent in registry and vault.
#[tokio::test]
async fn test_repay_racing_a_bid_settles_once() -> Result<()> {
    let env = setup().await?;
    let customer = env.funded("customer", 10_000_000).await?;
    let lender = env.funded("lender", 20_000_000).await?;
    let borrower = env.funded("borrower", 20_000_000).await?;
    let bidder = env.funded("bidder", 50_000_000).await?;
    let principal = 5_000_000u128;
    let debt = 6_000_000u128;
    let (token_id, vault) = env.earning_company("repay-bid", &borrower, &customer).await?;
    let offer = fund_offer(&env, &lender, &token_id, principal, debt, 1_000, None).await?;
    assert_ok(&accept_tx(&env, &borrower, offer).transact().await?);
    advance_ms(&env, 2_000).await?;
    assert_ok(&env.operator.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?);
    let quoted = u128_of(&env.registry.view("auction_price").args_json(json!({"token_id": token_id})).await?.json::<Value>()?);
    let (lender_before, borrower_before, bidder_before) =
        (env.balance(lender.id()).await?, env.balance(borrower.id()).await?, env.balance(bidder.id()).await?);

    let repay = env
        .ft_call_tx(&borrower, env.registry.id(), debt, json!({"action": "repay", "token_id": token_id}).to_string())
        .transact_async()
        .await?;
    let bid = env
        .ft_call_tx(&bidder, env.registry.id(), quoted, json!({"action": "bid", "token_id": token_id}).to_string())
        .transact_async()
        .await?;
    let (repay, bid) = (env.settle(repay).await?, env.settle(bid).await?);
    assert_ok(&repay);
    assert_ok(&bid);
    let repaid = logged(&repay, "loan_repaid");
    let sold = logged(&bid, "auction_settled");
    assert!(repaid ^ sold, "exactly one settlement must win: repay {:?} bid {:?}", repay.logs(), bid.logs());
    let refused = ["ERR_TOKEN_SETTLING", "ERR_NO_LOAN"];

    let state = env.assert_settled(&token_id, &vault).await?;
    assert_eq!(state["encumbrance"], "Free");
    let loan: Value = env.registry.view("get_loan").args_json(json!({"token_id": token_id})).await?.json()?;
    assert!(loan.is_null());
    if repaid {
        assert!(refused.iter().any(|r| logged(&bid, r)), "{:?}", bid.logs());
        assert_eq!(env.balance(bidder.id()).await?, bidder_before);
        assert_eq!(env.balance(borrower.id()).await?, borrower_before - debt);
        assert_eq!(env.balance(lender.id()).await? - lender_before, debt);
        assert_eq!(state["shareholder"], borrower.id().as_str());
        assert_eq!(env.assert_only_holder_can_claim(&vault, &borrower, &[&bidder, &lender]).await?, PAYMENT_RETAINED);
    } else {
        assert!(refused.iter().any(|r| logged(&repay, r)), "{:?}", repay.logs());
        let price = auction_price_paid(&bid)?;
        let remainder = price - debt;
        let royalty = remainder * ROYALTY_BPS / 10_000;
        assert_eq!(env.balance(bidder.id()).await?, bidder_before - price);
        assert_eq!(
            env.balance(borrower.id()).await?,
            borrower_before + remainder - royalty,
            "borrower must get its repayment back and the auction remainder"
        );
        assert_eq!(env.balance(lender.id()).await? - lender_before, debt);
        assert_eq!(state["shareholder"], bidder.id().as_str());
        assert_eq!(env.assert_only_holder_can_claim(&vault, &bidder, &[&borrower, &lender]).await?, PAYMENT_RETAINED);
    }
    assert_eq!(env.balance(env.registry.id()).await?, 0);
    env.assert_conserved(&[
        customer.id(), lender.id(), borrower.id(), bidder.id(), env.founder.id(), env.registry.id(),
        env.payee.id(), env.intents.id(), &vault,
    ])
    .await?;
    Ok(())
}
