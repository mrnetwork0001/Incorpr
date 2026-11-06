# Incorpr architecture (authoritative)

Where this file and `RUST_CONTRACTS_SPEC.md` / `BACKEND_AND_INTENTS_SPEC.md` disagree, this file wins. Section 7 lists each change and the defect it closes.

## 1. Trust model

| Actor | Can | Cannot |
|---|---|---|
| Shareholder (current NFT owner) | Claim dividends and sign raw L1 payloads while `Free`; rotate treasury epoch | Sign, claim, or set policy while `Listed`, `Pledged` or in transit |
| Operator (TEE agent relay, untrusted) | Ask the vault to build a `token_diff` or self-withdraw intent inside policy, with a TEE approval; deposit retained earnings to `intents.near`; pay compute from the reserve to `compute_payee`; mark a paid call as served | Supply bytes to sign or a prompt to approve, choose a destination, report revenue, use the agent methods while encumbered or in transit |
| Charter operator (`default_policy.operator`) | While encumbered or in transit, the only account that can call `pay_compute_bill` and `record_service_call`. A seller's own operator cannot | The agent methods, while encumbered or in transit |
| Registry | Update vault owner and encumbrance | Sign anything on the vault's behalf |
| Anyone | Call permissionless key setup and `resync_vault_owner`, refresh metrics, read all state | |

The vault sub-account has no access keys and no upgrade method. `get_state` and `view_access_key_list` make that checkable.

## 2. Derivation paths (composed only by the vault)

| Path | Domain | Use | Raw signing |
|---|---|---|---|
| `incorpr-<id>-intents` | 1 (Ed25519) | Key registered on `intents.near` for the vault account | Never |
| `incorpr-<id>-e<epoch>-treasury` | 0, 1 | Current L1 treasury: BTC P2WPKH, EVM, Solana | Shareholder; each signature marks the epoch dirty |
| `incorpr-<id>-e<epoch>-<subpath>` | 0, 1 | Shareholder-chosen auxiliary keys | Shareholder; also marks the epoch dirty |

`subpath` must match `[a-z0-9-]{1,32}`. `epoch` starts at 0.

The vault reads its keys from `<mpc>.derived_public_key({path, predecessor: <self>, domain_id})` and computes the addresses on-chain:
- Secp256k1 keys arrive as `secp256k1:<base58 of x||y>`.
- EVM address: `keccak256(x||y)[12..]`, lowercase `0x` hex.
- BTC address: P2WPKH bech32 of `ripemd160(sha256(compressed))`, with HRP `bc` on mainnet or `tb` on testnet (init arg).
- Solana address: base58 of the 32-byte Ed25519 key, the same string that follows `ed25519:`.

## 3. Pre-signed transaction rule

A signature can be issued while `Free`, held unbroadcast, and spent after a sale. A freeze cannot stop that, and neither can a mempool check. Incorpr handles it this way:

1. Every raw signature increments `raw_sigs_this_epoch` **before** the MPC call.
2. Applying `Listed` or `Pledged` panics with `ERR_RAW_SIGNATURES_THIS_EPOCH` if `raw_sigs_this_epoch > 0`.
3. `rotate_treasury_epoch` (shareholder, `Free`) moves to a new epoch and new addresses and resets the counter. The seller moves funds to the new addresses first.
4. NAV counts only current-epoch addresses and the vault's `intents.near` balance. The buyer's assets therefore sit on keys that have never signed a raw payload.
5. Old-epoch funds stay reachable through `sign_legacy_epoch` (shareholder, `Free`), are excluded from NAV, and never dirty the current epoch.
6. Vault-built intents have a deadline of at most `MAX_INTENT_TTL_MS` (300 000). Applying an encumbrance panics with `ERR_UNEXPIRED_SIGNED_INTENTS` until `now > latest_intent_deadline_ms`. The agent is frozen while encumbered.

Because the check runs when the freeze lands, a signature raced in between the registry call and the vault receipt makes the listing fail. It cannot slip through.

The same rule applies on every path that changes the shareholder, since `nft_transfer`, `nft_transfer_call` and `nft_transfer_payout` also sell a company:

