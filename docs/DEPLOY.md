# Deploy runbook

`scripts/deploy.mjs` puts Incorpr on a network. `scripts/demo.mjs` runs one company through its lifecycle and records every transaction. Both use plain Node ESM (Node 22.18 or later) and load `near-api-js`, `bitcoinjs-lib` and `@noble/*` from `web/node_modules`, so run `cd web && npm ci` once first. Nothing else needs installing.

Each step reads chain state before it acts and skips work that is already done, so a failed run can be rerun with the same command.

## 1. Rehearse on a local sandbox

The sandbox is nearcore 2.14.0, the build the integration tests download. Its genesis is pinned to protocol 87, as the tests are. Set `INCORPR_SANDBOX_PROTOCOL=88` to run mainnet's current protocol (see section 6). The scripts deploy the sandbox-only doubles from `contracts/test-doubles` (Test USDC, the signer double, the intents double) in place of the mainnet contracts.

```bash
scripts/build-contracts.sh                      # wasm into contracts/res, runs the import check
node scripts/lib/sandbox.mjs start --fresh      # detached node on 127.0.0.1:32123
node scripts/deploy.mjs --network sandbox
node scripts/demo.mjs --network sandbox --all --skip serve
node scripts/lib/sandbox.mjs stop --reset
```

Sandbox key files, evidence (`SANDBOX_EVIDENCE.md`) and app settings (`web.env.local`) go to the sandbox home (`$TMPDIR/incorpr-sandbox`, or `INCORPR_SANDBOX_HOME`). Nothing is written to `docs/` or `web/`. `serve` needs `NEAR_AI_API_KEY` on every network.

## 2. Price the mainnet deploy

```bash
node scripts/deploy.mjs --network mainnet --dry-run
```

The dry run sends no transactions and writes no key files. Before the first deploy it opens no key file either: key files are only read for accounts that already exist on chain. It runs every check a real run makes:

- the wasm import check;
- protocol version and `universal_accounts`, read from RPC;
- a live NEAR AI Cloud attestation for the TEE model;
- live 1Click prices for the caps and price floors;
- the deployer's balance against the plan.

Measured on 2026-11-06, protocol 88, gas price 1e8 yocto/gas, 3 companies:

| Item | NEAR |
|---|---|
| `incorpr.near`, funded through `near.create_account`: registry code storage 8.30, 0.5 settlement reserve, `operator.incorpr.near` 0.3, 0.3 margin | 9.50 |
| 3 × `incorporate_company` at `incorporation_cost()`. The registry refunds about 0.03 of each | 13.78 |
| USDC registrations for the founder and the compute payee | 0.0025 |
| Gas upper bound (attached gas × gas price) | 0.15 |
| **Deploy total for the deployer** | **23.43** |
| Demo accounts (`demo-customer`, `demo-buyer`, `demo-lender`, under `incorpr.near`) plus gas | about 0.6 |

The demo also spends native USDC: about 2.2 USDC, sent from the deployer. That is 0.10 for the customer, 1.01 for the buyer (1.00 ask plus 0.01 loan interest) and 1.00 for the lender.

Fund the deployer, the implicit account `717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9`, with 25 NEAR and 2.2 USDC on NEAR. Its key is read from `~/.near-credentials/mainnet/<deployer>.json`.

## 3. Deploy to mainnet

```bash
node scripts/deploy.mjs --network mainnet --confirm-mainnet
```

The steps, in order:

1. `near.create_account({new_account_id: "incorpr.near", new_public_key})`. The new key is written to `~/.near-credentials/mainnet/incorpr.near.json` (mode 0600) before the transaction is sent.
2. `operator.incorpr.near`, created by `incorpr.near` with a fresh key file of its own.
3. USDC `storage_deposit` for the founder (the deployer) and the compute payee (default: the operator).
4. One transaction carrying `DeployContract(incorpr_registry.wasm)` and `new(...)`. They share a transaction because `new` is not private, and a separate call could be front-run. The arguments:
   - `usdc_token` 17208628…33a1, `mpc_contract` `v1.signer`, `intents_contract` `intents.near`, `btc_hrp` `bc`;
   - `allowed_tokens`: USDC, `nep141:btc.omft.near` and `nep141:sol.omft.near`;
   - `epoch_caps`: 25 USD of each token per 24 h, at the live 1Click price;
   - `price_floors`: six pairs at the live cross rate less 10%;
   - `tee_signers`: the attested signing addresses;
   - `tee_models`: the model;
   - `tee_prompt_hash`: sha256 of `TREASURY_SYSTEM_PROMPT`, imported from `web/src/lib/rebalance.ts`.
5. `incorporate_company` for Ledgerline Audit, Tessera Translate and Brief Desk. The deposit is read from `incorporation_cost()`.
6. `refresh_treasury_keys` on each vault. Each vault reads its BTC (`bc1…`), EVM and SOL addresses from `v1.signer` on-chain.
7. `web/.env.local` is merged, and existing keys such as `NEAR_AI_API_KEY` are kept. The script writes:
   - `NEXT_PUBLIC_NEAR_NETWORK`, `NEXT_PUBLIC_REGISTRY_CONTRACT_ID`, `NEXT_PUBLIC_MPC_CONTRACT_ID`, `NEXT_PUBLIC_USDC_CONTRACT_ID`, `NEXT_PUBLIC_INTENTS_CONTRACT_ID`;
   - `NEAR_OPERATOR_ACCOUNT_ID` and `NEAR_OPERATOR_PRIVATE_KEY`.

   `web/.env.local` is in `.gitignore`. Rebuild the app afterwards, because Next inlines the `NEXT_PUBLIC_` values at build time.

