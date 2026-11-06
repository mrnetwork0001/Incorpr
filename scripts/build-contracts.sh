#!/usr/bin/env bash
# Builds all contracts into contracts/res. The vault goes first because incorpr-registry embeds
# contracts/res/company_vault.wasm with include_bytes!. After the build, every wasm is checked
# for host-function imports that mainnet does not provide (scripts/check-wasm-imports.py); the
# script exits non-zero if one is found.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/contracts"
RES="$CONTRACTS/res"
mkdir -p "$RES"

command -v cargo-near >/dev/null || { echo "cargo-near is required: cargo install cargo-near" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required for the wasm import check" >&2; exit 1; }

build() {
  local dir="$1" name="$2" abi="${3:-}"
  echo "==> $name"
  (cd "$CONTRACTS/$dir" && cargo near build non-reproducible-wasm --locked ${abi:+--no-abi})
  install -m 644 "$CONTRACTS/target/near/$name/$name.wasm" "$RES/$name.wasm"
  if [ -f "$CONTRACTS/target/near/$name/${name}_abi.json" ]; then
    cp "$CONTRACTS/target/near/$name/${name}_abi.json" "$RES/${name}_abi.json"
  fi
}

build company-vault company_vault
build incorpr-registry incorpr_registry
build test-doubles/mpc-signer mpc_signer_double no-abi
build test-doubles/intents intents_double no-abi
build test-doubles/test-usdc test_usdc no-abi

echo
echo "Import check (mainnet deny list):"
python3 "$ROOT/scripts/check-wasm-imports.py" "$RES"/*.wasm

echo
echo "Built:"
ls -l "$RES"/*.wasm | awk '{print $5, $NF}'
