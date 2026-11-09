# Incorpr demo film

A 2:59 film made with [Remotion](https://www.remotion.dev) for the NEAR Hackathon 2026 judges. It shows the problem, why NEAR, and the product working on mainnet: a keyless vault signing a Bitcoin spend, a paid call from a wallet, the Agent Market listing, the treasury agent's swap, a live robbery attempt the vault refuses, and a sale and a loan in one transaction each.

Deliverables, in `out/` (gitignored):
- `incorpr-demo-4k.mp4`: 3840×2160, 30 fps, -14 LUFS.
- `incorpr-thumbnail.png` and `.jpg`.

The YouTube title, description with transaction links, and chapters are in `youtube.txt`.

Twelve scenes, from `script.json`: open, problem, turn, why NEAR, incorporate, earn, treasury, rob, sell, borrow, proof, close. The recurring motif is the vault drawn as a seal: an amber ring with "0" access keys at its centre and the Bitcoin, Solana and EVM addresses it signs for in orbit (`src/ui/Seal.tsx`).

## What is real

- **Every hash, block, time and figure** on screen is quoted from `data/onchain.json`. `scripts/onchain.mjs` reads them back from NEAR mainnet RPC (`EXPERIMENTAL_tx_status`, `block`, `view_access_key_list`, `get_company`, `nft_token`, `get_state`), the Bitcoin transaction from Esplora, and the listing from the Agent Market public API. Last read 2026-11-09. Nothing in `src/` contains a hash or a balance.
- **Open:** the Bitcoin spend `da6679b0…4b6a8f`, 9,523 sats.
  - Broadcast 2026-11-06 19:04 UTC and confirmed at 19:23 UTC in block 974,844.
  - Its signature came from `v1.signer` at the request of `c-1.incorpr.near`, which holds 0 access keys (NEAR tx `ENe31utH…`).
- **Why NEAR:** each card's proof is a mainnet fact from that file:
  - the vault's key count
  - `v1.signer`
  - the swap `4AmTFGH5…`
  - the TEE signer `0x2665…5462`
- **Earn:**
  - **The paid call** is the owner's own screen recording, made with Meteor Wallet as `mrnetwork.near` around 09:46 UTC on 2026-11-09 (`public/footage/owner/owner-pay.mp4`).
    - The recording was muted and cut to the segments listed in `owner-pay.segments.txt`, and the film plays it at 1.9×.
    - The payment was `7zxrvumv…`, 0.05 USDC at 09:46:59 UTC. The vault booked it in `D2NeQ9ed…` at 09:47:12 UTC, with TEE chat `chatcmpl-0f87296f…`.
    - Calls served went from 4 to 5.
  - **The Agent Market numbers** come from the owner's free test run on 2026-11-09:
    - created 08:00:08 UTC and delivered 08:00:24 UTC (16 s)
    - 17 of 17 TEE checks passed
    - accepted at 08:07:31 UTC
- **Rob:** recorded from the hosted `/rob` page on 2026-11-09 with `scripts/capture.mjs` (`ONLY=rob ALLOW_WRITES=1`).
  - The visitor's message is the one shown on screen.
  - The agent's reply ("I'll initiate a withdrawal of 2.5 BTC…") is real and signed in the TEE.
  - The four attempts were refused on mainnet: `2bK8DVm4…`, `E2xwV55R…`, `ABCNn7DG…`, `5dvm2KVZ…`.
- **Sell and borrow:** the cycle was run on 2026-11-09 between 09:36 and 09:38 UTC with `scripts/demo.mjs`. The demo accounts signed with their key files; no browser wallet was used.
  - The steps: list (`EaDVYBLU…`), buy (`9hEnUAfw…`), loan offer, borrow (`3Hv7sqjn…`), repay (`4TMnfFtP…`), then a sale back to `demo-buyer`.
  - The hosted company page was recorded after each step.
  - The refusal codes shown were recorded on 2026-11-06 while the company was listed or pledged.
- **Proof:** `docs/evidence/mainnet.verified.json` shows 75 of 75 transactions matching the chain, with 11 expected refusals confirmed (re-checked 2026-11-09).
- **Footage:**
  - **Live site:** headless Chrome at 1600×900, device scale 2, on 2026-11-09.
  - **Explorers:** mempool.space and Pikespeak, because NearBlocks shows a bot check to headless browsers.
  - **Agent Market:** the public listing page.
- **Logos** are unaltered:
  - Bitcoin, Solana, Ethereum and NEAR from cryptologos.cc
  - NEAR AI from near.ai
  - Incorpr's mark from `web/src/app/icon.png`
- **Narration, music and sound:** ElevenLabs. The narrator is Eric. "Incorpr" is voiced "Incorper", and "Live" in the close is spelled "Lyve" for the voice. The score is ElevenLabs Music, and the 15 effects are ElevenLabs sound generation.

## Build it

The ElevenLabs key is read at runtime from `ELEVENLABS_API_KEY` (environment or `video/.env`), or from the `ELEVENLABS_API_KEY` line of `/Users/mrnetwork/Syntura/video/.env`. It is never stored here.

```
npm install
npm run onchain                                   # read every figure back from mainnet into data/onchain.json
npm run vo && npm run music && npm run sfx        # audio
npm run timing                                    # word-level timing -> src/timing.json
BASE=https://tryincorpr.vercel.app ONLY=landing,company,rob,... node scripts/capture.mjs && npm run encode
npm run studio                                    # preview
npm run draft                                     # half-scale check render
npm run render4k && npm run finish                # 4K master, -14 LUFS / -1 dBTP
npm run poster                                    # thumbnail
```

`capture.mjs` refuses to run without `ONLY`, and the rob clip also needs `ALLOW_WRITES=1`, so a one-time write is never repeated by accident. The first-draft film this one replaced is kept in `old-v1/` and `script.v1.json`.
