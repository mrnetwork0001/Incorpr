# Evidence

Each file here records transactions that `scripts/deploy.mjs` and `scripts/demo.mjs` sent, read back from RPC at the time. `scripts/evidence.mjs` checks them against the chain again later.

| File | Written by | Contents |
|---|---|---|
| `<network>.json` | `deploy.mjs`, `demo.mjs` | Deployment facts, companies, every transaction (including the ones refused on purpose), 1Click dry quotes, Bitcoin spends, TEE calls |
| `../<NETWORK>_EVIDENCE.md` | same, after every write | The same data as Markdown tables with explorer links |
| `<network>.verified.json` | `evidence.mjs` | What RPC returns for each recorded transaction today, compared with the record, with `checkedAt` |

None of these files is edited by hand. Sandbox evidence is not kept here: its hashes exist only on the machine that ran the sandbox, so it stays in the sandbox home (`$TMPDIR/incorpr-sandbox/evidence/sandbox.json`, or `INCORPR_SANDBOX_HOME`).

## Check it yourself

```bash
cd web && npm ci && cd ..                     # once: the scripts load near-api-js etc. from web/node_modules
node scripts/evidence.mjs --network mainnet   # read-only RPC calls, nothing is signed
```

Options: `--file <path>` checks another evidence file, `--rpc <url>` uses your own node, `--out <path>` moves the result. Exit code 0 means every check matched, 1 means at least one mismatch or a transaction RPC could not find, 2 is a usage error.

## What is checked

For every entry in `transactions`, the script calls the `tx` RPC method with the recorded hash and signer and compares:

| Check | Rule |
|---|---|
| `found` | RPC returns the transaction. Mainnet and testnet fall back to FastNEAR's archival endpoint for old ones |
| `status` | `success` or `failure` matches the record |
| `error` | For a failure, the root ERR_ code read from the outcome matches the record (same rule as `scripts/lib/near.mjs`) |
| `refused_as_expected` | Every row marked `expected_failure` (the "rug" attempts while Listed or Pledged) failed on chain |
| `signer`, `receiver` | Match the transaction body |
| `actions` | The action list, with function calls named by method (`DeployContract+new`, `claim_dividends`), matches the recorded label |
| `deposit` | Attached NEAR, summed over Transfer and FunctionCall actions, matches |
| `gas_burnt` | Gas burnt over the transaction and all its receipts matches |

Each row also gets the block height and block timestamp of the block that included the transaction.

Accounts: the registry's `code_hash` from `view_account` must equal the recorded `registry_code_hash`, and every company vault must exist with a code hash equal to the recorded `vault_wasm_sha256` (base58 on chain, hex in the record).

Bitcoin: each spend's NEAR signature transactions must be among the verified transactions, and a broadcast txid must be known to mempool.space, with its confirmation height when confirmed.

Not re-checked: NEAR AI Cloud chat signatures in `tee_calls` (the app verifies those per call) and 1Click dry quotes (point-in-time prices).

## Limits

- A node that is not archival keeps only the last few epochs. On mainnet the script falls back to the archival endpoint by itself. A local sandbox garbage-collects after 5 epochs of 60 blocks, so sandbox evidence can only be re-checked within minutes unless the node's `gc_num_epochs_to_keep` is raised before the run.
- Protocol version: the sandbox genesis is pinned to 87, but nearcore 2.14.0 upgrades the chain to 88 within a few epochs. The verified file records the protocol version RPC reports at check time.
