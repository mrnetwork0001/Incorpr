# Incorpr: guide for judges

Deployment URL: added at submission. The paths below are relative to it.

Status on 2026-11-06: the registry `incorpr.near` and one company vault `c-1.incorpr.near` are deployed on mainnet at protocol 88, with the operator `operator.incorpr.near` and three demo accounts. `docs/MAINNET_EVIDENCE.md` records those 16 transactions. The demo steps after account setup (pay, serve, list, the refused robbery transactions, sale, loan, repay, dividends) have run only on a local sandbox so far, so the mainnet evidence has no `rug-*` rows, TEE chat records or quotes yet.

## 60 seconds

1. `/exchange`: the companies the registry holds, read from chain.
2. `/rob`: try to make the house company's treasury agent pay you. The vault refuses on-chain; follow the link to the failed transaction on nearblocks and read the error code. If the page says attempts are off, the server has no stranger key yet (`scripts/rob-setup.mjs`) or, on mainnet, `ROB_ATTEMPTS_ENABLED` is not set.
3. `/verify`: each claim, the test that checks it, and the live transaction that shows it.

## No-wallet path (about 5 minutes)

1. **Landing page, Build status section.** Lists what runs today and what does not. Every row is a claim about this repo.
2. **`/exchange`, then a company.** The company page shows its vault account `c-<id>.incorpr.near`, state, revenue and its BTC, SOL and EVM treasury addresses, each linked to its explorer (nearblocks, mempool.space, solscan, basescan). The vault computed those addresses on-chain from `v1.signer` keys.
3. **Check that the vault has no keys.** On nearblocks, open the vault account's keys tab, or ask RPC directly:

   ```bash
   curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"c-1.incorpr.near"}}'
   ```

   An empty `keys` list means no person can sign for the vault account. Its funds move only through its contract code.
4. **`/rob`.** Write a message trying to get the agent to send money to an address of yours. The attempt is sent as a real transaction and the vault refuses it. Open the failed receipt on nearblocks: the error is in the receipt outcome, not just on the page.
5. **`/verify`.** Each claim with its test name and transaction link. Pick one and open it.
6. **Evidence file.** Open `docs/MAINNET_EVIDENCE.md` and spot-check a few hashes on nearblocks (see below).

To check the code instead of the deployment: `cd contracts && cargo test --workspace` (87 tests, about 6 minutes, downloads a nearcore sandbox) and `cd web && npm ci && npx vitest run`. See the README, section Build and test.

## Optional wallet path

This costs real funds on mainnet. Use a NEAR wallet supported by Wallet Selector (MyNearWallet or Meteor).

1. **Pay for one call.** On a company page, pay the per-call price in USDC. The app sends `usdc.ft_transfer_call` to the vault, reads the booked payment back with `get_payment`, then runs the model in a NEAR AI Cloud TEE and shows the output with its signature and attestation result.
2. **Incorporate.** `/incorporate` attaches `incorporation_cost()` (4.59454 NEAR at the time of writing; about 0.03 NEAR is refunded) and creates `c-<id>.incorpr.near` with no access keys.
3. **Desk.** `/desk` lists a company you own, funds an offer as a lender, or accepts an offer as an owner. While listed or pledged, try `claim_dividends` from the company page: it fails on-chain with `ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN`.

## On-chain links

These files are written only by `scripts/deploy.mjs` and `scripts/demo.mjs`, from transactions they sent and read back from RPC. They are never edited by hand. Hashes are not copied into this guide.

| File | Contents |
|---|---|
| `docs/evidence/mainnet.json` | Machine-readable record: `deployment`, `companies`, `transactions`, `quotes`, `bitcoin`, `tee_calls` |
| `docs/MAINNET_EVIDENCE.md` | The same record rendered as tables with explorer links |
| `docs/evidence/testnet.json`, `docs/TESTNET_EVIDENCE.md` | Testnet equivalents, present only if the testnet path is run |

