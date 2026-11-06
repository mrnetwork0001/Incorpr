# CLAUDE.md — Incorpr Build Instructions for Claude Code

## 1. Mission & Context
You are building **Incorpr** (`10 / NFT — NFTs That Do Something` + `$55,000` Overall Grand Prize contender) for the **`$250,000` NEAR Hackathon** (`nearhackathon.com`, submission window: **Nov 1 – Nov 14, 2026**).

**One-Sentence Product Definition:**
> **Incorpr is On-Chain Acquire.com on NEAR:** every `NEP-171` NFT is a keyless, cash-flowing AI company with its own NEAR sub-account (`c-001.<factory>.near`) and native Bitcoin, Solana, and EVM wallets (`v1.signer` Chain Signatures) — customers pay it per API call via **NEAR Intents**, it pays its own **NEAR AI Cloud** TEE compute bills, its TEE Treasury Agent compounds retained profit across BTC/SOL/USDC under a hard Rust WASM firewall, and the owner can **borrow instant `USDC` against it** or **sell the entire company in one atomic click**.

---

## 2. CRITICAL: How This Repo Will Be Judged (`Claude Code` + `Codex` + Human Jury)
Hackathon submissions are audited directly by **Claude Code and Codex acting as AI Judges**, alongside **Illia Polosukhin (NEAR)**, **Eddy Lazzarin (a16z crypto CTO)**, **Haseeb Qureshi (Dragonfly)**, **Kain Warwick (Synthetix/Infinex)**, **Mert Mumtaz (Helius)**, and **Avichal Garg (Electric Capital)**.

### Non-Negotiable Engineering Rules:
1. **NO FAKE OR MOCKED BLOCKCHAIN/TEE CALLS:** Never stub `v1.signer`, `intents.near`, `1click.chaindefuser.com`, or `cloud-api.near.ai` with hardcoded fake hashes. Every integration must execute real testnet/mainnet calls and expose verifiable transaction hashes & TEE ECDSA/TDX attestation signatures.
2. **REAL MULTI-CONTRACT RUST WORKSPACE:** Both `contracts/incorpr-registry` and `contracts/company-vault` must compile cleanly to WASM via `cargo near build` and pass real `near-workspaces` sandbox integration tests (`cargo test`).
3. **CRISP `NetLayerLabs` ENGINEERING PROSE:** Keep UI copy, code comments, and `README.md` direct, concrete, and technical—zero AI hype words ("revolutionize", "seamless", "delve"). Include a deterministic **"For Judges: Try It in 60 Seconds (Do X, See Y)"** section at the top of `README.md`.

---

## 3. First Step Before Coding: Pull Official NEAR Agent Skills
Run these commands first to load official NEAR documentation and reference skills locally:
```bash
mkdir -p .claude/skills vendor
git clone --depth 1 https://github.com/near/agent-skills.git vendor/near-agent-skills
cp -r vendor/near-agent-skills/* .claude/skills/ 2>/dev/null || true
curl -sL https://nearhackathon.com/HACKATHON.md -o docs/HACKATHON.md || true
```

---

## 4. Verified NEAR Protocol Endpoints & Contract IDs (2026)

| Component | Mainnet | Testnet | Notes |
| :--- | :--- | :--- | :--- |
| **Chain Signatures MPC** | `v1.signer` | `v1.signer-prod.testnet` | `domain_id: 0` = `Secp256k1` (BTC/EVM), `domain_id: 1` = `Ed25519` (Solana) |
| **NEAR Intents 1Click API** | `https://1click.chaindefuser.com/v0/quote` | `https://1click.chaindefuser.com/v0/quote` | `GET /v0/tokens` for supported cross-chain asset IDs (`nep141:...`) |
| **NEAR Intents Solver Bus** | `https://solver-relay-v2.chaindefuser.com/rpc` | — | JSON-RPC `quote` & `publish_intent` |
| **NEAR Intents Verifier** | `intents.near` | — | On-chain atomic cross-chain settlement contract |
| **NEAR AI Cloud (TEE LLM)** | `https://cloud-api.near.ai/v1` | `https://cloud-api.near.ai/v1` | OpenAI-compatible; Intel TDX + NVIDIA NRAS confidential compute |
| **NEAR AI TEE Signature** | `GET https://cloud-api.near.ai/v1/signature/{chatId}?model={model}&signing_algo=ecdsa` | Same | Verify hardware quote & ECDSA signature via `nearai-cloud-verifier` |

