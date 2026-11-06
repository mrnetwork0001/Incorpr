# Transfer threat model: how a seller could try to keep the money

This document lists the ways the current holder of a company NFT could try to keep value that a buyer or lender is paying for: when the company is sold, pledged for a loan, or moved to a new owner. For each attack it gives what the seller would gain, what stops it in the contracts, the test that exercises the rule, and mainnet evidence where a real transaction exists. Residual risks and trust assumptions are stated where the contracts do not close a gap. The list covers what a review of the current code found; it is not a proof that no other path exists.

Line numbers refer to the working tree on 2026-11-06 and will drift as the code changes. Function names, error codes and test names were checked with `grep` against `contracts/` and `web/tests/`. Transaction numbers are the `seq` field in [`docs/evidence/mainnet.json`](evidence/mainnet.json), also listed in [MAINNET_EVIDENCE.md](MAINNET_EVIDENCE.md).

Files cited:

- Vault: `contracts/company-vault/src/lib.rs` (shortened to `vault:<line>`)
- Registry: `contracts/incorpr-registry/src/lib.rs` (shortened to `registry:<line>`)
- Sandbox tests: `contracts/integration-tests/tests/sandbox.rs`, run with `cargo test -p integration-tests --test sandbox`
- Transfer race tests: `contracts/integration-tests/tests/transfer_races.rs`, run with `cargo test -p integration-tests --test transfer_races`

## 1. What "the money" is

A company NFT is minted by `incorpr.near` and controls one vault account, `c-<id>.incorpr.near`. When a buyer pays for it, the buyer is paying for:

