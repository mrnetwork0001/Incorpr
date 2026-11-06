//! SANDBOX ONLY. Stand-in for `v1.signer` in near-workspaces tests, because the sandbox cannot
//! reach the MPC network. Never deploy this to a public network: its keys are derived from public
//! inputs, so anyone can compute them. Real signer calls are exercised by scripts/e2e-testnet.mjs
//! against `v1.signer-prod.testnet`.
//!
//! The string formats match the live contract: `secp256k1:<base58 x||y>`, `ed25519:<base58>`, and
//! the responses `{"scheme":"Secp256k1","big_r":{"affine_point":..},"s":{"scalar":..},"recovery_id":..}`
//! and `{"scheme":"Ed25519","signature":[..]}`.

use ed25519_dalek::{Signer, SigningKey as EdSigningKey};
use k256::ecdsa::SigningKey as SecpSigningKey;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum PayloadV2 {
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SignRequest {
    pub payload_v2: PayloadV2,
    pub path: String,
    pub domain_id: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct RecordedSign {
    pub predecessor: AccountId,
    pub request: SignRequest,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MpcSignerDouble {
    fail_sign: bool,
    fail_derive: bool,
    sign_calls: Vec<RecordedSign>,
}

fn seed(predecessor: &str, path: &str, domain_id: u64) -> [u8; 32] {
    let input = format!("incorpr-sandbox-double,{predecessor},{path},{domain_id}");
    env::sha256_array(input.as_bytes())
}

fn secp_key(predecessor: &str, path: &str) -> SecpSigningKey {
    SecpSigningKey::from_bytes(&seed(predecessor, path, 0).into())
        .unwrap_or_else(|_| env::panic_str("double: seed is not a valid scalar"))
}

fn ed_key(predecessor: &str, path: &str) -> EdSigningKey {
    EdSigningKey::from_bytes(&seed(predecessor, path, 1))
}

fn decode_hex(input: &str) -> Vec<u8> {
    let raw = input.as_bytes();
    require!(raw.len().is_multiple_of(2), "double: odd hex length");
    raw.chunks(2)
        .map(|pair| {
            let hi = (pair[0] as char).to_digit(16);
            let lo = (pair[1] as char).to_digit(16);
            match (hi, lo) {
                (Some(h), Some(l)) => (h << 4 | l) as u8,
                _ => env::panic_str("double: invalid hex"),
            }
        })
        .collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[near]
impl MpcSignerDouble {
    #[init]
    pub fn new() -> Self {
        Self { fail_sign: false, fail_derive: false, sign_calls: Vec::new() }
    }

    pub fn set_fail_sign(&mut self, fail: bool) {
        self.fail_sign = fail;
    }

    pub fn set_fail_derive(&mut self, fail: bool) {
        self.fail_derive = fail;
    }

    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String {
        require!(!self.fail_derive, "double: forced derive failure");
        let predecessor = predecessor.unwrap_or_else(env::predecessor_account_id);
        match domain_id.unwrap_or(0) {
            0 => {
                let key = secp_key(predecessor.as_str(), &path);
                let point = key.verifying_key().to_encoded_point(false);
                format!("secp256k1:{}", bs58::encode(&point.as_bytes()[1..]).into_string())
            }
            1 => {
                let key = ed_key(predecessor.as_str(), &path);
                format!("ed25519:{}", bs58::encode(key.verifying_key().as_bytes()).into_string())
            }
            _ => env::panic_str("double: unknown domain"),
        }
    }

    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> Value {
        require!(!self.fail_sign, "double: forced sign failure");
        require!(
            env::attached_deposit().as_yoctonear() >= 1,
            "double: sign requires a deposit, as the live contract does"
        );
        let predecessor = env::predecessor_account_id();
        let response = match (&request.payload_v2, request.domain_id) {
            (PayloadV2::Ecdsa(payload), 0) => {
                let hash = decode_hex(payload);
                require!(hash.len() == 32, "double: Ecdsa payload must be 32 bytes");
                let key = secp_key(predecessor.as_str(), &request.path);
                let (signature, recovery) = key
                    .sign_prehash_recoverable(&hash)
                    .unwrap_or_else(|_| env::panic_str("double: signing failed"));
                let bytes = signature.to_bytes();
                let prefix = if recovery.is_y_odd() { "03" } else { "02" };
                json!({
                    "scheme": "Secp256k1",
                    "big_r": {"affine_point": format!("{prefix}{}", encode_hex(&bytes[..32]))},
                    "s": {"scalar": encode_hex(&bytes[32..])},
                    "recovery_id": recovery.to_byte(),
                })
            }
            (PayloadV2::Eddsa(payload), 1) => {
                let message = decode_hex(payload);
                let key = ed_key(predecessor.as_str(), &request.path);
                json!({
                    "scheme": "Ed25519",
                    "signature": key.sign(&message).to_bytes().to_vec(),
                })
            }
            _ => env::panic_str("double: payload does not match domain"),
        };
        self.sign_calls.push(RecordedSign { predecessor, request });
        response
    }

    pub fn sign_count(&self) -> u64 {
        self.sign_calls.len() as u64
    }

    pub fn sign_calls(&self) -> Vec<RecordedSign> {
        self.sign_calls.clone()
    }
}