---

## 5. Target Workspace Layout

```text
/Users/mrnetwork/Incorpr/
├── CLAUDE.md                        # Instructions for Claude Code (this file)
├── README.md                        # Product overview & "Try it in 60s" judge guide
├── RUST_CONTRACTS_SPEC.md           # Full Rust specs for incorpr-registry & company-vault
├── BACKEND_AND_INTENTS_SPEC.md      # Full TS specs for TEE worker, 1Click Intents & MPC derivation
├── .env.example                     # Environment configuration template
├── contracts/
│   ├── Cargo.toml                   # Rust workspace (near-sdk 5.x)
│   ├── incorpr-registry/            # NEP-171 + NEP-177 Dynamic SVG + NEP-199 + Subaccount Factory + Credit/M&A Market
│   ├── company-vault/               # Deployed per NFT subaccount (c-001.incorpr.near): Encumbrance Lock + WASM Firewall + v1.signer
│   └── integration-tests/           # near-workspaces tests proving anti-rug freeze & agent drain rejection
└── web/                             # Next.js 14 + TypeScript + Tailwind + @near-wallet-selector
    ├── src/app/
    │   ├── page.tsx                 # Screen 1: M&A & Credit Exchange (Live Company NFT cards)
    │   ├── incorporate/page.tsx     # Screen 2: 60s Wizard to Mint an Autonomous AI Company NFT
    │   ├── company/[id]/page.tsx    # Screen 3: Company Cockpit (Pay-per-call API, P&L, BTC/SOL/USDC Treasury, Claim Dividends)
    │   ├── desk/page.tsx            # Screen 4: Capital Markets Desk (Borrow USDC against NFT or List for Atomic Acquisition)
    │   └── api/
    │       ├── run-service/route.ts # Executes NFT's NEAR AI Cloud TEE skill after verifying Intents payment + returns TEE signature
    │       ├── rebalance/route.ts   # Generates TEE-attested BTC/SOL/USDC treasury rebalance intent
    │       ├── intents/route.ts     # Proxies 1click.chaindefuser.com quotes & tracks settlement
    │       └── verify-l1/route.ts   # TEE State-Freshness check on BTC UTXOs + SOL/EVM nonces before M&A / Loan unlock
    └── src/lib/
        ├── mpcAddresses.ts          # Deterministic BTC (bech32), SOL (ed25519), EVM (0x) derivation from subaccount ID
        ├── nearAiTee.ts             # cloud-api.near.ai inference + ECDSA hardware attestation verifier
        └── nearIntents.ts           # 1Click Swap & Cross-Chain M&A/Loan settlement client
```

---

## 6. Recommended Build Sequence
1. **Phase 1 — Rust Smart Contracts (`contracts/`):** Implement `company-vault` first (compile to `.wasm`), embed or load its WASM inside `incorpr-registry`, implement `NEP-171` minting that spawns `c-<id>.<registry>.near`, and write the `near-workspaces` test suite (`RUST_CONTRACTS_SPEC.md`).
2. **Phase 2 — MPC Key Derivation & NEAR AI Cloud TEE (`web/src/lib/`):** Wire deterministic BTC/SOL/EVM address derivation from `v1.signer` / `v1.signer-prod.testnet` and connect `cloud-api.near.ai/v1` with cryptographic signature verification (`BACKEND_AND_INTENTS_SPEC.md`).
3. **Phase 3 — NEAR Intents 1Click Revenue, Rebalance & M&A Rails:** Connect `https://1click.chaindefuser.com/v0/quote` so users can pay a Company NFT's API in any token, rebalance its treasury, borrow `USDC` against an encumbered NFT, or buy the entire company atomically.
4. **Phase 4 — 4-Screen Institutional Frontend (`web/`):** Build the Acquire.com-meets-Bloomberg interface showing live dynamic `NEP-171` SVGs, live P&L ledgers, TEE hardware badges, and clickable explorer links across NEAR, Bitcoin, Solana, and Base.