What to look for in `transactions`, by `step`:

| Step | Expected outcome |
|---|---|
| deploy steps | `incorpr.near` and `operator.incorpr.near` created; one transaction with `DeployContract` and `new`; one `incorporate_company` and one `refresh_treasury_keys` per company (mainnet: one company) |
| `actors` | `demo-customer`, `demo-buyer` and `demo-lender` created and registered on USDC, and sent USDC (0.10 to the customer, 1.01 to the buyer, 1.00 to the lender) |
| `pay` | `demo-customer` pays a vault with `ft_transfer_call` |
| `serve` | Operator `record_service_call`, with the TEE chat id in `tee_calls` |
| `list` | Owner `list_company` |
| `rug-listed` | Three failed transactions: `ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN`, `ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN`, `ERR_TOKEN_ENCUMBERED` |
| `buy` | `demo-buyer` acquires the company with one `ft_transfer_call` |
| `lend`, `borrow` | Lender funds an offer; owner `accept_offer` pledges the company |
| `rug-pledged` | Failed transactions with `ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN` and `ERR_TOKEN_ENCUMBERED` |
| `repay`, `dividends` | Loan repaid; shareholder claims retained earnings |
| `rebalance` | Read-only by default: no transaction, a live solver relay quote next to the vault's price floor. An executed run (`scripts/rebalance.mjs`) records its transactions under steps `rebalance:key`, `rebalance:fund`, `rebalance:deposit` and `rebalance:sign`, and the run itself (quote, TEE approval, signed intent, relay answer, settlement) in `docs/evidence/rebalance-mainnet.json` |
| `btc-send` | Present only if the BTC treasury address held UTXOs; entries in `bitcoin` |

Refused transactions are recorded on purpose. A different error than the expected one, or a success, stops the demo script.

## Real and simulated, in short

- Real: the contracts, `v1.signer`, NEAR AI Cloud inference and attestation, USDC payments on NEAR, the refused robbery transactions.
- Controlled by the deployer: `demo-customer`, `demo-buyer` and `demo-lender`. The sale and loan are real contract executions, not trades between independent parties.
- Run on mainnet: one treasury rebalance through `intents.near` (`scripts/rebalance.mjs`, 0.5 USDC to SOL), one Bitcoin spend signed by `v1.signer` for the vault, and the function-call operator key.
- Not in this release: a customer payment from a token on another chain run end to end (a wNEAR payment through 1Click has run), an EVM or Solana spend, an on-chain L1 freshness gate.
- Testnet has no `intents.near` and no 1Click.
- The local sandbox uses labelled test doubles for the signer, intents and USDC.

The full table is in the README, section What is real and what is simulated.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| A TEE route answers 503 "NEAR_AI_API_KEY is not set" | The server has no NEAR AI Cloud key. Put it in `web/.env.local` and restart the server; nothing is faked without it |
| Pages say no registry is configured | `NEXT_PUBLIC_REGISTRY_CONTRACT_ID` is empty. `scripts/deploy.mjs` writes it. `NEXT_PUBLIC_` values are inlined at build time, so rebuild or restart after a change |
| The wallet button says signing is unavailable | The app points at a local sandbox, where browser wallets cannot sign. Use the scripts or the sandbox tests there |
| A rebalance quote for USDC to BTC says "No liquidity available" | That is 1Click's answer, recorded as returned. USDC to SOL quoted normally on 2026-11-06 |
| An RPC call fails or is rate-limited | Mainnet uses `rpc.mainnet.fastnear.com` with `free.rpc.fastnear.com` as fallback. Retry, or set `NEXT_PUBLIC_NEAR_RPC_URL` |
| `cargo test` sandbox tests fail at startup | They need to download nearcore 2.14.0 and run it at protocol 87. Check network access and free ports |
| A buy is refunded with `ERR_LISTING_CHANGED` | The listing changed after the page read it. Reload and buy again |
