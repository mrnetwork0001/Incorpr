//! near-workspaces tests against a real local sandbox node. Contract wasm comes from contracts/res,
//! built by scripts/build-contracts.sh. The signer and the intents verifier are sandbox doubles
//! because the sandbox cannot reach the MPC network or mainnet; see test-doubles/.

use std::path::PathBuf;

use anyhow::{anyhow, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ed25519_dalek::Verifier;
use k256::ecdsa::{RecoveryId, Signature as EcdsaSignature, SigningKey, VerifyingKey};
use near_workspaces::network::{Sandbox, ValidatorKey};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccountDetailsPatch, Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use rand_core::{OsRng, RngCore};
use ripemd::Ripemd160;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sha3::Keccak256;

const USDC_ASSET: &str = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const BTC_ASSET: &str = "nep141:btc.omft.near";
const SOL_ASSET: &str = "nep141:sol.omft.near";
const ETH_ASSET: &str = "nep141:eth.omft.near";
const WRAP_ASSET: &str = "nep141:wrap.near";
const CAP: u128 = 1_000_000_000;
/// One buy unit per million sell units: low enough for the amounts these tests use.
const FLOOR_MIN_BUY: u128 = 1;
const FLOOR_PER_SELL: u128 = 1_000_000;

const TEST_MODEL: &str = "zai-org/GLM-4.6";
const TEST_PROMPT: &str = "You review treasury proposals. Reply exactly APPROVE <proposal_hash> or REJECT <proposal_hash>.";

const PRICE: u128 = 100_000;
const ROYALTY_BPS: u128 = 500;
const RESERVE_BPS: u128 = 1_500;
const AUCTION_MS: u64 = 120_000;

const MAX_GAS: Gas = Gas::from_tgas(300);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const FT_STORAGE: NearToken = NearToken::from_micronear(1_250);

fn wasm(name: &str) -> Result<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../res").join(format!("{name}.wasm"));
    std::fs::read(&path).map_err(|e| {
        anyhow!("{}: {e}. Run scripts/build-contracts.sh before cargo test.", path.display())
    })
}

/// The nearcore release mainnet validators run (RPC `status`, 2026-11-06).
const MAINNET_NEARCORE: &str = "2.14.0";
/// Default genesis protocol. nearcore 2.14.0 starts a fresh genesis at 88, where
/// `universal_accounts` is enabled; at 87 the node's runtime_config matched mainnet key for key
/// (compared against EXPERIMENTAL_protocol_config from rpc.mainnet.fastnear.com), including
/// wasm_config.universal_accounts = false. Mainnet moved to 88 on 2026-11-06; run the suite with
/// INCORPR_SANDBOX_PROTOCOL=88 to cover both. A long-lived node upgrades itself after a few epochs,
/// so the version is asserted at startup only.
const MAINNET_PROTOCOL: u32 = 87;

/// Genesis protocol for this run: 87 by default, or INCORPR_SANDBOX_PROTOCOL (for example 88, which
/// mainnet has run since 2026-11-06) to run the same suite on the newer runtime.
fn sandbox_protocol() -> Result<u32> {
    match std::env::var("INCORPR_SANDBOX_PROTOCOL") {
        Ok(v) if !v.trim().is_empty() => v
            .trim()
            .parse()
            .map_err(|e| anyhow!("INCORPR_SANDBOX_PROTOCOL must be a protocol version, got {v:?}: {e}")),
        _ => Ok(MAINNET_PROTOCOL),
    }
}

/// Starts a local node pinned to mainnet's runtime and connects near-workspaces to it. The
/// returned `near_sandbox::Sandbox` owns the node process; dropping it stops the node.
async fn mainnet_runtime_sandbox() -> Result<(near_sandbox::Sandbox, Worker<Sandbox>)> {
    let want = sandbox_protocol()?;
    let config = near_sandbox::SandboxConfig {
        // near-workspaces adds this account to its own sandboxes; tests that create top-level
        // accounts go through it.
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
    /// Keeps the node alive for the test. Declared after `worker` so the client drops first.
    _node: near_sandbox::Sandbox,
    root: Account,
    usdc: Contract,
    mpc: Contract,
    intents: Contract,
    registry: Contract,
    operator: Account,
    payee: Account,
    founder: Account,
    tee_key: SigningKey,
}

async fn account(root: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

async fn setup() -> Result<Env> {
    setup_with_auction(AUCTION_MS).await
}

async fn setup_with_auction(auction_ms: u64) -> Result<Env> {
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
    let founder = account(&root, "founder", 40).await?;

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
            "price_floors": default_floors(),
            "auction_duration_ms": auction_ms,
        }}))
        .gas(MAX_GAS)
        .transact()
        .await?
        .into_result()?;

    let env = Env { worker, _node: node, root, usdc, mpc, intents, registry, operator, payee, founder, tee_key };
    env.register(env.payee.id()).await?;
    env.register(env.intents.id()).await?;
    Ok(env)
}

fn prompt_hash(prompt: &str) -> String {
    hex::encode(Sha256::digest(prompt.as_bytes()))
}

fn floor(sell: &str, buy: &str, min_buy: u128, per_sell: u128) -> Value {
    json!({"sell_token": sell, "buy_token": buy, "min_buy": min_buy.to_string(), "per_sell": per_sell.to_string()})
}

fn default_floors() -> Value {
    json!([
        floor(USDC_ASSET, BTC_ASSET, FLOOR_MIN_BUY, FLOOR_PER_SELL),
        floor(USDC_ASSET, SOL_ASSET, FLOOR_MIN_BUY, FLOOR_PER_SELL),
    ])
}

fn tee_address(key: &SigningKey) -> String {
    let point = key.verifying_key().to_encoded_point(false);
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    format!("0x{}", hex::encode(&hash[12..]))
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

fn random_nonce() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    BASE64.encode(bytes)
}

fn u128_of(value: &Value) -> u128 {
    value.as_str().unwrap_or_else(|| panic!("not a U128 string: {value}")).parse().unwrap()
}

struct Proposal {
    hash: String,
    preimage: String,
}

impl std::fmt::Display for Proposal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.hash)
    }
}

fn proposal_for_vault(vault: &str, epoch: u32, generation: u64, kind: &str, fields: &[&str], nonce_b64: &str) -> Proposal {
    let preimage = format!("incorpr:v2:{vault}:{epoch}:{generation}:{kind}:{}:{nonce_b64}", fields.join(":"));
    let hash = hex::encode(Sha256::digest(preimage.as_bytes()));
    Proposal { hash, preimage }
}

/// For a company at epoch 0 that has not changed hands. All sandbox registries share this account.
fn proposal_hash(token_id: &str, kind: &str, fields: &[&str], nonce_b64: &str) -> Proposal {
    proposal_for_vault(&format!("c-{token_id}.registry.test.near"), 0, 0, kind, fields, nonce_b64)
}

/// The request the vault pins, written here without vault code.
fn request_body(model: &str, system_prompt: &str, proposal: &Proposal) -> String {
    let user = format!("{}\nproposal_hash={}", proposal.preimage, proposal.hash);
    format!(
        r#"{{"model":{},"messages":[{{"role":"system","content":{}}},{{"role":"user","content":{}}}],"stream":false}}"#,
        Value::from(model),
        Value::from(system_prompt),
        Value::from(user),
    )
}

fn wall_clock_s() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

/// A non-streaming chat completion, as the TEE returns it.
fn chat_body(content: &str, created: u64) -> String {
    json!({
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": created,
        "model": TEST_MODEL,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
    })
    .to_string()
}

/// EIP-191 signature over `text`, as NEAR AI Cloud produces with `signing_algo=ecdsa`.
fn sign_text(key: &SigningKey, text: &str) -> String {
    let mut hasher = Keccak256::new();
    hasher.update(format!("\x19Ethereum Signed Message:\n{}", text.len()).as_bytes());
    hasher.update(text.as_bytes());
    let (signature, recovery) = key.sign_prehash_recoverable(&hasher.finalize()).unwrap();
    let mut bytes = signature.to_bytes().to_vec();
    bytes.push(27 + recovery.to_byte());
    format!("0x{}", hex::encode(bytes))
}

/// Signed the way the TEE signs: `{model}:{sha256(request)}:{sha256(response)}`.
fn signed_proof(key: &SigningKey, model: &str, request: &str, body: &str, system_prompt: &str) -> Value {
    let text = format!(
        "{model}:{}:{}",
        hex::encode(Sha256::digest(request.as_bytes())),
        hex::encode(Sha256::digest(body.as_bytes()))
    );
    json!({"text": text, "signature_hex": sign_text(key, &text), "response_body": body, "system_prompt": system_prompt})
}

fn proof_for_body(key: &SigningKey, proposal: &Proposal, body: &str) -> Value {
    signed_proof(key, TEST_MODEL, &request_body(TEST_MODEL, TEST_PROMPT, proposal), body, TEST_PROMPT)
}

fn approval_at(key: &SigningKey, proposal: &Proposal, created: u64) -> Value {
    proof_for_body(key, proposal, &chat_body(&format!("APPROVE {}", proposal.hash), created))
}

/// Dated by the wall clock, which sandbox block time tracks until a test advances it.
fn approval(key: &SigningKey, proposal: &Proposal) -> Value {
    approval_at(key, proposal, wall_clock_s())
}

impl Env {
    async fn incorporate(&self, founder: &Account, name: &str) -> Result<(String, AccountId)> {
        let cost = self.incorporation_cost().await?;
        let outcome = founder
            .call(self.registry.id(), "incorporate_company")
            .args_json(json!({"args": {
                "name": name,
                "service_template": "translate-v1",
                "price_micro_usdc": PRICE.to_string(),
                "target_bps": [4000, 3000, 3000],
                "founder_royalty_bps": ROYALTY_BPS as u16,
                "compute_reserve_bps": RESERVE_BPS as u16,
            }}))
            .deposit(cost)
            .gas(MAX_GAS)
            .transact()
            .await?;
        assert_ok(&outcome);
        let token_id: Option<String> = outcome.json()?;
        let token_id = token_id.ok_or_else(|| anyhow!("incorporation returned no token"))?;
        let vault: AccountId = format!("c-{token_id}.{}", self.registry.id()).parse()?;
        Ok((token_id, vault))
    }

    async fn acquire_msg(&self, token_id: &str) -> Result<Value> {
        let nonce = self.company_view(token_id).await?["sync_nonce"].as_u64().unwrap();
        Ok(json!({"action": "acquire", "token_id": token_id, "expected_sync_nonce": nonce}))
    }

    async fn incorporation_cost(&self) -> Result<NearToken> {
        let cost: Value = self.registry.view("incorporation_cost").await?.json()?;
        Ok(NearToken::from_yoctonear(u128_of(&cost)))
    }

    async fn company(&self) -> Result<(String, AccountId)> {
        self.incorporate(&self.founder.clone(), "Acme Translate").await
    }

    /// Company with stored treasury addresses and a registered intents key.
    async fn agent_ready_company(&self) -> Result<(String, AccountId)> {
        let (token_id, vault) = self.company().await?;
        assert_ok(&self.refresh(&vault).await?);
        assert_ok(
            &self
                .operator
                .call(&vault, "setup_intents_key")
                .gas(MAX_GAS)
                .transact()
                .await?,
        );
        Ok((token_id, vault))
    }

