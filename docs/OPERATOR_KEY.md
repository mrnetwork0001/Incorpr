# The operator's function-call key

The app server signs as `operator.incorpr.near`, the account each vault names in `policy.operator`. Until this change the server held that account's full access key in `NEAR_OPERATOR_PRIVATE_KEY`. A full access key can do anything the account can: send its NEAR, add keys, deploy code, delete the account. `scripts/operator-key.mjs` replaces it in the server's env with a NEAR function-call access key that can call five methods on one vault, attach no deposit, and spend at most a fixed gas allowance.

The vault already treats the operator as untrusted (docs/ARCHITECTURE.md section 1 and "Agent firewall"). This key adds a second, independent limit at the protocol level: a stolen server key reaches only those five methods on that one contract.

Figures below were measured on 2026-11-06 on a local nearcore 2.14.0 sandbox (protocols 87 and 88), or read from mainnet RPC that day. Gas price on mainnet was 1e8 yocto/gas.

## 1. What the operator sends today

Every place that signs as the operator, from `web/src/lib`, `web/src/app/api` and `scripts`:

| Sender | Receiver | Method | Deposit | Prepaid gas | Mainnet example |
|---|---|---|---|---|---|
| `/api/run-service` (`operatorCall`) | the company's vault | `record_service_call` | 0 | 40 TGas | [`3iLE29jP…`](https://nearblocks.io/txns/3iLE29jPqeiLjqxHzpU1bG2YX6tLRv5u73tMUCKroLbz) |
| `/api/rebalance` step a | the vault | `setup_intents_key` | 0 | 80 TGas | [`6riRRm81…`](https://nearblocks.io/txns/6riRRm81h8Ptzqd9YtU4z9AA6gVRKZjN8jv94G6wmFkQ) |
| `/api/rebalance` step b | the vault | `agent_deposit_to_intents` | 0 | 120 TGas | [`856Sf7ui…`](https://nearblocks.io/txns/856Sf7uijk8wz7odxtET1L594cp5Ph6hsWupjVRatFCM) |
| `/api/rebalance` step f | the vault | `agent_swap_intent` | 0 | 90 TGas | [`4AmTFGH5…`](https://nearblocks.io/txns/4AmTFGH5Lb7KSki1zQeVf65owD2zDTZwCpg4uf9XAkvi) |
| `/api/rob/attempt`, `agent_withdraw` | the vault | `agent_withdraw_intent` | 0 | 30 TGas | [`9yHuadXB…`](https://nearblocks.io/txns/9yHuadXBoMuFqhBGeP8rK96xnggvZ8UPyPqDnWoS2AyL) |
| `/api/rob/attempt`, `agent_dump`, `replay_chat`, `forged_approval` | the vault | `agent_swap_intent` | 0 | 30 or 60 TGas | [`BqvJHjW5…`](https://nearblocks.io/txns/BqvJHjW5pHWS8Rj5PN2D4U4UhCkfNq39S5o2Nqstre5M), [`4wbpoEEW…`](https://nearblocks.io/txns/4wbpoEEWMcZhDZfy8shDsdZdosX2evq6TJa4Epj6efhE) |
| `scripts/demo.mjs` serve | the vault | `record_service_call` | 0 | 40 TGas | |
| `scripts/rebalance.mjs` | the vault | `setup_intents_key`, `agent_deposit_to_intents`, `agent_swap_intent` | 0 | as the route | |

All eight operator transactions in `docs/evidence/mainnet.json` go to `c-1.incorpr.near` with deposit 0. No operator call attaches a deposit, and none goes to another contract:

- `setup_intents_key` makes the vault call `intents.near.add_public_key` with 1 yocto. The vault pays that yocto from its own balance in a cross-contract call. The operator's transaction attaches nothing.
- The operator is the `compute_payee` on mainnet, so it receives USDC from `pay_compute_bill`. Its USDC `storage_deposit` was paid by the deployer in `scripts/deploy.mjs` (step 3), not signed by the operator. The operator held 0 USDC on 2026-11-06.
- `pay_compute_bill` is an operator method, but nothing in the app or the scripts sends it. It is left off the key. Add it with `--methods` if the server starts paying compute bills.
- `refresh_treasury_keys` and `refresh_metrics` are permissionless. The app sends `refresh_treasury_keys` from the user's wallet and `deploy.mjs` from the deployer. Neither is on the key.

Nothing has to move to a separate path. One limit follows from "one receiver per key": the key covers `c-1.incorpr.near` only. A second company's vault needs a second key, and `web/src/lib/operator.ts` reads a single `NEAR_OPERATOR_PRIVATE_KEY`, so serving `c-2` from the same server would need a key per vault there. Mainnet has one company today.

## 2. The key's exact limits

```text
account       operator.incorpr.near
permission    FunctionCall
receiver_id   c-1.incorpr.near
method_names  record_service_call, setup_intents_key, agent_deposit_to_intents,
              agent_swap_intent, agent_withdraw_intent
allowance     250000000000000000000000 yocto (0.25 NEAR), the default of --allowance
```

nearcore checks a transaction signed by a function-call key before it is included in a chunk. A transaction that fails these checks is refused, never executed, and costs nothing:

| The key tries to | Refused with | Checked on the sandbox |
|---|---|---|
| Send NEAR (`Transfer`) | `RequiresFullAccess` | yes |
| Add a key, delete a key (including the full access key), delete the account | `RequiresFullAccess` | yes |
| Put two calls in one transaction | `RequiresFullAccess` | yes |
| Call another contract (registry `nft_token`) | `ReceiverMismatch` | yes |
| Call USDC `ft_transfer` (needs 1 yocto) | `DepositWithFunctionCall` | yes |
| Call a listed vault method with 1 yocto attached | `DepositWithFunctionCall` | yes |
| Call an unlisted vault method (`pay_compute_bill`, `refresh_metrics`) | `MethodNameMismatch` | yes |
| Prepay more gas than its remaining allowance covers | `NotEnoughAllowance` | yes |

Deploying code and staking are also actions other than a single `FunctionCall`, so they fall under `RequiresFullAccess`; they were not sent in the rehearsal.

`scripts/operator-key.mjs` checks each method against `contracts/res/company_vault_abi.json` before it adds the key: the method must exist, must be a call, and must not be payable. A payable method could never be called with this key.

## 3. What an attacker with this key can and cannot do

Assume the server is compromised and the attacker has `NEAR_OPERATOR_PRIVATE_KEY`.

**Can**, inside the vault's own rules:

- Mark a paid, unserved call as served without serving it (`record_service_call`). The customer's payment was booked when it arrived, so this takes no money; it denies service to that customer.
- Move retained earnings into the vault's own balance on `intents.near` (`agent_deposit_to_intents`). The funds stay under the vault's account, but the shareholder cannot claim them as dividends until a swap or withdrawal brings them back.
- Propose swaps and withdrawals (`agent_swap_intent`, `agent_withdraw_intent`). Each needs a TEE approval that the vault verifies on-chain. Withdrawals go only to the vault's own current-epoch addresses. A swap can be resubmitted until the model approves it, and a colluding solver can fill it at `min_buy_amount`. The loss per 24 hours is bounded by the per-token epoch cap and the shareholder's price floor (docs/ARCHITECTURE.md section 4, "Limits"). On mainnet on 2026-11-06 the caps were about 25 USD of each token per 24 hours, with floors set 10% under the rate at deploy.
- Burn gas on failing calls, up to the remaining allowance. The gas is paid from the operator account's balance (0.344 NEAR on 2026-11-06).
- Act while the company is `FREE` only. The agent methods are frozen while it is listed, pledged or changing hands.

**Cannot:**

- Move the operator account's NEAR or USDC, add or delete keys, deploy code, or delete the account.
- Call the registry, USDC, `intents.near`, `v1.signer` or any other vault.
- Call `pay_compute_bill` or any shareholder method.
- Attach a deposit to anything.
- Spend more than the allowance on gas, in total, over the key's life.

**Revoking it** takes either of two independent steps: the full access key deletes it (`DeleteKey`, or `--replace` in section 5), or the shareholder calls `set_operator` on the vault to name another account (while `FREE`), which makes every key on `operator.incorpr.near` useless for that vault.

## 4. Running it

```bash
node scripts/operator-key.mjs --network sandbox                      # rehearsal: adds the key, probes refusals, writes <sandbox home>/web.env.local
node scripts/operator-key.mjs --network mainnet --dry-run             # reads public chain state only; opens no key file
node scripts/operator-key.mjs --network mainnet --confirm-mainnet     # one AddKey transaction signed by the full access key
```

A real run:

1. Reads `get_state` on the vault and refuses unless `policy.operator` is `operator.<registry>`.
2. Writes a fresh ed25519 key to `~/.near-credentials/mainnet/operator.incorpr.near.fc.json` (mode 0600) before sending anything. If that file exists, its key is reused, so a rerun after a failure adds the same key.
3. Sends one `AddKey` transaction, signed with the full access key from `~/.near-credentials/mainnet/operator.incorpr.near.json`. That file is not changed. The transaction is recorded in the evidence log like every other script transaction.
4. Reads the key back with `view_access_key` and refuses to continue unless receiver, method list and allowance match.
5. On a sandbox, or with `--probe`, signs a transfer, a call to another contract, a 1 yocto deposit and an unlisted method with the new key, and fails unless the node refuses each one. Refused transactions are never included and cost nothing.
6. Sets `NEAR_OPERATOR_PRIVATE_KEY` in `web/.env.local` to the new key. Before that it checks that the old value is the full access key from the key file (or empty), so it never overwrites a key it cannot recover. The full access key stays on chain and in its key file.

Restart the web server afterwards. `scripts/demo.mjs` and `scripts/rebalance.mjs` still sign with the full access key file, because `scripts/lib/near.mjs` loads `<account>.json`.

## 5. The allowance, running out, and topping up

How the allowance is charged, measured on the sandbox:

- Before a transaction is accepted, the remaining allowance must cover its prepaid gas at the pessimistic price, which is 10 times the gas price on nearcore 2.14, plus about 1 TGas of fees. With 0.2486 NEAR left, a 250 TGas call was refused (`cost: 250919250686802500000000`) and a 240 TGas call was accepted.
- After it runs, only the gas burnt is deducted. Unused gas returns to the allowance. An 80 TGas `setup_intents_key` reduced the allowance by 0.0013568 NEAR, exactly its `tokens_burnt`.

So the largest call the app sends sets a floor. `agent_deposit_to_intents` prepays 120 TGas and needs 0.121 NEAR of allowance left at a gas price of 1e8. A 0.25 NEAR key therefore has about 0.129 NEAR of usable allowance before the rebalance's deposit step is refused. Gas burnt per call on mainnet (`tokens_burnt` in `docs/evidence/mainnet.json`):

| Call | Prepaid | Allowance needed up front | Burnt on mainnet |
|---|---|---|---|
| `record_service_call` | 40 TGas | 0.041 NEAR | 0.00055 NEAR |
| `setup_intents_key` (once per vault) | 80 TGas | 0.081 NEAR | 0.00164 NEAR |
| `agent_deposit_to_intents` | 120 TGas | 0.121 NEAR | 0.00166 NEAR |
| `agent_swap_intent` | 90 TGas | 0.091 NEAR | 0.00140 NEAR |
| refused `/rob` attempt | 30 or 60 TGas | 0.031 or 0.061 NEAR | 0.00019 to 0.00027 NEAR |

At those rates 0.129 NEAR covers about 235 served calls, or about 42 rebalances (deposit plus swap), or a mix, before the deposit step stops. Smaller calls keep working until the allowance falls below their own floor. The gas price can rise under load, which raises every floor.

**When it runs out**, the node refuses the transaction with `NotEnoughAllowance`. `operatorCall` in `web/src/lib/operator.ts` broadcasts with `wait_until: NONE`, and for a refused transaction the RPC answers `{"final_execution_status":"NONE"}` instead of the error (checked on the sandbox). The app then polls for a transaction that never lands: `/api/run-service` and `/api/rebalance` wait 180 s and report `TransactionPendingError`, and `/rob` shows the attempt as pending after 90 s. The same happens today when the account's NEAR balance cannot cover a call. Check the key directly:

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"operator.incorpr.near"}}'
```

`node scripts/operator-key.mjs --network mainnet --dry-run` prints the same list with each key's remaining allowance and the largest call it can still send.

**Topping up.** NEAR has no action that raises a key's allowance in place. `--replace` adds a fresh key with the new allowance and deletes the previous function-call key in the same transaction, signed by the full access key, then points the env file at the new key:

```bash
node scripts/operator-key.mjs --network mainnet --replace --allowance 0.25 --dry-run
node scripts/operator-key.mjs --network mainnet --replace --allowance 0.25 --confirm-mainnet
```

The new key waits in `operator.incorpr.near.fc.pending.json` until `view_access_key` shows it added and the previous key gone. Only then is the previous key file renamed to `operator.incorpr.near.fc.retired-<time>.json` (not deleted) and the pending file renamed to `operator.incorpr.near.fc.json`. A run that stops before that point (an RPC timeout, a failed env check) leaves `fc.json` naming the key that is still on chain, so a rerun deletes it in the same way; a pending key that never reached the chain is set aside as `fc.abandoned-<time>.json`. Restart the web server afterwards. The allowance is a cap, not a fund: the gas is paid from the account's balance, which is topped up with a plain NEAR transfer to `operator.incorpr.near`.

## 6. The remaining full access key

`operator.incorpr.near` keeps its full access key, `ed25519:FJsgQ1gpHmER6FQoDS3rxCvJmG6Y8RWyn4p2QcVWiHsb` on 2026-11-06, in `~/.near-credentials/mainnet/operator.incorpr.near.json` on the deployer's machine. After the switch it is no longer on the web server, and the script never deletes it.

It is still needed to:

- top up or rotate the function-call key (`--replace`), and revoke it after a leak;
- add a key for each new vault (`c-2.incorpr.near` and later);
- move the operator's NEAR, and the USDC it receives as `compute_payee` from `pay_compute_bill`;
- run `scripts/demo.mjs` and `scripts/rebalance.mjs`, which sign with it.

Deleting it would leave the account with only the function-call key. The allowance could then never be refilled, so the operator would stop for good once it is spent: no calls served, no rebalances. Compute payments sent to the operator, and its NEAR, would stay locked. No new vault could be served, and a leaked function-call key could no longer be removed from the account; only each shareholder's `set_operator` would cut it off. The recommendation is to keep the full access key, keep it off the web server, and move it to a hardware wallet or another offline store if the operator holds more than gas money.

## 7. Rehearsal

```bash
cd web && npx vitest run tests/operatorKey.cli.test.ts tests/operatorKey.sandbox.e2e.test.ts
```

`tests/operatorKey.sandbox.e2e.test.ts` starts a fresh sandbox, runs `deploy.mjs`, `rob-setup.mjs` and `operator-key.mjs` with `--network sandbox`, loads the env file the scripts wrote, and then, with `NEAR_OPERATOR_PRIVATE_KEY` set to the function-call key:

- `record_service_call` marks a real Test USDC payment served, through `operatorCall`, the function `/api/run-service` uses;
- `setup_intents_key` and `agent_deposit_to_intents` succeed with the rebalance route's gas, and `deposited_to_intents` grows by the amount;
- `POST /api/rob/attempt` sends `agent_withdraw`, `agent_dump` and `forged_approval` signed by the function-call key, and the vault refuses each with its own error code (`ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION`, `ERR_FIREWALL_PRICE_BELOW_FLOOR`, `ERR_TEE_SIGNATURE_UNTRUSTED`), read back from the chain by hash;
- `agent_swap_intent` with an approval from a signer the shareholder listed returns a NEP-413 signed intent;
- every refusal in section 2 is sent and refused;
- the allowance falls by exactly the gas burnt, and a call prepaying 5 TGas more than the allowance covers is refused with `NotEnoughAllowance`;
- `--replace` adds a new key, deletes the old one in the same transaction, keeps the old key file, and the app keeps working with the new key;
- a `--replace` run that stops at its env check renames nothing and leaves the previous key on chain, and the rerun deletes that key, so only the current key file's key remains on chain.

Each operator transaction is read back by hash, and its `public_key` must be the function-call key. On 2026-11-06 both files passed (16 of 16 tests) from a fresh sandbox at protocol 87, and again with `INCORPR_SANDBOX_PROTOCOL=88`, the protocol mainnet runs; the allowance test, which assumes the 10x factor, passed at both. `OPERATOR_KEY_E2E_SANDBOX_HOME=<dir>` reuses a sandbox home where `deploy.mjs` and `rob-setup.mjs` already ran. The sandbox uses the test doubles in `contracts/test-doubles` for the MPC signer, `intents.near` and USDC, and a locally generated key stands in for the TEE signer in the swap test; the access key checks themselves are nearcore's own.
