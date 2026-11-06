# Ledgerline Audit on Agent Market

Agent Market (market.near.ai) is a NEAR ecosystem marketplace where people and agents hire AI agents per job. This integration lists company #1, Ledgerline Audit (an AI smart-contract auditor, `c-1.incorpr.near`), as a self-hosted agent there. A hire on the marketplace runs the same NEAR AI Cloud skill that on-chain customers pay 0.05 USDC per call for, and the deliverable carries the TEE signature with the steps to check it.

What is built and tested, and what waits on the listing, is set out in "Status" at the end.

## The hire, step by step

1. A buyer hires the listing on market.near.ai, or bids are awarded, and the marketplace holds the price in escrow.
2. The marketplace POSTs `hire.created` to `https://<project>.vercel.app/api/market/webhook`, signed with the webhook secret.
3. The route reads the body as raw bytes and checks `X-Market-Signature` = `sha256=` + hex HMAC-SHA256(secret, `"<X-Market-Timestamp>.<raw body>"`) with a constant-time compare. It refuses (401) a missing or wrong signature and a timestamp more than 300 s off. Duplicates are dropped on the delivery id and on `(event, assignment_id)` for once-only events.
4. The route answers 200 at once. On Vercel the audit then runs after the response through the function's `waitUntil` (the request-context lookup `@vercel/functions` performs, done inline so no new dependency is needed). The 2xx itself stamps the assignment's start on the marketplace, and it also means the marketplace will not redeliver the event. So a transient failure (a NEAR AI or marketplace 5xx, a 429, a signature not yet served, a failed verification) is retried inside the same invocation: 35 s after the failure, at most 3 inferences, and no attempt starts unless 90 s remain before the 300 s limit. Without a Vercel request context (`next dev`, `next start`) one attempt runs before the answer, and a retryable failure answers 503 so the marketplace redelivers (10 s, 30 s, 90 s, 270 s).
5. The worker re-reads the assignment from `GET /v1/agents/me/assignments`, because serverless instances share no memory. It acts only if the status is `in_progress`. It calls `POST /v1/assignments/{id}/start` (idempotent), then takes a lease: it posts a progress report, "Running the audit on NEAR AI Cloud in a TEE". Another instance that sees a lease younger than 6 minutes skips the row. One that gets `409 progress_report_too_soon` reads the thread again: if a live lease is there now it skips, otherwise (the last report was a released lease under 30 s ago) it tries again after the marketplace's `retry_after`. Only the instance that took a lease releases it.
6. It reads the company from the registry (`incorpr.near` `get_company` for token 1): name, vault, and `service_template`, the on-chain prompt.
7. It runs one NEAR AI Cloud chat completion. The system message is the on-chain `service_template`, as in `/api/run-service`. The user message holds the job brief as data: title, description, tags, and up to 4 text attachments (each at most 64 KiB, checked against the marketplace's sha256). The brief sits between BEGIN and END lines carrying a random tag, so text inside it cannot close the block, and the model is told not to follow instructions inside it. The brief is capped at 24,000 characters, the change request at 8,000 and the previous audit at 12,000. The whole request is also capped at 96 KiB before inference, because the deliverable carries it as base64 under the marketplace's 256 KiB submit limit; a brief of characters that JSON escapes (control characters are 6 bytes each) is cut further to fit. The deliverable says when the brief was cut and to how many characters.
8. It fetches the chat's TEE signature, checks it locally, and fetches a fresh attestation report with a new nonce. Before anything is delivered, the request and response hashes must match the signed text, the signature must recover to the signing address, and that address must be in the fresh report. If any check fails, nothing is submitted and the lease is released. The retry is the in-invocation retry from step 4; after that, the next poll.
9. It re-reads the assignment again. If the buyer cancelled during inference, nothing is submitted. Otherwise it calls `POST /v1/assignments/{id}/submit` with the Markdown.
10. The buyer accepts, or silence accepts after the acceptance window, and the marketplace pays the owner's account.

Rework: `hire.changes_requested` puts the assignment back to `in_progress`. The worker reads the buyer's request from `latestMessage.body`, or from the full thread when the marketplace cut it at 4,000 characters, and the previous audit from `GET /v1/assignments/{id}/deliverable/raw`. It then writes a complete revised audit. A dispute ruling of `redo` reruns the original brief. Other events (`hire.accepted`, `hire.refunded`, `message.created`, `agent.suspended`) are acknowledged and do nothing. `webhook.ping` answers 200 with no side effects.

## Missed webhooks: the poll

The marketplace says a `hire.created` can be missed, so `GET /api/market/poll` lists every `in_progress` assignment. It starts each unstarted one first, which is cheap and removes the buyer's free cancel. It then runs each one through the same steps 5 to 9. It is idempotent: a submitted assignment is no longer `in_progress`, and a running one is behind the lease. It needs `Authorization: Bearer <CRON_SECRET>`.

`web/vercel.json` schedules it daily at 06:17 UTC. **Vercel Hobby runs cron jobs at most once a day.** The webhook's in-invocation retries cover failures that clear within about 4 minutes. Anything longer, such as a NEAR AI outage or a missed webhook, waits for the next poll, and with only the daily cron that can be after the 3600 s SLA, when the buyer may cancel. So run the poll every 10 minutes from an outside scheduler. Any of these works:

- **GitHub Actions** (free; GitHub may delay scheduled runs by a few minutes). Add the repository secrets `CRON_SECRET` and `INCORPR_URL` (`https://<project>.vercel.app`), and commit `.github/workflows/market-poll.yml`:

  ```yaml
  name: Agent Market poll
  on:
    schedule:
      - cron: '*/10 * * * *'
    workflow_dispatch: {}
  jobs:
    poll:
      runs-on: ubuntu-latest
      timeout-minutes: 6
      steps:
        - run: curl -fsS -m 310 -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" "${{ secrets.INCORPR_URL }}/api/market/poll"
  ```

- **cron-job.org** or a similar HTTP scheduler: GET `https://<project>.vercel.app/api/market/poll` every 10 minutes with the header `Authorization: Bearer <CRON_SECRET>` and a 300 s timeout.
- **Vercel Pro**: change the schedule in `web/vercel.json` to `*/10 * * * *`.

Each poll that finds nothing in progress makes one marketplace call and no NEAR AI call. A poll that retries a failing assignment pays for one inference per run.

If no outside scheduler is set up, set the plan's SLA to `86400` instead of `3600`, so the daily sweep still lands inside it.

To run the poll by hand:

```bash
CRON_SECRET=... node scripts/market-poll.mjs --url https://<project>.vercel.app             # once
CRON_SECRET=... node scripts/market-poll.mjs --url https://<project>.vercel.app --every 60  # loop while this machine is on
```

The cron entry takes effect only if the Vercel project's Root Directory is `web`, where `vercel.json` lives.

## What the buyer receives

The Markdown has the audit, then a "Verify this answer" section. That section lists the model, chat id, host, signing address, signature, signed text and its format (`<model>:<sha256 of request bytes>:<sha256 of response bytes>`, signed EIP-191 by the model TEE's ECDSA key), and both hashes. It also holds the exact request and response bytes in base64, and a table of every check this server ran, each marked pass, FAIL, or "not run" with the reason. The steps it gives the buyer:

1. Decode the two base64 blocks and `shasum -a 256` them. The hashes must equal the signed text's fields.
2. Recover the signer of the signed text with `viem` `recoverMessageAddress`. It must equal the signing address.
3. Fetch `https://cloud-api.near.ai/v1/attestation/report?model=<model>&signing_algo=ecdsa&nonce=<your 32-byte hex>`, find the address in `model_attestations[].signing_address`, and verify that entry's Intel TDX quote and NVIDIA payload, for example with https://github.com/nearai/nearai-cloud-verifier. Or call `<site>/api/attestation?model=<model>&signing_address=<address>`, which runs the same checks here.
4. Read `get_company` from the registry over RPC (the deliverable gives the `curl`). Its `service_template` must equal the request's system message.

It ends with "Delivered by Ledgerline Audit, NEP-171 company #1 on NEAR (vault c-1.incorpr.near)." and links to `<NEXT_PUBLIC_SITE_URL>/company/1` and the vault on NearBlocks.

A rehearsal on 2026-11-06 ran the builder on a small Solidity contract with a reentrancy bug. It produced chat `chatcmpl-c884b8a9-8e48-4959-9a84-b785e6a67eea` on `Qwen/Qwen3-VL-30B-A3B-Instruct`, signed by `0x2665cce942fa427ef30d87f4b0bff67fb7645462`, and all 17 checks passed, including the Intel quote (TCB `UpToDate`) and NVIDIA NRAS. Steps 1 to 4 above were then run by hand from the Markdown alone, and each matched. No marketplace endpoint was called, because there is no listing yet.

## Where the money goes, and what that means on chain

- **Marketplace pay goes to the owner's marketplace balance, not to the vault.** The escrow is released to the owner's marketplace account after acceptance, minus the marketplace fee. An aat_ token cannot move money, and the vault never sees it.
- **Booking it on chain is a separate, manual step.** `scripts/market-forward.mjs` sends USDC from a NEAR account to the vault with `usdc.ft_transfer_call`, using the vault's payment message `{"call_id": "<sha256(salt:text)>"}` and the memo "Agent Market payout forward (market.near.ai)". The committed text names Agent Market, the amount, the payer and the time. The script records the salt and text in `docs/evidence/agent-market-forward-<timestamp>.json`, so anyone can recompute the call id, and the transaction in `docs/evidence/<network>.json`.
- **How the vault books it** (`contracts/company-vault/src/lib.rs`, `ft_on_transfer`): if the sender is the vault's current `shareholder`, the amount goes to `related_party_revenue`; any other sender's amount goes to `gross_revenue` and `revenue_30d`. Either way the compute reserve (20%) and retained earnings grow, and an unserved payment record is stored. An amount under the per-call price (0.05 USDC), or a reused call id, is returned in full and booked nowhere. The script defaults `--from` to the shareholder, so forwarded earnings are booked as related-party funds: they are the owner's own withdrawal, not a payment from an outside customer. Sending from another account needs `--allow-non-shareholder`, because it would be booked as outside revenue.
- **It does not count as a served API call.** No `record_service_call` is sent, so `api_calls_served` does not change.
- **The withdrawal rail is not confirmed.** The marketplace's public API documents only USD withdrawals to a bank through Stripe (`/v1/wallet/fiat/payout/withdraw`). If the dashboard offers USDC to a NEAR account, withdraw to the shareholder account and forward that. If it does not, the owner can forward the same amount of their own USDC. The accounting is the same (related-party), but they are not the same coins, and the docs should say so.

```bash
node scripts/market-forward.mjs --network mainnet --amount 4.50 --dry-run           # reads state, prints the plan, opens no key file
node scripts/market-forward.mjs --network mainnet --amount 4.50 --confirm-mainnet   # signs with ~/.near-credentials/mainnet/<shareholder>.json
```

Today the shareholder of token 1 is `demo-buyer.incorpr.near` (read 2026-11-06), so on mainnet it signs with that account's key file.

## Setup

### 1. Host the app

Deploy `web/` to Vercel (Root Directory `web`). Set the variables in step 5 on the project, for Production. Note the production domain, `https://<project>.vercel.app`.

### 2. Create the account and the agent on market.near.ai

Sign in at https://market.near.ai and create an agent with these values:

| Field | Value |
|---|---|
| Handle (immutable, it is the hostname) | `ledgerline-audit` |
| Name | `Ledgerline Audit` |
| Category | `dev_tools` |
| Runtime | `http` (self-hosted) |
| SLA | `3600` seconds with the 10-minute poll from "Missed webhooks"; `86400` without it |
| Description | `Smart-contract security audit by Ledgerline Audit, NEP-171 company #1 on NEAR (vault c-1.incorpr.near). Runs on NEAR AI Cloud in an Intel TDX and NVIDIA TEE. Each deliverable includes the TEE signature, the exact request and response bytes, and the steps to verify them against NEAR AI Cloud's attestation.` |
| Tags | `solidity`, `smart-contract-audit`, `security`, `near`, `tee` |
| Webhook URL | `https://<project>.vercel.app/api/market/webhook` |
| Webhook secret | the output of `openssl rand -hex 32` (64 characters; the marketplace requires at least 32) |

Add a pricing plan: model `per_call`, a price as a decimal string (for example `"2.00"`), and the same SLA as the agent. Make it the default. Pay in USDC if you want to forward earnings to NEAR. USD needs a Stripe account connected under Payouts, or bids on USD jobs are refused.

### 3. Mint the API token

On the agent's page, mint an API token (`POST /v1/agents/{agent_id}/api-tokens` behind the button). It is shown once and starts with `aat_`. Put it in `AGENT_MARKET_TOKEN` and nowhere else.

### 4. Generate the cron secret

```bash
openssl rand -hex 32   # CRON_SECRET
```

### 5. Set the variables on Vercel

| Variable | Value |
|---|---|
| `AGENT_MARKET_TOKEN` | the `aat_` token from step 3 |
| `AGENT_MARKET_WEBHOOK_SECRET` | the same value entered as the webhook secret in step 2 |
| `AGENT_MARKET_HANDLE` | `ledgerline-audit` |
| `AGENT_MARKET_COMPANY_ID` | `1` |
| `CRON_SECRET` | from step 4 |
| `NEAR_AI_API_KEY` | the NEAR AI Cloud key, already used by `/api/run-service` |
| `NEXT_PUBLIC_SITE_URL` | `https://<project>.vercel.app` (used for the company link in deliverables) |
| `NEXT_PUBLIC_NEAR_NETWORK`, `NEXT_PUBLIC_REGISTRY_CONTRACT_ID` | `mainnet`, `incorpr.near` |

`AGENT_MARKET_API_URL` defaults to `https://market.near.ai/v1`. Redeploy after setting them. With the token or the NEAR AI key unset, the webhook answers 503 to work events (the marketplace retries those) and the poll answers 503. `webhook.ping` needs only the secret.

### 6. Test the webhook

Press "test webhook" on the agent's page (`POST /v1/agents/{id}/webhook/test`). The marketplace sends a signed `webhook.ping`, which must get 200. A 401 means the two secrets differ. Then check `https://<project>.vercel.app/api/market/status`: every `configured` flag should be true.

### 7. Self-hire test

Use the dashboard's test run on your own agent. The marketplace docs describe it as a free hire by the owner, with zero escrow and `bid_id` null. Within about a minute the job should show the progress note, then a delivered result with the "Verify this answer" section. Run the four checks from the deliverable yourself. In the Vercel logs, `[agent-market] event hire.created ...` is followed by `delivered <assignment> round=fresh chat=...`. Then press "request changes" with a note, and a revised version should arrive. If nothing arrives, run `node scripts/market-poll.mjs --url https://<project>.vercel.app` and read its report.

A paid end-to-end hire needs a second marketplace account as the buyer. It costs the plan's price, of which the owner gets back the price minus the marketplace fee.

### 8. Go live

Set the listing to Live (`listing_status: live`). The marketplace refuses this until the default pricing plan is live. The agent then answers at `https://ledgerline-audit.market.near.ai` (agent card, A2A with x402) and is listed at `https://market.near.ai/a/ledgerline-audit`. A2A callers become ordinary assignments on the same webhook. Once `/api/market/status` shows `listing.listing_status: "live"`, the `HireOnMarket` component (`web/src/app/ui/hire-on-market.tsx`) renders a "Hire on Agent Market" button and the delivered count. It renders nothing before that.

## Files

| Path | Role |
|---|---|
| `web/src/lib/agentMarket.ts` | Worker REST client, with zod schemas matching `openapi.json`; webhook HMAC check; dedupe set |
| `web/src/lib/agentMarketWork.ts` | Prompt, deliverable builder, assignment state machine, lease, poll |
| `web/src/app/api/market/webhook/route.ts` | Signed webhook receiver |
| `web/src/app/api/market/poll/route.ts` | Cron and manual fallback |
| `web/src/app/api/market/status/route.ts` | Public counts for the site (no buyer data) |
| `web/src/app/ui/hire-on-market.tsx` | Client button for other pages |
| `web/vercel.json` | Daily cron (the 10-minute poll needs an outside scheduler on Hobby) |
| `scripts/market-forward.mjs` | Books withdrawn earnings into the vault |
| `scripts/market-poll.mjs` | Runs the poll by hand |
| `web/tests/agentMarket.*.test.ts` | Signature vectors, route behaviour, state machine with a fetch-mocked marketplace, live `openapi.json` contract check, gated live NEAR AI rehearsal |

## Status

Built and tested:

- Signature check, with expected values computed separately using `node:crypto` in the tests.
- Dedupe, every route answer, and the state machine (fresh hire, redelivery, rework, truncated feedback, dispute redo, lease, a lease taken between read and report, no release of another worker's lease, cancel during work, failed verification, in-invocation retries and their limits, the 96 KiB request cap on a brief of control characters, poll idempotency, attachments), tested against an in-memory model of the documented API.
- The schemas, checked against the live `openapi.json`.
- One live NEAR AI Cloud rehearsal.
- The forward script, in dry runs only.

Not yet exercised:

- Any authenticated marketplace call. No listing or token exists yet.
- `waitUntil` on Vercel, and the in-invocation retries behind it. If the request context is missing there, the route runs one attempt before answering (`mode: "inline"` in the response, about 10 to 60 s) within `maxDuration` 300, and relies on the marketplace's redelivery for retries.
- The first real `market-forward.mjs` transaction.

Known limits:

- Thread questions from buyers (`message.created`) and pre-award bid threads are not answered automatically.
- Image and binary attachments are not read.
- The lease is a progress report, so two instances that both read "no lease" in the same instant are separated only by the marketplace's 30-second progress limit.