| Path | Raw signatures this epoch | Unexpired intent |
|---|---|---|
| `nft_transfer_payout`, `nft_transfer_call`, `nft_transfer` by an approved account | `ERR_RAW_SIGNATURES_THIS_EPOCH` | `ERR_UNEXPIRED_SIGNED_INTENTS` |
| `nft_transfer` by the owner | The vault rotates: `treasury_epoch + 1`, counter 0, addresses cleared | `ERR_UNEXPIRED_SIGNED_INTENTS` |

An owner's direct transfer stays possible for gifts and moves between the owner's own accounts. The receiver starts on keys that never signed, and funds left on the old key stay spendable by any signature the sender holds, so they count for nothing under item 4. `nft_payout` is a view and cannot read the vault, so it can quote a company that `nft_transfer_payout` then refuses.

## 4. `company-vault`

Amounts are `U128` in micro-USDC in all JSON interfaces. State uses Borsh. `#[near(contract_state)]`, `PanicOnDefault`. All privileged methods check `predecessor_account_id`.

```text
new(args: VaultInit { token_id, registry, shareholder, founder, founder_royalty_bps, operator, compute_payee,
    mpc_contract, intents_contract, usdc_token, btc_hrp, price_micro_usdc, compute_reserve_bps,
    allowed_tokens: Vec<String>, epoch_caps: Vec<(String, U128)>, tee_signers: Vec<String>,
    tee_models: Vec<String>, tee_prompt_hash: String, price_floors: Vec<PriceFloor> })
    // compute_reserve_bps must be in 100..=10000

// Registry only
sync_owner(new_shareholder, sync_nonce: u64, require_clean: Option<bool>)
    // monotonic nonce; stale calls panic ERR_STALE_SYNC. Refused while encumbered or in transit.
    // On a change of shareholder: unexpired intents panic, raw signatures panic if require_clean, otherwise rotate.
begin_transit(sync_nonce: u64)                               // section 3 checks, then blocks shareholder and agent rights
apply_encumbrance(new_shareholder, state, sync_nonce: u64, terms: Option<PledgeTerms>)
    // enforces section 3 for non-Free states and PledgeTerms { min_retained, required_epoch } (ERR_PLEDGE_TERMS_NOT_MET). Ends transit.

// Revenue: USDC only arrives through NEP-141 callbacks. Revenue is never reported by an actor.
ft_on_transfer(sender_id, amount, msg) -> U128
   // predecessor must be usdc_token, else return full amount (refund). msg = {"call_id": "<1..64 chars>"}.
   // Refund in full if msg is invalid, amount < price, or call_id already exists.
   // Otherwise split into compute_reserve and retained_earnings, add to daily buckets, store Payment
   // { payer, amount, served: false }, then notify the registry with report_metrics. Return 0.
   // If sender_id == shareholder, book to related_party_revenue. This is excluded from revenue_30d.
   // The newest 128 Payment records stay on-chain; the oldest makes way. `payment_received` events are the full record.

// Operator
record_service_call(call_id, tee_chat_id)                    // payment must exist and be unserved; increments api_calls_served. Charter operator only while encumbered or in transit
pay_compute_bill(amount)                                     // reserve -> compute_payee via ft_transfer; callback restores on failure. Charter operator only while encumbered or in transit
agent_deposit_to_intents(amount)                             // retained -> ft_transfer_call(intents_contract, msg = self); callback restores unused amount
agent_swap_intent(p: SwapProposal, tee: TeeProof) -> Promise // { sell_token, sell_amount, buy_token, min_buy_amount, nonce_b64 }
agent_withdraw_intent(p: WithdrawProposal, tee: TeeProof) -> Promise // { token, amount, destination, chain, nonce_b64 }

// Shareholder
claim_dividends(amount)                                      // one yocto, Free only; callback restores on failure
request_shareholder_signature(domain_id, payload_hex, subpath) -> Promise // Free only: ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN
sign_legacy_epoch(epoch, domain_id, payload_hex, subpath) -> Promise      // Free only, epoch < current
rotate_treasury_epoch() -> Promise
set_operator(account), set_tee_signers(addresses), set_policy(allowed_tokens, epoch_caps)   // Free only
set_tee_policy(models, prompt_hash), set_price_floors(floors)                               // Free only

// Permissionless
refresh_treasury_keys() -> Promise                           // derive and store current-epoch addresses
setup_intents_key() -> Promise                               // derive intents key, then intents_contract.add_public_key(key) with 1 yocto. Idempotent.
refresh_metrics()                                            // pushes current metrics to the registry

// Views
get_state() -> VaultView, get_payment(call_id), treasury_addresses(), revenue_30d()
payment_stats() -> { records, total_amount, served_amount, distinct_payers, largest_payer_amount }   // over the records still on-chain
swap_tee_request(p, model, system_prompt), withdraw_tee_request(p, model, system_prompt) -> { body, proposal_hash }
```

