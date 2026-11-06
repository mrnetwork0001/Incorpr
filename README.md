# 🏛️ Incorpr — Incorporate, Finance & Trade Autonomous AI Companies as `NEP-171` NFTs

> **Track:** `10 / NFT — NFTs That Do Something` (`$10,000` 1st Place + `$55,000` Overall Grand Prize Contender)  
> **Hackathon:** `$250,000` NEAR Hackathon (`nearhackathon.com` · Nov 1 – Nov 14, 2026)  
> **Core NEAR Stack:** `NEP-171 / NEP-177 / NEP-199` · `NEAR Sub-accounts` · `Chain Signatures (v1.signer MPC)` · `NEAR Intents (1Click & intents.near)` · `NEAR AI Cloud (TEE + nearai-cloud-verifier)`

---

## ⚡ What Incorpr Is (In One Paragraph)

**Incorpr** turns every `NEP-171` NFT on NEAR into a **keyless, cash-flowing, multichain AI corporation**. Minting a Company NFT deploys an isolated Rust smart contract onto its own NEAR sub-account (`c-001.incorpr.near`) that deterministically owns native **Bitcoin (`bc1q...`)**, **Solana**, and **EVM (`ETH / Base / Arbitrum`)** wallets via **NEAR Chain Signatures (`v1.signer`)**—with **zero human seed phrase**. Customers and other agents pay the company per API call from any chain via **NEAR Intents**; its sub-account automatically pays its own **NEAR AI Cloud** TEE compute bill; its TEE Treasury Agent compounds surplus earnings across `BTC`, staked `SOL`, and `USDC` under a strict Rust WASM firewall (the AI can rebalance inside the company's wallets, *never* withdraw outside); and whoever holds the `NEP-171` NFT can **claim `USDC` dividends**, **pledge the company to borrow instant `USDC`**, or **sell the entire operating business + multichain treasury in one atomic click**.

---

## 🔥 Why Only NEAR Can Do This (The Seed-Phrase Impossibility Proof)

On Bitcoin, Solana, or Ethereum, you **cannot safely sell or lend against an operating wallet or staked account**—because even after selling, the creator still knows the private key and can drain the wallet.

Incorpr solves this at the cryptographic protocol layer:
1. **Zero Seed Phrases Ever Exist:** Native `BTC` (`secp256k1`, `domain_id: 0`), `EVM` (`secp256k1`, `domain_id: 0`), and `SOL` (`ed25519`, `domain_id: 1`) accounts are controlled exclusively by `c-001.incorpr.near` calling `v1.signer`.
2. **Anti-Rug MPC Encumbrance Lock:** The millisecond a Company NFT is `LISTED` for M&A sale or `PLEDGED` for a `USDC` credit line, its Rust sub-account **freezes outbound owner MPC signing** and verifies L1 UTXO/nonce freshness via a **NEAR AI Cloud TEE attestation**—making seller front-running mathematically impossible.
3. **WASM Byte-Level Treasury Firewall:** The TEE Treasury Agent holds a bounded operator role: the Rust sub-account inspects raw transaction payloads in WASM before calling `v1.signer`, allowing internal cross-chain rebalancing via **NEAR Intents** while panicking on any attempt to transfer principal to an external address.

---

## 🏗️ System Architecture (All 3 Corporate Desks Unified)

```
+-----------------------------------------------------------------------------------------+
|                      INCORPR — AUTONOMOUS COMPANY-IN-AN-NFT (NEP-171)                   |
|     Token #001 -> Deploys Isolated Sub-Account Contract: `c-001.incorpr.near`           |
|     MPC Keyring (`v1.signer`): Native BTC (bc1q..) + Native SOL + EVM (0x..) + NEAR     |
+-----------------------------------------------------------------------------------------+
            |                                   |                                   |
            v                                   v                                   v
+-------------------------+       +-----------------------------+     +-------------------------+
|   1. OPERATIONS DESK    |       |     2. TREASURY DESK        |     | 3. CREDIT & M&A DESK    |
| (Earn & Self-Pay Bills) |       |  (Compound BTC/SOL/USDC)    |     | (Borrow or Exit 1-Click)|
+-------------------------+       +-----------------------------+     +-------------------------+
| • Hosts AI Skill inside |       | • TEE Treasury Agent        |     | • Pledge NFT -> Freezes |
|   NEAR AI Cloud TEE     |       |   allocates net profit into |     |   MPC signing on-chain  |
|   (cloud-api.near.ai)   |       |   BTC, SOL & USDC via       |     |   & borrows instant     |
| • Customers pay per call|       |   NEAR Intents + v1.signer  |     |   USDC via NEAR Intents |
|   from ANY chain via    |       | • Rust WASM Firewall allows |     | • Sell Company on M&A   |
|   NEAR Intents 1Click   |       |   internal swaps ONLY;      |     |   Market at `NAV + P/E` |
| • Auto-reserves 15% for |       |   blocks external drains    |     | • Single `nft_transfer` |
|   compute; books 85%    |       | • Shareholder claims live   |     |   hands buyer AI + cash |
|   as Net Profit         |       |   USDC dividends + NEP-199  |     |   flow + BTC/SOL vault! |
+-------------------------+       +-----------------------------+     +-------------------------+
```

---

## 🖥️ The 4-Screen Product Experience

1. **M&A & Credit Exchange (`/`)** — Live Bloomberg-meets-Acquire.com board of `NEP-171` Company NFTs displaying their dynamic on-chain SVG charter, verified **30d Net Revenue**, **Multichain Treasury NAV (`BTC + SOL + USDC`)**, **Implied P/E Multiple**, **Encumbrance State (`FREE | PLEDGED | LISTED`)**, and **1-Click Acquire / Lend** via NEAR Intents.
2. **Incorporate Wizard (`/incorporate`)** — Mint a new AI Company NFT in 60 seconds: choose its service template (e.g., *Solidity/Rust Exploit Scanner*, *Cross-Chain Whale Flow Oracle*, *DeFi Yield Router*), set its per-call price in `USDC`, define its automated treasury target (`40% BTC / 30% SOL / 30% USDC`), and deploy `c-<id>.incorpr.near`.
3. **Company Cockpit (`/company/[id]`)** — Test and pay the NFT's live AI API right on the page (watch real revenue hit its sub-account and receive a cryptographically verified `NEAR AI Cloud` TEE ECDSA signature!), trigger an attested treasury rebalance, or withdraw shareholder dividends.
4. **Capital Markets Desk (`/desk`)** — Lock your Company NFT as collateral to borrow instant `USDC` (delivered to *any* chain you choose via NEAR Intents!) or list the entire cash-flowing company for atomic acquisition.

---

## 🧪 Judge Verification Flow ("Do X, See Y" — Built for Human + AI Judges)

1. **Run Rust Contract & Security Invariant Suite (`cargo test`):**
   * Verifies `NEP-171` mint spawns `c-001.<registry>.near` and deploys `company-vault.wasm`.
   * Proves **Invariant 1 (Agent Firewall):** Prompt-injected AI operator attempting an external withdrawal panics in WASM before `v1.signer` is called.
   * Proves **Invariant 2 (Anti-Rug Encumbrance):** Once `LISTED` or `PLEDGED`, the current NFT owner is blocked from calling `request_chain_signature()` until unlisted or loan-repaid, and `nft_transfer` atomically hands `v1.signer` control to the buyer.
2. **Live App Walkthrough (`60 seconds`):**
   * **Do:** Click **Incorporate** $\rightarrow$ mint `c-001` $\rightarrow$ click **Run Paid Inference (`$0.10` via NEAR Intents)** on `/company/1`.
   * **See:** On-chain P&L ledger credits net profit + compute reserve, and UI displays the verified `cloud-api.near.ai/v1/signature/{chatId}` Intel TDX / NVIDIA NRAS hardware attestation.
   * **Do:** Click **Pledge & Borrow `$50 USDC`** (or **Acquire Company**) on `/desk`.
   * **See:** NFT encumbrance badge flips to `PLEDGED` (raw owner MPC signing locked on-chain) and `USDC` settles cross-chain via NEAR Intents!

---

## Known Limits

- `revenue_30d` is not verified against sybil payers. A seller's second account counts as a customer; only the current shareholder's own payments are excluded. Read it with `payment_stats`, `dividends_paid` and `compute_paid` on the vault.
- A compromised operator can resubmit a proposal until the model approves it, and a colluding solver can then fill at `min_buy_amount`. The loss per 24-hour window is bounded by the epoch cap and the shareholder-set price floor, which is not an oracle.
- Funds left on a key from an earlier epoch stay spendable by any signature the previous shareholder holds. They are excluded from NAV.

`docs/ARCHITECTURE.md` is authoritative where this file disagrees with it.
