# Incorpr demo film

A film of about two minutes, made with [Remotion](https://www.remotion.dev), for the NEAR Hackathon (Nov 1 to 14, 2026). It runs under 2:10 because X handles longer videos poorly. Seven scenes, from `script.json`:

| # | Scene | What it shows | Contract calls on screen |
|---|---|---|---|
| 01 | hook | "A company you can sell in one NFT transfer." | `nft_transfer` |
| 02 | incorporate | the vault sub-account with no owner key; BTC, SOL and EVM addresses from Chain Signatures | `incorporate_company`, `refresh_treasury_keys` |
| 03 | earn | pay per call in USDC (or through NEAR Intents); the model runs in a NEAR AI Cloud TEE; the browser verifies the signature | `ft_on_transfer`, `record_service_call` |
| 04 | rob | a visitor tries to talk the treasury agent into moving money out; the vault's firewall refuses on-chain | `agent_withdraw_intent` and its checks |
| 05 | sell | list, buyer pays, the NFT and the company move in one transaction | `list_company`, `ft_on_transfer`, `on_acquire_settled` |
| 06 | borrow | pledge, USDC loan, owner signing frozen until repaid | `accept_offer`, `request_shareholder_signature` |
| 07 | close | "Built on NEAR. Every claim links to a transaction." and NEAR HACKATHON | `/verify` |

Compositions (`src/Root.tsx`): `Incorpr` (1920x1080, 30 fps), `Poster` (1280x720 thumbnail), `Banner` (1500x500 X header).

## Title-card mode and footage

Every scene renders on its own before anything is recorded: a title card in the site's design (background `#0D0D0D`, amber `#F0A24C`, glass panels with an amber top edge, film grain, Google Sans Flex and IBM Plex Mono), with the scene's key line and the contract method it relies on, copied from `contracts/*/src/lib.rs`.

When `scripts/encode.mjs` (or `scripts/addclip.mjs`) writes a clip into `src/footage.json`, the scenes that name it play it in a browser frame instead:

| Scene | Clips, first available wins |
|---|---|
| incorporate | `incorporate`, `company` |
| earn | `company` |
| rob | `rob`, `scan_rob` |
| sell | `desk`, `exchange` |
| borrow | `desk` |
| close | `verify` |

Before VO exists, `scripts/timing.mjs` estimates word timings (2.6 words per second) and marks each line `audio: false`; the film then renders silent with captions. Music, VO and effects play only for files that exist.

## What is real

- **Transaction hashes** come only from `/Users/mrnetwork/Incorpr/docs/evidence/<network>.json`. `scripts/sync.mjs` copies that file into `public/evidence/` before each render, and `src/evidence.ts` reads it at render time (`calculateMetadata`). Mainnet is preferred, then testnet. A scene shows a hash only when the file has a matching entry; with no file the scenes show no hash and the corner reads "no evidence file: hashes hidden". Nothing in `src/` contains a hash, balance or address.
  The loader accepts any JSON in which an entry is an object with `hash` (or `txHash`, `tx_hash`, `transaction_hash`) holding a NEAR tx hash, named by `key`, `label`, `step` or its JSON key. Optional: `method`, `receiver_id`, `status`, `error`, `explorer`, `block`, `timestamp`. Scene matching (`SCENE_TX` in `src/evidence.ts`): incorporate (`incorporate`, `mint`, `create`), earn (`pay`, `service`, `ft_transfer_call`, `revenue`), rob (`rob`, `firewall`, `reject`, `withdraw`), sell (`acquire`, `sale`, `sell`, `buy`, `list`), borrow (`pledge`, `loan`, `borrow`, `accept_offer`).
- **The app** is recorded from the running site with `scripts/capture.mjs` (headless Chrome, 1600x900 CSS px at device scale 2). Read-only clips only navigate, scroll and hover. Wallet-signed flows are recorded by the owner on screen and registered with `scripts/addclip.mjs`.
- **The charter card** follows the registry's own SVG (`contracts/incorpr-registry/src/charter.rs`): same rows and state pill. It shows field names and where each value comes from, not values.
- **The rob scene's visitor message** is an example of what `/rob` invites; it is labelled as a visitor's message. The error names in the code panels are the strings in `company-vault/src/lib.rs`. The failed receipt appears only from the evidence file.
- **Marble hands**: `web/public/hero/hand-left.png` and `hand-right.png`, linked (not copied) into `public/hero` by `scripts/sync.mjs`. If they are missing, the scenes leave them out.
- **Narration, music and effects**: ElevenLabs (not generated yet).

## Run it

```
npm install
cp .env.example .env          # add ELEVENLABS_API_KEY; CHROME_PATH and BASE are optional

# audio, then timing (timing also runs without audio: estimated words, silent film)
npm run vo && npm run vocheck  # narration, then a speech-to-text check of each line
npm run music && npm run sfx
npm run timing

# footage from the running app (default BASE http://localhost:3010)
npm run look                                    # screenshots + page text into .cache/look, clicks nothing
ONLY=landing,exchange,incorporate,desk,verify npm run capture
COMPANY_ID=<token id> ONLY=company npm run capture
ONLY=scan npm run capture                       # nearblocks pages of every hash in docs/evidence
ONLY=rob ALLOW_WRITES=1 npm run capture         # sends one real /rob attempt; run once
node scripts/addclip.mjs desk ~/Desktop/desk-pledge.mov localhost:3010/desk   # owner recordings
npm run encode

# preview and render
npm run studio
npm run stills -- 150 600 1200                  # half-scale check stills of film frames
npm run draft                                   # half-scale check render
npm run render && npm run finish                # out/incorpr-demo-raw.mp4 -> out/incorpr-demo.mp4 at -14 LUFS
npm run poster && npm run banner                # out/incorpr-thumbnail.png, out/incorpr-x-header.png
```

`capture.mjs` refuses to run without `ONLY`, and clips that send a transaction (`rob`) also need `ALLOW_WRITES=1`, so a re-run never repeats a write by accident. `script.json` holds every spoken line; `say` is how the voice reads it ("near", "U S D C", "T E E", "N F T"), and `pronounce` maps the spoken words back to the written ones for captions. `public/footage`, `public/audio` and `out` are git-ignored; `src/footage.json` lists what the local footage folder holds.

## License note

Remotion is free for individuals and for companies of up to 3 people; larger companies need a company license (https://www.remotion.dev/license). This project is within the free tier.

## Prior work and credits

Incorpr is a NEAR Hackathon entry. Only tooling is reused, from the author's earlier project **Animr** (a Remotion demo film for Chogathon 2026); no scenes, copy, footage, data or audio from that film are used. Files adapted from `Animr/video`:

- `scripts/cdp.mjs`: Chrome DevTools harness; Chrome path now from `CHROME_PATH`.
- `scripts/capture.mjs`: cursor overlay, glide, press, typing, eased scroll, screencast and the `ONLY` guard kept; Incorpr routes, `ALLOW_WRITES` guard and evidence explorer clips are new.
- `scripts/encode.mjs`, `scripts/finish.mjs`, `scripts/vofx.mjs`, `scripts/vocheck.mjs`, `scripts/stills.mjs`, `scripts/look.mjs`: path and name changes.
- `scripts/voiceover.mjs`, `scripts/music.mjs`, `scripts/sfx.mjs`: new performance overrides, music prompt and effect list.
- `scripts/timing.mjs`: new 2:10 budget, estimated timings without VO, `pronounce` caption mapping, audio and effect inventory.
- `scripts/env.mjs`: rewritten to read only this project's `video/.env` (with `scripts/dotenv.mjs`).
- `src/timing.ts`, `src/ui/motion.ts`, `src/ui/Count.tsx`, `src/ui/Grain.tsx`: as is or with small additions.
- `src/ui/Captions.tsx`, `src/ui/Words.tsx`, `src/ui/Footage.tsx`, `src/ui/Chrome.tsx`, `src/scenes/common.tsx`, `src/Film.tsx`, `src/Root.tsx`, `src/Poster.tsx`, `src/Banner.tsx`: structure kept, restyled and rewritten for Incorpr.
- `package.json`, `tsconfig.json`, `remotion.config.ts`: same toolchain (Remotion 4.0.530).

New for Incorpr: `scripts/dotenv.mjs`, `scripts/sync.mjs`, `scripts/addclip.mjs`, `src/evidence.ts`, `src/theme.ts`, `src/ui/Charter.tsx` and the seven scenes in `src/scenes/`.