A plain NEAR transfer tops up the vault's balance, and `get_state().free_near_balance` reports what is left. Incorporation funds `VAULT_STATE_BYTES` (64 000) plus a 0.5 NEAR operating balance, which covers the largest allowed policy and full payment and nonce logs.

### Agent firewall

The operator passes structured fields and never passes bytes. The vault:

1. Checks caller is operator (`ERR_ONLY_TEE_TREASURY_AGENT`) and state is `Free` (`ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN`).
2. Checks tokens against `allowed_tokens` (`ERR_FIREWALL_BLOCKED_TOKEN`). `sell_token != buy_token`, amounts > 0.
3. Withdrawals only: `destination` must equal the stored current-epoch address for `chain` (`btc`, `sol`, `evm`), else `ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION`. No stored addresses is the same error.
4. Adds to the per-token epoch spend for the current `EPOCH_MS` (86 400 000) window and panics with `ERR_FIREWALL_EPOCH_CAP_EXCEEDED` over the cap. Not refunded on signing failure.
5. Swaps only: `min_buy_amount / sell_amount` must be at least the `min_buy / per_sell` floor set for that pair in `price_floors`, else `ERR_FIREWALL_PRICE_BELOW_FLOOR`. A pair with no floor is `ERR_FIREWALL_NO_PRICE_FLOOR`.
6. Rejects a reused nonce (`ERR_NONCE_USED`). A nonce is kept for 660 s, longer than any proof carrying it can be accepted, and at most 32 are live at once (`ERR_TOO_MANY_LIVE_NONCES`).
7. Verifies the TEE approval (below).
8. Builds the NEP-413 message itself, computes the NEP-413 hash, sets `latest_intent_deadline_ms`, and calls `sign` on the intents path, domain 1. The callback returns `{ standard: "nep413", payload: { message, nonce, recipient }, public_key, signature }`, ready for `execute_intents` or the solver relay.

```json
{"signer_id":"<self>","deadline":"<ISO8601 ms Z>","intents":[{"intent":"token_diff","diff":{"<sell>":"-<amount>","<buy>":"<min_buy>"}}]}
{"signer_id":"<self>","deadline":"<ISO8601 ms Z>","intents":[{"intent":"ft_withdraw","token":"<contract>","receiver_id":"<omft contract>","amount":"<amount>","memo":"WITHDRAW_TO:<destination>"}]}
```

NEP-413 hash: `sha256(borsh(2147484061u32) || borsh({message, nonce: [u8;32], recipient, callback_url: None}))`. Check `intents.near` for its current nonce format (`current_salt`) against the deployed contract and match it; `nonce_b64` is opaque to the vault apart from being 32 bytes and unused.

### TEE approval, verified on-chain

```text
TeeProof { text, signature_hex, response_body, system_prompt }
preimage      = "incorpr:v2:<vault account>:<treasury_epoch>:<owner_generation>:<kind>:<canonical fields joined by ':'>:<nonce_b64>"
proposal_hash = hex(sha256(preimage))
user message  = preimage + "\nproposal_hash=" + proposal_hash
request body  = {"model":"<model>","messages":[{"role":"system","content":"<system_prompt>"},{"role":"user","content":"<user message>"}],"stream":false}
```