| Asset | Where it sits | Who can move it while `Free` |
|---|---|---|
| Retained earnings (USDC) | Vault USDC balance, `retained_earnings` | Shareholder (`claim_dividends`), operator (`agent_deposit_to_intents` to the vault's own `intents.near` account) |
| Compute reserve (USDC) | Vault USDC balance, `compute_reserve` | Operator, only to the fixed `compute_payee` (`pay_compute_bill`) |
| Intents balance | `intents.near`, under the vault account | Operator, with a vault-built and TEE-approved intent (`agent_swap_intent`, `agent_withdraw_intent`) |
| L1 treasury (BTC, SOL, EVM) | Addresses derived by `v1.signer` from the vault account and the current `treasury_epoch` | Shareholder, by asking the vault for a signature (`request_shareholder_signature`) |
| Future revenue | Arrives through `ft_on_transfer` from the USDC contract | Follows the shareholder of record |

ARCHITECTURE.md section 3 item 4 defines what a buyer should count: current-epoch addresses and the vault's `intents.near` balance. Funds on addresses from an earlier epoch are excluded, because an earlier holder may hold signatures for them.

The state machine that protects these assets has three states plus a transit flag: `Free`, `Listed`, `Pledged`, and `in_transit` while a settlement runs. Shareholder, agent and policy methods work only in `Free` with no transit (`assert_free`, vault:1244).

## 2. Summary table

| ID | Attack | Seller would gain | What stops it | Test | Mainnet |
|---|---|---|---|---|---|
| A1 | Keep a copy of the vault account key | Full control of the vault after the sale | Vault is created with no access key and has no method that adds one, deploys code or deletes the account (`incorporate_company` batch, registry:474-478) | `test_incorporate_spawns_subaccount_and_mints_nep171` | tx 5; `c-1.incorpr.near` has zero access keys |
| A2 | Keep a copy of a BTC, SOL or EVM treasury key | Spend the L1 treasury after the sale | No private key exists outside the MPC network. Keys derive from the vault account id and a path only the vault composes (`epoch_path` vault:1536, `intents_path` vault:1532, `check_subpath` vault:471) | `test_role_separation_and_registry_only_sync`, `test_refresh_treasury_keys_matches_independent_derivation` | tx 33 (`ERR_ONLY_CURRENT_SHAREHOLDER`) |
| A3 | Hold a signed but unbroadcast L1 transaction | Spend the buyer's L1 funds after the sale | Every raw signature marks the epoch dirty first (vault:827). A dirty epoch refuses `Listed`, `Pledged` and transit with `ERR_RAW_SIGNATURES_THIS_EPOCH` (vault:634, vault:617), and a marketplace transfer (vault:603-604). An owner's direct transfer rotates the epoch if any raw signature was made on it (vault:1216-1221) | `test_listing_requires_clean_epoch_and_rotation_changes_addresses`, `test_sale_paths_refuse_dirty_keys_and_owner_transfer_rotates`, `test_pledge_obeys_the_same_freeze_rules_as_listing` | No refused tx yet |
| A4 | Sign between the registry call and the vault freeze | Same as A3 | The dirty-epoch check runs inside the vault receipt that applies the freeze, so the two calls are ordered on one account | `test_signature_raced_before_freeze_fails_listing_and_leaves_no_lock` | No refused tx yet |
| A5 | Sign while listed, pledged or in transit | Same as A3 | `ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN` in `request_shareholder_signature` (vault:825), `sign_legacy_epoch` (vault:847), `rotate_treasury_epoch` (vault:859) | `test_anti_rug_encumbrance_freezes_seller_mpc_signing` | tx 21 |
| A6 | Drain retained earnings during the sale | Keep the earnings and the price | `claim_dividends` refuses with `ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN` (vault:806). Agent deposit refuses with `ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN` (vault:718) | `test_dividends_bounded_frozen_and_restored`, `test_transfer_call_gives_no_vault_rights_until_kept_and_revert_changes_nothing` | tx 20 (listed), tx 27 (pledged) |
| A7 | Strip the company after the buyer read the listing, then relist | Sell an emptied company at the old price | `acquire` names `expected_sync_nonce`; unlist and relist both change it; mismatch refunds with `ERR_LISTING_CHANGED` (registry:1733-1734). Lenders can set `PledgeTerms`, checked as `ERR_PLEDGE_TERMS_NOT_MET` (vault:637-642) | `test_acquire_is_bound_to_the_listing_the_buyer_read`, `test_lender_terms_refuse_a_stripped_company` | tx 23 (buy at `sync_nonce` 1) |
| A8 | A payout callback lands after the sale | Collect a dividend twice, or have a failed payout restored to the seller | Amounts are deducted before the transfer; a failed transfer restores to the vault, not to the caller (vault:974, vault:961, vault:990). Registry payouts that fail credit `pending_withdrawals` once (registry:1430-1437) | `test_dividends_bounded_frozen_and_restored`, `test_failed_payouts_credit_pending_withdrawals`, and thirteen race tests in `transfer_races.rs` (see section A8) | tx 30 (successful claim) |
| A9 | Change the ask or unlist while the buyer's payment is in flight | Take more than the buyer agreed to, or keep the payment | Below-ask refunds (`ERR_AMOUNT_BELOW_ASK`), excess refunds (registry:1133), unlisted refunds (`ERR_TOKEN_NOT_LISTED`), settling lock refunds (`ERR_TOKEN_SETTLING`) | `test_atomic_ma_acquisition_flips_shareholder_and_pays_royalty`, `test_concurrent_market_call_hits_settling_lock` | tx 23 |
| A10 | Have the operator or agent move funds out | Move the treasury to an address the seller controls | Agent is frozen while encumbered; withdrawals only to the vault's own current-epoch address; per-token 24 h caps; price floors; nonce reuse check; on-chain TEE approval. Policy resets to the charter policy on a change of shareholder (vault:1213) | `test_firewall_blocks_prompt_injected_agent_drain`, `test_new_shareholder_gets_charter_policy_not_seller_policy`, `test_seller_operator_cannot_act_while_encumbered` and others in section A10 | tx 34, 35, 36, 37 |
| A11 | Report fake revenue to raise the price | Sell at a multiple of revenue that does not exist | Revenue is booked only by `ft_on_transfer` from the USDC contract (vault:656-686). No actor can report revenue. `report_metrics` accepts only the vault (registry:598). The shareholder's own payments are excluded | `test_operator_cannot_credit_revenue_and_metrics_only_from_vault`, `test_revenue_split_refunds_and_related_party`, `test_reserve_minimum_and_payment_concentration_view` | tx 17, tx 42 (real payments) |
| A12 | Sell while a signed intent is still live | Settle a trade out of the vault's intents balance after the sale | `latest_intent_deadline_ms` (vault:1454-1458); `ERR_UNEXPIRED_SIGNED_INTENTS` on `sync_owner` (vault:606), `begin_transit` (vault:618), `apply_encumbrance` (vault:635) | `test_unexpired_agent_intent_blocks_encumbrance_until_deadline`, `test_unexpired_intent_blocks_every_owner_change` | No refused tx yet |
| A13 | Move the NFT outside the registry market while listed or pledged | Escape the freeze, or pledge and sell the same company | `authorize_transfer` refuses with `ERR_TOKEN_ENCUMBERED` (registry:1640); `nft_approve` too (registry:923); the vault refuses `sync_owner` with `ERR_ACCOUNT_ENCUMBERED_SYNC` (vault:600) | `test_nft_transfer_syncs_vault_and_approvals_clear`, `test_credit_offer_accept_repay_cycle`, `test_sync_is_refused_on_an_encumbered_vault_and_mint_event_is_exact` | tx 22 (listed), tx 28 (pledged) |
| A14 | Keep shareholder rights through `nft_transfer_call` or a failed callback | Use the vault after being paid, or keep both NFT and payment | Transit: nobody has shareholder rights between the first and last step. A failed callback refunds the payer and sets `needs_resync` | `test_transfer_call_gives_no_vault_rights_until_kept_and_revert_changes_nothing`, `test_failed_bid_callback_refunds_gives_no_rights_and_can_be_recovered`, `test_failed_claim_and_transfer_callbacks_can_be_recovered` | None |
| A15 | Borrower keeps the principal and recovers the company cheaply | Principal plus the company | Freeze while pledged; Dutch auction from 200% to 50% of debt; lender is paid first from any bid | `test_default_dutch_auction_bid_pays_lender_royalty_borrower`, `test_no_bid_lender_claims_collateral` | tx 26, 27, 28, 29 |
| A16 | Use the registry account key | Reassign any vault to itself; move USDC the registry escrows | Not stopped by the contracts. Trust assumption, see section 4.1 | `test_role_separation_and_registry_only_sync` shows a direct call from the registry account is accepted | `incorpr.near` has one FullAccess key |
| A17 | Collude with the MPC network | Signatures on the vault's paths without the vault | Not stopped by the contracts. Trust assumption, see section 4.2 | None (the sandbox uses a signer double) | tx 6 (keys derived from `v1.signer`) |

## 3. Attacks in detail

### A1. Keep a copy of the vault account key

**Gain.** A full access key on `c-<id>.incorpr.near` would let the seller move every asset the vault holds, at any time, whatever the contract says.

**What stops it.** `incorporate_company` creates the vault in one batch: `create_account`, `transfer`, `deploy_contract`, `function_call("new")` (registry:474-478). The batch has no `AddKey` action. The vault code has no method that adds a key, deploys code, deletes the account or sends NEAR (`grep -n "add_full_access_key\|add_access_key\|deploy_contract\|delete_account\|\.transfer(" contracts/company-vault/src/lib.rs` returns nothing). The vault cannot be upgraded.

**Test.** `test_incorporate_spawns_subaccount_and_mints_nep171` asserts `view_access_keys(vault)` is empty (sandbox.rs:603). In the web suite, `web/tests/sandbox.e2e.test.ts` has "confirms the vault has no access keys, through the same RPC the guard uses".

**Mainnet.** Tx 5 created `c-1.incorpr.near`. Read from archival RPC on 2026-11-06, its receipt to `c-1.incorpr.near` carries `CreateAccount`, `Transfer`, `DeployContract`, `FunctionCall` and nothing else. `view_access_key_list` on `c-1.incorpr.near` returned an empty list the same day.

### A2. Keep a copy of a Chain Signatures key

**Gain.** A copy of the BTC, SOL or EVM treasury key would let the seller spend the L1 treasury after the sale.

**What stops it.** No such key exists outside the MPC network. `v1.signer` derives each key from the calling account and a path. The vault composes every path itself:

- Treasury and auxiliary keys: `incorpr-<id>-e<epoch>-<subpath>` (`epoch_path`, vault:1536). `subpath` must match `[a-z0-9-]{1,32}` (`check_subpath`, vault:471, `ERR_INVALID_SUBPATH`).
- Intents key: `incorpr-<id>-intents` (`intents_path`, vault:1532). No shareholder method signs on it.

The vault asks for signatures only for the current shareholder (`assert_shareholder`, vault:1225, `ERR_ONLY_CURRENT_SHAREHOLDER`). A call to `v1.signer` from any other account derives different keys, because the derivation includes the predecessor. The vault computes its addresses on-chain from `derived_public_key` (`on_treasury_keys`, vault:998), so a seller cannot register an address it holds a key for.

**Tests.** `test_role_separation_and_registry_only_sync` checks that a subpath of `../intents` is refused and that a subpath named `intents` signs on `incorpr-1-e0-intents`, not on the intents key `incorpr-1-intents` (sandbox.rs:1145-1186). `test_refresh_treasury_keys_matches_independent_derivation` recomputes the addresses with independent code. `test_setup_intents_key_registers_exactly_the_derived_key` checks that only the derived key is registered on the intents contract.

**Mainnet.** Tx 6 derived the treasury addresses for token 1 from `v1.signer`. Tx 33: `rob.incorpr.near`, an account that owns nothing, asked the vault for a Bitcoin signature and was refused with `ERR_ONLY_CURRENT_SHAREHOLDER`.

### A3. Hold a signed but unbroadcast L1 transaction

**Gain.** While the company is `Free`, the seller is the shareholder and may sign anything on the treasury keys. A signature it keeps unbroadcast can be spent after the sale. Concrete forms: a Bitcoin transaction (no expiry), a Solana transaction on a durable nonce (no expiry), an EVM transaction at a future nonce, a token permit, or an EIP-7702 authorization that delegates the EOA. A freeze cannot stop a signature that already exists, and a mempool check cannot see one that was never broadcast.

**What stops it.** The vault treats any raw signature on the current epoch as a reason to retire the epoch before the company changes hands:

1. `request_shareholder_signature` increments `raw_sigs_this_epoch` before it calls the signer (vault:827). The vault cannot tell a transaction hash from a permit hash, so every payload counts, and a failed signer call still counts.
2. `apply_encumbrance` refuses `Listed` and `Pledged` with `ERR_RAW_SIGNATURES_THIS_EPOCH` (vault:633-634).
3. `begin_transit`, the first step of every registry settlement (`acquire`, `bid`, `repay`, `claim_defaulted_collateral`, `unlist_company`, `nft_transfer_call`, `nft_transfer_payout`), refuses the same way (vault:617).
4. `nft_transfer` by an approved account, which is how a marketplace sells, calls `sync_owner` with `require_clean = true` (registry:656) and is refused with the same error (vault:603-604).
5. `nft_transfer` by the owner, used for gifts and moves between the owner's own accounts, is allowed. If any raw signature was made on the current epoch, `set_shareholder` then rotates to a new epoch, resets the counter and clears the stored addresses (vault:1216-1221). If none was, the epoch and addresses stay as they are. Either way the receiver starts on keys that have never produced a raw signature.
6. `rotate_treasury_epoch` (vault:856) lets the seller move to fresh addresses, move the funds there with `sign_legacy_epoch` (vault:839, which does not dirty the new epoch), and then list.

**Tests.** `test_listing_requires_clean_epoch_and_rotation_changes_addresses` (listing refused after a signature, new addresses after rotation, legacy signing does not dirty the epoch, an auxiliary subpath dirties it). `test_sale_paths_refuse_dirty_keys_and_owner_transfer_rotates` (`nft_transfer_payout`, approved `nft_transfer` and `nft_transfer_call` are all refused; the owner's own transfer rotates). `test_pledge_obeys_the_same_freeze_rules_as_listing` (a pledge is refused and no principal moves).

**Mainnet.** No `ERR_RAW_SIGNATURES_THIS_EPOCH` refusal has been recorded on mainnet yet. Tx 21 shows the related freeze (A5).

**Residual risk.**

- Funds left on an earlier epoch's addresses stay spendable by any signature the seller kept. The vault excludes them from NAV, and the buyer should give them no value.
- The vault does not read L1 balances. A buyer should count only confirmed funds on current-epoch addresses. A deposit into the current epoch that is still unconfirmed, sent from an old-epoch address, can be replaced by a conflicting old-epoch transaction the seller kept. The L1 freshness check in `web/src/app/api/verify-l1` is not enforced before a sale or loan (DEPLOY.md section 5).
- An off-registry sale paid outside the contracts and completed with the owner's own `nft_transfer` gets the rotation but no payment atomicity, and the old-epoch funds go with the risk above.

### A4. Sign between the registry call and the vault freeze

**Gain.** `list_company` and `accept_offer` run on the registry, and the freeze lands in a later receipt on the vault. A seller could try to sign in the gap and still get listed.

**What stops it.** The check from A3 runs inside the vault receipt that applies the freeze (`apply_encumbrance`, vault:633-636), not in the registry call. Both the signature request and the freeze execute on the vault account, so one of them lands first. If the signature lands first, the freeze fails and the registry callback (`on_listing_frozen`, registry:1033; `on_pledge_frozen`, registry:1168) clears the lock and activates nothing. If the freeze lands first, the signature request fails with `ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN`.

**Test.** `test_signature_raced_before_freeze_fails_listing_and_leaves_no_lock` covers both orders: sequential, and two transactions sent concurrently, asserting that a listing and an outstanding raw signature never coexist and that registry and vault agree.

### A5. Sign while listed, pledged or in transit

**Gain.** Same as A3, after the buyer has read the listing.

**What stops it.** `assert_free("ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN")` in `request_shareholder_signature` (vault:825), `sign_legacy_epoch` (vault:847) and `rotate_treasury_epoch` (vault:859). `assert_free` also fails while `in_transit` (vault:1244-1248).

**Tests.** `test_anti_rug_encumbrance_freezes_seller_mpc_signing` (the signer double records zero calls). `test_credit_offer_accept_repay_cycle` (pledged). `test_transfer_call_gives_no_vault_rights_until_kept_and_revert_changes_nothing` (in transit).

**Mainnet.** Tx 21: the shareholder asked for a BTC signature while token 1 was listed and was refused with `ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN`.

### A6. Drain retained earnings before or during the sale

**Gain.** Keep the company's earnings and the sale price.

**What stops it.**

- During the sale: `claim_dividends` refuses with `ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN` (vault:806). `agent_deposit_to_intents` refuses with `ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN` (vault:718). Policy changes refuse with `ERR_ACCOUNT_ENCUMBERED_POLICY_FROZEN` (vault:1257). The only USDC that can leave the vault while listed or pledged is the compute reserve, and only to the fixed `compute_payee` (A10).
- Before the listing: the seller may claim every dividend. That is allowed. The buyer pays for the state it reads, and A7 binds the payment to that state.

**Tests.** `test_dividends_bounded_frozen_and_restored`, `test_transfer_call_gives_no_vault_rights_until_kept_and_revert_changes_nothing`, `test_compute_bill_only_from_reserve_to_payee_and_intents_deposit`. In the web suite, `web/tests/sandbox.actions.e2e.test.ts` has "listCompany freezes the vault: the owner cannot claim dividends while listed".

**Mainnet.** Tx 20 (listed) and tx 27 (pledged): `claim_dividends` refused with `ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN`. Tx 30: after the loan was repaid, the same claim went through.

### A7. Strip the company after the buyer read the listing

**Gain.** The buyer reads a listing with retained earnings and a treasury, decides to pay, and the seller unlists, claims everything, relists at the same ask, and receives the payment.

**What stops it.** The `acquire` message carries `expected_sync_nonce`, which `get_listing` returns. Each vault call from the registry increments `sync_nonce` (`next_sync`, registry:1560), so `unlist_company` and `list_company` both change it. `handle_acquire` refunds a mismatch in full with `ERR_LISTING_CHANGED` (registry:1733-1734). A message without the nonce does not parse and is refunded.

For a pledge, a lender can attach `PledgeTerms { min_retained, required_epoch }` to its offer. `apply_encumbrance` checks them when the pledge lands and fails with `ERR_PLEDGE_TERMS_NOT_MET` (vault:637-642). No principal moves.

**Tests.** `test_acquire_is_bound_to_the_listing_the_buyer_read` (strip, rotate and relist at the same ask; the buyer is refunded in full; a message without a nonce is refunded; a fresh read buys the stripped company knowingly). `test_lender_terms_refuse_a_stripped_company`. In the web suite, `web/tests/sandbox.actions.e2e.test.ts` has "an acquire against a stale sync nonce succeeds as a transaction, refunds, and carries ERR_LISTING_CHANGED".

**Mainnet.** Tx 23 bought token 1 naming `sync_nonce` 1. No `ERR_LISTING_CHANGED` refusal has been recorded on mainnet.

**Residual risk.** `PledgeTerms` are optional. A lender that funds an offer without terms accepts whatever the company holds when the borrower accepts.

### A8. A pending payout callback lands after the sale

**Gain.** NEAR settles cross-contract calls in separate receipts, so a payout started before the sale can resolve after it. The seller could hope that a failed payout is restored to it, or that a payout is counted twice.

**What stops it.**

- `claim_dividends` deducts `retained_earnings` before it sends the transfer, and the recipient is fixed when the claim is made (vault:809-812). If the transfer fails, `on_dividends_paid` adds the amount back to `retained_earnings` (vault:974). The money returns to the vault, which by then may belong to the buyer. It never returns to the claimant.
- `pay_compute_bill` deducts the reserve first and `on_compute_paid` restores it on failure (vault:711, vault:961).
- `agent_deposit_to_intents` deducts retained earnings first and `on_intents_deposit` restores only the unused part (vault:721, vault:988-990).
- On the registry, the seller's proceeds from `on_acquire_settled` go out through `pay_out` (registry:1922) after the token and the buyer's funds have moved. A failed transfer credits `pending_withdrawals` for the seller once (`on_payout`, registry:1430-1437). `withdraw_pending` removes the entry before it pays, and a failure credits it again (registry:1417-1427). The sale is not reversed.
- The buyer becomes shareholder only in the last step, `finish_vault` (registry:1590), after it has paid.

**Tests.** In `sandbox.rs`: `test_dividends_bounded_frozen_and_restored` (a failed transfer restores `retained_earnings` and leaves `dividends_paid` at zero) and `test_failed_payouts_credit_pending_withdrawals` (the buyer gets the token, the founder and seller are credited once, a second withdrawal fails with `ERR_NOTHING_PENDING`).

`contracts/integration-tests/tests/transfer_races.rs` (13 tests) sends the payout and the sale without waiting for each other and checks whichever order the chain produced. After every scenario it checks that the seller receives at most the dividends that accrued before the sale, that the buyer can claim everything left, that total USDC is conserved, that registry and vault agree with no lock left, that the vault's USDC equals `retained_earnings + compute_reserve`, and that a failed payout is credited back to the ledger it was debited from. Tests that aim at one interleaving retry on a fresh company until the chain produces it, and fail if it never does. Each prints the receipt block heights it saw. Scenarios:

| Test | Race |
|---|---|
| `test_claim_in_flight_when_a_marketplace_sale_lands` | Dividend claim and `nft_transfer_payout` in the same block |
| `test_failed_claim_restores_to_the_company_after_an_owner_transfer` | Failed dividend transfer whose callback lands after the owner's `nft_transfer` |
| `test_listing_with_a_claim_in_flight_is_safe_for_the_buyer` | Claim and listing in the same block, the freeze landing while the claim is out, then an acquire sent the moment the listing is active. The checks hold whichever of the claim callback and the buyer's `begin_transit` comes first |
| `test_pledge_with_a_claim_in_flight_honours_lender_terms` | Claim and `accept_offer` with `PledgeTerms`, the freeze landing between the claim and its callback |
| `test_customer_payment_mid_sale_is_booked_to_the_company_for_the_buyer` | Customer payment while listed and while the acquire settles |
| `test_failed_compute_bill_during_a_sale_restores_the_reserve` | Failed compute bill while an acquire settles |
| `test_intents_deposit_in_flight_when_an_owner_transfer_lands` | Intents deposit whose resolve chain ends after an owner transfer |
| `test_concurrent_acquires_settle_once_and_refund_the_rest` | Two acquires for one listing in the same block |
| `test_failed_sale_payouts_stay_with_the_seller_through_a_resale` | Seller's failed proceeds, then an immediate resale |
| `test_principal_and_repayment_payouts_through_a_repay_and_a_sale` | Failed principal and repayment payouts, then a sale |
| `test_auction_proceeds_and_pledge_period_revenue_reach_the_right_accounts` | Revenue while pledged, then a default auction |
| `test_cancel_racing_accept_pays_the_principal_once` | `cancel_offer` and `accept_offer` on one offer: the principal leaves the registry once, and a cancel that arrives while the accept settles gets `ERR_OFFER_SETTLING` |
| `test_repay_racing_a_bid_settles_once` | A repayment and an auction bid after default: exactly one settles, the other is refunded |

**Mainnet.** Tx 30 is a successful `claim_dividends` of 0.04 USDC. No failed payout has been recorded on mainnet.

**Residual risk.** The two contracts treat a failed payout differently. A failed `claim_dividends` transfer goes back to `retained_earnings`, which belongs to whoever is shareholder when the callback runs: if the sale landed in between, that is the buyer (`test_failed_claim_restores_to_the_company_after_an_owner_transfer` asserts this). A failed registry payout stays credited to the account it was owed to in `pending_withdrawals`. The vault's rule never pays a seller twice. A claimant's transfer fails when the claimant's own USDC account cannot receive it (for example, it is not registered with the token contract), so in the cases tested the loss falls on the seller whose account refused the transfer. It is still a design choice; a claimant credit in the vault, like the registry's, would remove it.

The vault has no in-flight payout counter, so a listing or pledge is not refused while a dividend transfer is still out. The claim was debited before the freeze, so the buyer can only receive more than the listing showed (if the claim fails), never less.

### A9. Change the ask or unlist while the buyer's payment is in flight

**Gain.** Take more than the buyer agreed to, or keep the payment without delivering.

**What stops it.** The buyer's USDC reaches the registry through `ft_transfer_call`, and `handle_acquire` (registry:1717) refunds the whole amount when the token is not listed (`ERR_TOKEN_NOT_LISTED`), is settling (`ERR_TOKEN_SETTLING`), the nonce changed (`ERR_LISTING_CHANGED`), the amount is below the ask (`ERR_AMOUNT_BELOW_ASK`), the registry balance is below its reserve (`ERR_REGISTRY_RESERVE_LOW`) or the buyer is the seller (`ERR_BUYER_IS_SELLER`). The ask cannot change without an unlist and a relist, which changes the nonce. On success the callback returns `amount - ask`, so an overpayment is refunded (registry:1133). If the vault refuses, the callback returns the full amount (registry:1114-1118).

**Tests.** `test_atomic_ma_acquisition_flips_shareholder_and_pays_royalty` (an overpayment of 5 USDC is refunded). `test_concurrent_market_call_hits_settling_lock`. `test_vault_failure_leaves_no_stuck_lock_and_refunds_via_resolve`.

**Mainnet.** Tx 23 paid exactly the 1 USDC ask.

### A10. Have the operator or the agent move funds out

**Gain.** The seller points the vault's operator at an account it controls and moves the treasury to its own address, before or during the sale.

**What stops it.** The operator sends structured fields and never bytes. `agent_swap_intent` (vault:738) and `agent_withdraw_intent` (vault:766) check, in order:

| Check | Function | Error |
|---|---|---|
| Caller is the operator | `assert_operator` (vault:1229) | `ERR_ONLY_TEE_TREASURY_AGENT` |
| Company is `Free`, not in transit | `assert_agent_not_frozen` (vault:1250) | `ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN` |
| Tokens on the allow list | `assert_token_allowed` (vault:1260) | `ERR_FIREWALL_BLOCKED_TOKEN` |
| Withdrawal destination is the vault's own current-epoch address for that chain | `assert_own_address` (vault:1280) | `ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION` |
| Per-token spend in the 24 h window | `charge_epoch_spend` (vault:1294) | `ERR_FIREWALL_EPOCH_CAP_EXCEEDED` |
| Swap price at or above the shareholder's floor | `assert_price_floor` (vault:1267) | `ERR_FIREWALL_PRICE_BELOW_FLOOR`, `ERR_FIREWALL_NO_PRICE_FLOOR` |
| Nonce not reused | `consume_nonce` (vault:1318) | `ERR_NONCE_USED`, `ERR_TOO_MANY_LIVE_NONCES` |
| TEE approval of the exact request the vault wrote, signed by a listed TEE key | `verify_tee_approval` (vault:1385) | `ERR_TEE_NOT_APPROVED`, `ERR_TEE_SIGNATURE_UNTRUSTED`, `ERR_TEE_APPROVAL_EXPIRED`, `ERR_TEE_REQUEST_MISMATCH` and others |

Around the sale:

- The approval preimage includes `treasury_epoch` and `owner_generation` (vault:1365-1370), so approvals issued before a sale stop working after it.
- On any change of shareholder, `set_shareholder` replaces the seller's policy (operator, TEE signers, caps, floors) with the charter policy fixed at incorporation (vault:1213).
- While encumbered or in transit, only the charter operator can call `pay_compute_bill` and `record_service_call` (`assert_service_operator`, vault:1235). A seller's own operator cannot.
- `pay_compute_bill` pays only to `compute_payee`, fixed at incorporation (vault:707-714).

**Tests.** `test_firewall_blocks_prompt_injected_agent_drain`, `test_firewall_tokens_and_epoch_caps`, `test_price_floor_bounds_a_swap_even_with_a_valid_approval`, `test_tee_proof_checks_and_onchain_ecrecover`, `test_tee_approval_is_bound_to_the_pinned_request`, `test_only_an_exact_approve_message_counts`, `test_approval_lifetime_binding_to_vault_epoch_and_owner`, `test_new_shareholder_gets_charter_policy_not_seller_policy`, `test_seller_operator_cannot_act_while_encumbered`, `test_withdraw_intent_frozen_while_listed_and_pledged`, `test_compute_bill_only_from_reserve_to_payee_and_intents_deposit`. In the web suite, `web/tests/rob.sandbox.e2e.test.ts` has "while LISTED the owner, the agent and a stranger are all refused", and `web/tests/rob.checks.test.ts` checks that the order of checks shown on `/rob` matches the vault source.

**Mainnet.** Tx 34 (withdrawal to an outside address, `ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION`), tx 35 (a swap of the day's USDC allowance for 1 satoshi, `ERR_FIREWALL_PRICE_BELOW_FLOOR`), tx 36 (an approval signed with the operator's own key, `ERR_TEE_SIGNATURE_UNTRUSTED`), tx 37 (the agent's signed chat reply presented as an approval, `ERR_TEE_NOT_APPROVED`).

**Residual risk.**

- While `Free`, the shareholder sets the whole policy. A seller can name its own operator and TEE signer, lower the floors and raise the caps, then trade the vault's intents balance at a bad price through a solver it controls. Withdrawals still go only to the vault's own addresses. This happens before the listing and shows in the balances the buyer reads. A12 stops the last such intent from settling after the sale.
- A compromised operator with a genuine TEE can resubmit a proposal until a nondeterministic model approves it, and a colluding solver can fill at `min_buy_amount`. The loss per 24 h window is bounded by the cap and the floor (ARCHITECTURE.md section 4).
- On mainnet the charter operator and `compute_payee` are the same account, `operator.incorpr.near`, and on 2026-11-06 it held one FullAccess key. Whoever holds that key controls the compute reserve end to end, including while the company is listed or pledged. A buyer should value `compute_reserve` (134 999 micro-USDC on `c-1.incorpr.near` when read on 2026-11-06) at zero.
- After a sale the vault's operator is the charter operator, which the deployer controls. On mainnet the deployer is also the founder of token 1. The buyer can name its own operator with `set_operator` while `Free`.

### A11. Report fake revenue

**Gain.** Companies are priced on revenue. Fake revenue raises the ask.

**What stops it.** Revenue is booked only by `ft_on_transfer` (vault:656-686). The caller must be the USDC contract (vault:657), `msg` must carry a new `call_id`, and the amount must be at least the price. Otherwise the transfer is refunded. Payments from the current shareholder go to `related_party_revenue` and are excluded from `revenue_30d` (vault:672-678). `record_service_call` marks a paid call as served and moves no money (vault:690-703). The registry's metrics come only from the vault (`report_metrics`, registry:598, `ERR_ONLY_COMPANY_VAULT`). The `record_service_revenue` method from the original spec does not exist.

**Tests.** `test_operator_cannot_credit_revenue_and_metrics_only_from_vault`, `test_revenue_split_refunds_and_related_party`, `test_reserve_minimum_and_payment_concentration_view`, `test_registry_metrics_follow_deposits_and_are_dated`. Registry unit test `a_snapshot_with_no_report_for_30_days_reads_as_zero`.

**Mainnet.** Tx 17 and tx 42 are real USDC payments for one call each. `demo-customer.incorpr.near` is controlled by the deployer, and its payments count toward `revenue_30d` (README "What is real and what is simulated").

**Residual risk.**

- `revenue_30d` does not resist sybil payers. A seller's second account counts as a customer. Each wash payment loses its `compute_reserve_bps` share to the compute reserve, at least 1% (`MIN_COMPUTE_RESERVE_BPS`, vault:28). That cost goes away if the seller also controls `compute_payee`, as the deployer does on mainnet today. Read `payment_stats` (`distinct_payers`, `largest_payer_amount`, `served_amount`) before you buy.
- The registry's snapshot can overstate a company that stopped earning, for up to 30 days. The charter prints the report date, and `vault.revenue_30d` is exact.

### A12. Sell while a signed intent is still live

**Gain.** An intent the vault signed before the sale can settle on `intents.near` after it and move the vault's intents balance.

**What stops it.** Every intent the vault signs has a deadline of at most `MAX_INTENT_TTL_MS` (300 000 ms, vault:20), and `next_intent_deadline` records the latest one in `latest_intent_deadline_ms` (vault:1454-1458). Until block time passes it, the vault refuses every change of holder with `ERR_UNEXPIRED_SIGNED_INTENTS`: `sync_owner` (vault:606), `begin_transit` (vault:618) and `apply_encumbrance` for `Listed` or `Pledged` (vault:635).

**Tests.** `test_unexpired_agent_intent_blocks_encumbrance_until_deadline`, `test_unexpired_intent_blocks_every_owner_change` (`nft_transfer_payout`, an approved `nft_transfer`, the owner's `nft_transfer` and `nft_transfer_call` all refused; after 301 s the marketplace sale goes through), `test_pledge_obeys_the_same_freeze_rules_as_listing`. In the web suite, `web/tests/rebalance.execute.e2e.test.ts` has "route: refuses to sign while an intent the vault signed is still live".

**Mainnet.** No `ERR_UNEXPIRED_SIGNED_INTENTS` refusal has been recorded on mainnet.

**Residual risk.** This relies on `intents.near` refusing an intent after its deadline.

### A13. Move the NFT outside the registry market

**Gain.** Escape the freeze by moving a listed or pledged token to another account, pledge a company and also sell it, or keep an approval that lets an accomplice pull the token back after the sale.

**What stops it.**

- `authorize_transfer` refuses an encumbered token with `ERR_TOKEN_ENCUMBERED` and a settling one with `ERR_TOKEN_SETTLING` (registry:1639-1640). This covers `nft_transfer`, `nft_transfer_call` and `nft_transfer_payout`.
- `list_company` and `accept_offer` require a `Free` token (`assert_owner_of_free_token`, registry:1547-1554), so a company cannot be listed and pledged at once.
- `nft_approve` refuses an encumbered token (registry:923). Approvals are cleared on every transfer (`finish_transfer`, registry:1673-1677). At most 16 approvals per token (`ERR_TOO_MANY_APPROVALS`).
- The vault refuses `sync_owner` while encumbered or in transit with `ERR_ACCOUNT_ENCUMBERED_SYNC` (vault:598-601).

**Tests.** `test_nft_transfer_syncs_vault_and_approvals_clear`, `test_credit_offer_accept_repay_cycle` (transfer, list and a second pledge all refused while pledged), `test_approvals_are_capped_and_full_map_settles_within_callback_gas`, `test_sync_is_refused_on_an_encumbered_vault_and_mint_event_is_exact`, `test_nep199_payout_respects_royalty_and_encumbrance`.

**Mainnet.** Tx 22 (listed) and tx 28 (pledged): `nft_transfer` refused with `ERR_TOKEN_ENCUMBERED`.

**Residual risk.** `nft_payout` is a view and cannot read the vault, so it can quote a company that `nft_transfer_payout` then refuses (A3). A marketplace must pay only when `nft_transfer_payout` succeeds.

### A14. Keep shareholder rights through a transfer call or a failed callback

**Gain.** Use the vault while a receiver contract decides whether to keep the token, or break a settlement callback so that the seller keeps the NFT and the buyer's payment.

**What stops it.**

- Transit. `begin_transit` (vault:615) blocks shareholder and agent rights until `apply_encumbrance` names the final holder. During `nft_on_transfer` neither the sender nor the receiver can use the vault. On a revert the sender gets its position back unchanged (`nft_resolve_transfer`, registry:748-784).
- Watcher. Each settlement callback is followed by `on_settlement_checked` or `on_ft_settlement_checked` (registry:808-834). If the callback failed while the lock was on, the payer is refunded in full on NEP-141 paths and `needs_resync` is set. `resync_vault_owner` (registry:838), callable by anyone, writes the registry's current owner and state to the vault. Only the newest resync releases the lock (`on_resync`, registry:856-865).
- Bounded inputs. `memo` (256 bytes, `ERR_MEMO_TOO_LONG`) and `msg` (4096, `ERR_MSG_TOO_LONG`) are checked before the vault is touched, so a seller cannot pick an input that aborts the callback after the vault moved.

**Tests.** `test_transfer_call_gives_no_vault_rights_until_kept_and_revert_changes_nothing`, `test_nft_transfer_call_keep_and_revert_resyncs_vault`, `test_failed_bid_callback_refunds_gives_no_rights_and_can_be_recovered`, `test_failed_claim_and_transfer_callbacks_can_be_recovered`, `test_settling_lock_rejects_calls_and_failed_revert_needs_resync`, `test_concurrent_resyncs_recover_the_token_once`, `test_memo_and_msg_are_bounded_before_the_vault_is_touched`. Registry unit tests `an_older_resync_does_not_release_the_lock` and `a_late_resync_does_not_release_a_lock_taken_afterwards`.

### A15. Borrower keeps the principal and recovers the company cheaply

**Gain.** The borrower receives the principal, defaults, and buys the company back at the auction floor from a second account.

**What stops it.** While pledged the borrower cannot claim, sign, set policy, transfer, list or pledge again (A5, A6, A13). After `due_ms` anyone can start a Dutch auction (`start_auction`, registry:1243). The price falls linearly from 200% to 50% of the debt (`dutch_price`, registry:1885). A bid pays the lender first, up to the debt, then the royalty, then the borrower (`on_bid_settled`, registry:1273-1278). With no bid, the lender claims the company after the window (`claim_defaulted_collateral`, registry:1289).

**Tests.** `test_default_dutch_auction_bid_pays_lender_royalty_borrower`, `test_no_bid_lender_claims_collateral`, `test_credit_offer_accept_repay_cycle`, `test_auction_vault_failure_refunds_bidder_and_keeps_loan`. In `transfer_races.rs`, `test_auction_proceeds_and_pledge_period_revenue_reach_the_right_accounts` (a dividend claim sent with the bid is refused, and revenue booked while pledged goes to the winning bidder) and `test_repay_racing_a_bid_settles_once` (a late repayment and a bid cannot both settle).

**Mainnet.** Tx 26 (pledge and borrow), tx 27 and tx 28 (refused claim and transfer while pledged), tx 29 (repay).

**Residual risk.** Once the price falls below the debt, the first bid wins, and the lender bears the gap. `handle_bid` does not exclude the lender, and a lender's own bid at or below the debt is paid back to it in full, so a lender that bids when the price reaches the debt gets the company at no net cost, provided it holds the bid amount in USDC for the duration of the call. A lender that waits for `claim_defaulted_collateral` can be outbid below the debt by the borrower's second account. No test covers a bid by the lender itself.

## 4. Trust assumptions the contracts do not remove

### 4.1 The registry account key (`incorpr.near`)

On 2026-11-06 `view_access_key_list` on `incorpr.near` returned one FullAccess key, held on the deployer's machine. The registry's `owner` is the registry account itself (`owner: ctx.registry`, `scripts/deploy.mjs:365`). The deployer is also the founder of token 1.

The vault trusts any call whose predecessor is the registry (`assert_registry_nonce`, vault:1204-1208). A transaction signed with that key and sent from `incorpr.near` is such a call. No redeploy is needed. With the key, its holder can:

- Call `sync_owner` on any `Free` vault, or `apply_encumbrance` on any vault in any state, with a higher `sync_nonce`, and name any account as shareholder. `apply_encumbrance` does not require `Free` (vault:625-651). `test_role_separation_and_registry_only_sync` shows that a direct call from the registry account is accepted (sandbox.rs:1128-1134). The new shareholder can then claim dividends and request signatures.
- Redeploy the registry code. `scripts/upgrade-registry.mjs` does this; on 2026-11-06 the code hash on `incorpr.near` read `BD1oUGVmyi17bVyxB1NzuAda1LgULoTfvuQ4mfQhWgYA`, against `EZ4ZuzRAMPYv5rdU2kYj78FaecPSMY8rZHYTptTHEnqK` at deploy.
- Move USDC the registry holds with a direct `ft_transfer`: principal escrowed in open loan offers, `pending_withdrawals`, and buyer funds in the middle of a settlement.
- Change the default policy for companies incorporated later (`set_default_policy`, registry:613). Existing vaults keep theirs.

It cannot change vault code, add a key to a vault, or get signatures on a vault's derivation paths by calling `v1.signer` from `incorpr.near` (the derivation would use a different predecessor). Through the shareholder reassignment above it can still reach everything a shareholder can.

Until the key is deleted, every holder, buyer and lender trusts the deployer not to use it this way, and a sale by the deployer is protected only by that trust. The plan in DEPLOY.md section 6 is to delete the key once the default policy is final. After a `DeleteKey`, `set_default_policy` can no longer be called, because the owner is the registry account and no key can sign for it. A FunctionCall key cannot replace it for that method, because `set_default_policy` requires one yoctoNEAR and FunctionCall keys cannot attach a deposit.

### 4.2 The MPC network (`v1.signer`)

The treasury and intents keys exist only as shares held by the MPC nodes. A threshold of colluding nodes could sign any payload on any vault's paths, or return a wrong `derived_public_key` that the vault would store as its addresses (`on_treasury_keys`, vault:998). The contract upgrade policy of `v1.signer` is outside this project. The sandbox uses a labelled signer double, so no sandbox test covers MPC behaviour. `web/tests/mpcAddresses.live.test.ts` reads keys from the live `v1.signer-prod.testnet` and `v1.signer` and checks the addresses against independent libraries, including "matches independent libraries on mainnet v1.signer, read only" for `c-1.incorpr.near`. Tx 6 derived the mainnet addresses on-chain from `v1.signer`.

### 4.3 Other contracts and services

| Dependency | What is assumed |
|---|---|
| `intents.near` | Accepts intents for `c-<id>.incorpr.near` only under the key the vault registered with `setup_intents_key`, refuses an intent after its deadline, and refuses a reused nonce |
| USDC (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) | Calls `ft_on_transfer` only for real transfers. The vault books revenue only when the predecessor is this contract |
| NEAR AI Cloud TEE | The keys in `tee_signers` belong to attested enclaves. A leaked enclave key lets an operator approve proposals, still bounded by destinations, caps and floors. The charter's signers were read from a live attestation report at deploy (MAINNET_EVIDENCE.md) |
| `operator.incorpr.near` | On 2026-11-06 it held one FullAccess key. Its holder has operator rights on every vault whose operator it is and receives every compute bill as `compute_payee` (A10). `scripts/operator-key.mjs` adds a function-call key scoped to `c-1.incorpr.near` and the five operator methods for the web server to sign with ([OPERATOR_KEY.md](OPERATOR_KEY.md)); the FullAccess key stays on the account, off the server, so this row holds until that key is removed |

## 5. Checks a buyer or lender can run before paying

1. `view_access_key_list` on the vault returns an empty list (A1).
2. `get_state` on the vault: `raw_sigs_this_epoch` is 0, `latest_intent_deadline_ms` is in the past, `in_transit` is false (A3, A12).
3. Count only confirmed balances on `treasury_addresses()` for the current `treasury_epoch`, plus the vault's balance on `intents.near` (A3).
4. Read `get_listing` and put its `sync_nonce` in the `acquire` message (A7).
5. Read `payment_stats`, `dividends_paid` and `compute_paid`, and compare `revenue_30d` with `distinct_payers` and `largest_payer_amount` (A11).
6. Give `compute_reserve` no value (A10).
7. Lenders: attach `PledgeTerms` with `min_retained` and `required_epoch` (A7), and bid once the auction price reaches the debt if no one else has (A15).
8. Check whether `incorpr.near` still has a FullAccess key (section 4.1).

## 6. Mainnet evidence index

All rows come from [`docs/evidence/mainnet.json`](evidence/mainnet.json). Refusals are real transactions whose outcome carried the error code.

| Tx | Used in | Method | Result | Hash |
|---|---|---|---|---|
| 5 | A1 | `incorporate_company` | success | [`2xPK7TCGCM2q6ZrxH8FK1uwfcS4KaDFs6N4vPg2oTJHX`](https://nearblocks.io/txns/2xPK7TCGCM2q6ZrxH8FK1uwfcS4KaDFs6N4vPg2oTJHX) |
| 6 | A2, 4.2 | `refresh_treasury_keys` | success | [`EMDJGJn41TvGWnoZtQ7vtrmTPVHBZr6ywyLDZCaXjfcZ`](https://nearblocks.io/txns/EMDJGJn41TvGWnoZtQ7vtrmTPVHBZr6ywyLDZCaXjfcZ) |
| 17 | A11 | `ft_transfer_call` (pay one call) | success | [`HovPj1W2PKv9XH6HvRj6TweQ83rdhHiw9KqD2CrFXLfb`](https://nearblocks.io/txns/HovPj1W2PKv9XH6HvRj6TweQ83rdhHiw9KqD2CrFXLfb) |
| 20 | A6 | `claim_dividends` while listed | `ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN` | [`2ZujvBZpKB5K6vrdnHj3hhHreuQ4xkwTqP3x5P4kTqSx`](https://nearblocks.io/txns/2ZujvBZpKB5K6vrdnHj3hhHreuQ4xkwTqP3x5P4kTqSx) |
| 21 | A3, A5 | `request_shareholder_signature` while listed | `ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN` | [`DwLfeptiuLwzLMZwVLuUFqXsopso5PPM6wXP2ZHVxEXG`](https://nearblocks.io/txns/DwLfeptiuLwzLMZwVLuUFqXsopso5PPM6wXP2ZHVxEXG) |
| 22 | A13 | `nft_transfer` while listed | `ERR_TOKEN_ENCUMBERED` | [`4tg5N6kTxwSnVo18XmseDrGg1g2Youmo3sYZmGcLUpXB`](https://nearblocks.io/txns/4tg5N6kTxwSnVo18XmseDrGg1g2Youmo3sYZmGcLUpXB) |
| 23 | A7, A9 | `ft_transfer_call` (acquire at `sync_nonce` 1) | success | [`4Tu3Xabccsft9qvowKovMZ4oeqW99urm9CcYS8xCkcKZ`](https://nearblocks.io/txns/4Tu3Xabccsft9qvowKovMZ4oeqW99urm9CcYS8xCkcKZ) |
| 26 | A15 | `accept_offer` | success | [`3gA99cMdWigv4RGgopmXnNZK7C7QWqS5VAT5XCvQB5fj`](https://nearblocks.io/txns/3gA99cMdWigv4RGgopmXnNZK7C7QWqS5VAT5XCvQB5fj) |
| 27 | A6, A15 | `claim_dividends` while pledged | `ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN` | [`Du7yUNyxL9HHXzDexUy9VMpvfiqjfFnEfsgToyMSSQbE`](https://nearblocks.io/txns/Du7yUNyxL9HHXzDexUy9VMpvfiqjfFnEfsgToyMSSQbE) |
| 28 | A13, A15 | `nft_transfer` while pledged | `ERR_TOKEN_ENCUMBERED` | [`CE7Yp11fZazGFWQWgbXxsCr2q4RQgLxJnyibbVJwgGRe`](https://nearblocks.io/txns/CE7Yp11fZazGFWQWgbXxsCr2q4RQgLxJnyibbVJwgGRe) |
| 29 | A15 | `ft_transfer_call` (repay) | success | [`69jjS9SsTgYKZnTM57QUUGr822pRYLfDECcbeafeVMcY`](https://nearblocks.io/txns/69jjS9SsTgYKZnTM57QUUGr822pRYLfDECcbeafeVMcY) |
| 30 | A6, A8 | `claim_dividends` after repayment | success | [`5WW8cPNcN2CwtHm82sFE49LRPNTfb8J8Tz5Gky54nCgn`](https://nearblocks.io/txns/5WW8cPNcN2CwtHm82sFE49LRPNTfb8J8Tz5Gky54nCgn) |
| 33 | A2 | `request_shareholder_signature` from a stranger | `ERR_ONLY_CURRENT_SHAREHOLDER` | [`FtbSPNYgx16EHdvinmhdCSY3robWnviVCbRvvGwRhx6U`](https://nearblocks.io/txns/FtbSPNYgx16EHdvinmhdCSY3robWnviVCbRvvGwRhx6U) |
| 34 | A10 | `agent_withdraw_intent` to an outside address | `ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION` | [`9yHuadXBoMuFqhBGeP8rK96xnggvZ8UPyPqDnWoS2AyL`](https://nearblocks.io/txns/9yHuadXBoMuFqhBGeP8rK96xnggvZ8UPyPqDnWoS2AyL) |
| 35 | A10 | `agent_swap_intent` for 1 satoshi | `ERR_FIREWALL_PRICE_BELOW_FLOOR` | [`BqvJHjW5pHWS8Rj5PN2D4U4UhCkfNq39S5o2Nqstre5M`](https://nearblocks.io/txns/BqvJHjW5pHWS8Rj5PN2D4U4UhCkfNq39S5o2Nqstre5M) |
| 36 | A10 | `agent_swap_intent` with the operator's own signature | `ERR_TEE_SIGNATURE_UNTRUSTED` | [`97HLn2o1Tcs1wnVG4NfLtkyPxrLxm4H9iRHDAvgdQQjq`](https://nearblocks.io/txns/97HLn2o1Tcs1wnVG4NfLtkyPxrLxm4H9iRHDAvgdQQjq) |
| 37 | A10 | `agent_swap_intent` with a chat reply as approval | `ERR_TEE_NOT_APPROVED` | [`4wbpoEEWMcZhDZfy8shDsdZdosX2evq6TJa4Epj6efhE`](https://nearblocks.io/txns/4wbpoEEWMcZhDZfy8shDsdZdosX2evq6TJa4Epj6efhE) |
| 42 | A11 | `ft_transfer_call` (pay with USDC swapped through 1Click) | success | [`2ZmwLs3VzYexjJCkEY77Tcvm5bK3UAvegSypMvfiokqx`](https://nearblocks.io/txns/2ZmwLs3VzYexjJCkEY77Tcvm5bK3UAvegSypMvfiokqx) |

Not yet on mainnet: refusals with `ERR_RAW_SIGNATURES_THIS_EPOCH`, `ERR_UNEXPIRED_SIGNED_INTENTS`, `ERR_LISTING_CHANGED` and `ERR_PLEDGE_TERMS_NOT_MET`. The sandbox tests above cover them.