`tee_signers` come only from `GET {NEAR_AI_CLOUD_URL}/attestation/report?model=…&nonce=<fresh>`. A node's address is used only if all of these hold:

- the report echoes the nonce;
- TDX `report_data` binds both the address and the nonce;
- `signing_public_key` hashes to the address;
- `@phala/dcap-qvl` verifies the Intel quote at `UpToDate` or `OutOfDate`.

If the report cannot be fetched or a node fails a check, the deploy stops. `--allow-unverified-quote` accepts a quote when Intel's collateral server cannot be reached. It does not accept a quote that fails verification.

## 4. Run the demo on mainnet

```bash
node scripts/demo.mjs --network mainnet --confirm-mainnet --all --token 1
```

| Step | What happens on chain |
|---|---|
| `actors` | Deployer tops up `incorpr.near`, which creates the three demo accounts (an implicit account cannot have sub-accounts). USDC registration and funding from the deployer |
| `pay` | `demo-customer` calls `usdc.ft_transfer_call(c-1.incorpr.near, price, {"call_id": sha256(salt:input)})` |
| `serve` | Real NEAR AI Cloud inference with the company's `service_template`, signature and fresh attestation checked, then the operator's `record_service_call` |
| `list` | Owner `list_company(1, 1 USDC)` |
| `rug-listed` | Owner tries `claim_dividends`, `request_shareholder_signature` (BTC key) and `nft_transfer`. All three are recorded as failed transactions with `ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN`, `ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN` and `ERR_TOKEN_ENCUMBERED`. A different error, or a success, stops the demo |
| `buy` | `demo-buyer` acquires through `ft_transfer_call` `{"action":"acquire","expected_sync_nonce":N}`. On a rerun the seller is `demo-buyer` and the founder buys back |
| `lend` / `borrow` / `rug-pledged` / `repay` | Lender prepays storage and funds a 1.00 USDC offer at 1.01 repay. Owner `accept_offer` (vault becomes Pledged), the rug attempts are refused, then the owner repays |
| `rebalance` | Prints the planned BTC/SOL trade for retained earnings and records real 1Click `dry: true` quotes next to the vault's price floor. Nothing is executed. `--execute` is refused |
| `dividends` | Shareholder `claim_dividends(retained_earnings)` |
| `btc-send` | If the treasury `bc1…` address holds confirmed UTXOs and `--btc-to` is given, the script builds a P2WPKH spend and has `request_shareholder_signature` sign each BIP-143 sighash through `v1.signer`. It checks each signature against the derived key, then broadcasts to mempool.space. Without UTXOs it reports the address and skips |

Every transaction, including the refused ones, goes to `docs/evidence/mainnet.json`, and `docs/MAINNET_EVIDENCE.md` is regenerated from it after each write. Neither file is edited by hand. Demo salts and call ids are kept in `~/.near-credentials/mainnet/incorpr-demo-incorpr.near.json`.

## 5. Not in this release

- Rebalance execution: `agent_deposit_to_intents`, the TEE approval and `agent_swap_intent` with solver settlement. Quotes only.
- The L1 freshness check (BTC UTXOs, SOL/EVM nonces unchanged) before a sale or loan.
- Cross-chain customer payments through NEAR Intents. Customers pay in USDC on NEAR with `ft_transfer_call`. On testnet that is Test USDC.

## 6. Notes and limits

- `near-sdk` is pinned to 5.29.1 (contracts agent). On protocol 87, mainnet had `universal_accounts = false`, and a wasm importing `promise_batch_action_universal_state_init` deployed but then failed every call with `Link Error: unknown or invalid import`. Mainnet moved to protocol 88 on 2026-11-06 (`universal_accounts = true`). The 5.29.1 wasm only drops that import. Both scripts were rehearsed end to end on a protocol-88 sandbox as well as on 87. The `cargo test` suite still pins 87.
- `incorpr.near` keeps a full access key on the deployer's machine. It is the registry `owner`, which `set_default_policy` requires, and the key can redeploy the registry. The vaults have no keys and no upgrade method. To make the registry immutable, delete that key once the policy is final.
- The demo accounts are controlled by the same person as the founder. The sale and the loan are real contract executions, not trades between independent parties. Payments from `demo-customer` count toward `revenue_30d`, because only the current shareholder's own payments are excluded (ARCHITECTURE.md section 4).
- `v1.signer`'s sign fee was not read on chain. `btc-send` attaches `--sign-deposit-yocto`, default 1. The vault forwards the whole deposit to the signer.
- On 2026-11-06, 1Click answered "No liquidity available" for USDC to `btc.omft.near` dry quotes. USDC to SOL quoted normally. The evidence records whatever 1Click returns.
- Testnet: `--deployer <you>.testnet --intents <account>` is required, and Test USDC is deployed to `test-usdc.<deployer>`. The testnet path was not run for this release.