The vault writes the whole request, and the operator sends exactly those bytes. `swap_tee_request` and `withdraw_tee_request` return them. Every proposal field is a policy-checked value, a number or base64, so the operator has no free text in front of the model and no request parameter to steer it with. The vault account pins network and deployment. `treasury_epoch` and `owner_generation` end an approval on rotation or on any change of shareholder.

1. Empty proof fields panic with `ERR_MISSING_TEE_ATTESTATION`; oversized ones with `ERR_TEE_PROOF_TOO_LARGE`.
2. `text` must be exactly `{model}:{request_hash}:{response_hash}` (`ERR_TEE_TEXT_FORMAT`). This is the `provider_tee` form; a two-field gateway signature is refused, so call the model's `{slug}.completions.near.ai` endpoint.
3. `model` is in `tee_models` (`ERR_TEE_MODEL_NOT_ALLOWED`). `sha256(system_prompt)` equals a non-empty `tee_prompt_hash` (`ERR_TEE_PROMPT_NOT_PINNED`).
4. `response_body` is a chat completion JSON with one choice, whose `message.content`, trimmed, equals `APPROVE <proposal_hash>`, else `ERR_TEE_NOT_APPROVED`.
5. Its `created` field is at most 600 s old and at most 60 s ahead of block time (`ERR_TEE_APPROVAL_EXPIRED`). The TEE signs over this value, so an operator cannot stockpile approvals.
6. `response_hash` equals hex `sha256(response_body)` (`ERR_TEE_RESPONSE_MISMATCH`). `request_hash` equals hex `sha256(request body)` (`ERR_TEE_REQUEST_MISMATCH`).
7. `env::ecrecover` over EIP-191 `keccak256("\x19Ethereum Signed Message:\n<len>" || text)` gives an address in `tee_signers`, else `ERR_TEE_SIGNATURE_UNTRUSTED`.

Limits to state plainly in the README:
- A compromised operator can resubmit a proposal until a nondeterministic model approves it. A colluding solver can then fill at `min_buy_amount`. The loss per window is bounded by the epoch cap and the price floor.
- A price floor is a shareholder-set lower bound, not an oracle. It goes stale when the market moves.
- `tee_signers`, `tee_models` and `tee_prompt_hash` are set by the shareholder; the UI compares them with the live attestation. None of these widen the destination set.
- `revenue_30d` is not verified against sybil payers. A seller's second account counts as a customer, and only the current shareholder's own payments are excluded. Each cycle through dividends costs at least the 1% minimum reserve, which goes to `compute_payee`. Read it with `payment_stats`, `dividends_paid` and `compute_paid`.
- A buyer sees a listing's state as of `sync_nonce`. While listed, the charter operator can still spend the compute reserve, only to `compute_payee`.

## 5. `incorpr-registry`

NEP-171, NEP-177, NEP-178, NEP-181, NEP-199, built on `near-contract-standards` internals with custom `nft_transfer`.

