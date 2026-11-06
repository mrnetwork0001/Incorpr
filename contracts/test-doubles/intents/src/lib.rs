//! SANDBOX ONLY. Stand-in for `intents.near`, which runs on mainnet and cannot be reached from the
//! sandbox. It covers the surface the vault touches: `add_public_key` (one yocto, duplicate keys
//! panic, as on the live contract), `public_keys_of`, and NEP-141 deposits. It does not settle
//! intents.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, PanicOnDefault,
    PromiseOrValue,
};

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Keys,
    Balances,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct IntentsDouble {
    keys: LookupMap<AccountId, Vec<String>>,
    balances: LookupMap<(AccountId, String), u128>,
    reject_deposits: bool,
    fail_add_key: bool,
    add_key_calls: u64,
}

#[near]
impl IntentsDouble {
    #[init]
    pub fn new() -> Self {
        Self {
            keys: LookupMap::new(StorageKey::Keys),
            balances: LookupMap::new(StorageKey::Balances),
            reject_deposits: false,
            fail_add_key: false,
            add_key_calls: 0,
        }
    }

    pub fn set_reject_deposits(&mut self, reject: bool) {
        self.reject_deposits = reject;
    }

    pub fn set_fail_add_key(&mut self, fail: bool) {
        self.fail_add_key = fail;
    }

    #[payable]
    pub fn add_public_key(&mut self, public_key: String) {
        assert_one_yocto();
        require!(!self.fail_add_key, "double: forced add_public_key failure");
        let account = env::predecessor_account_id();
        let mut keys = self.keys.get(&account).cloned().unwrap_or_default();
        require!(!keys.contains(&public_key), "public key already exists");
        keys.push(public_key);
        self.keys.insert(account, keys);
        self.add_key_calls += 1;
    }

    pub fn public_keys_of(&self, account_id: AccountId) -> Vec<String> {
        self.keys.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn add_key_calls(&self) -> u64 {
        self.add_key_calls
    }

    /// `msg` names the account to credit; empty credits the sender, as on the live contract.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        if self.reject_deposits {
            return amount;
        }
        let account: AccountId = if msg.is_empty() {
            sender_id
        } else {
            msg.parse().unwrap_or_else(|_| env::panic_str("double: invalid msg"))
        };
        let key = (account, format!("nep141:{}", env::predecessor_account_id()));
        let balance = self.balances.get(&key).copied().unwrap_or(0);
        self.balances.insert(key, balance + amount.0);
        U128(0)
    }

    /// NEP-171 receiver for transfer-call tests. `return` sends the token back, `slow-return:<n>`
    /// does so after n chained self-calls, which holds the registry lock open for n blocks.
    pub fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let _ = (sender_id, previous_owner_id, token_id);
        match msg.strip_prefix("slow-return:").and_then(|n| n.parse::<u32>().ok()) {
            Some(hops) => self.hop(hops),
            None => PromiseOrValue::Value(msg == "return"),
        }
    }

    pub fn hop(&self, remaining: u32) -> PromiseOrValue<bool> {
        if remaining == 0 {
            return PromiseOrValue::Value(true);
        }
        Self::ext(env::current_account_id())
            .with_static_gas(Gas::from_tgas(3))
            .hop(remaining - 1)
            .into()
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.balances.get(&(account_id, token_id)).copied().unwrap_or(0))
    }
}
