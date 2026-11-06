// Computes a vault's L1 addresses off-chain from the same MPC keys and paths the vault uses
// (docs/ARCHITECTURE.md section 2). Compare the result with the vault's stored addresses.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base58, bech32 } from '@scure/base';
import type { TreasuryAddresses, VaultState } from './contracts';
import { viewFunction, type ViewOptions } from './near';

export const DOMAIN_SECP256K1 = 0;
export const DOMAIN_ED25519 = 1;

export function treasuryPath(tokenId: string, epoch: number): string {
  return `incorpr-${tokenId}-e${epoch}-treasury`;
}

export function auxiliaryPath(tokenId: string, epoch: number, subpath: string): string {
  return `incorpr-${tokenId}-e${epoch}-${subpath}`;
}

export function intentsPath(tokenId: string): string {
  return `incorpr-${tokenId}-intents`;
}

/** `<mpc>.derived_public_key({path, predecessor, domain_id})`. */
export function readDerivedKey(
  mpcContract: string,
  predecessor: string,
  path: string,
  domainId: number,
  options?: ViewOptions,
): Promise<string> {
  return viewFunction<string>(
    mpcContract,
    'derived_public_key',
    { path, predecessor, domain_id: domainId },
    options,
  );
}

/** Parses `secp256k1:<base58 of x||y>` and checks the point is on the curve. */
export function parseSecp256k1Key(key: string): Uint8Array {
  if (!key.startsWith('secp256k1:')) throw new Error(`Not a secp256k1 key: ${key}`);
  const xy = base58.decode(key.slice('secp256k1:'.length));
  if (xy.length !== 64) throw new Error(`Expected 64 key bytes, got ${xy.length}`);
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 4;
  uncompressed.set(xy, 1);
  secp256k1.Point.fromBytes(uncompressed).assertValidity();
  return xy;
}

export function parseEd25519Key(key: string): Uint8Array {
  if (!key.startsWith('ed25519:')) throw new Error(`Not an ed25519 key: ${key}`);
  const bytes = base58.decode(key.slice('ed25519:'.length));
  if (bytes.length !== 32) throw new Error(`Expected 32 key bytes, got ${bytes.length}`);
  return bytes;
}

/** `keccak256(x||y)[12..]`, lowercase `0x` hex, matching the vault's stored form. */
export function evmAddress(xy: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(xy).slice(12))}`;
}

/** P2WPKH bech32 of `ripemd160(sha256(compressed))`. */
export function btcP2wpkhAddress(xy: Uint8Array, hrp: string): string {
  const compressed = new Uint8Array(33);
  compressed[0] = (xy[63] as number) & 1 ? 3 : 2;
  compressed.set(xy.subarray(0, 32), 1);
  return bech32.encode(hrp, [0, ...bech32.toWords(ripemd160(sha256(compressed)))]);
}

export function solanaAddress(ed25519Key: Uint8Array): string {
  return base58.encode(ed25519Key);
}

export interface DeriveParams {
  mpcContract: string;
  vaultAccount: string;
  tokenId: string;
  epoch: number;
  btcHrp: string;
}

export async function deriveTreasuryAddresses(
  params: DeriveParams,
  options?: ViewOptions,
): Promise<TreasuryAddresses> {
  const path = treasuryPath(params.tokenId, params.epoch);
  const [secp256k1Key, ed25519Key] = await Promise.all([
    readDerivedKey(params.mpcContract, params.vaultAccount, path, DOMAIN_SECP256K1, options),
    readDerivedKey(params.mpcContract, params.vaultAccount, path, DOMAIN_ED25519, options),
  ]);
  const xy = parseSecp256k1Key(secp256k1Key);
  return {
    epoch: params.epoch,
    btc: btcP2wpkhAddress(xy, params.btcHrp),
    evm: evmAddress(xy),
    sol: solanaAddress(parseEd25519Key(ed25519Key)),
    secp256k1_key: secp256k1Key,
    ed25519_key: ed25519Key,
  };
}

export function deriveIntentsKey(
  mpcContract: string,
  vaultAccount: string,
  tokenId: string,
  options?: ViewOptions,
): Promise<string> {
  return readDerivedKey(mpcContract, vaultAccount, intentsPath(tokenId), DOMAIN_ED25519, options);
}

export interface AddressMismatch {
  field: keyof TreasuryAddresses;
  derived: string | number;
  vault: string | number;
}

export type AddressComparison =
  | { match: true }
  | { match: false; reason: 'vault_has_no_addresses' }
  | { match: false; reason: 'mismatch'; mismatches: AddressMismatch[] };

export function compareWithVaultAddresses(
  derived: TreasuryAddresses,
  vault: TreasuryAddresses | null,
): AddressComparison {
  if (!vault) return { match: false, reason: 'vault_has_no_addresses' };
  const fields: (keyof TreasuryAddresses)[] = ['epoch', 'btc', 'evm', 'sol', 'secp256k1_key', 'ed25519_key'];
  const mismatches = fields
    .filter((field) => derived[field] !== vault[field])
    .map((field) => ({ field, derived: derived[field], vault: vault[field] }));
  return mismatches.length === 0 ? { match: true } : { match: false, reason: 'mismatch', mismatches };
}

/** Derives the current epoch's addresses from the vault's own MPC contract and compares. */
export async function checkVaultAddresses(
  vaultAccount: string,
  state: Pick<VaultState, 'mpc_contract' | 'token_id' | 'treasury_epoch' | 'btc_hrp' | 'addresses'>,
  options?: ViewOptions,
): Promise<{ derived: TreasuryAddresses; comparison: AddressComparison }> {
  const derived = await deriveTreasuryAddresses(
    {
      mpcContract: state.mpc_contract,
      vaultAccount,
      tokenId: state.token_id,
      epoch: state.treasury_epoch,
      btcHrp: state.btc_hrp,
    },
    options,
  );
  return { derived, comparison: compareWithVaultAddresses(derived, state.addresses ?? null) };
}