```text
new(args: RegistryInit { owner, usdc_token, mpc_contract, intents_contract, btc_hrp, default_operator, compute_payee,
    allowed_tokens, epoch_caps, tee_signers, tee_models, tee_prompt_hash, price_floors, auction_duration_ms })
set_default_policy(default_operator, compute_payee, allowed_tokens, epoch_caps, tee_signers, tee_models, tee_prompt_hash, price_floors)  // owner
incorporate_company(args: Incorporate { name, service_template, price_micro_usdc, target_bps: [u16;3], founder_royalty_bps, compute_reserve_bps })
   // payable; attached >= vault storage + token storage, excess refunded. royalty <= 1000, targets sum to 10000, reserve in 100..=10000.
   // Batch: create c-<id>.<registry>, transfer, deploy, new, no access keys. Callback mints on success, refunds on failure.
report_metrics(token_id, gross, retained, revenue_30d, calls)  // predecessor must be that company's vault

// Market. Every path: set lock, call vault, act in callback only on success, clear lock on failure.
list_company(token_id, ask: U128)        // 1 yocto; Listing activates only after the vault freeze succeeds
unlist_company(token_id)                 // 1 yocto
accept_offer(offer_id)                   // 1 yocto; freeze, then ft_transfer principal to borrower
cancel_offer(offer_id)                   // 1 yocto, lender only
start_auction(token_id)                  // anyone, after due_ms
claim_defaulted_collateral(token_id)     // lender, after auction window with no bid
withdraw_pending()                       // pull fallback for failed payouts
resync_vault_owner(token_id)             // anyone, when needs_resync: writes the registry's owner and state to the vault

// NEP-145. A lender prepays offer storage here, because ft_transfer_call cannot carry NEAR.
storage_deposit(account_id, registration_only), storage_withdraw(amount), storage_unregister(force),
storage_balance_of(account_id), storage_balance_bounds(), offer_storage_cost()

ft_on_transfer(sender_id, amount, msg) -> PromiseOrValue<U128>   // USDC only; other tokens refunded
   {"action":"acquire","token_id":"1","expected_sync_nonce":N}   // amount >= ask; excess refunded. N from get_listing or get_company
   {"action":"fund_offer","token_id":"1","repay_amount":"..","term_ms":N,"terms":{"min_retained":"..","required_epoch":N}}   // terms optional
   {"action":"repay","token_id":"1"}                             // anyone; amount >= debt; excess refunded
   {"action":"bid","token_id":"1"}                               // amount >= current Dutch price

get_company(token_id), list_companies(from, limit), get_offers(token_id), get_loan(token_id), get_listing(token_id), auction_price(token_id)
```

Rules:
- Lock states: a token with `settling == true` rejects all market calls and transfers (`ERR_TOKEN_SETTLING`).
- Vault first, ownership second. If the first vault call fails nothing moves.
- `nft_transfer`: `sync_owner`, then transfer in the callback.
- `acquire`, `bid`, `repay`, `claim_defaulted_collateral`, `unlist_company`, `nft_transfer_payout`: `begin_transit`, then token and funds move in the callback, then `apply_encumbrance` names the final holder. Nobody holds shareholder rights between the first and last step, and a buyer gets them only after it has paid.
- `nft_transfer_call`: the same, around the receiver call. During `nft_on_transfer` the receiver owns the NFT but neither it nor the sender can use the vault. If the receiver keeps the token it becomes shareholder when the call resolves. On a revert the sender keeps its shareholder position, policy and approvals, as if nothing had happened.
- Each callback is followed by a watcher receipt. If the callback failed while the lock is on, the watcher sets `needs_resync`, releases a settling offer, and refunds the payer in full on NEP-141 paths. The token stays locked until anyone calls `resync_vault_owner`, which writes the registry's current owner and state to the vault. A failure of the last vault step sets the same flag.
- NEP-178 approvals keep working and are cleared on transfer. At most 16 per token (`ERR_TOO_MANY_APPROVALS`), and none can be added while `Listed` or `Pledged` (`ERR_TOKEN_ENCUMBERED`), because settlement callbacks read this map. `memo` is at most 256 bytes (`ERR_MEMO_TOO_LONG`), checked before the vault is touched; `msg` at most 4096.
- `Listed` or `Pledged` tokens reject `nft_transfer` with `ERR_TOKEN_ENCUMBERED`.
- `acquire` names the `sync_nonce` the buyer read. Unlisting and relisting both change it, so a seller who strips a company and relists at the same ask gets `ERR_LISTING_CHANGED` and the buyer a refund.
- `acquire` and `bid`: the callback returns the amount to refund, so `ft_resolve_transfer` returns the buyer's funds if the vault call failed. On success: transfer NFT, pay royalty to founder, pay the rest to seller or lender. A failed `ft_transfer` payout credits `pending_withdrawals`.
- Offers: each locks `offer_storage_cost()` (0.01024 NEAR) of the lender's prepaid storage until it is cancelled or evicted or its loan closes; without it the principal is refunded with `ERR_STORAGE_DEPOSIT_REQUIRED`. A token holds 32 offers. When full, a larger offer evicts the smallest, whose lender gets principal and storage back. Otherwise `ERR_TOO_MANY_OFFERS`. `terms` lets a lender refuse a company stripped after it priced the offer.
- Registry balance: `list_company`, `acquire` and `accept_offer` are refused below a 0.5 NEAR free balance (`ERR_REGISTRY_RESERVE_LOW`), so running settlements can still record failed payouts. `repay`, `bid` and claims are not refused: they free more storage than they use, and refusing them could force a default. A failed payout to a fresh unregistered account stores a pending entry at the registry's cost, about 0.0012 NEAR against far more than that in the attacker's gas. Deployers keep the registry funded above the reserve.
- Dutch auction: price falls linearly from 200% of debt to 50% of debt over `auction_duration_ms`. Bid proceeds pay the lender up to debt, then royalty on the remainder, then the borrower.
- `nft_token` metadata `media` is a `data:image/svg+xml;base64,...` charter: name, sub-account, service, price, encumbrance pill (`FREE` green, `LISTED` amber, `PLEDGED` purple), target allocation, 30d revenue with its report date, calls. `media_hash` is the base64 sha256 of the SVG bytes.
- The registry holds a metrics snapshot from `report_metrics`. It reads as zero once 30 days pass with no report; before that it can overstate a company that stopped earning, so the charter prints the date, and `refresh_metrics` on the vault updates it. `vault.revenue_30d` is exact.
- NEP-297 events for market, credit, approval and storage state changes.
- Wasm: registry embeds `contracts/res/company_vault.wasm` with `include_bytes!`. Build order is in `scripts/build-contracts.sh`.