    async fn refresh(&self, vault: &AccountId) -> Result<ExecutionFinalResult> {
        Ok(self.operator.call(vault, "refresh_treasury_keys").gas(MAX_GAS).transact().await?)
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

    async fn funded(&self, name: &str, usdc: u128) -> Result<Account> {
        let acct = account(&self.root, name, 30).await?;
        self.register(acct.id()).await?;
        self.mint(acct.id(), usdc).await?;
        Ok(acct)
    }

    async fn mint(&self, id: &AccountId, amount: u128) -> Result<()> {
        self.usdc
            .call("mint")
            .args_json(json!({"account_id": id, "amount": amount.to_string()}))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn balance(&self, id: &AccountId) -> Result<u128> {
        let value: Value = self
            .usdc
            .view("ft_balance_of")
            .args_json(json!({"account_id": id}))
            .await?
            .json()?;
        Ok(u128_of(&value))
    }

    async fn ft_call(
        &self,
        from: &Account,
        to: &AccountId,
        amount: u128,
        msg: Value,
    ) -> Result<ExecutionFinalResult> {
        let msg = match msg {
            Value::String(s) => s,
            other => other.to_string(),
        };
        Ok(from
            .call(self.usdc.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id": to, "amount": amount.to_string(), "msg": msg}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    async fn pay(
        &self,
        from: &Account,
        vault: &AccountId,
        amount: u128,
        call_id: &str,
    ) -> Result<ExecutionFinalResult> {
        self.ft_call(from, vault, amount, json!({"call_id": call_id})).await
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

    async fn charter_svg(&self, token_id: &str) -> Result<String> {
        let token: Value =
            self.registry.view("nft_token").args_json(json!({"token_id": token_id})).await?.json()?;
        let media = token["metadata"]["media"].as_str().ok_or_else(|| anyhow!("no media"))?;
        let b64 = media
            .strip_prefix("data:image/svg+xml;base64,")
            .ok_or_else(|| anyhow!("media is not a base64 SVG data URI: {media}"))?;
        Ok(String::from_utf8(BASE64.decode(b64)?)?)
    }

    async fn sign_count(&self) -> Result<u64> {
        Ok(self.mpc.view("sign_count").await?.json()?)
    }

    async fn raw_sign(&self, who: &Account, vault: &AccountId) -> Result<ExecutionFinalResult> {
        Ok(who
            .call(vault, "request_shareholder_signature")
            .args_json(json!({"domain_id": 0, "payload_hex": "ab".repeat(32), "subpath": "treasury"}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    async fn list(&self, who: &Account, token_id: &str, ask: u128) -> Result<ExecutionFinalResult> {
        Ok(who
            .call(self.registry.id(), "list_company")
            .args_json(json!({"token_id": token_id, "ask": ask.to_string()}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?)
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

    async fn swap(&self, who: &Account, vault: &AccountId, token_id: &str, sell: u128) -> Result<ExecutionFinalResult> {
        let nonce = random_nonce();
        let hash = proposal_hash(
            token_id,
            "swap",
            &[USDC_ASSET, &sell.to_string(), BTC_ASSET, "1000"],
            &nonce,
        );
        self.swap_with(who, vault, USDC_ASSET, sell, BTC_ASSET, 1000, &nonce, approval(&self.tee_key, &hash)).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn swap_with(
        &self,
        who: &Account,
        vault: &AccountId,
        sell_token: &str,
        sell: u128,
        buy_token: &str,
        min_buy: u128,
        nonce: &str,
        tee: Value,
    ) -> Result<ExecutionFinalResult> {
        Ok(who
            .call(vault, "agent_swap_intent")
            .args_json(json!({
                "p": {
                    "sell_token": sell_token,
                    "sell_amount": sell.to_string(),
                    "buy_token": buy_token,
                    "min_buy_amount": min_buy.to_string(),
                    "nonce_b64": nonce,
                },
                "tee": tee,
            }))
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    #[allow(clippy::too_many_arguments)]
    async fn withdraw(
        &self,
        who: &Account,
        vault: &AccountId,
        token_id: &str,
        token: &str,
        destination: &str,
        chain: &str,
        amount: u128,
    ) -> Result<ExecutionFinalResult> {
        let nonce = random_nonce();
        let hash = proposal_hash(token_id, "withdraw", &[token, &amount.to_string(), destination, chain], &nonce);
        Ok(who
            .call(vault, "agent_withdraw_intent")
            .args_json(json!({
                "p": {
                    "token": token,
                    "amount": amount.to_string(),
                    "destination": destination,
                    "chain": chain,
                    "nonce_b64": nonce,
                },
                "tee": approval(&self.tee_key, &hash),
            }))
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    async fn block_ms(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    /// Moves block time forward by at least `ms`.
    async fn advance_ms(&self, ms: u64) -> Result<()> {
        let target = self.block_ms().await? + ms + 1;
        for _ in 0..200 {
            if self.block_ms().await? > target {
                return Ok(());
            }
            self.worker.fast_forward(ms / 1_000 + 20).await?;
        }
        Err(anyhow!("block time did not reach the target"))
    }

    async fn break_vault(&self, vault: &AccountId) -> Result<()> {
        // Replaces the vault's code with a contract that has none of its methods.
        self.worker.patch(vault).code(&wasm("test_usdc")?).transact().await?;
        Ok(())
    }

    async fn restore_vault(&self, vault: &AccountId) -> Result<()> {
        self.worker.patch(vault).code(&wasm("company_vault")?).transact().await?;
        Ok(())
    }
}

// ------------------------------------------------------------------- Required scenarios 1-4

#[tokio::test]
async fn test_incorporate_spawns_subaccount_and_mints_nep171() -> Result<()> {
    let env = setup().await?;
    let before = env.founder.view_account().await?.balance;
    let (token_id, vault) = env.incorporate(&env.founder, "Acme <Translate>").await?;
    assert_eq!(token_id, "1");
    assert_eq!(vault.as_str(), format!("c-1.{}", env.registry.id()));

    let code = env.worker.view_code(&vault).await?;
    assert_eq!(code, wasm("company_vault")?, "vault account does not hold the embedded code");
    assert!(env.worker.view_access_keys(&vault).await?.is_empty(), "vault must have zero access keys");

    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], env.founder.id().as_str());
    assert_eq!(state["encumbrance"], "Free");
    assert_eq!(env.owner_of(&token_id).await?, env.founder.id().as_str());

    let svg = env.charter_svg(&token_id).await?;
    assert!(svg.starts_with("<svg"), "not an SVG: {svg}");
    assert!(svg.contains("Acme &lt;Translate&gt;"), "name missing or unescaped: {svg}");
    assert!(svg.contains(vault.as_str()));
    assert!(svg.contains("FREE") && svg.contains("#16a34a"));
    assert!(svg.contains("40% BTC / 30% SOL / 30% USDC"));
    assert!(svg.contains("$0.10 USDC"));

    // The vault holds a USDC account, so customers can pay it immediately.
    let registered: Value = env
        .usdc
        .view("storage_balance_of")
        .args_json(json!({"account_id": vault}))
        .await?
        .json()?;
    assert!(!registered.is_null());

    // Excess over vault funding and measured storage came back.
    let cost = env.incorporation_cost().await?.as_yoctonear();
    let spent = before.as_yoctonear() - env.founder.view_account().await?.balance.as_yoctonear();
    assert!(spent <= cost, "spent {spent} > cost {cost}");

    let nep177: Value = env.registry.view("nft_metadata").await?.json()?;
    assert_eq!(nep177["symbol"], "INCORPR");
    let supply: Value = env.registry.view("nft_total_supply").await?.json()?;
    assert_eq!(supply, "1");
    let listed: Vec<Value> = env
        .registry
        .view("nft_tokens_for_owner")
        .args_json(json!({"account_id": env.founder.id()}))
        .await?
        .json()?;
    assert_eq!(listed.len(), 1);
    assert!(listed[0]["metadata"]["media"].as_str().unwrap().starts_with("data:image/svg+xml;base64,"));
    Ok(())
}

#[tokio::test]
async fn test_firewall_blocks_prompt_injected_agent_drain() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;

    // The injected model output approves the attacker's destination. The TEE proof is valid, and
    // the vault still refuses, because destinations are not the model's to choose.
    let attacker = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    let outcome = env.withdraw(&env.operator, &vault, &token_id, ETH_ASSET, attacker, "evm", 1_000).await?;
    assert_failed(&outcome, "ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION");
    assert_eq!(env.sign_count().await?, 0, "signer must not be reached");

    let state = env.vault_state(&vault).await?;
    assert_eq!(state["spent_this_window"], json!([]));
    Ok(())
}

#[tokio::test]
async fn test_anti_rug_encumbrance_freezes_seller_mpc_signing() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    assert_ok(&env.list(&env.founder, &token_id, 10_000_000).await?);
    assert_eq!(env.vault_state(&vault).await?["encumbrance"]["Listed"]["ask"], "10000000");

    let outcome = env.raw_sign(&env.founder, &vault).await?;
    assert_failed(&outcome, "ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN");
    assert_eq!(env.sign_count().await?, 0);
    assert_eq!(env.vault_state(&vault).await?["raw_sigs_this_epoch"], 0);

    // Legacy-epoch signing and rotation are frozen as well.
    let legacy = env
        .founder
        .call(&vault, "sign_legacy_epoch")
        .args_json(json!({"epoch": 0, "domain_id": 0, "payload_hex": "ab".repeat(32), "subpath": "treasury"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&legacy, "ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN");
    let rotate = env
        .founder
        .call(&vault, "rotate_treasury_epoch")
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&rotate, "ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN");
    Ok(())
}

#[tokio::test]
async fn test_atomic_ma_acquisition_flips_shareholder_and_pays_royalty() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let seller = env.funded("seller", 0).await?;
    let buyer = env.funded("buyer", 50_000_000).await?;
    env.register(env.founder.id()).await?;

    assert_ok(&env.transfer_nft(&env.founder, seller.id(), &token_id).await?);
    assert_eq!(env.vault_state(&vault).await?["shareholder"], seller.id().as_str());

    let ask: u128 = 20_000_000;
    assert_ok(&env.list(&seller, &token_id, ask).await?);
    let listing: Value = env.registry.view("get_listing").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(listing["seller"], seller.id().as_str());
    assert_eq!(listing["ask"], ask.to_string());
    let svg = env.charter_svg(&token_id).await?;
    assert!(svg.contains("LISTED") && svg.contains("#d97706"));

    // Overpays by 5 USDC: the excess returns through ft_resolve_transfer.
    let outcome = env
        .ft_call(&buyer, env.registry.id(), ask + 5_000_000, env.acquire_msg(&token_id).await?)
        .await?;
    assert_ok(&outcome);

    assert_eq!(env.owner_of(&token_id).await?, buyer.id().as_str());
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], buyer.id().as_str());
    assert_eq!(state["encumbrance"], "Free");
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["encumbrance"], "Free");
    assert_eq!(company["settling"], false);
    let listing: Value = env.registry.view("get_listing").args_json(json!({"token_id": token_id})).await?.json()?;
    assert!(listing.is_null());

    let royalty = ask * ROYALTY_BPS / 10_000;
    assert_eq!(env.balance(env.founder.id()).await?, royalty);
    assert_eq!(env.balance(seller.id()).await?, ask - royalty);
    assert_eq!(env.balance(buyer.id()).await?, 50_000_000 - ask);
    assert_eq!(env.balance(env.registry.id()).await?, 0);
    Ok(())
}

// ------------------------------------------------------------------- 5-7: Section 3 rule

#[tokio::test]
async fn test_listing_requires_clean_epoch_and_rotation_changes_addresses() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    assert_ok(&env.refresh(&vault).await?);
    let first = env.vault_state(&vault).await?["addresses"].clone();
    assert_eq!(first["epoch"], 0);

    assert_ok(&env.raw_sign(&env.founder, &vault).await?);
    assert_eq!(env.vault_state(&vault).await?["raw_sigs_this_epoch"], 1);

    let denied = env.list(&env.founder, &token_id, 1_000_000).await?;
    assert_failed(&denied, "ERR_RAW_SIGNATURES_THIS_EPOCH");
    assert_eq!(env.company_view(&token_id).await?["encumbrance"], "Free");
    assert_eq!(env.company_view(&token_id).await?["settling"], false);
    assert_eq!(env.vault_state(&vault).await?["encumbrance"], "Free");

    assert_ok(
        &env.founder
            .call(&vault, "rotate_treasury_epoch")
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    let state = env.vault_state(&vault).await?;
    let second = &state["addresses"];
    assert_eq!(state["treasury_epoch"], 1);
    assert_eq!(state["raw_sigs_this_epoch"], 0);
    assert_eq!(second["epoch"], 1);
    for field in ["btc", "evm", "sol"] {
        assert_ne!(first[field], second[field], "{field} did not change on rotation");
    }

    // Old-epoch funds stay reachable and do not dirty the new epoch. A future epoch is refused.
    let legacy = env
        .founder
        .call(&vault, "sign_legacy_epoch")
        .args_json(json!({"epoch": 0, "domain_id": 0, "payload_hex": "cd".repeat(32), "subpath": "treasury"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_ok(&legacy);
    assert_eq!(env.vault_state(&vault).await?["raw_sigs_this_epoch"], 0);
    let calls: Vec<Value> = env.mpc.view("sign_calls").await?.json()?;
    assert_eq!(calls[0]["request"]["path"], "incorpr-1-e0-treasury");
    assert_eq!(calls[1]["request"]["path"], "incorpr-1-e0-treasury");
    let future = env
        .founder
        .call(&vault, "sign_legacy_epoch")
        .args_json(json!({"epoch": 1, "domain_id": 0, "payload_hex": "cd".repeat(32), "subpath": "treasury"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&future, "ERR_NOT_A_LEGACY_EPOCH");

    assert_ok(&env.list(&env.founder, &token_id, 1_000_000).await?);
    assert!(env.company_view(&token_id).await?["encumbrance"]["Listed"].is_object());

    // An auxiliary subpath dirties the epoch the same way as the treasury path.
    let (token2, vault2) = env.incorporate(&env.founder, "Second").await?;
    assert_ok(
        &env.founder
            .call(&vault2, "request_shareholder_signature")
            .args_json(json!({"domain_id": 1, "payload_hex": "ee".repeat(32), "subpath": "hot-wallet-1"}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    let calls: Vec<Value> = env.mpc.view("sign_calls").await?.json()?;
    assert_eq!(calls.last().unwrap()["request"]["path"], "incorpr-2-e0-hot-wallet-1");
    assert_failed(&env.list(&env.founder, &token2, 1_000_000).await?, "ERR_RAW_SIGNATURES_THIS_EPOCH");
    Ok(())
}

#[tokio::test]
async fn test_signature_raced_before_freeze_fails_listing_and_leaves_no_lock() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let other = env.funded("other", 0).await?;

    // Sequential form of the race: the signature reaches the vault before the freeze receipt.
    assert_ok(&env.raw_sign(&env.founder, &vault).await?);
    let outcome = env.list(&env.founder, &token_id, 1_000_000).await?;
    assert_failed(&outcome, "ERR_RAW_SIGNATURES_THIS_EPOCH");
    let listing: Value = env.registry.view("get_listing").args_json(json!({"token_id": token_id})).await?.json()?;
    assert!(listing.is_null(), "listing must not activate");
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["settling"], false, "lock must be cleared");
    assert_eq!(company["encumbrance"], "Free");
    assert_ok(&env.transfer_nft(&env.founder, other.id(), &token_id).await?);
    assert_eq!(env.owner_of(&token_id).await?, other.id().as_str());

    // Concurrent form: either order may land first. A listing and a signature never coexist.
    let (token2, vault2) = env.incorporate(&env.founder, "Second").await?;
    let list_tx = env
        .founder
        .call(env.registry.id(), "list_company")
        .args_json(json!({"token_id": token2, "ask": "1000000"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact_async()
        .await?;
    let sign_tx = env
        .founder
        .call(&vault2, "request_shareholder_signature")
        .args_json(json!({"domain_id": 0, "payload_hex": "ab".repeat(32), "subpath": "treasury"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact_async()
        .await?;
    let _ = list_tx.await?;
    let _ = sign_tx.await?;
    let state = env.vault_state(&vault2).await?;
    let company = env.company_view(&token2).await?;
    assert_eq!(company["settling"], false);
    let listed = company["encumbrance"]["Listed"].is_object();
    assert_eq!(state["encumbrance"]["Listed"].is_object(), listed, "registry and vault disagree");
    assert!(!(listed && state["raw_sigs_this_epoch"] != 0), "listed with a raw signature outstanding");
    Ok(())
}

#[tokio::test]
async fn test_unexpired_agent_intent_blocks_encumbrance_until_deadline() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    assert_ok(&env.swap(&env.operator, &vault, &token_id, 1_000).await?);
    let deadline = env.vault_state(&vault).await?["latest_intent_deadline_ms"].as_u64().unwrap();
    let now = env.block_ms().await?;
    assert!(deadline > now && deadline <= now + 300_000, "deadline {deadline} now {now}");

    let denied = env.list(&env.founder, &token_id, 1_000_000).await?;
    assert_failed(&denied, "ERR_UNEXPIRED_SIGNED_INTENTS");
    assert_eq!(env.company_view(&token_id).await?["settling"], false);

    env.advance_ms(301_000).await?;
    assert_ok(&env.list(&env.founder, &token_id, 1_000_000).await?);

    let frozen = env.swap(&env.operator, &vault, &token_id, 1_000).await?;
    assert_failed(&frozen, "ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN");
    Ok(())
}

// ------------------------------------------------------------------- 8: TEE proof

#[tokio::test]
async fn test_tee_proof_checks_and_onchain_ecrecover() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let sell = "1000";
    let fields = [USDC_ASSET, sell, BTC_ASSET, "1000"];
    let attempt = |nonce: String, tee: Value| {
        let (env, vault) = (&env, &vault);
        async move {
            env.swap_with(&env.operator, vault, USDC_ASSET, 1000, BTC_ASSET, 1000, &nonce, tee).await
        }
    };

    // Missing fields.
    let nonce = random_nonce();
    let hash = proposal_hash(&token_id, "swap", &fields, &nonce);
    let empty = json!({"text": "", "signature_hex": "", "response_body": "", "system_prompt": ""});
    assert_failed(&attempt(nonce.clone(), empty).await?, "ERR_MISSING_TEE_ATTESTATION");

    // Signed by a key that is not in tee_signers.
    let wrong_key = SigningKey::random(&mut OsRng);
    assert_failed(
        &attempt(nonce.clone(), approval(&wrong_key, &hash)).await?,
        "ERR_TEE_SIGNATURE_UNTRUSTED",
    );

    // Tampered signature bytes.
    let mut bad = approval(&env.tee_key, &hash);
    bad["signature_hex"] = json!(format!("0x{}", "11".repeat(65)));
    assert_failed(&attempt(nonce.clone(), bad).await?, "ERR_TEE_SIGNATURE_UNTRUSTED");
    let mut flipped = approval(&env.tee_key, &hash);
    let mut bytes = hex::decode(flipped["signature_hex"].as_str().unwrap().trim_start_matches("0x"))?;
    bytes[10] ^= 0xff;
    flipped["signature_hex"] = json!(format!("0x{}", hex::encode(bytes)));
    assert_failed(&attempt(nonce.clone(), flipped).await?, "ERR_TEE_SIGNATURE_UNTRUSTED");
    let mut short = approval(&env.tee_key, &hash);
    short["signature_hex"] = json!("0xabcd");
    assert_failed(&attempt(nonce.clone(), short).await?, "ERR_TEE_SIGNATURE_UNTRUSTED");

    // Response body swapped after signing.
    let mut swapped = approval(&env.tee_key, &hash);
    swapped["response_body"] = json!(chat_body(&format!("APPROVE {hash}"), wall_clock_s() + 1));
    assert_failed(&attempt(nonce.clone(), swapped).await?, "ERR_TEE_RESPONSE_MISMATCH");

    // No APPROVE line.
    let no_approve = proof_for_body(&env.tee_key, &hash, &chat_body("The proposal looks fine to me.", wall_clock_s()));
    assert_failed(&attempt(nonce.clone(), no_approve).await?, "ERR_TEE_NOT_APPROVED");

    // REJECT anywhere in the body wins over APPROVE.
    let both = proof_for_body(&env.tee_key, &hash, &chat_body(&format!("APPROVE {hash}\nREJECT: over budget"), wall_clock_s()));
    assert_failed(&attempt(nonce.clone(), both).await?, "ERR_TEE_NOT_APPROVED");

    // An approval for a different proposal.
    let other_hash = proposal_hash(&token_id, "swap", &[USDC_ASSET, "999", BTC_ASSET, "1000"], &nonce);
    assert_failed(
        &attempt(nonce.clone(), approval(&env.tee_key, &other_hash)).await?,
        "ERR_TEE_NOT_APPROVED",
    );

    // An approval issued for another company, same fields.
    let other_company = proposal_hash("2", "swap", &fields, &nonce);
    assert_failed(
        &attempt(nonce.clone(), approval(&env.tee_key, &other_company)).await?,
        "ERR_TEE_NOT_APPROVED",
    );

    assert_eq!(env.sign_count().await?, 0, "no failed proof may reach the signer");
    assert_eq!(env.vault_state(&vault).await?["spent_this_window"], json!([]));

    // Positive path: on-chain ecrecover accepts a real secp256k1 signature.
    assert_ok(&attempt(nonce.clone(), approval(&env.tee_key, &hash)).await?);
    assert_eq!(env.sign_count().await?, 1);

    // The same nonce again.
    assert_failed(&attempt(nonce, approval(&env.tee_key, &hash)).await?, "ERR_NONCE_USED");

    // A malformed nonce.
    let bad_nonce = attempt("c2hvcnQ=".to_string(), approval(&env.tee_key, &hash)).await?;
    assert_failed(&bad_nonce, "ERR_INVALID_NONCE");
    Ok(())
}

// ------------------------------------------------------------------- 9: Firewall and roles

#[tokio::test]
async fn test_firewall_tokens_and_epoch_caps() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let state = env.vault_state(&vault).await?;
    let addresses = state["addresses"].clone();
    let evm = addresses["evm"].as_str().unwrap();
    let btc = addresses["btc"].as_str().unwrap();

    // A token outside allowed_tokens, on both sides of a swap and on a withdrawal.
    let bad = "nep141:scam.near";
    let nonce = random_nonce();
    let hash = proposal_hash(&token_id, "swap", &[bad, "10", BTC_ASSET, "10"], &nonce);
    let outcome = env
        .swap_with(&env.operator, &vault, bad, 10, BTC_ASSET, 10, &nonce, approval(&env.tee_key, &hash))
        .await?;
    assert_failed(&outcome, "ERR_FIREWALL_BLOCKED_TOKEN");
    let outcome = env
        .swap_with(&env.operator, &vault, USDC_ASSET, 10, bad, 10, &nonce, approval(&env.tee_key, &hash))
        .await?;
    assert_failed(&outcome, "ERR_FIREWALL_BLOCKED_TOKEN");
    let outcome = env.withdraw(&env.operator, &vault, &token_id, bad, evm, "evm", 10).await?;
    assert_failed(&outcome, "ERR_FIREWALL_BLOCKED_TOKEN");

    // Same token on both sides and zero amounts.
    let outcome = env
        .swap_with(&env.operator, &vault, USDC_ASSET, 10, USDC_ASSET, 10, &nonce, approval(&env.tee_key, &hash))
        .await?;
    assert_failed(&outcome, "ERR_FIREWALL_INVALID_PROPOSAL");
    let outcome = env
        .swap_with(&env.operator, &vault, USDC_ASSET, 0, BTC_ASSET, 10, &nonce, approval(&env.tee_key, &hash))
        .await?;
    assert_failed(&outcome, "ERR_FIREWALL_INVALID_PROPOSAL");

    // Withdrawal token with no bridge contract: receiver_id would be the token contract itself.
    let outcome = env.withdraw(&env.operator, &vault, &token_id, USDC_ASSET, evm, "evm", 10).await?;
    assert_failed(&outcome, "ERR_FIREWALL_BLOCKED_TOKEN");

    // The vault's own address on the wrong chain for the token.
    let outcome = env.withdraw(&env.operator, &vault, &token_id, BTC_ASSET, evm, "evm", 10).await?;
    assert_failed(&outcome, "ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION");
    let outcome = env.withdraw(&env.operator, &vault, &token_id, ETH_ASSET, evm, "btc", 10).await?;
    assert_failed(&outcome, "ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION");
    let outcome = env.withdraw(&env.operator, &vault, &token_id, ETH_ASSET, evm, "tron", 10).await?;
    assert_failed(&outcome, "ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION");

    // An allowed token with no cap entry has a cap of zero.
    let nonce = random_nonce();
    let hash = proposal_hash(&token_id, "swap", &[WRAP_ASSET, "10", BTC_ASSET, "10"], &nonce);
    let outcome = env
        .swap_with(&env.operator, &vault, WRAP_ASSET, 10, BTC_ASSET, 10, &nonce, approval(&env.tee_key, &hash))
        .await?;
    assert_failed(&outcome, "ERR_FIREWALL_EPOCH_CAP_EXCEEDED");

    // The per-token cap accumulates over the window.
    assert_ok(&env.swap(&env.operator, &vault, &token_id, CAP - 100).await?);
    let outcome = env.swap(&env.operator, &vault, &token_id, 101).await?;
    assert_failed(&outcome, "ERR_FIREWALL_EPOCH_CAP_EXCEEDED");
    assert_ok(&env.swap(&env.operator, &vault, &token_id, 100).await?);
    assert_failed(&env.swap(&env.operator, &vault, &token_id, 1).await?, "ERR_FIREWALL_EPOCH_CAP_EXCEEDED");

    // Withdrawal to the stored address passes all checks.
    let outcome = env.withdraw(&env.operator, &vault, &token_id, BTC_ASSET, btc, "btc", 500).await?;
    assert_ok(&outcome);
    let signed: Value = outcome.json()?;
    let message: Value = serde_json::from_str(signed["payload"]["message"].as_str().unwrap())?;
    assert_eq!(message["signer_id"], vault.as_str());
    assert_eq!(message["intents"][0]["intent"], "ft_withdraw");
    assert_eq!(message["intents"][0]["token"], "btc.omft.near");
    assert_eq!(message["intents"][0]["receiver_id"], "btc.omft.near");
    assert_eq!(message["intents"][0]["amount"], "500");
    assert_eq!(message["intents"][0]["memo"], format!("WITHDRAW_TO:{btc}"));

    // No stored addresses: after rotation fails to derive, withdrawals have no valid destination.
    assert_ok(&env.mpc.call("set_fail_derive").args_json(json!({"fail": true})).transact().await?);
    let _ = env
        .founder
        .call(&vault, "rotate_treasury_epoch")
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert!(env.vault_state(&vault).await?["addresses"].is_null());
    let outcome = env.withdraw(&env.operator, &vault, &token_id, BTC_ASSET, btc, "btc", 1).await?;
    assert_failed(&outcome, "ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION");
    Ok(())
}

#[tokio::test]
async fn test_role_separation_and_registry_only_sync() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let stranger = account(&env.root, "stranger", 10).await?;

    // Operator cannot use shareholder methods.
    assert_failed(&env.raw_sign(&env.operator, &vault).await?, "ERR_ONLY_CURRENT_SHAREHOLDER");
    for (method, args) in [
        ("claim_dividends", json!({"amount": "1"})),
        ("rotate_treasury_epoch", json!({})),
        ("set_operator", json!({"account": env.operator.id()})),
        ("set_tee_signers", json!({"addresses": []})),
        ("set_policy", json!({"allowed_tokens": [], "epoch_caps": []})),
    ] {
        let outcome = env
            .operator
            .call(&vault, method)
            .args_json(args)
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?;
        assert_failed(&outcome, "ERR_ONLY_CURRENT_SHAREHOLDER");
    }

    // Shareholder cannot use operator methods.
    assert_failed(
        &env.swap(&env.founder, &vault, &token_id, 1_000).await?,
        "ERR_ONLY_TEE_TREASURY_AGENT",
    );
    for (method, args) in [
        ("record_service_call", json!({"call_id": "x", "tee_chat_id": "y"})),
        ("pay_compute_bill", json!({"amount": "1"})),
        ("agent_deposit_to_intents", json!({"amount": "1"})),
    ] {
        let outcome = env.founder.call(&vault, method).args_json(args).gas(MAX_GAS).transact().await?;
        assert_failed(&outcome, "ERR_ONLY_TEE_TREASURY_AGENT");
    }
    let outcome = env
        .founder
        .call(&vault, "agent_withdraw_intent")
        .args_json(json!({
            "p": {"token": BTC_ASSET, "amount": "1", "destination": "x", "chain": "btc", "nonce_b64": random_nonce()},
            "tee": {"text": "x", "signature_hex": "x", "response_body": "x", "system_prompt": "x"},
        }))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&outcome, "ERR_ONLY_TEE_TREASURY_AGENT");

    // Only the registry can sync, and only with a newer nonce.
    for who in [&stranger, &env.founder, &env.operator] {
        let outcome = who
            .call(&vault, "sync_owner")
            .args_json(json!({"new_shareholder": who.id(), "sync_nonce": 99}))
            .transact()
            .await?;
        assert_failed(&outcome, "ERR_ONLY_REGISTRY");
        let outcome = who
            .call(&vault, "apply_encumbrance")
            .args_json(json!({"new_shareholder": who.id(), "state": "Free", "sync_nonce": 99}))
            .transact()
            .await?;
        assert_failed(&outcome, "ERR_ONLY_REGISTRY");
    }
    let registry_account = env.registry.as_account();
    let fresh = registry_account
        .call(&vault, "sync_owner")
        .args_json(json!({"new_shareholder": env.founder.id(), "sync_nonce": 5}))
        .transact()
        .await?;
    assert_ok(&fresh);
    for nonce in [0, 4, 5] {
        let stale = registry_account
            .call(&vault, "sync_owner")
            .args_json(json!({"new_shareholder": env.founder.id(), "sync_nonce": nonce}))
            .transact()
            .await?;
        assert_failed(&stale, "ERR_STALE_SYNC");
    }

    // Signing paths reject a subpath the vault did not compose and unknown domains.
    let outcome = env
        .founder
        .call(&vault, "request_shareholder_signature")
        .args_json(json!({"domain_id": 0, "payload_hex": "ab".repeat(32), "subpath": "../intents"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&outcome, "ERR_INVALID_SUBPATH");
    let outcome = env
        .founder
        .call(&vault, "request_shareholder_signature")
        .args_json(json!({"domain_id": 7, "payload_hex": "ab".repeat(32), "subpath": "treasury"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&outcome, "ERR_INVALID_DOMAIN");
    assert_failed(
        &env.founder
            .call(&vault, "request_shareholder_signature")
            .args_json(json!({"domain_id": 0, "payload_hex": "abcd", "subpath": "treasury"}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?,
        "ERR_INVALID_PAYLOAD",
    );

    // A subpath named "intents" never reaches the intents key: it stays under the epoch prefix.
    assert_ok(
        &env.founder
            .call(&vault, "request_shareholder_signature")
            .args_json(json!({"domain_id": 1, "payload_hex": "ab".repeat(32), "subpath": "intents"}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    let calls: Vec<Value> = env.mpc.view("sign_calls").await?.json()?;
    assert_eq!(calls.last().unwrap()["request"]["path"], "incorpr-1-e0-intents");
    assert_ne!(calls.last().unwrap()["request"]["path"], "incorpr-1-intents");
    Ok(())
}

#[tokio::test]
async fn test_new_shareholder_gets_charter_policy_not_seller_policy() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let buyer = env.funded("buyer", 10_000_000).await?;
    let accomplice = account(&env.root, "accomplice", 10).await?;
    env.register(env.founder.id()).await?;
    let default_policy = env.vault_state(&vault).await?["default_policy"].clone();

    assert_ok(
        &env.founder
            .call(&vault, "set_operator")
            .args_json(json!({"account": accomplice.id()}))
            .deposit(ONE_YOCTO)
            .transact()
            .await?,
    );
    let seller_tee = SigningKey::random(&mut OsRng);
    assert_ok(
        &env.founder
            .call(&vault, "set_tee_signers")
            .args_json(json!({"addresses": [tee_address(&seller_tee)]}))
            .deposit(ONE_YOCTO)
            .transact()
            .await?,
    );
    assert_ne!(env.vault_state(&vault).await?["policy"], default_policy);

    // While listed, policy changes are frozen.
    assert_ok(&env.list(&env.founder, &token_id, 1_000_000).await?);
    let frozen = env
        .founder
        .call(&vault, "set_operator")
        .args_json(json!({"account": env.founder.id()}))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert_failed(&frozen, "ERR_ACCOUNT_ENCUMBERED_POLICY_FROZEN");

    assert_ok(
        &env.ft_call(&buyer, env.registry.id(), 1_000_000, env.acquire_msg(&token_id).await?)
            .await?,
    );
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["policy"], default_policy, "seller policy survived the sale");
    let outcome = env.swap(&accomplice, &vault, &token_id, 1_000).await?;
    assert_failed(&outcome, "ERR_ONLY_TEE_TREASURY_AGENT");
    Ok(())
}

// ------------------------------------------------------------------- 10: Revenue

#[tokio::test]
async fn test_revenue_split_refunds_and_related_party() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let customer = env.funded("customer", 10_000_000).await?;
    env.register(env.founder.id()).await?;
    env.mint(env.founder.id(), 1_000_000).await?;

    let svg_before = env.charter_svg(&token_id).await?;

    // Split between compute reserve and retained earnings.
    let amount = 1_000_000u128;
    assert_ok(&env.pay(&customer, &vault, amount, "call-1").await?);
    let state = env.vault_state(&vault).await?;
    let reserve = amount * RESERVE_BPS / 10_000;
    assert_eq!(u128_of(&state["compute_reserve"]), reserve);
    assert_eq!(u128_of(&state["retained_earnings"]), amount - reserve);
    assert_eq!(u128_of(&state["gross_revenue"]), amount);
    assert_eq!(u128_of(&state["revenue_30d"]), amount);
    assert_eq!(env.balance(&vault).await?, amount);
    let payment: Value = env.worker.view(&vault, "get_payment").args_json(json!({"call_id": "call-1"})).await?.json()?;
    assert_eq!(payment["payer"], customer.id().as_str());
    assert_eq!(payment["served"], false);

    // Registry heard it from the vault, and the charter changed.
    let company = env.company_view(&token_id).await?;
    assert_eq!(u128_of(&company["gross"]), amount);
    assert_eq!(u128_of(&company["revenue_30d"]), amount);
    let svg_after = env.charter_svg(&token_id).await?;
    assert_ne!(svg_before, svg_after);
    assert!(svg_after.contains("$1.00"), "30d revenue not on charter: {svg_after}");

    // Duplicate call_id: full refund, no booking.
    let balance = env.balance(customer.id()).await?;
    let outcome = env.pay(&customer, &vault, amount, "call-1").await?;
    assert_ok(&outcome);
    assert_eq!(env.balance(customer.id()).await?, balance);
    assert_eq!(u128_of(&env.vault_state(&vault).await?["gross_revenue"]), amount);

    // Under-price: full refund.
    assert_ok(&env.pay(&customer, &vault, PRICE - 1, "call-2").await?);
    assert_eq!(env.balance(customer.id()).await?, balance);
    assert!(env.worker.view(&vault, "get_payment").args_json(json!({"call_id": "call-2"})).await?.json::<Value>()?.is_null());

    // Invalid msg forms: full refund.
    for msg in [json!("not json"), json!({"call_id": ""}), json!({"call_id": "x".repeat(65)})] {
        assert_ok(&env.ft_call(&customer, &vault, amount, msg).await?);
        assert_eq!(env.balance(customer.id()).await?, balance);
    }

    // A token other than USDC is refunded and books nothing.
    let other_ft = account(&env.root, "other-ft", 30).await?.deploy(&wasm("test_usdc")?).await?.into_result()?;
    other_ft.call("new").transact().await?.into_result()?;
    for id in [customer.id(), &vault] {
        env.root
            .call(other_ft.id(), "storage_deposit")
            .args_json(json!({"account_id": id, "registration_only": true}))
            .deposit(FT_STORAGE)
            .transact()
            .await?
            .into_result()?;
    }
    other_ft
        .call("mint")
        .args_json(json!({"account_id": customer.id(), "amount": "5000000"}))
        .transact()
        .await?
        .into_result()?;
    assert_ok(
        &customer
            .call(other_ft.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id": vault, "amount": "5000000", "msg": json!({"call_id": "fake"}).to_string()}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    let other_balance: Value =
        other_ft.view("ft_balance_of").args_json(json!({"account_id": customer.id()})).await?.json()?;
    assert_eq!(u128_of(&other_balance), 5_000_000);
    assert_eq!(u128_of(&env.vault_state(&vault).await?["gross_revenue"]), amount);

    // A direct call is a no-op too: predecessor is not the USDC contract.
    let attacker = account(&env.root, "attacker", 10).await?;
    let outcome = attacker
        .call(&vault, "ft_on_transfer")
        .args_json(json!({"sender_id": attacker.id(), "amount": "99999999", "msg": json!({"call_id": "forged"}).to_string()}))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_ok(&outcome);
    assert_eq!(outcome.json::<Value>()?, "99999999");
    assert_eq!(u128_of(&env.vault_state(&vault).await?["gross_revenue"]), amount);

    // The shareholder paying its own company is related-party: excluded from revenue_30d.
    assert_ok(&env.pay(&env.founder, &vault, 500_000, "self-1").await?);
    let state = env.vault_state(&vault).await?;
    assert_eq!(u128_of(&state["related_party_revenue"]), 500_000);
    assert_eq!(u128_of(&state["gross_revenue"]), amount);
    assert_eq!(u128_of(&state["revenue_30d"]), amount);
    let view_30d: Value = env.worker.view(&vault, "revenue_30d").await?.json()?;
    assert_eq!(u128_of(&view_30d), amount);
    assert_eq!(u128_of(&env.company_view(&token_id).await?["revenue_30d"]), amount);
    Ok(())
}

#[tokio::test]
async fn test_operator_cannot_credit_revenue_and_metrics_only_from_vault() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let customer = env.funded("customer", 5_000_000).await?;
    assert_ok(&env.pay(&customer, &vault, 1_000_000, "call-1").await?);

    // The method from the original spec does not exist.
    let outcome = env
        .operator
        .call(&vault, "record_service_revenue")
        .args_json(json!({"amount_micro_usdc": "99999999", "tee_chat_id": "chat"}))
        .transact()
        .await?;
    assert_failed(&outcome, "MethodNotFound");

    // Marking a call as served moves no money and books no revenue.
    let before = env.vault_state(&vault).await?;
    assert_failed(
        &env.operator
            .call(&vault, "record_service_call")
            .args_json(json!({"call_id": "nope", "tee_chat_id": "chat-1"}))
            .gas(MAX_GAS)
            .transact()
            .await?,
        "ERR_PAYMENT_NOT_FOUND",
    );
    assert_ok(
        &env.operator
            .call(&vault, "record_service_call")
            .args_json(json!({"call_id": "call-1", "tee_chat_id": "chat-1"}))
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    let after = env.vault_state(&vault).await?;
    assert_eq!(after["api_calls_served"], 1);
    assert_eq!(after["gross_revenue"], before["gross_revenue"]);
    assert_eq!(after["retained_earnings"], before["retained_earnings"]);
    let payment: Value = env.worker.view(&vault, "get_payment").args_json(json!({"call_id": "call-1"})).await?.json()?;
    assert_eq!(payment["served"], true);
    assert_eq!(payment["tee_chat_id"], "chat-1");
    assert_failed(
        &env.operator
            .call(&vault, "record_service_call")
            .args_json(json!({"call_id": "call-1", "tee_chat_id": "chat-2"}))
            .gas(MAX_GAS)
            .transact()
            .await?,
        "ERR_PAYMENT_ALREADY_SERVED",
    );
    assert_eq!(env.company_view(&token_id).await?["calls"], 1);

    // report_metrics from anyone but the vault.
    for who in [&env.operator, &env.founder] {
        let outcome = who
            .call(env.registry.id(), "report_metrics")
            .args_json(json!({"token_id": token_id, "gross": "1", "retained": "1", "revenue_30d": "999999999", "calls": 1000}))
            .transact()
            .await?;
        assert_failed(&outcome, "ERR_ONLY_COMPANY_VAULT");
    }
    // Revenue paid to another company's vault does not touch this charter.
    let (_token2, vault2) = env.incorporate(&env.founder, "Second").await?;
    assert_ok(&env.pay(&customer, &vault2, 200_000, "call-x").await?);
    assert_eq!(u128_of(&env.company_view(&token_id).await?["revenue_30d"]), 1_000_000);
    Ok(())
}

// ------------------------------------------------------------------- 11: Dividends and compute

#[tokio::test]
async fn test_dividends_bounded_frozen_and_restored() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let customer = env.funded("customer", 5_000_000).await?;
    assert_ok(&env.pay(&customer, &vault, 1_000_000, "c1").await?);
    let retained = u128_of(&env.vault_state(&vault).await?["retained_earnings"]);
    assert_eq!(retained, 850_000);

    let claim = |amount: u128| {
        env.founder
            .call(&vault, "claim_dividends")
            .args_json(json!({"amount": amount.to_string()}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
    };

    // No yocto: rejected.
    let outcome = env
        .founder
        .call(&vault, "claim_dividends")
        .args_json(json!({"amount": "1"}))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&outcome, "Requires attached deposit of exactly 1 yoctoNEAR");

    // The founder has no USDC account yet, so ft_transfer fails and the balance is restored.
    let outcome = claim(100_000).await?;
    assert_failed(&outcome, "not registered");
    let state = env.vault_state(&vault).await?;
    assert_eq!(u128_of(&state["retained_earnings"]), retained);
    assert_eq!(u128_of(&state["dividends_paid"]), 0);

    env.register(env.founder.id()).await?;
    assert_failed(&claim(retained + 1).await?, "ERR_INSUFFICIENT_RETAINED_EARNINGS");
    assert_ok(&claim(300_000).await?);
    assert_eq!(env.balance(env.founder.id()).await?, 300_000);
    let state = env.vault_state(&vault).await?;
    assert_eq!(u128_of(&state["retained_earnings"]), retained - 300_000);
    assert_eq!(u128_of(&state["dividends_paid"]), 300_000);
    assert_eq!(u128_of(&env.company_view(&token_id).await?["retained"]), retained - 300_000);

    // Frozen while listed.
    assert_ok(&env.list(&env.founder, &token_id, 1_000_000).await?);
    assert_failed(&claim(1).await?, "ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN");
    Ok(())
}

#[tokio::test]
async fn test_compute_bill_only_from_reserve_to_payee_and_intents_deposit() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let customer = env.funded("customer", 5_000_000).await?;
    assert_ok(&env.pay(&customer, &vault, 1_000_000, "c1").await?);
    let reserve = 150_000u128;
    let retained = 850_000u128;

    let bill = |amount: u128| {
        env.operator
            .call(&vault, "pay_compute_bill")
            .args_json(json!({"amount": amount.to_string()}))
            .gas(MAX_GAS)
            .transact()
    };

    // Over the reserve, even though retained earnings could cover it.
    assert_failed(&bill(reserve + 1).await?, "ERR_INSUFFICIENT_COMPUTE_RESERVE");
    assert_ok(&bill(50_000).await?);
    assert_eq!(env.balance(env.payee.id()).await?, 50_000);
    let state = env.vault_state(&vault).await?;
    assert_eq!(u128_of(&state["compute_reserve"]), reserve - 50_000);
    assert_eq!(u128_of(&state["retained_earnings"]), retained);
    assert_eq!(u128_of(&state["compute_paid"]), 50_000);

    // The payee is not an argument.
    let outcome = env
        .operator
        .call(&vault, "pay_compute_bill")
        .args_json(json!({"amount": "1000", "compute_payee": env.operator.id(), "receiver_id": env.operator.id()}))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_ok(&outcome);
    assert_eq!(env.balance(env.payee.id()).await?, 51_000);
    assert_eq!(env.balance(env.operator.id()).await?, 0);

    // Failed ft_transfer restores the reserve: a company whose payee has no USDC account.
    assert_ok(
        &env.registry
            .call("set_default_policy")
            .args_json(json!({
                "default_operator": env.operator.id(),
                "compute_payee": customer.id().as_str().replace("customer", "unregistered-payee"),
                "allowed_tokens": [USDC_ASSET],
                "epoch_caps": [[USDC_ASSET, CAP.to_string()]],
                "tee_signers": [tee_address(&env.tee_key)],
                "tee_models": [TEST_MODEL],
                "tee_prompt_hash": prompt_hash(TEST_PROMPT),
                "price_floors": default_floors(),
            }))
            .deposit(ONE_YOCTO)
            .transact()
            .await?,
    );
    let (_token2, vault2) = env.incorporate(&env.founder, "Second").await?;
    assert_ok(&env.pay(&customer, &vault2, 1_000_000, "c2").await?);
    let failed = env
        .operator
        .call(&vault2, "pay_compute_bill")
        .args_json(json!({"amount": "1000"}))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&failed, "not registered");
    let state2 = env.vault_state(&vault2).await?;
    assert_eq!(u128_of(&state2["compute_reserve"]), 150_000);
    assert_eq!(u128_of(&state2["compute_paid"]), 0);

    // Retained earnings go only to the vault's own account on the verifier.
    let deposit = |amount: u128| {
        env.operator
            .call(&vault, "agent_deposit_to_intents")
            .args_json(json!({"amount": amount.to_string()}))
            .gas(MAX_GAS)
            .transact()
    };
    assert_failed(&deposit(retained + 1).await?, "ERR_INSUFFICIENT_RETAINED_EARNINGS");
    assert_ok(&deposit(200_000).await?);
    let balance: Value = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({"account_id": vault, "token_id": format!("nep141:{}", env.usdc.id())}))
        .await?
        .json()?;
    assert_eq!(u128_of(&balance), 200_000);
    let state = env.vault_state(&vault).await?;
    assert_eq!(u128_of(&state["retained_earnings"]), retained - 200_000);
    assert_eq!(u128_of(&state["deposited_to_intents"]), 200_000);

    // An unused deposit returns to retained earnings.
    assert_ok(&env.intents.call("set_reject_deposits").args_json(json!({"reject": true})).transact().await?);
    assert_ok(&deposit(100_000).await?);
    let state = env.vault_state(&vault).await?;
    assert_eq!(u128_of(&state["retained_earnings"]), retained - 200_000);
    assert_eq!(u128_of(&state["deposited_to_intents"]), 200_000);

    // Compute continues while listed; the agent's deposit path does not.
    assert_ok(&env.list(&env.founder, &token_id, 1_000_000).await?);
    assert_ok(&bill(1_000).await?);
    assert_failed(&deposit(1).await?, "ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN");
    Ok(())
}

// ------------------------------------------------------------------- 12: Credit and failures

async fn storage_deposit(env: &Env, who: &Account, amount: NearToken) -> Result<ExecutionFinalResult> {
    Ok(who.call(env.registry.id(), "storage_deposit").args_json(json!({})).deposit(amount).gas(MAX_GAS).transact().await?)
}

async fn fund_offer(env: &Env, lender: &Account, token_id: &str, principal: u128, repay: u128, term_ms: u64) -> Result<u64> {
    assert_ok(&storage_deposit(env, lender, NearToken::from_millinear(20)).await?);
    assert_ok(
        &env.ft_call(
            lender,
            env.registry.id(),
            principal,
            json!({"action": "fund_offer", "token_id": token_id, "repay_amount": repay.to_string(), "term_ms": term_ms}),
        )
        .await?,
    );
    let offers: Vec<Value> = env.registry.view("get_offers").args_json(json!({"token_id": token_id})).await?.json()?;
    Ok(offers.last().ok_or_else(|| anyhow!("offer not stored"))?["id"].as_u64().unwrap())
}

async fn accept(env: &Env, who: &Account, offer_id: u64) -> Result<ExecutionFinalResult> {
    Ok(who
        .call(env.registry.id(), "accept_offer")
        .args_json(json!({"offer_id": offer_id}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?)
}

/// Founder holds the charter until `borrower` takes it, so the royalty receiver is distinct.
async fn pledged_company(env: &Env, lender: &Account, borrower: &Account, principal: u128, repay: u128, term_ms: u64) -> Result<(String, AccountId, u64)> {
    let (token_id, vault) = env.company().await?;
    assert_ok(&env.transfer_nft(&env.founder, borrower.id(), &token_id).await?);
    let offer = fund_offer(env, lender, &token_id, principal, repay, term_ms).await?;
    assert_ok(&accept(env, borrower, offer).await?);
    Ok((token_id, vault, offer))
}

#[tokio::test]
async fn test_credit_offer_accept_repay_cycle() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let lender = env.funded("lender", 20_000_000).await?;
    let payer = env.funded("payer", 20_000_000).await?;
    let stranger = env.funded("stranger", 0).await?;
    let principal = 10_000_000u128;
    let debt = 11_000_000u128;

    // Bad offers are refunded.
    for bad in [
        json!({"action": "fund_offer", "token_id": token_id, "repay_amount": "1", "term_ms": 100}),
        json!({"action": "fund_offer", "token_id": token_id, "repay_amount": debt.to_string(), "term_ms": 0}),
        json!({"action": "fund_offer", "token_id": "404", "repay_amount": debt.to_string(), "term_ms": 100}),
        json!({"action": "nonsense"}),
    ] {
        assert_ok(&env.ft_call(&lender, env.registry.id(), principal, bad).await?);
        assert_eq!(env.balance(lender.id()).await?, 20_000_000);
    }

    let offer = fund_offer(&env, &lender, &token_id, principal, debt, 3_600_000).await?;
    assert_eq!(env.balance(env.registry.id()).await?, principal);
    env.register(env.founder.id()).await?;

    // Only the owner can accept, and only the lender can cancel.
    assert_failed(&accept(&env, &stranger, offer).await?, "ERR_NOT_TOKEN_OWNER");
    let not_lender = stranger
        .call(env.registry.id(), "cancel_offer")
        .args_json(json!({"offer_id": offer}))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert_failed(&not_lender, "ERR_NOT_OFFER_LENDER");

    let outcome = accept(&env, &env.founder, offer).await?;
    assert_ok(&outcome);

    // Freeze before disbursal, in receipt order.
    let logs = outcome.logs();
    let freeze = logs.iter().position(|l| l.contains("encumbrance_applied")).expect("no freeze log");
    let opened = logs.iter().position(|l| l.contains("loan_opened")).expect("no loan log");
    let transferred = logs.iter().position(|l| l.contains("ft_transfer")).expect("no ft_transfer log");
    assert!(freeze < opened && freeze < transferred, "disbursal before freeze: {logs:?}");

    assert_eq!(env.balance(env.founder.id()).await?, principal);
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["encumbrance"]["Pledged"]["lender"], lender.id().as_str());
    assert_eq!(u128_of(&state["encumbrance"]["Pledged"]["debt"]), debt);
    let svg = env.charter_svg(&token_id).await?;
    assert!(svg.contains("PLEDGED") && svg.contains("#7c3aed"));

    // Pledged: no transfer, no signature, no listing, no second loan.
    assert_failed(&env.transfer_nft(&env.founder, stranger.id(), &token_id).await?, "ERR_TOKEN_ENCUMBERED");
    assert_failed(&env.raw_sign(&env.founder, &vault).await?, "ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN");
    assert_failed(&env.list(&env.founder, &token_id, 1).await?, "ERR_TOKEN_ENCUMBERED");
    let second = fund_offer(&env, &lender, &token_id, 1_000_000, 1_000_000, 1000).await?;
    assert_failed(&accept(&env, &env.founder, second).await?, "ERR_TOKEN_ENCUMBERED");

    // The lender cancels the unused offer and gets the principal back.
    assert_ok(
        &lender
            .call(env.registry.id(), "cancel_offer")
            .args_json(json!({"offer_id": second}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    assert_eq!(env.balance(lender.id()).await?, 20_000_000 - principal);

    // Before due: no auction.
    let early = env.operator.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?;
    assert_failed(&early, "ERR_LOAN_NOT_DUE");

    // Repay below debt is refunded; above debt refunds the excess. Anyone may repay.
    let payer_before = env.balance(payer.id()).await?;
    assert_ok(&env.ft_call(&payer, env.registry.id(), debt - 1, json!({"action": "repay", "token_id": token_id})).await?);
    assert_eq!(env.balance(payer.id()).await?, payer_before);
    assert_ok(&env.ft_call(&payer, env.registry.id(), debt + 500, json!({"action": "repay", "token_id": token_id})).await?);
    assert_eq!(env.balance(payer.id()).await?, payer_before - debt);
    assert_eq!(env.balance(lender.id()).await?, 20_000_000 - principal + debt);

    let state = env.vault_state(&vault).await?;
    assert_eq!(state["encumbrance"], "Free");
    assert_eq!(state["shareholder"], env.founder.id().as_str());
    assert_eq!(env.company_view(&token_id).await?["encumbrance"], "Free");
    let loan: Value = env.registry.view("get_loan").args_json(json!({"token_id": token_id})).await?.json()?;
    assert!(loan.is_null());
    assert_ok(&env.transfer_nft(&env.founder, stranger.id(), &token_id).await?);
    Ok(())
}

#[tokio::test]
async fn test_default_dutch_auction_bid_pays_lender_royalty_borrower() -> Result<()> {
    let env = setup().await?;
    let lender = env.funded("lender", 20_000_000).await?;
    let borrower = env.funded("borrower", 0).await?;
    let bidder = env.funded("bidder", 40_000_000).await?;
    env.register(env.founder.id()).await?;
    let principal = 10_000_000u128;
    let debt = 12_000_000u128;
    let (token_id, vault, _) = pledged_company(&env, &lender, &borrower, principal, debt, 1_000).await?;
    assert_eq!(env.balance(borrower.id()).await?, principal);

    // Before the auction starts, a bid is refunded.
    assert_ok(&env.ft_call(&bidder, env.registry.id(), 30_000_000, json!({"action": "bid", "token_id": token_id})).await?);
    assert_eq!(env.balance(bidder.id()).await?, 40_000_000);

    env.advance_ms(2_000).await?;
    assert_ok(&env.operator.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?);
    let again = env.operator.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?;
    assert_failed(&again, "ERR_AUCTION_ALREADY_STARTED");

    let price = |env_ref: &Env| {
        let registry = env_ref.registry.clone();
        let token = token_id.clone();
        async move {
            let value: Value = registry.view("auction_price").args_json(json!({"token_id": token})).await?.json()?;
            Ok::<u128, anyhow::Error>(u128_of(&value))
        }
    };
    let first = price(&env).await?;
    assert!(first <= 2 * debt && first > debt, "unexpected start price {first}");

    // Below the current price: refunded.
    assert_ok(&env.ft_call(&bidder, env.registry.id(), debt / 2, json!({"action": "bid", "token_id": token_id})).await?);
    assert_eq!(env.balance(bidder.id()).await?, 40_000_000);

    env.advance_ms(30_000).await?;
    let later = price(&env).await?;
    assert!(later < first, "price did not decay: {first} -> {later}");
    assert!(later >= debt / 2);

    // Bid with a margin above the current price. The excess returns.
    let bid_amount = first;
    assert_ok(&env.ft_call(&bidder, env.registry.id(), bid_amount, json!({"action": "bid", "token_id": token_id})).await?);
    assert_eq!(env.owner_of(&token_id).await?, bidder.id().as_str());
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], bidder.id().as_str());
    assert_eq!(state["encumbrance"], "Free");

    let paid = 40_000_000 - env.balance(bidder.id()).await?;
    assert!(paid <= later, "paid {paid} above the price {later} seen before the bid");
    assert!(paid > debt, "test expects a price above debt, got {paid}");
    let remainder = paid - debt;
    let royalty = remainder * ROYALTY_BPS / 10_000;
    assert_eq!(env.balance(lender.id()).await?, 20_000_000 - principal + debt);
    assert_eq!(env.balance(env.founder.id()).await?, royalty);
    assert_eq!(env.balance(borrower.id()).await?, principal + remainder - royalty);
    assert_eq!(env.balance(env.registry.id()).await?, 0);
    let loan: Value = env.registry.view("get_loan").args_json(json!({"token_id": token_id})).await?.json()?;
    assert!(loan.is_null());
    Ok(())
}

#[tokio::test]
async fn test_no_bid_lender_claims_collateral() -> Result<()> {
    let env = setup_with_auction(5_000).await?;
    let lender = env.funded("lender", 20_000_000).await?;
    let borrower = env.funded("borrower", 0).await?;
    let (token_id, vault, _) = pledged_company(&env, &lender, &borrower, 5_000_000, 6_000_000, 1_000).await?;

    let claim = |who: Account| {
        let registry = env.registry.id().clone();
        let token = token_id.clone();
        async move {
            who.call(&registry, "claim_defaulted_collateral")
                .args_json(json!({"token_id": token}))
                .deposit(ONE_YOCTO)
                .gas(MAX_GAS)
                .transact()
                .await
        }
    };
    assert_failed(&claim(lender.clone()).await?, "ERR_AUCTION_NOT_STARTED");
    env.advance_ms(2_000).await?;
    assert_ok(&env.operator.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?);
    assert_failed(&claim(borrower.clone()).await?, "ERR_NOT_LOAN_LENDER");

    env.advance_ms(6_000).await?;
    // The price stops at the floor: 50% of debt.
    let floor: Value = env.registry.view("auction_price").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(u128_of(&floor), 3_000_000);
    // A bid after the window is refunded.
    let bidder = env.funded("late-bidder", 20_000_000).await?;
    assert_ok(&env.ft_call(&bidder, env.registry.id(), 20_000_000, json!({"action": "bid", "token_id": token_id})).await?);
    assert_eq!(env.balance(bidder.id()).await?, 20_000_000);

    assert_ok(&claim(lender.clone()).await?);
    assert_eq!(env.owner_of(&token_id).await?, lender.id().as_str());
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], lender.id().as_str());
    assert_eq!(state["encumbrance"], "Free");
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["encumbrance"], "Free");
    assert_eq!(company["settling"], false);
    Ok(())
}

#[tokio::test]
async fn test_vault_failure_leaves_no_stuck_lock_and_refunds_via_resolve() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let buyer = env.funded("buyer", 50_000_000).await?;
    let other = env.funded("other", 0).await?;
    env.register(env.founder.id()).await?;
    let ask = 10_000_000u128;
    assert_ok(&env.list(&env.founder, &token_id, ask).await?);

    // Below ask: refund without touching the vault.
    assert_ok(&env.ft_call(&buyer, env.registry.id(), ask - 1, env.acquire_msg(&token_id).await?).await?);
    assert_eq!(env.balance(buyer.id()).await?, 50_000_000);

    // The vault cannot accept the call: the buyer gets everything back through ft_resolve_transfer.
    env.break_vault(&vault).await?;
    let outcome = env
        .ft_call(&buyer, env.registry.id(), ask, env.acquire_msg(&token_id).await?)
        .await?;
    assert_failed(&outcome, "MethodNotFound");
    assert_eq!(env.balance(buyer.id()).await?, 50_000_000, "buyer not refunded");
    assert_eq!(env.balance(env.registry.id()).await?, 0);
    assert_eq!(env.owner_of(&token_id).await?, env.founder.id().as_str());
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["settling"], false, "lock stuck after failed acquire");
    assert!(company["encumbrance"]["Listed"].is_object());
    env.restore_vault(&vault).await?;

    // Market still works afterwards.
    assert_ok(&env.ft_call(&buyer, env.registry.id(), ask, env.acquire_msg(&token_id).await?).await?);
    assert_eq!(env.owner_of(&token_id).await?, buyer.id().as_str());

    // Failed sync on a plain transfer: nothing moves, lock cleared.
    env.break_vault(&vault).await?;
    let outcome = env.transfer_nft(&buyer, other.id(), &token_id).await?;
    assert_failed(&outcome, "MethodNotFound");
    assert_eq!(env.owner_of(&token_id).await?, buyer.id().as_str());
    assert_eq!(env.company_view(&token_id).await?["settling"], false);

    // Failed freeze on a listing: not listed, lock cleared.
    let outcome = env.list(&buyer, &token_id, ask).await?;
    assert_failed(&outcome, "ERR_VAULT_FREEZE_FAILED");
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["encumbrance"], "Free");
    assert_eq!(company["settling"], false);

    // Failed freeze on a pledge: offer intact and reusable, no principal paid.
    env.restore_vault(&vault).await?;
    let lender = env.funded("lender", 5_000_000).await?;
    let offer = fund_offer(&env, &lender, &token_id, 5_000_000, 5_500_000, 3_600_000).await?;
    env.break_vault(&vault).await?;
    let outcome = accept(&env, &buyer, offer).await?;
    assert_failed(&outcome, "ERR_VAULT_FREEZE_FAILED");
    assert_eq!(env.balance(buyer.id()).await?, 50_000_000 - ask, "principal paid without a freeze");
    let offers: Vec<Value> = env.registry.view("get_offers").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(offers[0]["settling"], false);
    assert_eq!(env.company_view(&token_id).await?["settling"], false);
    env.restore_vault(&vault).await?;

    assert_ok(&accept(&env, &buyer, offer).await?);
    assert_eq!(env.balance(buyer.id()).await?, 50_000_000 - ask + 5_000_000);

    // Repay with a broken vault: payer refunded, loan still open.
    let payer = env.funded("payer", 6_000_000).await?;
    env.break_vault(&vault).await?;
    assert_failed(
        &env.ft_call(&payer, env.registry.id(), 5_500_000, json!({"action": "repay", "token_id": token_id})).await?,
        "MethodNotFound",
    );
    assert_eq!(env.balance(payer.id()).await?, 6_000_000);
    let loan: Value = env.registry.view("get_loan").args_json(json!({"token_id": token_id})).await?.json()?;
    assert!(!loan.is_null());
    assert_eq!(env.company_view(&token_id).await?["settling"], false);
    env.restore_vault(&vault).await?;
    Ok(())
}

#[tokio::test]
async fn test_signer_failure_does_not_lock_anything() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    assert_ok(&env.mpc.call("set_fail_sign").args_json(json!({"fail": true})).transact().await?);

    // Agent path: the nonce and cap stay spent, per the design. Nothing else changes.
    let outcome = env.swap(&env.operator, &vault, &token_id, 1_000).await?;
    assert_failed(&outcome, "ERR_MPC_SIGNATURE_FAILED");
    let state = env.vault_state(&vault).await?;
    assert_eq!(u128_of(&state["spent_this_window"][0][1]), 1_000);

    // Raw path: the counter was incremented before the call and stays incremented.
    let outcome = env.raw_sign(&env.founder, &vault).await?;
    assert_failed(&outcome, "double: forced sign failure");
    assert_eq!(env.vault_state(&vault).await?["raw_sigs_this_epoch"], 1);

    // Rotation clears it and the company can be listed once intents expire.
    assert_ok(&env.mpc.call("set_fail_sign").args_json(json!({"fail": false})).transact().await?);
    assert_ok(&env.founder.call(&vault, "rotate_treasury_epoch").deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?);
    env.advance_ms(301_000).await?;
    assert_ok(&env.list(&env.founder, &token_id, 1_000_000).await?);
    assert_eq!(env.company_view(&token_id).await?["settling"], false);
    Ok(())
}

#[tokio::test]
async fn test_failed_payouts_credit_pending_withdrawals() -> Result<()> {
    let env = setup().await?;
    let (token_id, _vault) = env.company().await?;
    let buyer = env.funded("buyer", 20_000_000).await?;
    let seller = account(&env.root, "seller", 20).await?;
    let ask = 10_000_000u128;

    // Neither founder nor seller has a USDC account.
    assert_ok(&env.transfer_nft(&env.founder, seller.id(), &token_id).await?);
    assert_ok(&env.list(&seller, &token_id, ask).await?);
    let outcome = env.ft_call(&buyer, env.registry.id(), ask, env.acquire_msg(&token_id).await?).await?;
    assert_failed(&outcome, "not registered");
    assert_eq!(env.owner_of(&token_id).await?, buyer.id().as_str());

    let royalty = ask * ROYALTY_BPS / 10_000;
    let pending = |id: AccountId| {
        let registry = env.registry.clone();
        async move {
            let value: Value = registry.view("pending_withdrawal").args_json(json!({"account_id": id})).await?.json()?;
            Ok::<u128, anyhow::Error>(u128_of(&value))
        }
    };
    assert_eq!(pending(env.founder.id().clone()).await?, royalty);
    assert_eq!(pending(seller.id().clone()).await?, ask - royalty);
    assert_eq!(env.balance(env.registry.id()).await?, ask);

    // Withdrawing before registering fails and keeps the credit.
    let outcome = seller.call(env.registry.id(), "withdraw_pending").deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?;
    assert_failed(&outcome, "not registered");
    assert_eq!(pending(seller.id().clone()).await?, ask - royalty);

    env.register(seller.id()).await?;
    assert_ok(&seller.call(env.registry.id(), "withdraw_pending").deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?);
    assert_eq!(env.balance(seller.id()).await?, ask - royalty);
    assert_eq!(pending(seller.id().clone()).await?, 0);
    let again = seller.call(env.registry.id(), "withdraw_pending").deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?;
    assert_failed(&again, "ERR_NOTHING_PENDING");
    Ok(())
}

// ------------------------------------------------------------------- 13: NEP-171/178/199

#[tokio::test]
async fn test_nft_transfer_syncs_vault_and_approvals_clear() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let friend = account(&env.root, "friend", 10).await?;
    let spender = account(&env.root, "spender", 10).await?;
    let stranger = account(&env.root, "stranger", 10).await?;

    // A stranger cannot move it, and the vault is not contacted.
    assert_failed(&env.transfer_nft(&stranger, friend.id(), &token_id).await?, "ERR_NOT_APPROVED");
    assert_eq!(env.vault_state(&vault).await?["sync_nonce"], 0);

    assert_ok(
        &env.founder
            .call(env.registry.id(), "nft_approve")
            .args_json(json!({"token_id": token_id, "account_id": spender.id()}))
            .deposit(NearToken::from_millinear(10))
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    let token: Value = env.registry.view("nft_token").args_json(json!({"token_id": token_id})).await?.json()?;
    let approval_id = token["approved_account_ids"][spender.id().as_str()].as_u64().unwrap();
    let approved: bool = env
        .registry
        .view("nft_is_approved")
        .args_json(json!({"token_id": token_id, "approved_account_id": spender.id(), "approval_id": approval_id}))
        .await?
        .json()?;
    assert!(approved);

    // Wrong approval id.
    let outcome = spender
        .call(env.registry.id(), "nft_transfer")
        .args_json(json!({"receiver_id": friend.id(), "token_id": token_id, "approval_id": approval_id + 7}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&outcome, "ERR_APPROVAL_ID_MISMATCH");

    // The approved account moves it; vault sync lands before the ownership log.
    let outcome = spender
        .call(env.registry.id(), "nft_transfer")
        .args_json(json!({"receiver_id": friend.id(), "token_id": token_id, "approval_id": approval_id}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_ok(&outcome);
    let logs = outcome.logs();
    let synced = logs.iter().position(|l| l.contains("owner_synced")).expect("no sync log");
    let moved = logs.iter().position(|l| l.contains("nft_transfer")).expect("no transfer log");
    assert!(synced < moved, "ownership moved before the vault sync: {logs:?}");
    assert!(logs[moved].contains(spender.id().as_str()), "authorized_id missing: {}", logs[moved]);

    assert_eq!(env.owner_of(&token_id).await?, friend.id().as_str());
    assert_eq!(env.vault_state(&vault).await?["shareholder"], friend.id().as_str());
    let token: Value = env.registry.view("nft_token").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(token["approved_account_ids"], json!({}), "approvals not cleared");

    // The old approval no longer works, and the old owner has no vault rights.
    assert_failed(&env.transfer_nft(&spender, stranger.id(), &token_id).await?, "ERR_NOT_APPROVED");
    assert_failed(&env.raw_sign(&env.founder, &vault).await?, "ERR_ONLY_CURRENT_SHAREHOLDER");
    assert_failed(&env.transfer_nft(&friend, friend.id(), &token_id).await?, "ERR_RECEIVER_IS_OWNER");

    // Approvals on a listed token do not let it move.
    assert_ok(
        &friend
            .call(env.registry.id(), "nft_approve")
            .args_json(json!({"token_id": token_id, "account_id": spender.id()}))
            .deposit(NearToken::from_millinear(10))
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    assert_ok(&env.list(&friend, &token_id, 1_000_000).await?);
    assert_failed(&env.transfer_nft(&spender, stranger.id(), &token_id).await?, "ERR_TOKEN_ENCUMBERED");
    assert_failed(&env.transfer_nft(&friend, stranger.id(), &token_id).await?, "ERR_TOKEN_ENCUMBERED");

    // A sale clears approvals as well.
    let buyer = env.funded("buyer", 2_000_000).await?;
    env.register(env.founder.id()).await?;
    env.register(friend.id()).await?;
    assert_ok(&env.ft_call(&buyer, env.registry.id(), 1_000_000, env.acquire_msg(&token_id).await?).await?);
    let token: Value = env.registry.view("nft_token").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(token["approved_account_ids"], json!({}));
    Ok(())
}

#[tokio::test]
async fn test_nft_transfer_call_keep_and_revert_resyncs_vault() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let receiver = env.intents.id().clone();

    let call = |msg: &str| {
        env.founder
            .call(env.registry.id(), "nft_transfer_call")
            .args_json(json!({"receiver_id": receiver, "token_id": token_id, "msg": msg}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
    };

    // The receiver asks for the token back: ownership and the vault both return.
    let outcome = call("return").await?;
    assert_ok(&outcome);
    assert!(!outcome.json::<bool>()?);
    assert_eq!(env.owner_of(&token_id).await?, env.founder.id().as_str());
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], env.founder.id().as_str());
    assert_eq!(env.company_view(&token_id).await?["settling"], false);

    // The receiver keeps it.
    let outcome = call("keep").await?;
    assert_ok(&outcome);
    assert!(outcome.json::<bool>()?);
    assert_eq!(env.owner_of(&token_id).await?, receiver.as_str());
    assert_eq!(env.vault_state(&vault).await?["shareholder"], receiver.as_str());
    assert_eq!(env.company_view(&token_id).await?["settling"], false);

    // A receiver without nft_on_transfer: the failed call reverts it.
    let (token2, vault2) = env.incorporate(&env.founder, "Second").await?;
    let outcome = env
        .founder
        .call(env.registry.id(), "nft_transfer_call")
        .args_json(json!({"receiver_id": env.mpc.id(), "token_id": token2, "msg": ""}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&outcome, "MethodNotFound");
    assert_eq!(env.owner_of(&token2).await?, env.founder.id().as_str());
    assert_eq!(env.vault_state(&vault2).await?["shareholder"], env.founder.id().as_str());
    assert_eq!(env.company_view(&token2).await?["settling"], false);
    Ok(())
}

#[tokio::test]
async fn test_nep199_payout_respects_royalty_and_encumbrance() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let owner = account(&env.root, "owner", 10).await?;
    let market = account(&env.root, "market", 10).await?;
    let buyer = account(&env.root, "buyer", 10).await?;
    assert_ok(&env.transfer_nft(&env.founder, owner.id(), &token_id).await?);

    let balance = 1_000_000u128;
    let royalty = balance * ROYALTY_BPS / 10_000;
    let payout: Value = env
        .registry
        .view("nft_payout")
        .args_json(json!({"token_id": token_id, "balance": balance.to_string(), "max_len_payout": 2}))
        .await?
        .json()?;
    assert_eq!(u128_of(&payout["payout"][env.founder.id().as_str()]), royalty);
    assert_eq!(u128_of(&payout["payout"][owner.id().as_str()]), balance - royalty);

    let too_short = env
        .registry
        .view("nft_payout")
        .args_json(json!({"token_id": token_id, "balance": "1000000", "max_len_payout": 1}))
        .await;
    assert!(format!("{too_short:?}").contains("ERR_PAYOUT_TOO_LONG"), "{too_short:?}");

    // Listed: both refuse.
    assert_ok(&env.list(&owner, &token_id, 1_000_000).await?);
    let encumbered = env
        .registry
        .view("nft_payout")
        .args_json(json!({"token_id": token_id, "balance": "1000000", "max_len_payout": 2}))
        .await;
    assert!(format!("{encumbered:?}").contains("ERR_TOKEN_ENCUMBERED"), "{encumbered:?}");
    let transfer_payout = |who: &Account| {
        who.call(env.registry.id(), "nft_transfer_payout")
            .args_json(json!({"receiver_id": buyer.id(), "token_id": token_id, "balance": balance.to_string(), "max_len_payout": 2}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
    };
    assert_failed(&transfer_payout(&owner).await?, "ERR_TOKEN_ENCUMBERED");

    assert_ok(
        &owner
            .call(env.registry.id(), "unlist_company")
            .args_json(json!({"token_id": token_id}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    assert_eq!(env.vault_state(&vault).await?["encumbrance"], "Free");

    // Free, called by an approved marketplace.
    assert_ok(
        &owner
            .call(env.registry.id(), "nft_approve")
            .args_json(json!({"token_id": token_id, "account_id": market.id()}))
            .deposit(NearToken::from_millinear(10))
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    let outcome = transfer_payout(&market).await?;
    assert_ok(&outcome);
    let payout: Value = outcome.json()?;
    assert_eq!(u128_of(&payout["payout"][env.founder.id().as_str()]), royalty);
    assert_eq!(u128_of(&payout["payout"][owner.id().as_str()]), balance - royalty);
    assert_eq!(env.owner_of(&token_id).await?, buyer.id().as_str());
    assert_eq!(env.vault_state(&vault).await?["shareholder"], buyer.id().as_str());
    let token: Value = env.registry.view("nft_token").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(token["approved_account_ids"], json!({}));
    Ok(())
}

// ------------------------------------------------------------------- 14: Keys and addresses

fn independent_evm(xy: &[u8]) -> String {
    format!("0x{}", hex::encode(&Keccak256::digest(xy)[12..]))
}

fn independent_btc(xy: &[u8], hrp: &str) -> Result<String> {
    let mut sec1 = vec![4u8];
    sec1.extend_from_slice(xy);
    let key = VerifyingKey::from_sec1_bytes(&sec1)?;
    let compressed = key.to_encoded_point(true);
    let program = Ripemd160::digest(Sha256::digest(compressed.as_bytes()));
    Ok(bech32::segwit::encode_v0(bech32::Hrp::parse(hrp)?, &program)?)
}

#[tokio::test]
async fn test_refresh_treasury_keys_matches_independent_derivation() -> Result<()> {
    let env = setup().await?;
    let (_token_id, vault) = env.company().await?;
    assert!(env.vault_state(&vault).await?["addresses"].is_null());

    let outcome = env.refresh(&vault).await?;
    assert_ok(&outcome);
    let addresses: Value = env.worker.view(&vault, "treasury_addresses").await?.json()?;

    let secp: String = env
        .mpc
        .view("derived_public_key")
        .args_json(json!({"path": "incorpr-1-e0-treasury", "predecessor": vault, "domain_id": 0}))
        .await?
        .json()?;
    let ed: String = env
        .mpc
        .view("derived_public_key")
        .args_json(json!({"path": "incorpr-1-e0-treasury", "predecessor": vault, "domain_id": 1}))
        .await?
        .json()?;
    assert_eq!(addresses["secp256k1_key"], secp);
    assert_eq!(addresses["ed25519_key"], ed);

    let xy = bs58::decode(secp.strip_prefix("secp256k1:").unwrap()).into_vec()?;
    assert_eq!(xy.len(), 64);
    assert_eq!(addresses["evm"], independent_evm(&xy));
    assert_eq!(addresses["btc"], independent_btc(&xy, "tb")?);
    assert!(addresses["btc"].as_str().unwrap().starts_with("tb1q"));

    let ed_bytes = bs58::decode(ed.strip_prefix("ed25519:").unwrap()).into_vec()?;
    assert_eq!(ed_bytes.len(), 32);
    assert_eq!(addresses["sol"], bs58::encode(&ed_bytes).into_string());
    assert_eq!(addresses["sol"], ed.strip_prefix("ed25519:").unwrap());

    // A mainnet-configured vault derives a bc1 address from the same key material.
    assert_eq!(independent_btc(&xy, "bc")?.len(), addresses["btc"].as_str().unwrap().len());

    // Failed derivation leaves the old addresses alone and surfaces the error.
    let before = env.vault_state(&vault).await?["addresses"].clone();
    assert_ok(&env.mpc.call("set_fail_derive").args_json(json!({"fail": true})).transact().await?);
    let outcome = env.refresh(&vault).await?;
    assert_failed(&outcome, "ERR_MPC_DERIVATION_FAILED");
    assert_eq!(env.vault_state(&vault).await?["addresses"], before);
    Ok(())
}

#[tokio::test]
async fn test_setup_intents_key_registers_exactly_the_derived_key() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let anyone = account(&env.root, "anyone", 10).await?;

    // A caller-supplied key is ignored: the method takes no key.
    let chosen = "ed25519:E3Trc6Kdz6eVN9usuTkcTrycqjSJ7EDC2sQ6rRDsnDSH";
    let outcome = anyone
        .call(&vault, "setup_intents_key")
        .args_json(json!({"public_key": chosen, "key": chosen}))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_ok(&outcome);

    let derived: String = env
        .mpc
        .view("derived_public_key")
        .args_json(json!({"path": format!("incorpr-{token_id}-intents"), "predecessor": vault, "domain_id": 1}))
        .await?
        .json()?;
    let keys: Vec<String> = env.intents.view("public_keys_of").args_json(json!({"account_id": vault})).await?.json()?;
    assert_eq!(keys, vec![derived.clone()]);
    assert_ne!(derived, chosen);
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["intents_key"], derived);
    assert_eq!(state["intents_key_registered"], true);

    // Idempotent: a second call adds nothing and returns the same key.
    let outcome = anyone.call(&vault, "setup_intents_key").gas(MAX_GAS).transact().await?;
    assert_ok(&outcome);
    assert_eq!(outcome.json::<String>()?, derived);
    assert_eq!(env.intents.view("add_key_calls").await?.json::<u64>()?, 1);

    // Callbacks are private, so nobody can feed in a different key.
    for (method, args) in [
        ("on_intents_key_derived", json!({})),
        ("on_intents_key_added", json!({})),
        ("on_treasury_keys", json!({"epoch": 0})),
        ("on_intent_signed", json!({"message": "m", "nonce_b64": "n"})),
    ] {
        let outcome = anyone.call(&vault, method).args_json(args).gas(MAX_GAS).transact().await?;
        assert_failed(&outcome, "is private");
    }

    // Registration failure leaves the flag off, and a retry works.
    let (_t2, vault2) = env.incorporate(&env.founder, "Second").await?;
    assert_ok(&env.intents.call("set_fail_add_key").args_json(json!({"fail": true})).transact().await?);
    let outcome = anyone.call(&vault2, "setup_intents_key").gas(MAX_GAS).transact().await?;
    assert_failed(&outcome, "ERR_INTENTS_KEY_REGISTRATION_FAILED");
    assert_eq!(env.vault_state(&vault2).await?["intents_key_registered"], false);
    assert_ok(&env.intents.call("set_fail_add_key").args_json(json!({"fail": false})).transact().await?);
    assert_ok(&anyone.call(&vault2, "setup_intents_key").gas(MAX_GAS).transact().await?);
    assert_eq!(env.vault_state(&vault2).await?["intents_key_registered"], true);

    // Without the registered key, the agent gets a clear error and no signer call.
    let (t3, vault3) = env.incorporate(&env.founder, "Third").await?;
    let count = env.sign_count().await?;
    assert_failed(&env.swap(&env.operator, &vault3, &t3, 1_000).await?, "ERR_INTENTS_KEY_NOT_SET");
    assert_eq!(env.sign_count().await?, count);
    Ok(())
}

#[tokio::test]
async fn test_signed_intent_verifies_against_registered_key_with_independent_hash() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;

    let nonce = random_nonce();
    let hash = proposal_hash(&token_id, "swap", &[USDC_ASSET, "2500", SOL_ASSET, "7"], &nonce);
    let outcome = env
        .swap_with(&env.operator, &vault, USDC_ASSET, 2500, SOL_ASSET, 7, &nonce, approval(&env.tee_key, &hash))
        .await?;
    assert_ok(&outcome);
    let signed: Value = outcome.json()?;

    assert_eq!(signed["standard"], "nep413");
    assert_eq!(signed["payload"]["nonce"], nonce);
    assert_eq!(signed["payload"]["recipient"], env.intents.id().as_str());
    let public_key = signed["public_key"].as_str().unwrap();
    assert_eq!(env.vault_state(&vault).await?["intents_key"], public_key);

    let message = signed["payload"]["message"].as_str().unwrap();
    let parsed: Value = serde_json::from_str(message)?;
    assert_eq!(parsed["signer_id"], vault.as_str());
    assert_eq!(parsed["intents"][0]["intent"], "token_diff");
    assert_eq!(parsed["intents"][0]["diff"][USDC_ASSET], "-2500");
    assert_eq!(parsed["intents"][0]["diff"][SOL_ASSET], "7");
    let deadline = parsed["deadline"].as_str().unwrap();
    assert!(deadline.ends_with('Z') && deadline.len() == 24, "deadline format: {deadline}");

    // NEP-413 hash computed here without any vault code.
    let nonce_bytes = BASE64.decode(&nonce)?;
    let mut preimage = 2_147_484_061u32.to_le_bytes().to_vec();
    preimage.extend_from_slice(&(message.len() as u32).to_le_bytes());
    preimage.extend_from_slice(message.as_bytes());
    preimage.extend_from_slice(&nonce_bytes);
    let recipient = env.intents.id().as_str();
    preimage.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
    preimage.extend_from_slice(recipient.as_bytes());
    preimage.push(0);
    let nep413_hash = Sha256::digest(&preimage);

    let key_bytes: [u8; 32] = bs58::decode(public_key.strip_prefix("ed25519:").unwrap())
        .into_vec()?
        .try_into()
        .map_err(|_| anyhow!("key length"))?;
    let signature_bytes: [u8; 64] = bs58::decode(signed["signature"].as_str().unwrap().strip_prefix("ed25519:").unwrap())
        .into_vec()?
        .try_into()
        .map_err(|_| anyhow!("signature length"))?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key_bytes)?;
    key.verify(&nep413_hash, &ed25519_dalek::Signature::from_bytes(&signature_bytes))?;

    // The signer saw the hash on the intents path, domain 1.
    let calls: Vec<Value> = env.mpc.view("sign_calls").await?.json()?;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["predecessor"], vault.as_str());
    assert_eq!(calls[0]["request"]["path"], format!("incorpr-{token_id}-intents"));
    assert_eq!(calls[0]["request"]["domain_id"], 1);
    assert_eq!(calls[0]["request"]["payload_v2"]["Eddsa"], hex::encode(nep413_hash));
    Ok(())
}

#[tokio::test]
async fn test_shareholder_signature_response_and_gas_guard() -> Result<()> {
    let env = setup().await?;
    let (_token_id, vault) = env.company().await?;

    let payload = [7u8; 32];
    let outcome = env
        .founder
        .call(&vault, "request_shareholder_signature")
        .args_json(json!({"domain_id": 0, "payload_hex": hex::encode(payload), "subpath": "treasury"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_ok(&outcome);
    let response: Value = outcome.json()?;
    assert_eq!(response["scheme"], "Secp256k1");

    // The signature recovers to the key the signer publishes for this path.
    let big_r = hex::decode(response["big_r"]["affine_point"].as_str().unwrap())?;
    let s = hex::decode(response["s"]["scalar"].as_str().unwrap())?;
    assert_eq!((big_r.len(), s.len()), (33, 32));
    let mut rs = big_r[1..].to_vec();
    rs.extend_from_slice(&s);
    let signature = EcdsaSignature::from_slice(&rs)?;
    let recovery = RecoveryId::try_from(response["recovery_id"].as_u64().unwrap() as u8)?;
    let recovered = VerifyingKey::recover_from_prehash(&payload, &signature, recovery)?;
    let derived: String = env
        .mpc
        .view("derived_public_key")
        .args_json(json!({"path": "incorpr-1-e0-treasury", "predecessor": vault, "domain_id": 0}))
        .await?
        .json()?;
    let expected = bs58::decode(derived.strip_prefix("secp256k1:").unwrap()).into_vec()?;
    assert_eq!(&recovered.to_encoded_point(false).as_bytes()[1..], expected.as_slice());

    // No deposit: refused, as the live signer would. Counter unchanged.
    let before = env.vault_state(&vault).await?["raw_sigs_this_epoch"].as_u64().unwrap();
    let outcome = env
        .founder
        .call(&vault, "request_shareholder_signature")
        .args_json(json!({"domain_id": 0, "payload_hex": hex::encode(payload), "subpath": "treasury"}))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&outcome, "ERR_SIGNATURE_REQUIRES_DEPOSIT");

    // Too little gas to give the signer its share: refused before state changes.
    let outcome = env
        .founder
        .call(&vault, "request_shareholder_signature")
        .args_json(json!({"domain_id": 0, "payload_hex": hex::encode(payload), "subpath": "treasury"}))
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(40))
        .transact()
        .await?;
    assert_failed(&outcome, "ERR_INSUFFICIENT_GAS_FOR_SIGNATURE");
    assert_eq!(env.vault_state(&vault).await?["raw_sigs_this_epoch"].as_u64().unwrap(), before);
    Ok(())
}

#[tokio::test]
async fn test_incorporation_validation_and_failed_batch_refund() -> Result<()> {
    let env = setup().await?;
    let cost = env.incorporation_cost().await?;
    let args = |royalty: u16, targets: [u16; 3]| {
        json!({"args": {
            "name": "Bad",
            "service_template": "t",
            "price_micro_usdc": "1000",
            "target_bps": targets,
            "founder_royalty_bps": royalty,
            "compute_reserve_bps": 1000,
        }})
    };
    let call = |a: Value, deposit: NearToken| {
        env.founder
            .call(env.registry.id(), "incorporate_company")
            .args_json(a)
            .deposit(deposit)
            .gas(MAX_GAS)
            .transact()
    };
    assert_failed(&call(args(1001, [4000, 3000, 3000]), cost).await?, "ERR_INVALID_ROYALTY");
    assert_failed(&call(args(100, [4000, 3000, 2999]), cost).await?, "ERR_INVALID_TARGET_ALLOCATION");
    assert_failed(
        &call(args(100, [4000, 3000, 3000]), NearToken::from_near(1)).await?,
        "ERR_INSUFFICIENT_DEPOSIT",
    );

    // The vault's `new` rejects a malformed TEE signer, which fails the whole batch.
    let bad_policy = env
        .registry
        .call("set_default_policy")
        .args_json(json!({
            "default_operator": env.operator.id(),
            "compute_payee": env.payee.id(),
            "allowed_tokens": [],
            "epoch_caps": [],
            "tee_signers": ["not-an-address"],
            "tee_models": [],
            "tee_prompt_hash": "",
            "price_floors": [],
        }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert_ok(&bad_policy);

    let before = env.founder.view_account().await?.balance;
    let outcome = call(args(100, [4000, 3000, 3000]), cost).await?;
    assert_failed(&outcome, "ERR_INVALID_POLICY");
    let after = env.founder.view_account().await?.balance;
    let lost = before.as_yoctonear() - after.as_yoctonear();
    assert!(lost < NearToken::from_millinear(100).as_yoctonear(), "founder lost {lost} yocto");
    assert!(env.registry.view("nft_token").args_json(json!({"token_id": "1"})).await?.json::<Value>()?.is_null());
    assert!(env.worker.view_account(&format!("c-1.{}", env.registry.id()).parse()?).await.is_err());

    // Only the registry owner can change defaults.
    let outcome = env
        .founder
        .call(env.registry.id(), "set_default_policy")
        .args_json(json!({
            "default_operator": env.founder.id(),
            "compute_payee": env.founder.id(),
            "allowed_tokens": [],
            "epoch_caps": [],
            "tee_signers": [],
            "tee_models": [],
            "tee_prompt_hash": "",
            "price_floors": [],
        }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert_failed(&outcome, "ERR_ONLY_REGISTRY_OWNER");

    let page: Vec<Value> = env.registry.view("list_companies").args_json(json!({"from": 0, "limit": 10})).await?.json()?;
    assert!(page.is_empty());
    Ok(())
}

#[tokio::test]
async fn test_concurrent_market_call_hits_settling_lock() -> Result<()> {
    let env = setup().await?;
    let (token_id, _vault) = env.company().await?;

    // Two owner calls in flight together. One takes the lock and the other cannot race it.
    let first = env
        .founder
        .call(env.registry.id(), "list_company")
        .args_json(json!({"token_id": token_id, "ask": "1000000"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact_async()
        .await?;
    let second = env
        .founder
        .call(env.registry.id(), "list_company")
        .args_json(json!({"token_id": token_id, "ask": "2000000"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact_async()
        .await?;
    let first = first.await?;
    let second = second.await?;
    let successes = [&first, &second].iter().filter(|o| o.failures().is_empty()).count();
    assert_eq!(successes, 1, "exactly one listing wins: {} / {}", failure_text(&first), failure_text(&second));
    let loser = if first.failures().is_empty() { &second } else { &first };
    let text = failure_text(loser);
    assert!(text.contains("ERR_TOKEN_SETTLING") || text.contains("ERR_TOKEN_ENCUMBERED"), "{text}");
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["settling"], false);
    assert!(company["encumbrance"]["Listed"].is_object());
    Ok(())
}

#[tokio::test]
async fn test_auction_vault_failure_refunds_bidder_and_keeps_loan() -> Result<()> {
    let env = setup_with_auction(5_000).await?;
    let lender = env.funded("lender", 20_000_000).await?;
    let borrower = env.funded("borrower", 0).await?;
    let bidder = env.funded("bidder", 30_000_000).await?;
    let (token_id, vault, _) = pledged_company(&env, &lender, &borrower, 5_000_000, 6_000_000, 1_000).await?;
    env.advance_ms(2_000).await?;
    assert_ok(&env.operator.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?);

    env.break_vault(&vault).await?;
    let outcome = env
        .ft_call(&bidder, env.registry.id(), 13_000_000, json!({"action": "bid", "token_id": token_id}))
        .await?;
    assert_failed(&outcome, "MethodNotFound");
    assert_eq!(env.balance(bidder.id()).await?, 30_000_000, "bidder not refunded");
    assert_eq!(env.owner_of(&token_id).await?, borrower.id().as_str());
    let loan: Value = env.registry.view("get_loan").args_json(json!({"token_id": token_id})).await?.json()?;
    assert!(!loan.is_null());
    assert_eq!(env.company_view(&token_id).await?["settling"], false);

    // The window closes. A failed claim keeps the lender's position and clears the lock.
    env.advance_ms(6_000).await?;
    let claim = lender
        .call(env.registry.id(), "claim_defaulted_collateral")
        .args_json(json!({"token_id": token_id}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&claim, "ERR_VAULT_UNFREEZE_FAILED");
    assert_eq!(env.owner_of(&token_id).await?, borrower.id().as_str());
    assert_eq!(env.company_view(&token_id).await?["settling"], false);
    env.restore_vault(&vault).await?;
    let claim = lender
        .call(env.registry.id(), "claim_defaulted_collateral")
        .args_json(json!({"token_id": token_id}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_ok(&claim);
    assert_eq!(env.owner_of(&token_id).await?, lender.id().as_str());
    Ok(())
}

#[tokio::test]
async fn test_settling_lock_rejects_calls_and_failed_revert_needs_resync() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let buyer = env.funded("buyer", 5_000_000).await?;
    let stranger = account(&env.root, "stranger", 10).await?;
    let receiver = env.intents.id().clone();

    // The receiver holds the transfer open across many blocks before asking for the token back.
    let pending = env
        .founder
        .call(env.registry.id(), "nft_transfer_call")
        .args_json(json!({"receiver_id": receiver, "token_id": token_id, "msg": "slow-return:40"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact_async()
        .await?;
    for _ in 0..50 {
        if env.owner_of(&token_id).await? == receiver.as_str() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(env.owner_of(&token_id).await?, receiver.as_str());
    assert_eq!(env.company_view(&token_id).await?["settling"], true);

    // The vault breaks while the transfer is open, so the revert cannot re-sync.
    env.break_vault(&vault).await?;

    // Calls during the lock.
    let approve = env
        .founder
        .call(env.registry.id(), "nft_approve")
        .args_json(json!({"token_id": token_id, "account_id": stranger.id()}))
        .deposit(NearToken::from_millinear(10))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&approve, "ERR_TOKEN_SETTLING");
    let transfer = env
        .intents
        .as_account()
        .call(env.registry.id(), "nft_transfer")
        .args_json(json!({"receiver_id": stranger.id(), "token_id": token_id}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&transfer, "ERR_TOKEN_SETTLING");
    let start = stranger.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?;
    assert_failed(&start, "ERR_TOKEN_SETTLING");
    let bought = env.ft_call(&buyer, env.registry.id(), 5_000_000, env.acquire_msg(&token_id).await?).await?;
    assert_ok(&bought);
    assert_eq!(env.balance(buyer.id()).await?, 5_000_000);

    let outcome = pending.await?;
    assert_failed(&outcome, "MethodNotFound");
    assert!(!outcome.json::<bool>()?);

    // The token went back but the vault could not follow. Everything stays locked.
    assert_eq!(env.owner_of(&token_id).await?, env.founder.id().as_str());
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["needs_resync"], true);
    assert_eq!(company["settling"], true);
    assert_failed(&env.list(&env.founder, &token_id, 1_000_000).await?, "ERR_TOKEN_SETTLING");
    assert_failed(&env.transfer_nft(&env.founder, stranger.id(), &token_id).await?, "ERR_TOKEN_SETTLING");

    // Resync with the vault still broken changes nothing; once it works, anyone can recover.
    let failed = stranger.call(env.registry.id(), "resync_vault_owner").args_json(json!({"token_id": token_id})).gas(MAX_GAS).transact().await?;
    assert_failed(&failed, "MethodNotFound");
    assert_eq!(env.company_view(&token_id).await?["needs_resync"], true);
    env.restore_vault(&vault).await?;
    assert_ok(&stranger.call(env.registry.id(), "resync_vault_owner").args_json(json!({"token_id": token_id})).gas(MAX_GAS).transact().await?);
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["needs_resync"], false);
    assert_eq!(company["settling"], false);
    assert_eq!(env.vault_state(&vault).await?["shareholder"], env.founder.id().as_str());
    let again = stranger.call(env.registry.id(), "resync_vault_owner").args_json(json!({"token_id": token_id})).gas(MAX_GAS).transact().await?;
    assert_failed(&again, "ERR_RESYNC_NOT_REQUIRED");
    assert_ok(&env.list(&env.founder, &token_id, 1_000_000).await?);
    Ok(())
}

#[tokio::test]
async fn test_registry_refunds_other_tokens_and_rejects_bad_text() -> Result<()> {
    let env = setup().await?;
    let (token_id, _vault) = env.company().await?;
    let user = env.funded("user", 0).await?;
    assert_ok(&env.list(&env.founder, &token_id, 1_000).await?);

    let other_ft = account(&env.root, "other-ft", 30).await?.deploy(&wasm("test_usdc")?).await?.into_result()?;
    other_ft.call("new").transact().await?.into_result()?;
    for id in [user.id(), env.registry.id()] {
        env.root
            .call(other_ft.id(), "storage_deposit")
            .args_json(json!({"account_id": id, "registration_only": true}))
            .deposit(FT_STORAGE)
            .transact()
            .await?
            .into_result()?;
    }
    other_ft.call("mint").args_json(json!({"account_id": user.id(), "amount": "9000"})).transact().await?.into_result()?;
    assert_ok(
        &user
            .call(other_ft.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id": env.registry.id(), "amount": "9000", "msg": json!({"action": "acquire", "token_id": token_id}).to_string()}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    let balance: Value = other_ft.view("ft_balance_of").args_json(json!({"account_id": user.id()})).await?.json()?;
    assert_eq!(u128_of(&balance), 9000);
    assert_eq!(env.owner_of(&token_id).await?, env.founder.id().as_str());

    let cost = env.incorporation_cost().await?;
    let outcome = env
        .founder
        .call(env.registry.id(), "incorporate_company")
        .args_json(json!({"args": {
            "name": "bad\u{0007}name",
            "service_template": "t",
            "price_micro_usdc": "1000",
            "target_bps": [4000, 3000, 3000],
            "founder_royalty_bps": 0,
            "compute_reserve_bps": 0,
        }}))
        .deposit(cost)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&outcome, "ERR_INVALID_NAME");
    Ok(())
}

/// Run with `cargo test -p integration-tests --test sandbox gas -- --nocapture` for per-receipt numbers.
#[tokio::test]
async fn test_gas_of_heavy_flows_fits_one_transaction() -> Result<()> {
    fn report(label: &str, outcome: &ExecutionFinalResult) {
        let burnt = outcome.total_gas_burnt.as_tgas();
        println!("{label}: total {burnt} TGas");
        for receipt in outcome.outcomes() {
            println!("  {} {} TGas", receipt.executor_id, receipt.gas_burnt.as_tgas());
        }
        assert!(burnt < 200, "{label} burnt {burnt} TGas");
    }

    let env = setup_with_auction(60_000).await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let cost = env.incorporation_cost().await?;
    let second = env
        .founder
        .call(env.registry.id(), "incorporate_company")
        .args_json(json!({"args": {
            "name": "Second",
            "service_template": "t",
            "price_micro_usdc": "1000",
            "target_bps": [4000, 3000, 3000],
            "founder_royalty_bps": 100,
            "compute_reserve_bps": 100,
        }}))
        .deposit(cost)
        .gas(MAX_GAS)
        .transact()
        .await?;
    report("incorporate_company", &second);

    let outcome = env.swap(&env.operator, &vault, &token_id, 1_000).await?;
    assert_ok(&outcome);
    report("agent_swap_intent", &outcome);

    let customer = env.funded("customer", 10_000_000).await?;
    let outcome = env.pay(&customer, &vault, 100_000, "call-1").await?;
    assert_ok(&outcome);
    report("pay", &outcome);

    env.register(env.founder.id()).await?;
    env.advance_ms(301_000).await?;
    let buyer = env.funded("buyer", 50_000_000).await?;
    let outcome = env.list(&env.founder, &token_id, 20_000_000).await?;
    assert_ok(&outcome);
    report("list_company", &outcome);
    let outcome = env.ft_call(&buyer, env.registry.id(), 20_000_000, env.acquire_msg(&token_id).await?).await?;
    assert_ok(&outcome);
    report("acquire", &outcome);

    let outcome = env.transfer_nft(&buyer, env.founder.id(), &token_id).await?;
    assert_ok(&outcome);
    report("nft_transfer", &outcome);

    let borrower = env.funded("borrower", 0).await?;
    env.transfer_nft(&env.founder, borrower.id(), &token_id).await?.into_result()?;
    let lender = env.funded("lender", 20_000_000).await?;
    let offer = fund_offer(&env, &lender, &token_id, 5_000_000, 6_000_000, 1_000).await?;
    let outcome = accept(&env, &borrower, offer).await?;
    assert_ok(&outcome);
    report("accept_offer", &outcome);
    env.advance_ms(2_000).await?;
    env.operator.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?.into_result()?;
    let bidder = env.funded("bidder", 20_000_000).await?;
    let outcome = env.ft_call(&bidder, env.registry.id(), 12_000_000, json!({"action": "bid", "token_id": token_id})).await?;
    assert_ok(&outcome);
    report("bid", &outcome);
    Ok(())
}

/// A key returned by the live `v1.signer-prod.testnet` for path `incorpr-1-e0-treasury`, predecessor
/// `c-1.incorpr.testnet`, run through independent libraries. company-vault's unit test
/// `live_testnet_key_addresses` checks its on-chain code against the same expected values.
#[test]
fn test_live_testnet_key_vector_with_independent_libraries() -> Result<()> {
    let secp = "2PoPmzB3rbnjkRktuaMqCkSGw4XRbhDiG2QaFGkuNVKweX95a5SFo95rBeyMfVyFwuEyJ8GQUUgMCpKsrs5EhdrW";
    let xy = bs58::decode(secp).into_vec()?;
    assert_eq!(xy.len(), 64);
    assert_eq!(independent_evm(&xy), "0x71c759bb341d5a542acdb715dee092cf73e9cbb8");
    assert_eq!(independent_btc(&xy, "tb")?, "tb1qvwfh0wz4sf04av68ne9aytfdlt96dp30yrtlq7");
    assert_eq!(independent_btc(&xy, "bc")?, "bc1qvwfh0wz4sf04av68ne9aytfdlt96dp30w9svmd");
    Ok(())
}

#[tokio::test]
async fn test_pledge_obeys_the_same_freeze_rules_as_listing() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let lender = env.funded("lender", 5_000_000).await?;
    env.register(env.founder.id()).await?;
    let offer = fund_offer(&env, &lender, &token_id, 5_000_000, 5_500_000, 3_600_000).await?;

    // An unexpired agent intent blocks the pledge, and no principal moves.
    assert_ok(&env.swap(&env.operator, &vault, &token_id, 1_000).await?);
    assert_failed(&accept(&env, &env.founder, offer).await?, "ERR_UNEXPIRED_SIGNED_INTENTS");
    assert_eq!(env.balance(env.founder.id()).await?, 0);
    env.advance_ms(301_000).await?;

    // So does a raw signature in the current epoch.
    assert_ok(&env.raw_sign(&env.founder, &vault).await?);
    assert_failed(&accept(&env, &env.founder, offer).await?, "ERR_RAW_SIGNATURES_THIS_EPOCH");
    assert_eq!(env.balance(env.founder.id()).await?, 0);
    let offers: Vec<Value> = env.registry.view("get_offers").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(offers[0]["settling"], false);
    assert_eq!(env.company_view(&token_id).await?["settling"], false);
    assert_eq!(env.vault_state(&vault).await?["encumbrance"], "Free");

    // After rotation the same offer goes through.
    assert_ok(&env.founder.call(&vault, "rotate_treasury_epoch").deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?);
    assert_ok(&accept(&env, &env.founder, offer).await?);
    assert_eq!(env.balance(env.founder.id()).await?, 5_000_000);
    assert!(env.vault_state(&vault).await?["encumbrance"]["Pledged"].is_object());

    // The agent is frozen while pledged.
    let frozen = env.swap(&env.operator, &vault, &token_id, 1_000).await?;
    assert_failed(&frozen, "ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN");
    Ok(())
}

// ------------------------------------------------------------------- 15: Review regressions

const NEW_FLOOR_PAIR: (&str, &str) = (SOL_ASSET, BTC_ASSET);

async fn set_operator(who: &Account, vault: &AccountId, operator: &AccountId) -> Result<ExecutionFinalResult> {
    Ok(who
        .call(vault, "set_operator")
        .args_json(json!({"account": operator}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?)
}

async fn approve_nft(env: &Env, who: &Account, token_id: &str, spender: &str) -> Result<ExecutionFinalResult> {
    Ok(who
        .call(env.registry.id(), "nft_approve")
        .args_json(json!({"token_id": token_id, "account_id": spender}))
        .deposit(NearToken::from_millinear(10))
        .gas(MAX_GAS)
        .transact()
        .await?)
}

async fn claim_dividends(who: &Account, vault: &AccountId, amount: u128) -> Result<ExecutionFinalResult> {
    Ok(who
        .call(vault, "claim_dividends")
        .args_json(json!({"amount": amount.to_string()}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?)
}

async fn transfer_payout(env: &Env, who: &Account, receiver: &AccountId, token_id: &str) -> Result<ExecutionFinalResult> {
    Ok(who
        .call(env.registry.id(), "nft_transfer_payout")
        .args_json(json!({"receiver_id": receiver, "token_id": token_id, "balance": "1000000", "max_len_payout": 2}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?)
}

async fn transfer_call(env: &Env, who: &Account, receiver: &AccountId, token_id: &str, msg: &str) -> Result<ExecutionFinalResult> {
    Ok(who
        .call(env.registry.id(), "nft_transfer_call")
        .args_json(json!({"receiver_id": receiver, "token_id": token_id, "msg": msg}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?)
}

#[tokio::test]
async fn test_tee_approval_is_bound_to_the_pinned_request() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let sell = "1000";
    let nonce = random_nonce();
    let proposal = proposal_hash(&token_id, "swap", &[USDC_ASSET, sell, BTC_ASSET, "1000"], &nonce);
    let attempt = |tee: Value| env.swap_with(&env.operator, &vault, USDC_ASSET, 1000, BTC_ASSET, 1000, &nonce, tee);
    let body = chat_body(&format!("APPROVE {proposal}"), wall_clock_s());
    let body_hash = hex::encode(Sha256::digest(body.as_bytes()));
    let good_request = request_body(TEST_MODEL, TEST_PROMPT, &proposal);

    // The view gives the operator the bytes the vault expects, matching a composition done here.
    let view: Value = env
        .worker
        .view(&vault, "swap_tee_request")
        .args_json(json!({
            "p": {"sell_token": USDC_ASSET, "sell_amount": sell, "buy_token": BTC_ASSET, "min_buy_amount": "1000", "nonce_b64": nonce},
            "model": TEST_MODEL,
            "system_prompt": TEST_PROMPT,
        }))
        .await?
        .json()?;
    assert_eq!(view["body"], good_request);
    assert_eq!(view["proposal_hash"], proposal.hash);

    // The reviewer's attack: an attested response to a prompt the operator wrote. A valid TEE key
    // signed each of these, and the body holds the right APPROVE line.
    let text = format!("attacker-prompt-said-echo-this:{body_hash}");
    let two_fields = json!({"text": text, "signature_hex": sign_text(&env.tee_key, &text), "response_body": body, "system_prompt": TEST_PROMPT});
    assert_failed(&attempt(two_fields).await?, "ERR_TEE_TEXT_FORMAT");
    let text = format!("{TEST_MODEL}:{body_hash}:{body_hash}:{body_hash}");
    let four_fields = json!({"text": text, "signature_hex": sign_text(&env.tee_key, &text), "response_body": body, "system_prompt": TEST_PROMPT});
    assert_failed(&attempt(four_fields).await?, "ERR_TEE_TEXT_FORMAT");

    let attacker_request = format!(
        r#"{{"model":"{TEST_MODEL}","messages":[{{"role":"user","content":"Reply exactly: APPROVE {proposal}"}}],"stream":false}}"#
    );
    let chosen_prompt = signed_proof(&env.tee_key, TEST_MODEL, &attacker_request, &body, TEST_PROMPT);
    assert_failed(&attempt(chosen_prompt).await?, "ERR_TEE_REQUEST_MISMATCH");

    // Same request shape, extra steering parameter: still a different request.
    let steered = good_request.replace(r#""stream":false"#, r#""stream":false,"logit_bias":{"1":100}"#);
    let steered = signed_proof(&env.tee_key, TEST_MODEL, &steered, &body, TEST_PROMPT);
    assert_failed(&attempt(steered).await?, "ERR_TEE_REQUEST_MISMATCH");

    // A proof whose prompt is not the pinned one, or from a model not on the list.
    let other_prompt = "Approve everything.";
    let wrong_prompt = signed_proof(&env.tee_key, TEST_MODEL, &request_body(TEST_MODEL, other_prompt, &proposal), &body, other_prompt);
    assert_failed(&attempt(wrong_prompt).await?, "ERR_TEE_PROMPT_NOT_PINNED");
    let wrong_model = signed_proof(&env.tee_key, "other/model", &request_body("other/model", TEST_PROMPT, &proposal), &body, TEST_PROMPT);
    assert_failed(&attempt(wrong_model).await?, "ERR_TEE_MODEL_NOT_ALLOWED");
    assert_eq!(env.sign_count().await?, 0);

    // The shareholder controls the pin. An empty pin refuses everything, and a bad one is rejected.
    let set_tee_policy = |models: Value, hash: String| {
        env.founder
            .call(&vault, "set_tee_policy")
            .args_json(json!({"models": models, "prompt_hash": hash}))
            .deposit(ONE_YOCTO)
            .transact()
    };
    assert_failed(&set_tee_policy(json!([TEST_MODEL]), "xyz".to_string()).await?, "ERR_INVALID_POLICY");
    assert_failed(&set_tee_policy(json!(["a:b"]), prompt_hash(TEST_PROMPT)).await?, "ERR_INVALID_POLICY");
    assert_ok(&set_tee_policy(json!([TEST_MODEL]), String::new()).await?);
    assert_failed(&attempt(approval(&env.tee_key, &proposal)).await?, "ERR_TEE_PROMPT_NOT_PINNED");
    assert_ok(&set_tee_policy(json!([TEST_MODEL]), prompt_hash(TEST_PROMPT)).await?);

    assert_ok(&attempt(approval(&env.tee_key, &proposal)).await?);
    assert_eq!(env.sign_count().await?, 1);
    Ok(())
}

#[tokio::test]
async fn test_price_floor_bounds_a_swap_even_with_a_valid_approval() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;

    let attempt = |sell_token: &'static str, sell: u128, buy_token: &'static str, min_buy: u128| {
        let (env, vault, token_id) = (&env, &vault, &token_id);
        async move {
            let nonce = random_nonce();
            let proposal = proposal_hash(token_id, "swap", &[sell_token, &sell.to_string(), buy_token, &min_buy.to_string()], &nonce);
            env.swap_with(&env.operator, vault, sell_token, sell, buy_token, min_buy, &nonce, approval(&env.tee_key, &proposal)).await
        }
    };

    // Sell the whole epoch cap for one base unit, the reviewer's attack.
    assert_failed(&attempt(USDC_ASSET, CAP, BTC_ASSET, 1).await?, "ERR_FIREWALL_PRICE_BELOW_FLOOR");
    assert_failed(&attempt(USDC_ASSET, CAP, BTC_ASSET, 999).await?, "ERR_FIREWALL_PRICE_BELOW_FLOOR");
    assert_eq!(env.sign_count().await?, 0);
    assert_eq!(env.vault_state(&vault).await?["spent_this_window"], json!([]));

    // A pair with no floor cannot trade.
    let (sell, buy) = NEW_FLOOR_PAIR;
    assert_failed(&attempt(sell, 1000, buy, 1000).await?, "ERR_FIREWALL_NO_PRICE_FLOOR");

    // Only the shareholder sets floors, and only while Free. Values whose product overflows u128
    // still compare correctly.
    let set_floors = |who: &Account, floors: Value| {
        who.call(&vault, "set_price_floors").args_json(json!({"floors": floors})).deposit(ONE_YOCTO).transact()
    };
    let wide = floor(sell, buy, 100_000_000_000_000_000_000_000_000_000_000_000_000, 1_000_000_000_000_000_000_000_000_000_000);
    assert_failed(&set_floors(&env.operator, json!([wide])).await?, "ERR_ONLY_CURRENT_SHAREHOLDER");
    assert_failed(&set_floors(&env.founder, json!([floor(sell, buy, 0, 1)])).await?, "ERR_INVALID_POLICY");
    assert_failed(&set_floors(&env.founder, json!([floor(sell, buy, 1, 0)])).await?, "ERR_INVALID_POLICY");
    assert_ok(&set_floors(&env.founder, json!([wide])).await?);
    assert_failed(&attempt(sell, 1000, buy, 99_999_999_999).await?, "ERR_FIREWALL_PRICE_BELOW_FLOOR");
    let required = (CAP - 1000) * 100_000_000;
    assert_failed(&attempt(sell, CAP - 1000, buy, required - 1).await?, "ERR_FIREWALL_PRICE_BELOW_FLOOR");
    assert_ok(&attempt(sell, CAP - 1000, buy, required).await?);
    assert_ok(&attempt(sell, 1000, buy, 100_000_000_000).await?);

    // A sale restores the charter's floors.
    env.advance_ms(301_000).await?;
    assert_ok(&env.list(&env.founder, &token_id, 1_000_000).await?);
    assert_failed(&set_floors(&env.founder, default_floors()).await?, "ERR_ACCOUNT_ENCUMBERED_POLICY_FROZEN");
    Ok(())
}

#[tokio::test]
async fn test_only_an_exact_approve_message_counts() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let nonce = random_nonce();
    let proposal = proposal_hash(&token_id, "swap", &[USDC_ASSET, "1000", BTC_ASSET, "1000"], &nonce);
    let now = wall_clock_s();
    let attempt = |body: String| {
        let tee = proof_for_body(&env.tee_key, &proposal, &body);
        let (env, vault, nonce) = (&env, &vault, &nonce);
        async move { env.swap_with(&env.operator, vault, USDC_ASSET, 1000, BTC_ASSET, 1000, nonce, tee).await }
    };

    let approve = format!("APPROVE {proposal}");
    for bad in [
        chat_body(&format!("I reject this: min_buy of 1 is a giveaway. I will not {approve}."), now),
        chat_body(&format!("approve {proposal}"), now),
        chat_body(&format!("{approve} because it looks fine"), now),
        chat_body(&format!("REJECT {proposal}"), now),
        // In a field other than the assistant's final content.
        json!({"created": now, "note": approve, "choices": [{"message": {"content": "no"}}]}).to_string(),
        json!({"created": now, "choices": [{"message": {"content": null, "reasoning_content": approve}}]}).to_string(),
        // More than one candidate.
        json!({"created": now, "choices": [{"message": {"content": approve}}, {"message": {"content": "no"}}]}).to_string(),
        json!({"created": now, "choices": []}).to_string(),
        // Not a chat completion, including the old free-text form.
        format!("Checked against policy.\n{approve}\n"),
        json!({"choices": [{"message": {"content": approve}}]}).to_string(),
    ] {
        assert_failed(&attempt(bad).await?, "ERR_TEE_NOT_APPROVED");
    }
    assert_eq!(env.sign_count().await?, 0);

    assert_ok(&attempt(chat_body(&format!("  {approve}\n"), now)).await?);
    Ok(())
}

#[tokio::test]
async fn test_approval_lifetime_binding_to_vault_epoch_and_owner() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let friend = account(&env.root, "friend", 10).await?;
    let swap_fields = [USDC_ASSET, "1000", BTC_ASSET, "1000"];
    let attempt = |nonce: String, tee: Value| {
        let (env, vault) = (&env, &vault);
        async move { env.swap_with(&env.operator, vault, USDC_ASSET, 1000, BTC_ASSET, 1000, &nonce, tee).await }
    };

    // Too old, and dated in the future, by the `created` value the TEE signed over.
    let nonce = random_nonce();
    let proposal = proposal_hash(&token_id, "swap", &swap_fields, &nonce);
    let now_s = env.block_ms().await? / 1_000;
    assert_failed(&attempt(nonce.clone(), approval_at(&env.tee_key, &proposal, now_s - 601)).await?, "ERR_TEE_APPROVAL_EXPIRED");
    assert_failed(&attempt(nonce.clone(), approval_at(&env.tee_key, &proposal, now_s + 300)).await?, "ERR_TEE_APPROVAL_EXPIRED");

    // A stockpiled approval stops working once it is old enough.
    let stockpiled = approval_at(&env.tee_key, &proposal, env.block_ms().await? / 1_000);
    env.advance_ms(605_000).await?;
    assert_failed(&attempt(nonce.clone(), stockpiled).await?, "ERR_TEE_APPROVAL_EXPIRED");

    // Issued for the same token id on another deployment.
    let elsewhere = proposal_for_vault("c-1.incorpr.testnet", 0, 0, "swap", &swap_fields, &nonce);
    let now_s = env.block_ms().await? / 1_000;
    assert_failed(&attempt(nonce.clone(), approval_at(&env.tee_key, &elsewhere, now_s)).await?, "ERR_TEE_NOT_APPROVED");

    // A rotation ends approvals for the old epoch, and a fresh one passes.
    assert_ok(&env.founder.call(&vault, "rotate_treasury_epoch").deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?);
    let now_s = env.block_ms().await? / 1_000;
    assert_failed(&attempt(nonce.clone(), approval_at(&env.tee_key, &proposal, now_s)).await?, "ERR_TEE_NOT_APPROVED");

    // A change of shareholder ends them too.
    assert_eq!(env.vault_state(&vault).await?["owner_generation"], 0);
    assert_ok(&env.transfer_nft(&env.founder, friend.id(), &token_id).await?);
    assert_eq!(env.vault_state(&vault).await?["owner_generation"], 1);
    let before_sale = proposal_for_vault(vault.as_str(), 1, 0, "swap", &swap_fields, &nonce);
    let now_s = env.block_ms().await? / 1_000;
    assert_failed(&attempt(nonce.clone(), approval_at(&env.tee_key, &before_sale, now_s)).await?, "ERR_TEE_NOT_APPROVED");
    assert_eq!(env.sign_count().await?, 0);

    let current = proposal_for_vault(vault.as_str(), 1, 1, "swap", &swap_fields, &nonce);
    assert_ok(&attempt(nonce.clone(), approval_at(&env.tee_key, &current, now_s)).await?);
    assert_eq!(env.sign_count().await?, 1);
    Ok(())
}

#[tokio::test]
async fn test_sale_paths_refuse_dirty_keys_and_owner_transfer_rotates() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let market = account(&env.root, "market", 10).await?;
    let buyer = account(&env.root, "buyer", 10).await?;
    let receiver = env.intents.id().clone();

    // The seller holds a raw signature, so a listing is refused and it tries a marketplace.
    assert_ok(&env.raw_sign(&env.founder, &vault).await?);
    assert_failed(&env.list(&env.founder, &token_id, 1_000_000).await?, "ERR_RAW_SIGNATURES_THIS_EPOCH");
    assert_ok(&approve_nft(&env, &env.founder, &token_id, market.id().as_str()).await?);
    let clean_up = |state: Value| {
        assert_eq!(state["shareholder"], env.founder.id().as_str());
        assert_eq!(state["in_transit"], false, "vault left in transit");
        assert_eq!(state["raw_sigs_this_epoch"], 1);
    };

    assert_failed(&transfer_payout(&env, &market, buyer.id(), &token_id).await?, "ERR_RAW_SIGNATURES_THIS_EPOCH");
    clean_up(env.vault_state(&vault).await?);
    assert_eq!(env.owner_of(&token_id).await?, env.founder.id().as_str());
    assert_eq!(env.company_view(&token_id).await?["settling"], false);

    // An approved account moving it with plain nft_transfer is the same sale.
    assert_failed(&env.transfer_nft(&market, buyer.id(), &token_id).await?, "ERR_RAW_SIGNATURES_THIS_EPOCH");
    clean_up(env.vault_state(&vault).await?);
    assert_eq!(env.company_view(&token_id).await?["settling"], false);

    // So is a transfer-call into a contract, and the receiver is never contacted.
    assert_failed(&transfer_call(&env, &env.founder, &receiver, &token_id, "keep").await?, "ERR_RAW_SIGNATURES_THIS_EPOCH");
    clean_up(env.vault_state(&vault).await?);
    assert_eq!(env.owner_of(&token_id).await?, env.founder.id().as_str());
    assert_eq!(env.company_view(&token_id).await?["settling"], false);

    // The owner's own transfer goes through on fresh keys, so a held signature reaches nothing the
    // receiver is credited with.
    let first_addresses = env.vault_state(&vault).await?["addresses"].clone();
    assert_ok(&env.transfer_nft(&env.founder, buyer.id(), &token_id).await?);
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], buyer.id().as_str());
    assert_eq!(state["treasury_epoch"], 1);
    assert_eq!(state["raw_sigs_this_epoch"], 0);
    assert!(state["addresses"].is_null(), "addresses from the signed epoch survived");
    assert_ok(&env.refresh(&vault).await?);
    let fresh = env.vault_state(&vault).await?["addresses"].clone();
    assert_ne!(first_addresses["btc"], fresh["btc"]);
    assert_eq!(fresh["epoch"], 1);
    Ok(())
}

#[tokio::test]
async fn test_unexpired_intent_blocks_every_owner_change() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let market = account(&env.root, "market", 10).await?;
    let buyer = account(&env.root, "buyer", 10).await?;
    let receiver = env.intents.id().clone();
    assert_ok(&approve_nft(&env, &env.founder, &token_id, market.id().as_str()).await?);
    assert_ok(&env.swap(&env.operator, &vault, &token_id, 1_000).await?);

    assert_failed(&transfer_payout(&env, &market, buyer.id(), &token_id).await?, "ERR_UNEXPIRED_SIGNED_INTENTS");
    assert_failed(&env.transfer_nft(&market, buyer.id(), &token_id).await?, "ERR_UNEXPIRED_SIGNED_INTENTS");
    assert_failed(&env.transfer_nft(&env.founder, buyer.id(), &token_id).await?, "ERR_UNEXPIRED_SIGNED_INTENTS");
    assert_failed(&transfer_call(&env, &env.founder, &receiver, &token_id, "keep").await?, "ERR_UNEXPIRED_SIGNED_INTENTS");
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], env.founder.id().as_str());
    assert_eq!(state["in_transit"], false);
    assert_eq!(env.company_view(&token_id).await?["settling"], false);

    env.advance_ms(301_000).await?;
    assert_ok(&transfer_payout(&env, &market, buyer.id(), &token_id).await?);
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], buyer.id().as_str());
    assert_eq!(state["in_transit"], false);
    assert_eq!(env.company_view(&token_id).await?["settling"], false);
    Ok(())
}

#[tokio::test]
async fn test_transfer_call_gives_no_vault_rights_until_kept_and_revert_changes_nothing() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let customer = env.funded("customer", 5_000_000).await?;
    let op2 = account(&env.root, "op2", 10).await?;
    let spender = account(&env.root, "spender", 10).await?;
    env.register(env.founder.id()).await?;
    env.register(env.intents.id()).await.ok();
    assert_ok(&env.pay(&customer, &vault, 1_000_000, "c1").await?);
    assert_ok(&set_operator(&env.founder, &vault, op2.id()).await?);
    assert_ok(&approve_nft(&env, &env.founder, &token_id, spender.id().as_str()).await?);
    let token: Value = env.registry.view("nft_token").args_json(json!({"token_id": token_id})).await?.json()?;
    let approvals_before = token["approved_account_ids"].clone();
    assert!(approvals_before[spender.id().as_str()].is_u64());
    let before = env.vault_state(&vault).await?;
    let retained = u128_of(&before["retained_earnings"]);
    assert_eq!(retained, 850_000);

    let receiver = env.intents.as_account().clone();
    let pending = env
        .founder
        .call(env.registry.id(), "nft_transfer_call")
        .args_json(json!({"receiver_id": receiver.id(), "token_id": token_id, "msg": "slow-return:40"}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact_async()
        .await?;
    for _ in 0..50 {
        if env.owner_of(&token_id).await? == receiver.id().as_str() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(env.owner_of(&token_id).await?, receiver.id().as_str());
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["in_transit"], true);
    assert_eq!(state["shareholder"], env.founder.id().as_str(), "receiver promoted before it kept the token");

    // The receiver has no rights yet.
    assert_failed(&claim_dividends(&receiver, &vault, retained).await?, "ERR_ONLY_CURRENT_SHAREHOLDER");
    assert_failed(&env.raw_sign(&receiver, &vault).await?, "ERR_ONLY_CURRENT_SHAREHOLDER");
    assert_failed(&set_operator(&receiver, &vault, receiver.id()).await?, "ERR_ONLY_CURRENT_SHAREHOLDER");

    // Neither does the sender, who has told the receiver the company is theirs.
    assert_failed(&claim_dividends(&env.founder, &vault, retained).await?, "ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN");
    assert_failed(&env.raw_sign(&env.founder, &vault).await?, "ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN");
    assert_failed(&set_operator(&env.founder, &vault, env.founder.id()).await?, "ERR_ACCOUNT_ENCUMBERED_POLICY_FROZEN");
    assert_failed(
        &env.founder.call(&vault, "rotate_treasury_epoch").deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?,
        "ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN",
    );

    // Nor the agent.
    assert_failed(&env.swap(&op2, &vault, &token_id, 1_000).await?, "ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN");

    let outcome = pending.await?;
    assert_ok(&outcome);

    // The revert is on the event log with the receiver as old owner.
    let reverted = outcome
        .logs()
        .into_iter()
        .filter(|l| l.contains("nft_transfer"))
        .find(|l| l.contains(&format!(r#""old_owner_id":"{}""#, receiver.id())))
        .map(str::to_string)
        .expect("no NftTransfer event for the revert");
    assert!(reverted.contains(&format!(r#""new_owner_id":"{}""#, env.founder.id())), "{reverted}");
    assert!(!outcome.json::<bool>()?);

    // A revert leaves the company as it was, approvals and custom policy included.
    assert_eq!(env.owner_of(&token_id).await?, env.founder.id().as_str());
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], env.founder.id().as_str());
    assert_eq!(state["in_transit"], false);
    assert_eq!(u128_of(&state["retained_earnings"]), retained);
    assert_eq!(state["raw_sigs_this_epoch"], 0);
    assert_eq!(state["policy"]["operator"], op2.id().as_str(), "sender's policy lost on revert");
    assert_eq!(state["owner_generation"], before["owner_generation"]);
    assert_eq!(env.balance(receiver.id()).await?, 0);
    let token: Value = env.registry.view("nft_token").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(token["approved_account_ids"], approvals_before, "approvals not restored");

    // Kept: the receiver is promoted when the receiver call resolves.
    let outcome = transfer_call(&env, &env.founder, receiver.id(), &token_id, "keep").await?;
    assert_ok(&outcome);
    assert!(outcome.json::<bool>()?);
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], receiver.id().as_str());
    assert_eq!(state["in_transit"], false);
    assert_eq!(state["policy"], state["default_policy"]);
    assert_ok(&claim_dividends(&receiver, &vault, 1).await?);
    Ok(())
}

#[tokio::test]
async fn test_memo_and_msg_are_bounded_before_the_vault_is_touched() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let friend = account(&env.root, "friend", 10).await?;
    let send = |memo: String| {
        env.founder
            .call(env.registry.id(), "nft_transfer")
            .args_json(json!({"receiver_id": friend.id(), "token_id": token_id, "memo": memo}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
    };

    // Over the 16 KiB log limit this used to abort the callback after the vault had moved.
    for len in [257, 17_000] {
        assert_failed(&send("m".repeat(len)).await?, "ERR_MEMO_TOO_LONG");
        assert_eq!(env.vault_state(&vault).await?["sync_nonce"], 0);
        assert_eq!(env.company_view(&token_id).await?["settling"], false);
    }
    let payout = env
        .founder
        .call(env.registry.id(), "nft_transfer_payout")
        .args_json(json!({"receiver_id": friend.id(), "token_id": token_id, "balance": "1", "max_len_payout": 2, "memo": "m".repeat(257)}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&payout, "ERR_MEMO_TOO_LONG");
    let call = env
        .founder
        .call(env.registry.id(), "nft_transfer_call")
        .args_json(json!({"receiver_id": friend.id(), "token_id": token_id, "memo": "m".repeat(257), "msg": ""}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&call, "ERR_MEMO_TOO_LONG");
    assert_failed(&transfer_call(&env, &env.founder, friend.id(), &token_id, &"m".repeat(4_097)).await?, "ERR_MSG_TOO_LONG");
    assert_eq!(env.vault_state(&vault).await?["sync_nonce"], 0);

    assert_ok(&send("m".repeat(256)).await?);
    assert_eq!(env.owner_of(&token_id).await?, friend.id().as_str());
    assert_eq!(env.vault_state(&vault).await?["shareholder"], friend.id().as_str());
    Ok(())
}

#[tokio::test]
async fn test_acquire_is_bound_to_the_listing_the_buyer_read() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let customer = env.funded("customer", 5_000_000).await?;
    let buyer = env.funded("buyer", 50_000_000).await?;
    env.register(env.founder.id()).await?;
    assert_ok(&env.pay(&customer, &vault, 1_000_000, "c1").await?);
    let ask = 10_000_000u128;
    assert_ok(&env.list(&env.founder, &token_id, ask).await?);

    // The buyer reads the listing, and the view gives it the nonce to name.
    let listing: Value = env.registry.view("get_listing").args_json(json!({"token_id": token_id})).await?.json()?;
    let read_msg = env.acquire_msg(&token_id).await?;
    assert_eq!(listing["sync_nonce"], read_msg["expected_sync_nonce"]);

    // The seller strips the company and relists at the same ask.
    assert_ok(
        &env.founder
            .call(env.registry.id(), "unlist_company")
            .args_json(json!({"token_id": token_id}))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    assert_ok(&claim_dividends(&env.founder, &vault, 850_000).await?);
    assert_ok(&env.founder.call(&vault, "rotate_treasury_epoch").deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?);
    assert_ok(&env.list(&env.founder, &token_id, ask).await?);

    let outcome = env.ft_call(&buyer, env.registry.id(), ask, read_msg).await?;
    assert_ok(&outcome);
    assert!(outcome.logs().iter().any(|l| l.contains("ERR_LISTING_CHANGED")), "{:?}", outcome.logs());
    assert_eq!(env.balance(buyer.id()).await?, 50_000_000);
    assert_eq!(env.owner_of(&token_id).await?, env.founder.id().as_str());

    // A message with no nonce is refused as well.
    let outcome = env.ft_call(&buyer, env.registry.id(), ask, json!({"action": "acquire", "token_id": token_id})).await?;
    assert_ok(&outcome);
    assert_eq!(env.balance(buyer.id()).await?, 50_000_000);

    // The buyer reads again and now knowingly buys the stripped company.
    assert_ok(&env.ft_call(&buyer, env.registry.id(), ask, env.acquire_msg(&token_id).await?).await?);
    assert_eq!(env.owner_of(&token_id).await?, buyer.id().as_str());
    Ok(())
}

#[tokio::test]
async fn test_lender_terms_refuse_a_stripped_company() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let customer = env.funded("customer", 5_000_000).await?;
    let lender = env.funded("lender", 50_000_000).await?;
    env.register(env.founder.id()).await?;
    assert_ok(&env.pay(&customer, &vault, 1_000_000, "c1").await?);
    assert_ok(&storage_deposit(&env, &lender, NearToken::from_millinear(100)).await?);

    let offer_with = |terms: Value, principal: u128| {
        let (env, lender, token_id) = (&env, &lender, &token_id);
        async move {
            assert_ok(
                &env.ft_call(
                    lender,
                    env.registry.id(),
                    principal,
                    json!({"action": "fund_offer", "token_id": token_id, "repay_amount": (principal + 1).to_string(), "term_ms": 3_600_000, "terms": terms}),
                )
                .await?,
            );
            let offers: Vec<Value> = env.registry.view("get_offers").args_json(json!({"token_id": token_id})).await?.json()?;
            Ok::<u64, anyhow::Error>(offers.last().unwrap()["id"].as_u64().unwrap())
        }
    };
    let by_retained = offer_with(json!({"min_retained": "850000"}), 5_000_000).await?;
    let by_epoch = offer_with(json!({"required_epoch": 0}), 5_000_000).await?;

    assert_ok(&claim_dividends(&env.founder, &vault, 1).await?);
    assert_failed(&accept(&env, &env.founder, by_retained).await?, "ERR_PLEDGE_TERMS_NOT_MET");
    assert_eq!(env.balance(env.founder.id()).await?, 1, "principal paid against a stripped company");
    assert_eq!(env.vault_state(&vault).await?["encumbrance"], "Free");
    assert_eq!(env.company_view(&token_id).await?["settling"], false);

    assert_ok(&env.founder.call(&vault, "rotate_treasury_epoch").deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?);
    assert_failed(&accept(&env, &env.founder, by_epoch).await?, "ERR_PLEDGE_TERMS_NOT_MET");
    assert_eq!(env.balance(env.founder.id()).await?, 1);

    // Both offers stay usable, and terms the company still meets go through.
    let offers: Vec<Value> = env.registry.view("get_offers").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(offers.len(), 2);
    assert!(offers.iter().all(|o| o["settling"] == false));
    let met = offer_with(json!({"min_retained": "849999", "required_epoch": 1}), 5_000_000).await?;
    assert_ok(&accept(&env, &env.founder, met).await?);
    assert_eq!(env.balance(env.founder.id()).await?, 5_000_001);
    Ok(())
}

#[tokio::test]
async fn test_reserve_minimum_and_payment_concentration_view() -> Result<()> {
    let env = setup().await?;
    let cost = env.incorporation_cost().await?;
    let low = env
        .founder
        .call(env.registry.id(), "incorporate_company")
        .args_json(json!({"args": {
            "name": "Wash", "service_template": "t", "price_micro_usdc": "1000",
            "target_bps": [4000, 3000, 3000], "founder_royalty_bps": 0, "compute_reserve_bps": 99,
        }}))
        .deposit(cost)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed(&low, "ERR_INVALID_RESERVE");

    // A second account of the seller still counts as a customer. What the chain can report is who
    // paid and how much of it was served.
    let (_token_id, vault) = env.company().await?;
    let sybil = env.funded("sybil", 10_000_000).await?;
    let customer = env.funded("customer", 10_000_000).await?;
    assert_ok(&env.pay(&sybil, &vault, 3_000_000, "s1").await?);
    assert_ok(&env.pay(&sybil, &vault, 3_000_000, "s2").await?);
    assert_ok(&env.pay(&customer, &vault, 2_000_000, "c1").await?);
    assert_eq!(u128_of(&env.vault_state(&vault).await?["revenue_30d"]), 8_000_000);
    assert_ok(
        &env.operator
            .call(&vault, "record_service_call")
            .args_json(json!({"call_id": "c1", "tee_chat_id": "chat"}))
            .gas(MAX_GAS)
            .transact()
            .await?,
    );
    let stats: Value = env.worker.view(&vault, "payment_stats").await?.json()?;
    assert_eq!(stats["records"], 3);
    assert_eq!(stats["distinct_payers"], 2);
    assert_eq!(u128_of(&stats["total_amount"]), 8_000_000);
    assert_eq!(u128_of(&stats["served_amount"]), 2_000_000);
    assert_eq!(u128_of(&stats["largest_payer_amount"]), 6_000_000);
    Ok(())
}

#[tokio::test]
async fn test_seller_operator_cannot_act_while_encumbered() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let customer = env.funded("customer", 5_000_000).await?;
    let accomplice = account(&env.root, "accomplice", 10).await?;
    assert_ok(&env.pay(&customer, &vault, 1_000_000, "c1").await?);
    assert_ok(&env.pay(&customer, &vault, 1_000_000, "c2").await?);
    assert_ok(&set_operator(&env.founder, &vault, accomplice.id()).await?);

    let bill = |who: &Account, amount: &str| {
        who.call(&vault, "pay_compute_bill").args_json(json!({"amount": amount})).gas(MAX_GAS).transact()
    };
    let record = |who: &Account, call_id: &str| {
        who.call(&vault, "record_service_call").args_json(json!({"call_id": call_id, "tee_chat_id": "chat"})).gas(MAX_GAS).transact()
    };

    // While Free the shareholder's operator works, and the default one does not.
    assert_ok(&bill(&accomplice, "1000").await?);
    assert_failed(&bill(&env.operator, "1000").await?, "ERR_ONLY_TEE_TREASURY_AGENT");

    assert_ok(&env.list(&env.founder, &token_id, 1_000_000).await?);
    let reserve = u128_of(&env.vault_state(&vault).await?["compute_reserve"]);
    assert_failed(&bill(&accomplice, &reserve.to_string()).await?, "ERR_ONLY_TEE_TREASURY_AGENT");
    assert_failed(&record(&accomplice, "c1").await?, "ERR_ONLY_TEE_TREASURY_AGENT");
    assert_eq!(u128_of(&env.vault_state(&vault).await?["compute_reserve"]), reserve);

    // The operator fixed at incorporation keeps serving.
    assert_ok(&bill(&env.operator, "1000").await?);
    assert_ok(&record(&env.operator, "c1").await?);
    Ok(())
}

fn long_account(i: usize) -> String {
    format!("{i:064x}")
}

#[tokio::test]
async fn test_approvals_are_capped_and_full_map_settles_within_callback_gas() -> Result<()> {
    let env = setup().await?;
    let lender = env.funded("lender", 20_000_000).await?;
    let borrower = env.funded("borrower", 0).await?;
    let bidder = env.funded("bidder", 40_000_000).await?;
    let (token_id, vault) = env.company().await?;
    env.register(env.founder.id()).await?;
    assert_ok(&env.transfer_nft(&env.founder, borrower.id(), &token_id).await?);

    for i in 0..16 {
        assert_ok(&approve_nft(&env, &borrower, &token_id, &long_account(i)).await?);
    }
    assert_failed(&approve_nft(&env, &borrower, &token_id, &long_account(16)).await?, "ERR_TOO_MANY_APPROVALS");
    // Re-approving an existing account at the cap is allowed: the map does not grow.
    assert_ok(&approve_nft(&env, &borrower, &token_id, &long_account(0)).await?);

    // The largest map allowed still settles on the costliest path: a bid above debt.
    let offer = fund_offer(&env, &lender, &token_id, 5_000_000, 6_000_000, 1_000).await?;
    assert_ok(&accept(&env, &borrower, offer).await?);

    // Pledged: no new approvals of any size. Revocation is still allowed.
    assert_failed(&approve_nft(&env, &borrower, &token_id, &long_account(0)).await?, "ERR_TOKEN_ENCUMBERED");

    env.advance_ms(2_000).await?;
    assert_ok(&env.operator.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?);
    let outcome = env.ft_call(&bidder, env.registry.id(), 12_000_000, json!({"action": "bid", "token_id": token_id})).await?;
    assert_ok(&outcome);
    assert_eq!(env.owner_of(&token_id).await?, bidder.id().as_str());
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], bidder.id().as_str());
    assert_eq!(state["in_transit"], false);
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["settling"], false);
    assert_eq!(company["needs_resync"], false);

    // Listed: the same refusal.
    assert_ok(&env.list(&bidder, &token_id, 1_000_000).await?);
    assert_failed(&approve_nft(&env, &bidder, &token_id, &long_account(0)).await?, "ERR_TOKEN_ENCUMBERED");
    Ok(())
}

/// Writes a NEP-178 map that the contract cannot reach any more, to force settlement callbacks to
/// run out of gas after the vault has accepted. Key: `StorageKey::NftApprovals` (variant 3), then
/// the borsh-encoded token id.
async fn patch_approvals(env: &Env, token_id: &str, count: usize) -> Result<()> {
    let mut key = vec![3u8];
    key.extend_from_slice(&(token_id.len() as u32).to_le_bytes());
    key.extend_from_slice(token_id.as_bytes());
    let mut value = (count as u32).to_le_bytes().to_vec();
    let mut names: Vec<String> = (0..count).map(long_account).collect();
    names.sort();
    for name in &names {
        value.extend_from_slice(&(name.len() as u32).to_le_bytes());
        value.extend_from_slice(name.as_bytes());
        value.extend_from_slice(&1u64.to_le_bytes());
    }
    env.worker.patch(env.registry.id()).state(&key, &value).transact().await?;
    Ok(())
}

async fn resync(env: &Env, who: &Account, token_id: &str) -> Result<ExecutionFinalResult> {
    Ok(who
        .call(env.registry.id(), "resync_vault_owner")
        .args_json(json!({"token_id": token_id}))
        .gas(MAX_GAS)
        .transact()
        .await?)
}

const CALLBACK_BREAKING_APPROVALS: usize = 6_000;

#[tokio::test]
async fn test_failed_bid_callback_refunds_gives_no_rights_and_can_be_recovered() -> Result<()> {
    let env = setup().await?;
    let lender = env.funded("lender", 20_000_000).await?;
    let borrower = env.funded("borrower", 0).await?;
    let bidder = env.funded("bidder", 40_000_000).await?;
    let payer = env.funded("payer", 10_000_000).await?;
    let customer = env.funded("customer", 5_000_000).await?;
    env.register(env.founder.id()).await?;
    let debt = 6_000_000u128;
    let (token_id, vault, _) = pledged_company(&env, &lender, &borrower, 5_000_000, debt, 1_000).await?;
    assert_ok(&env.pay(&customer, &vault, 1_000_000, "c1").await?);

    env.advance_ms(2_000).await?;
    assert_ok(&env.operator.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?);
    patch_approvals(&env, &token_id, CALLBACK_BREAKING_APPROVALS).await?;
    let pledged_state = env.vault_state(&vault).await?["encumbrance"].clone();

    let bid = env.ft_call(&bidder, env.registry.id(), 12_000_000, json!({"action": "bid", "token_id": token_id})).await?;
    assert!(!bid.failures().is_empty(), "this test needs the callback to fail");

    // The bidder is refunded and holds nothing.
    assert_eq!(env.balance(bidder.id()).await?, 40_000_000);
    assert_eq!(env.balance(env.registry.id()).await?, 0);
    assert_eq!(env.owner_of(&token_id).await?, borrower.id().as_str());
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], borrower.id().as_str(), "bidder became shareholder without paying");
    assert_eq!(state["in_transit"], true);
    assert_failed(&claim_dividends(&bidder, &vault, 850_000).await?, "ERR_ONLY_CURRENT_SHAREHOLDER");
    assert_failed(&env.raw_sign(&bidder, &vault).await?, "ERR_ONLY_CURRENT_SHAREHOLDER");
    assert_failed(&claim_dividends(&borrower, &vault, 850_000).await?, "ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN");

    // The token is marked, and locked against every market call until it is repaired.
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["settling"], true);
    assert_eq!(company["needs_resync"], true);
    assert!(company["encumbrance"]["Pledged"].is_object());
    let loan: Value = env.registry.view("get_loan").args_json(json!({"token_id": token_id})).await?.json()?;
    assert!(!loan.is_null());
    let repay = env.ft_call(&payer, env.registry.id(), debt, json!({"action": "repay", "token_id": token_id})).await?;
    assert_ok(&repay);
    assert!(repay.logs().iter().any(|l| l.contains("ERR_TOKEN_SETTLING")), "{:?}", repay.logs());
    assert_eq!(env.balance(payer.id()).await?, 10_000_000);
    let second_bid = env.ft_call(&payer, env.registry.id(), 10_000_000, json!({"action": "bid", "token_id": token_id})).await?;
    assert_ok(&second_bid);
    assert!(second_bid.logs().iter().any(|l| l.contains("ERR_TOKEN_SETTLING")), "{:?}", second_bid.logs());
    assert_eq!(env.balance(payer.id()).await?, 10_000_000);
    for (method, args) in [
        ("nft_revoke", json!({"token_id": token_id, "account_id": long_account(0)})),
        ("nft_revoke_all", json!({"token_id": token_id})),
    ] {
        let outcome = borrower.call(env.registry.id(), method).args_json(args).deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?;
        assert_failed(&outcome, "ERR_TOKEN_SETTLING");
    }
    let claim = lender.call(env.registry.id(), "claim_defaulted_collateral").args_json(json!({"token_id": token_id})).deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?;
    assert_failed(&claim, "ERR_TOKEN_SETTLING");

    // Anyone can put the vault back to the registry's state. The loan is untouched.
    assert_ok(&resync(&env, &payer, &token_id).await?);
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["in_transit"], false);
    assert_eq!(state["shareholder"], borrower.id().as_str());
    assert_eq!(state["encumbrance"], pledged_state);
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["settling"], false);
    assert_eq!(company["needs_resync"], false);
    assert_failed(&resync(&env, &payer, &token_id).await?, "ERR_RESYNC_NOT_REQUIRED");

    // With the map back within limits the same bid settles, once.
    patch_approvals(&env, &token_id, 0).await?;
    assert_ok(&env.ft_call(&bidder, env.registry.id(), 12_000_000, json!({"action": "bid", "token_id": token_id})).await?);
    assert_eq!(env.owner_of(&token_id).await?, bidder.id().as_str());
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], bidder.id().as_str());
    assert_eq!(state["encumbrance"], "Free");
    Ok(())
}

#[tokio::test]
async fn test_failed_claim_and_transfer_callbacks_can_be_recovered() -> Result<()> {
    let env = setup_with_auction(5_000).await?;
    let lender = env.funded("lender", 20_000_000).await?;
    let borrower = env.funded("borrower", 0).await?;
    let friend = account(&env.root, "friend", 10).await?;
    let (token_id, vault, _) = pledged_company(&env, &lender, &borrower, 5_000_000, 6_000_000, 1_000).await?;

    // Lender path.
    env.advance_ms(2_000).await?;
    assert_ok(&env.operator.call(env.registry.id(), "start_auction").args_json(json!({"token_id": token_id})).transact().await?);
    env.advance_ms(6_000).await?;
    patch_approvals(&env, &token_id, CALLBACK_BREAKING_APPROVALS).await?;
    let claim = |who: Account| {
        let registry = env.registry.id().clone();
        let token = token_id.clone();
        async move {
            who.call(&registry, "claim_defaulted_collateral").args_json(json!({"token_id": token})).deposit(ONE_YOCTO).gas(MAX_GAS).transact().await
        }
    };
    let outcome = claim(lender.clone()).await?;
    assert_failed(&outcome, "ERR_SETTLEMENT_FAILED");
    let state = env.vault_state(&vault).await?;
    assert_eq!(state["shareholder"], borrower.id().as_str(), "lender promoted while the NFT stayed behind");
    assert_eq!(state["in_transit"], true);
    assert_eq!(env.owner_of(&token_id).await?, borrower.id().as_str());
    assert_eq!(env.company_view(&token_id).await?["needs_resync"], true);
    assert_failed(&claim_dividends(&lender, &vault, 1).await?, "ERR_ONLY_CURRENT_SHAREHOLDER");

    assert_ok(&resync(&env, &friend, &token_id).await?);
    assert_eq!(env.vault_state(&vault).await?["in_transit"], false);
    patch_approvals(&env, &token_id, 0).await?;
    assert_ok(&claim(lender.clone()).await?);
    assert_eq!(env.owner_of(&token_id).await?, lender.id().as_str());
    assert_eq!(env.vault_state(&vault).await?["shareholder"], lender.id().as_str());

    // Plain transfer: the sync comes first here, so recovery moves the vault back to the owner.
    patch_approvals(&env, &token_id, CALLBACK_BREAKING_APPROVALS).await?;
    let moved = env.transfer_nft(&lender, friend.id(), &token_id).await?;
    assert_failed(&moved, "ERR_SETTLEMENT_FAILED");
    assert_eq!(env.owner_of(&token_id).await?, lender.id().as_str());
    assert_eq!(env.company_view(&token_id).await?["needs_resync"], true);
    assert_ok(&resync(&env, &friend, &token_id).await?);
    assert_eq!(env.vault_state(&vault).await?["shareholder"], lender.id().as_str());
    assert_eq!(env.company_view(&token_id).await?["settling"], false);
    Ok(())
}

#[tokio::test]
async fn test_offers_pay_their_own_storage() -> Result<()> {
    let env = setup().await?;
    let (token_id, _vault) = env.company().await?;
    let attacker = env.funded("attacker", 10_000_000).await?;
    let offer_msg = json!({"action": "fund_offer", "token_id": token_id, "repay_amount": "1000000", "term_ms": 1000});

    // No storage prepaid: the principal goes straight back.
    let outcome = env.ft_call(&attacker, env.registry.id(), 1_000_000, offer_msg.clone()).await?;
    assert_ok(&outcome);
    assert!(outcome.logs().iter().any(|l| l.contains("ERR_STORAGE_DEPOSIT_REQUIRED")), "{:?}", outcome.logs());
    assert_eq!(env.balance(attacker.id()).await?, 10_000_000);
    let offers: Vec<Value> = env.registry.view("get_offers").args_json(json!({"token_id": token_id})).await?.json()?;
    assert!(offers.is_empty());

    let free_balance = || async {
        let details = env.worker.view_account(env.registry.id()).await?;
        Ok::<i128, anyhow::Error>(details.balance.as_yoctonear() as i128 - details.storage_usage as i128 * 10_000_000_000_000_000_000)
    };
    let cost: Value = env.registry.view("offer_storage_cost").await?.json()?;
    let cost = u128_of(&cost);
    let bounds: Value = env.registry.view("storage_balance_bounds").await?.json()?;
    let min = u128_of(&bounds["min"]);

    assert_failed(&storage_deposit(&env, &attacker, NearToken::from_yoctonear(min - 1)).await?, "ERR_STORAGE_DEPOSIT_TOO_LOW");
    let deposit = min + 3 * cost;
    let free_before = free_balance().await?;
    assert_ok(&storage_deposit(&env, &attacker, NearToken::from_yoctonear(deposit)).await?);
    let balance: Value = env.registry.view("storage_balance_of").args_json(json!({"account_id": attacker.id()})).await?.json()?;
    assert_eq!(u128_of(&balance["total"]), deposit);
    assert_eq!(u128_of(&balance["available"]), 3 * cost);

    // Offers live on prepaid storage, so across deposit and offers the free balance does not fall.
    for _ in 0..3 {
        assert_ok(&env.ft_call(&attacker, env.registry.id(), 1_000_000, offer_msg.clone()).await?);
    }
    assert!(free_balance().await? >= free_before, "offers were paid from the registry's balance");
    let offers: Vec<Value> = env.registry.view("get_offers").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(offers.len(), 3);

    // The fourth has no storage left, and locked storage cannot be withdrawn.
    let outcome = env.ft_call(&attacker, env.registry.id(), 1_000_000, offer_msg.clone()).await?;
    assert!(outcome.logs().iter().any(|l| l.contains("ERR_STORAGE_DEPOSIT_REQUIRED")), "{:?}", outcome.logs());
    assert_eq!(env.balance(attacker.id()).await?, 7_000_000);
    let withdraw = |amount: u128| {
        attacker.call(env.registry.id(), "storage_withdraw").args_json(json!({"amount": amount.to_string()})).deposit(ONE_YOCTO).gas(MAX_GAS).transact()
    };
    assert_failed(&withdraw(1).await?, "ERR_STORAGE_AMOUNT_TOO_HIGH");
    let unregister = attacker.call(env.registry.id(), "storage_unregister").args_json(json!({})).deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?;
    assert_failed(&unregister, "ERR_STORAGE_OFFERS_LOCKED");

    // Cancelling unlocks the storage, which then comes back.
    let id = offers[0]["id"].as_u64().unwrap();
    assert_ok(&attacker.call(env.registry.id(), "cancel_offer").args_json(json!({"offer_id": id})).deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?);
    let balance: Value = env.registry.view("storage_balance_of").args_json(json!({"account_id": attacker.id()})).await?.json()?;
    assert_eq!(u128_of(&balance["available"]), cost);
    let before = attacker.view_account().await?.balance.as_yoctonear();
    assert_ok(&withdraw(cost).await?);
    assert!(attacker.view_account().await?.balance.as_yoctonear() > before);
    assert_failed(&withdraw(1).await?, "ERR_STORAGE_AMOUNT_TOO_HIGH");
    Ok(())
}

#[tokio::test]
async fn test_full_offer_book_gives_way_to_larger_offers() -> Result<()> {
    let env = setup().await?;
    let (token_id, _vault) = env.company().await?;
    let attacker = env.funded("attacker", 40_000_000).await?;
    let lender = env.funded("lender", 40_000_000).await?;
    assert_ok(&storage_deposit(&env, &attacker, NearToken::from_near(1)).await?);
    assert_ok(&storage_deposit(&env, &lender, NearToken::from_near(1)).await?);

    // 32 one-USDC offers with terms no borrower would take.
    let msg = json!({"action": "fund_offer", "token_id": token_id, "repay_amount": "999000000", "term_ms": 1000}).to_string();
    let mut pending = Vec::new();
    for _ in 0..32 {
        pending.push(
            attacker
                .call(env.usdc.id(), "ft_transfer_call")
                .args_json(json!({"receiver_id": env.registry.id(), "amount": "1000000", "msg": msg}))
                .deposit(ONE_YOCTO)
                .gas(MAX_GAS)
                .transact_async()
                .await?,
        );
    }
    for tx in pending {
        assert_ok(&tx.await?);
    }
    let offers: Vec<Value> = env.registry.view("get_offers").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(offers.len(), 32);
    assert_eq!(env.balance(attacker.id()).await?, 8_000_000);

    let offer = |amount: u128| {
        env.ft_call(
            &lender,
            env.registry.id(),
            amount,
            json!({"action": "fund_offer", "token_id": token_id, "repay_amount": amount.to_string(), "term_ms": 3_600_000}),
        )
    };

    // Equal principal does not displace anyone.
    let refused = offer(1_000_000).await?;
    assert!(refused.logs().iter().any(|l| l.contains("ERR_TOO_MANY_OFFERS")), "{:?}", refused.logs());
    assert_eq!(env.balance(lender.id()).await?, 40_000_000);

    // A larger offer evicts one, whose lender gets principal and storage back.
    let locked_before: Value = env.registry.view("storage_balance_of").args_json(json!({"account_id": attacker.id()})).await?.json()?;
    assert_ok(&offer(5_000_000).await?);
    assert_eq!(env.balance(lender.id()).await?, 35_000_000);
    assert_eq!(env.balance(attacker.id()).await?, 9_000_000);
    let offers: Vec<Value> = env.registry.view("get_offers").args_json(json!({"token_id": token_id})).await?.json()?;
    assert_eq!(offers.len(), 32);
    assert_eq!(offers.last().unwrap()["lender"], lender.id().as_str());
    let locked_after: Value = env.registry.view("storage_balance_of").args_json(json!({"account_id": attacker.id()})).await?.json()?;
    let cost: Value = env.registry.view("offer_storage_cost").await?.json()?;
    assert_eq!(u128_of(&locked_after["available"]), u128_of(&locked_before["available"]) + u128_of(&cost));
    Ok(())
}

#[tokio::test]
async fn test_low_registry_balance_refuses_new_settlements_but_not_repayment() -> Result<()> {
    let env = setup().await?;
    let lender = env.funded("lender", 50_000_000).await?;
    let borrower = env.funded("borrower", 0).await?;
    let buyer = env.funded("buyer", 50_000_000).await?;
    let (pledged, pledged_vault, _) = pledged_company(&env, &lender, &borrower, 5_000_000, 6_000_000, 3_600_000).await?;
    let (listed, listed_vault) = env.incorporate(&env.founder, "Listed").await?;
    assert_ok(&env.list(&env.founder, &listed, 1_000_000).await?);
    let (free, _free_vault) = env.incorporate(&env.founder, "Free").await?;
    let offer = fund_offer(&env, &lender, &free, 1_000_000, 1_000_000, 1_000).await?;

    // Leave the registry just under its reserve.
    env.worker
        .patch(env.registry.id())
        .account_from_current(|details| {
            let storage = details.storage_usage as u128 * 10_000_000_000_000_000_000;
            AccountDetailsPatch::from(details).balance(NearToken::from_yoctonear(storage + NearToken::from_millinear(400).as_yoctonear()))
        })
        .transact()
        .await?;

    assert_failed(&env.list(&env.founder, &free, 1_000_000).await?, "ERR_REGISTRY_RESERVE_LOW");
    assert_failed(&accept(&env, &env.founder, offer).await?, "ERR_REGISTRY_RESERVE_LOW");
    let bought = env.ft_call(&buyer, env.registry.id(), 1_000_000, env.acquire_msg(&listed).await?).await?;
    assert_ok(&bought);
    assert!(bought.logs().iter().any(|l| l.contains("ERR_REGISTRY_RESERVE_LOW")), "{:?}", bought.logs());
    assert_eq!(env.balance(buyer.id()).await?, 50_000_000);
    assert_eq!(env.vault_state(&listed_vault).await?["shareholder"], env.founder.id().as_str());
    for token in [&listed, &free] {
        assert_eq!(env.company_view(token).await?["settling"], false);
    }

    // A borrower can always repay, so a drained registry cannot force a default.
    assert_ok(&env.ft_call(&buyer, env.registry.id(), 6_000_000, json!({"action": "repay", "token_id": pledged})).await?);
    assert_eq!(env.vault_state(&pledged_vault).await?["encumbrance"], "Free");
    Ok(())
}

#[tokio::test]
async fn test_vault_keeps_accepting_revenue_at_record_capacity() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let customer = env.funded("customer", 100_000_000).await?;
    const PAYMENTS: usize = 150;
    let ids: Vec<String> = (0..PAYMENTS).map(|i| format!("{i:064}")).collect();

    for chunk in ids.chunks(25) {
        let mut pending = Vec::new();
        for id in chunk {
            let msg = json!({"call_id": id}).to_string();
            pending.push(
                customer
                    .call(env.usdc.id(), "ft_transfer_call")
                    .args_json(json!({"receiver_id": vault, "amount": PRICE.to_string(), "msg": msg}))
                    .deposit(ONE_YOCTO)
                    .gas(MAX_GAS)
                    .transact_async()
                    .await?,
            );
        }
        for tx in pending {
            assert_ok(&tx.await?);
        }
    }

    let state = env.vault_state(&vault).await?;
    assert_eq!(state["payment_records"], 128);
    assert_eq!(u128_of(&state["gross_revenue"]), PRICE * PAYMENTS as u128);
    assert_eq!(env.balance(&vault).await?, PRICE * PAYMENTS as u128);
    assert_eq!(env.balance(customer.id()).await?, 100_000_000 - PRICE * PAYMENTS as u128);

    // Oldest records make way, and the newest are there. Which ones fell out depends on the order
    // the concurrent payments landed in, so count them.
    let mut kept = 0;
    let mut kept_ids = Vec::new();
    for id in &ids {
        let payment: Value = env.worker.view(&vault, "get_payment").args_json(json!({"call_id": id})).await?.json()?;
        if !payment.is_null() {
            kept += 1;
            kept_ids.push(id.clone());
        }
    }
    assert_eq!(kept, 128);

    // Fill the records to their largest size.
    let chat = "c".repeat(128);
    for chunk in kept_ids.chunks(25) {
        let mut pending = Vec::new();
        for id in chunk {
            pending.push(
                env.operator
                    .call(&vault, "record_service_call")
                    .args_json(json!({"call_id": id, "tee_chat_id": chat}))
                    .gas(MAX_GAS)
                    .transact_async()
                    .await?,
            );
        }
        for tx in pending {
            assert_ok(&tx.await?);
        }
    }
    let full = env.vault_state(&vault).await?;
    assert_eq!(full["api_calls_served"], 128);
    let free = u128_of(&full["free_near_balance"]);
    assert!(free > NearToken::from_millinear(50).as_yoctonear(), "vault close to its storage limit: {free}");

    // At capacity: payments, key setup and the policy reset on a sale all still work.
    assert_ok(&env.pay(&customer, &vault, PRICE, "after-capacity").await?);
    assert_eq!(env.vault_state(&vault).await?["payment_records"], 128);
    let stats: Value = env.worker.view(&vault, "payment_stats").await?.json()?;
    assert_eq!(stats["records"], 128);
    assert_eq!(stats["distinct_payers"], 1);
    assert_ok(&env.refresh(&vault).await?);
    assert_ok(&env.operator.call(&vault, "setup_intents_key").gas(MAX_GAS).transact().await?);
    assert_ok(&env.founder.call(&vault, "set_policy").args_json(json!({"allowed_tokens": [], "epoch_caps": []})).deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?);
    let friend = account(&env.root, "friend", 10).await?;
    assert_ok(&env.transfer_nft(&env.founder, friend.id(), &token_id).await?);

    // A plain NEAR transfer tops the vault up, and the view reports it.
    let before = u128_of(&env.vault_state(&vault).await?["free_near_balance"]);
    env.root.transfer_near(&vault, NearToken::from_near(1)).await?.into_result()?;
    let after = u128_of(&env.vault_state(&vault).await?["free_near_balance"]);
    assert_eq!(after - before, NearToken::from_near(1).as_yoctonear());
    Ok(())
}

#[tokio::test]
async fn test_registry_metrics_follow_deposits_and_are_dated() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let customer = env.funded("customer", 5_000_000).await?;
    assert!(env.charter_svg(&token_id).await?.contains("as of incorporation"));

    assert_ok(&env.pay(&customer, &vault, 1_000_000, "c1").await?);
    let svg = env.charter_svg(&token_id).await?;
    assert!(!svg.contains("as of incorporation"), "{svg}");
    let block = env.block_ms().await?;
    let days = block / 86_400_000;
    assert!(svg.contains("$1.00 as of 20"), "{svg}");
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["metrics_ms"].as_u64().unwrap() / 86_400_000, days);

    // Depositing to intents lowers retained earnings, and the registry hears about it.
    assert_eq!(u128_of(&company["retained"]), 850_000);
    assert_ok(&env.operator.call(&vault, "agent_deposit_to_intents").args_json(json!({"amount": "800000"})).gas(MAX_GAS).transact().await?);
    assert_eq!(u128_of(&env.vault_state(&vault).await?["retained_earnings"]), 50_000);
    assert_eq!(u128_of(&env.company_view(&token_id).await?["retained"]), 50_000);

    // Anyone can refresh a quiet company's snapshot.
    let before = env.company_view(&token_id).await?["metrics_ms"].as_u64().unwrap();
    env.advance_ms(5_000).await?;
    let stranger = account(&env.root, "stranger", 10).await?;
    assert_ok(&stranger.call(&vault, "refresh_metrics").gas(MAX_GAS).transact().await?);
    assert!(env.company_view(&token_id).await?["metrics_ms"].as_u64().unwrap() > before);
    Ok(())
}

#[tokio::test]
async fn test_media_hash_is_the_hash_of_the_rendered_charter() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let customer = env.funded("customer", 5_000_000).await?;
    for round in 0..2 {
        let token: Value = env.registry.view("nft_token").args_json(json!({"token_id": token_id})).await?.json()?;
        let svg = env.charter_svg(&token_id).await?;
        let expected = BASE64.encode(Sha256::digest(svg.as_bytes()));
        assert_eq!(token["metadata"]["media_hash"], expected, "round {round}");
        assert_eq!(BASE64.decode(token["metadata"]["media_hash"].as_str().unwrap())?.len(), 32);
        assert_ok(&env.pay(&customer, &vault, 1_000_000, "c1").await?);
    }
    let listed: Vec<Value> = env.registry.view("nft_tokens").args_json(json!({})).await?.json()?;
    assert!(listed[0]["metadata"]["media_hash"].is_string());
    Ok(())
}

#[tokio::test]
async fn test_withdraw_intent_frozen_while_listed_and_pledged() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.agent_ready_company().await?;
    let lender = env.funded("lender", 10_000_000).await?;
    let btc = env.vault_state(&vault).await?["addresses"]["btc"].as_str().unwrap().to_string();

    assert_ok(&env.list(&env.founder, &token_id, 1_000_000).await?);
    let frozen = env.withdraw(&env.operator, &vault, &token_id, BTC_ASSET, &btc, "btc", 10).await?;
    assert_failed(&frozen, "ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN");
    assert_ok(
        &env.founder.call(env.registry.id(), "unlist_company").args_json(json!({"token_id": token_id})).deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?,
    );

    let offer = fund_offer(&env, &lender, &token_id, 5_000_000, 5_000_000, 3_600_000).await?;
    env.register(env.founder.id()).await?;
    assert_ok(&accept(&env, &env.founder, offer).await?);
    let frozen = env.withdraw(&env.operator, &vault, &token_id, BTC_ASSET, &btc, "btc", 10).await?;
    assert_failed(&frozen, "ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN");
    assert_eq!(env.sign_count().await?, 0);
    Ok(())
}

#[tokio::test]
async fn test_one_yocto_is_required_on_every_value_moving_registry_method() -> Result<()> {
    let env = setup().await?;
    let (token_id, _vault) = env.company().await?;
    let friend = account(&env.root, "friend", 10).await?;
    for (method, args) in [
        ("nft_transfer", json!({"receiver_id": friend.id(), "token_id": token_id})),
        ("nft_transfer_call", json!({"receiver_id": friend.id(), "token_id": token_id, "msg": ""})),
        ("nft_transfer_payout", json!({"receiver_id": friend.id(), "token_id": token_id, "balance": "1"})),
        ("list_company", json!({"token_id": token_id, "ask": "1"})),
        ("unlist_company", json!({"token_id": token_id})),
        ("accept_offer", json!({"offer_id": 1})),
        ("cancel_offer", json!({"offer_id": 1})),
        ("claim_defaulted_collateral", json!({"token_id": token_id})),
        ("withdraw_pending", json!({})),
        ("storage_withdraw", json!({})),
        ("storage_unregister", json!({})),
    ] {
        let outcome = env.founder.call(env.registry.id(), method).args_json(args).gas(MAX_GAS).transact().await?;
        assert_failed(&outcome, "Requires attached deposit of exactly 1 yoctoNEAR");
    }
    assert_eq!(env.company_view(&token_id).await?["settling"], false);
    Ok(())
}

#[tokio::test]
async fn test_sync_is_refused_on_an_encumbered_vault_and_mint_event_is_exact() -> Result<()> {
    let env = setup().await?;
    let cost = env.incorporation_cost().await?;
    let outcome = env
        .founder
        .call(env.registry.id(), "incorporate_company")
        .args_json(json!({"args": {
            "name": "Events", "service_template": "t", "price_micro_usdc": "1000",
            "target_bps": [4000, 3000, 3000], "founder_royalty_bps": 0, "compute_reserve_bps": 100,
        }}))
        .deposit(cost)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_ok(&outcome);
    let event: Value = outcome
        .logs()
        .iter()
        .find(|l| l.contains("nft_mint"))
        .and_then(|l| l.strip_prefix("EVENT_JSON:"))
        .map(serde_json::from_str)
        .expect("no nft_mint event")?;
    assert_eq!(event["standard"], "nep171");
    assert_eq!(event["data"][0]["owner_id"], env.founder.id().as_str());
    assert_eq!(event["data"][0]["token_ids"], json!(["1"]));

    let vault: AccountId = format!("c-1.{}", env.registry.id()).parse()?;
    assert_ok(&env.list(&env.founder, "1", 1_000_000).await?);
    let sync = env
        .registry
        .as_account()
        .call(&vault, "sync_owner")
        .args_json(json!({"new_shareholder": env.operator.id(), "sync_nonce": 99}))
        .transact()
        .await?;
    assert_failed(&sync, "ERR_ACCOUNT_ENCUMBERED_SYNC");

    let stranger = account(&env.root, "stranger", 10).await?;
    let begin = stranger.call(&vault, "begin_transit").args_json(json!({"sync_nonce": 99})).transact().await?;
    assert_failed(&begin, "ERR_ONLY_REGISTRY");
    Ok(())
}

#[tokio::test]
async fn test_concurrent_resyncs_recover_the_token_once() -> Result<()> {
    let env = setup().await?;
    let (token_id, vault) = env.company().await?;
    let friend = account(&env.root, "friend", 10).await?;
    patch_approvals(&env, &token_id, CALLBACK_BREAKING_APPROVALS).await?;
    assert_failed(&env.transfer_nft(&env.founder, friend.id(), &token_id).await?, "ERR_SETTLEMENT_FAILED");
    patch_approvals(&env, &token_id, 0).await?;
    assert_eq!(env.company_view(&token_id).await?["needs_resync"], true);

    let first = friend.call(env.registry.id(), "resync_vault_owner").args_json(json!({"token_id": token_id})).gas(MAX_GAS).transact_async().await?;
    let second = friend.call(env.registry.id(), "resync_vault_owner").args_json(json!({"token_id": token_id})).gas(MAX_GAS).transact_async().await?;
    let _ = first.await?;
    let _ = second.await?;
    let company = env.company_view(&token_id).await?;
    assert_eq!(company["needs_resync"], false);
    assert_eq!(company["settling"], false);
    assert_eq!(env.vault_state(&vault).await?["shareholder"], env.founder.id().as_str());
    assert_ok(&env.transfer_nft(&env.founder, friend.id(), &token_id).await?);
    Ok(())
}

/// Minimal wasm module: imports one `env` host function with the given i64 parameter count and
/// no results, and exports `noop`, which does not call it.
fn single_import_module(host_fn: &str, i64_params: u8) -> Vec<u8> {
    fn section(id: u8, body: &[u8]) -> Vec<u8> {
        assert!(body.len() < 0x80, "single-byte LEB128 length");
        let mut out = vec![id, body.len() as u8];
        out.extend_from_slice(body);
        out
    }
    fn name(s: &str) -> Vec<u8> {
        assert!(s.len() < 0x80, "single-byte LEB128 length");
        let mut out = vec![s.len() as u8];
        out.extend_from_slice(s.as_bytes());
        out
    }
    let mut types = vec![2, 0x60, i64_params];
    types.extend(std::iter::repeat_n(0x7e, i64_params as usize));
    types.extend_from_slice(&[0x00, 0x60, 0x00, 0x00]);
    let mut imports = vec![1];
    imports.extend(name("env"));
    imports.extend(name(host_fn));
    imports.extend_from_slice(&[0x00, 0x00]); // func, type 0
    let mut exports = vec![1];
    exports.extend(name("noop"));
    exports.extend_from_slice(&[0x00, 0x01]); // func index 1: the import is index 0

    let mut module = b"\0asm\x01\0\0\0".to_vec();
    module.extend(section(1, &types));
    module.extend(section(2, &imports));
    module.extend(section(3, &[1, 1]));
    module.extend(section(7, &exports));
    module.extend(section(10, &[1, 2, 0, 0x0b]));
    module
}

/// The near-sdk 5.30 failure mode, reproduced on a protocol-87 node (at 88 the test checks the
/// import links instead). The runtime does not
/// check imports at deploy time: a contract importing promise_batch_action_universal_state_init
/// deploys, then every call into it fails to link, `new` included, so the account holds code that
/// can never run. The same module importing log_utf8 deploys and runs, so the failure comes from the
/// gated import and not from the module shape. scripts/check-wasm-imports.py catches this before a
/// deploy; this test pins the runtime behaviour that makes the check necessary.
#[tokio::test]
async fn test_mainnet_runtime_cannot_link_universal_state_init_import() -> Result<()> {
    let (_node, worker) = mainnet_runtime_sandbox().await?;
    let root = worker.root_account()?;

    let control = account(&root, "control", 5).await?;
    let deployed = control.deploy(&single_import_module("log_utf8", 2)).await?;
    assert!(deployed.is_success(), "control module failed to deploy: {:?}", deployed.details.failures());
    assert_ok(&control.call(control.id(), "noop").transact().await?);

    let gated = account(&root, "gated", 5).await?;
    let deployed = gated.deploy(&single_import_module("promise_batch_action_universal_state_init", 4)).await?;
    assert!(deployed.is_success(), "deploy-time behaviour changed: {:?}", deployed.details.failures());
    let call = gated.call(gated.id(), "noop").transact().await?;
    if sandbox_protocol()? >= 88 {
        // Protocol 88 enables universal_accounts, so the same import links and the call runs.
        // Mainnet has run 88 since 2026-11-06; the 5.29.1 pin stays so the wasm also runs on 87.
        assert_ok(&call);
    } else {
        assert_failed(&call, "Link Error: unknown or invalid import");
    }
    Ok(())
}
