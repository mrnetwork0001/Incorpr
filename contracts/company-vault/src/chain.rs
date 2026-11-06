//! Encoding and address derivation helpers. Hashes use NEAR host functions, so these
//! run inside the contract at host-function gas cost.

use near_sdk::env;

const HEX: &[u8; 16] = b"0123456789abcdef";
const BASE58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let raw = s.strip_prefix("0x").unwrap_or(s).as_bytes();
    if !raw.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(raw.len() / 2);
    for pair in raw.chunks(2) {
        out.push(hex_nibble(pair[0])? << 4 | hex_nibble(pair[1])?);
    }
    Some(out)
}

pub fn base58_encode(bytes: &[u8]) -> String {
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    let mut digits: Vec<u8> = Vec::with_capacity(bytes.len() * 138 / 100 + 1);
    for byte in &bytes[zeros..] {
        let mut carry = *byte as u32;
        for digit in digits.iter_mut() {
            carry += (*digit as u32) << 8;
            *digit = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(zeros + digits.len());
    for _ in 0..zeros {
        out.push('1');
    }
    for digit in digits.iter().rev() {
        out.push(BASE58[*digit as usize] as char);
    }
    out
}

pub fn base58_decode(s: &str) -> Option<Vec<u8>> {
    let zeros = s.bytes().take_while(|c| *c == b'1').count();
    let mut bytes: Vec<u8> = Vec::with_capacity(s.len());
    for c in s.bytes().skip(zeros) {
        let mut carry = BASE58.iter().position(|a| *a == c)? as u32;
        for byte in bytes.iter_mut() {
            carry += (*byte as u32) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let mut out = vec![0u8; zeros];
    out.extend(bytes.iter().rev());
    Some(out)
}

fn bech32_polymod(values: &[u8]) -> u32 {
    const GEN: [u32; 5] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let mut chk: u32 = 1;
    for v in values {
        let top = chk >> 25;
        chk = ((chk & 0x01ff_ffff) << 5) ^ (*v as u32);
        for (i, g) in GEN.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

/// Segwit v0 address (BIP-173) for a 20-byte witness program.
pub fn bech32_p2wpkh(hrp: &str, program: &[u8; 20]) -> String {
    let mut data: Vec<u8> = Vec::with_capacity(39);
    data.push(0);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in program {
        acc = (acc << 8) | (*b as u32);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            data.push(((acc >> bits) & 31) as u8);
        }
    }
    if bits > 0 {
        data.push(((acc << (5 - bits)) & 31) as u8);
    }

    let mut check_input: Vec<u8> = hrp.bytes().map(|c| c >> 5).collect();
    check_input.push(0);
    check_input.extend(hrp.bytes().map(|c| c & 31));
    check_input.extend_from_slice(&data);
    check_input.extend_from_slice(&[0; 6]);
    let polymod = bech32_polymod(&check_input) ^ 1;

    let mut out = String::with_capacity(hrp.len() + 1 + data.len() + 6);
    out.push_str(hrp);
    out.push('1');
    for d in &data {
        out.push(BECH32[*d as usize] as char);
    }
    for i in 0..6 {
        out.push(BECH32[((polymod >> (5 * (5 - i))) & 31) as usize] as char);
    }
    out
}

/// Parses `secp256k1:<base58 of x||y>`, the format `derived_public_key` returns for domain 0.
pub fn parse_secp256k1_key(key: &str) -> Option<[u8; 64]> {
    base58_decode(key.strip_prefix("secp256k1:")?)?.try_into().ok()
}

/// Parses `ed25519:<base58>`, the format `derived_public_key` returns for domain 1.
pub fn parse_ed25519_key(key: &str) -> Option<[u8; 32]> {
    base58_decode(key.strip_prefix("ed25519:")?)?.try_into().ok()
}

pub fn evm_address(xy: &[u8; 64]) -> String {
    let hash = env::keccak256_array(xy);
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    out.push_str(&hex_encode(&hash[12..]));
    out
}

pub fn btc_p2wpkh_address(xy: &[u8; 64], hrp: &str) -> String {
    let mut compressed = [0u8; 33];
    compressed[0] = if xy[63] & 1 == 0 { 2 } else { 3 };
    compressed[1..].copy_from_slice(&xy[..32]);
    let hash160 = env::ripemd160_array(env::sha256_array(compressed));
    bech32_p2wpkh(hrp, &hash160)
}

pub fn solana_address(ed25519_key: &[u8; 32]) -> String {
    base58_encode(ed25519_key)
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for a Unix timestamp in milliseconds.
pub fn iso8601_ms(ms: u64) -> String {
    let days = ms / 86_400_000;
    let rem = ms % 86_400_000;
    // Civil-from-days (Howard Hinnant), restricted to non-negative day counts.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);

    let (hour, minute, second, milli) =
        (rem / 3_600_000, rem / 60_000 % 60, rem / 1_000 % 60, rem % 1_000);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// NEP-413 hash: `sha256(borsh(2147484061u32) || borsh({message, nonce, recipient, callback_url: None}))`.
pub fn nep413_hash(message: &str, nonce: &[u8; 32], recipient: &str) -> [u8; 32] {
    const NEP413_TAG: u32 = 2_147_484_061;
    let mut buf = Vec::with_capacity(4 + 4 + message.len() + 32 + 4 + recipient.len() + 1);
    buf.extend_from_slice(&NEP413_TAG.to_le_bytes());
    buf.extend_from_slice(&(message.len() as u32).to_le_bytes());
    buf.extend_from_slice(message.as_bytes());
    buf.extend_from_slice(nonce);
    buf.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
    buf.extend_from_slice(recipient.as_bytes());
    buf.push(0); // callback_url: None
    env::sha256_array(&buf)
}

/// `keccak256("\x19Ethereum Signed Message:\n<len>" || text)` (EIP-191 personal_sign).
pub fn eip191_hash(text: &str) -> [u8; 32] {
    let mut buf = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    buf.extend_from_slice(text.as_bytes());
    env::keccak256_array(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    // secp256k1 generator point G, the public key used by the BIP-173 test vectors.
    const G_X: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const G_Y: &str = "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";

    fn generator() -> [u8; 64] {
        hex_decode(&format!("{G_X}{G_Y}")).unwrap().try_into().unwrap()
    }

    #[test]
    fn bip173_mainnet_and_testnet_vectors() {
        assert_eq!(
            btc_p2wpkh_address(&generator(), "bc"),
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
        );
        assert_eq!(
            btc_p2wpkh_address(&generator(), "tb"),
            "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"
        );
    }

    #[test]
    fn evm_address_of_generator_point() {
        assert_eq!(evm_address(&generator()), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    }

    #[test]
    fn base58_round_trip_with_leading_zeros() {
        assert_eq!(base58_encode(&[0, 0, 1]), "112");
        assert_eq!(base58_decode("112").unwrap(), vec![0, 0, 1]);
        assert_eq!(base58_encode(b"hello world"), "StV1DL6CwTryKyV");
        assert_eq!(base58_decode("StV1DL6CwTryKyV").unwrap(), b"hello world");
        assert!(base58_decode("0OIl").is_none());
    }

    #[test]
    fn parses_live_testnet_key_formats() {
        // Output of v1.signer-prod.testnet derived_public_key for path incorpr-1-e0-treasury,
        // predecessor c-1.incorpr.testnet.
        let secp = "secp256k1:2PoPmzB3rbnjkRktuaMqCkSGw4XRbhDiG2QaFGkuNVKweX95a5SFo95rBeyMfVyFwuEyJ8GQUUgMCpKsrs5EhdrW";
        let ed = "ed25519:E3Trc6Kdz6eVN9usuTkcTrycqjSJ7EDC2sQ6rRDsnDSH";
        assert_eq!(parse_secp256k1_key(secp).unwrap().len(), 64);
        let key = parse_ed25519_key(ed).unwrap();
        assert_eq!(solana_address(&key), "E3Trc6Kdz6eVN9usuTkcTrycqjSJ7EDC2sQ6rRDsnDSH");
        assert!(parse_secp256k1_key(ed).is_none());
        assert!(parse_ed25519_key(secp).is_none());
    }

    #[test]
    fn live_testnet_key_addresses() {
        // Expected values come from k256, sha3, ripemd and bech32 in
        // integration-tests::test_live_testnet_key_vector_with_independent_libraries.
        let secp = "secp256k1:2PoPmzB3rbnjkRktuaMqCkSGw4XRbhDiG2QaFGkuNVKweX95a5SFo95rBeyMfVyFwuEyJ8GQUUgMCpKsrs5EhdrW";
        let xy = parse_secp256k1_key(secp).unwrap();
        assert_eq!(evm_address(&xy), "0x71c759bb341d5a542acdb715dee092cf73e9cbb8");
        assert_eq!(btc_p2wpkh_address(&xy, "tb"), "tb1qvwfh0wz4sf04av68ne9aytfdlt96dp30yrtlq7");
        assert_eq!(btc_p2wpkh_address(&xy, "bc"), "bc1qvwfh0wz4sf04av68ne9aytfdlt96dp30w9svmd");
    }

    #[test]
    fn nep413_hash_matches_manual_borsh() {
        use near_sdk::borsh;
        #[derive(borsh::BorshSerialize)]
        #[borsh(crate = "near_sdk::borsh")]
        struct Payload {
            message: String,
            nonce: [u8; 32],
            recipient: String,
            callback_url: Option<String>,
        }
        let payload = Payload {
            message: "hello".to_string(),
            nonce: [9; 32],
            recipient: "intents.near".to_string(),
            callback_url: None,
        };
        let mut bytes = borsh::to_vec(&2_147_484_061u32).unwrap();
        bytes.extend(borsh::to_vec(&payload).unwrap());
        assert_eq!(nep413_hash("hello", &[9; 32], "intents.near"), env::sha256_array(&bytes));
    }

    #[test]
    fn iso8601_known_instants() {
        assert_eq!(iso8601_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso8601_ms(1_793_491_199_999), "2026-10-31T23:59:59.999Z");
    }
}