## 6. Sandbox and testnet

Production contracts contain no test branches. `contracts/test-doubles/` holds sandbox-only contracts: `mpc-signer`, `intents`, and `test-usdc`. The sandbox cannot reach the MPC network, so the signer double exists only there and is labelled as such. `test-usdc` also deploys to testnet, where it is labelled "Test USDC".

Real signer calls are proven on testnet by `scripts/e2e-testnet.mjs` against `v1.signer-prod.testnet`, with signatures verified off-chain against `derived_public_key` and hashes written to `docs/TESTNET_EVIDENCE.md`.

`intents.near` and 1Click settle on mainnet only. Default network is testnet. On testnet, pay and settle flows use Test USDC with `ft_transfer_call`, and 1Click panels show real `dry: true` quotes. On mainnet, 1Click runs with `dry: false`, using `customRecipientMsg` so USDC reaches the vault through `ft_on_transfer`.

If `NEAR_AI_API_KEY` is unset, the TEE routes return HTTP 503 with a clear message. The UI shows that state. Nothing is synthesized.

## 7. Changes from the original specs

| Original | Defect | Now |
|---|---|---|
| `execute_agent_rebalance(raw_tx, digest, prefix, ...)` | Caller chose the allowlist; digest not bound to the transaction | Vault builds and hashes the payload |
| Whitelisted 1Click deposit addresses | Per-quote address; recipient set off-chain | Agent acts through `intents.near` under a vault-only key |
| "Front-running is impossible" via freeze and mempool check | Held signatures bypass both | Section 3 |
| `ecdsaVerified` from one API response | Self-referential | Attested `signing_address`, request and response hashes, on-chain `ecrecover` |
| `record_service_revenue` by operator | Revenue is whatever the operator says | `ft_on_transfer` only |
| Freeze and transfer described as atomic | Separate NEAR receipts | Lock, vault first, callback, refund |
| Off-chain address registration | Seller could register a key they hold | On-chain derivation |
| `u128` in JSON | Precision loss in JS | `U128` |
| `DeepSeek-V3.1` default | Not in the live model list | Chosen from `/v1/models` |
| 25% of NAV epoch cap | No on-chain NAV | Per-token absolute caps set by shareholder |
| Approval as `APPROVE <hash>` anywhere in a response to any prompt | Operator wrote the prompt, so it controlled the approval | Vault writes the request; pinned prompt and model; exact response; price floors |
| Section 3 checked at freeze only | Marketplace sale handed a buyer dirty keys | Checked on every change of shareholder |
| Shareholder moved before the callback committed | A failed callback left a non-payer holding the vault | Transit, watcher receipt and `resync_vault_owner` |
| Unbounded approvals, memo, offers and payments | Callbacks and storage could be exhausted | Caps, prepaid offer storage, record log, registry reserve |
