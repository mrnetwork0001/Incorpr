> **Historical design draft, superseded.** The code as built follows `docs/ARCHITECTURE.md`, which wins wherever the two disagree; its section 7 lists each change and the defect it fixes.
> Notable differences: TEE approvals are checked on-chain with `ecrecover`, the agent acts through a vault-only `intents.near` key instead of per-quote deposit addresses, and treasury rebalance execution is not in this release.
> Code: `web/src/lib/` and `web/src/app/api/`. Start with `README.md`.

# 🌐 Incorpr — TEE Inference, Multichain MPC Derivation & NEAR Intents Recipes

This guide provides the exact TypeScript modules for `web/src/lib/` to connect **NEAR Chain Signatures (`v1.signer`)**, **NEAR AI Cloud TEE (`cloud-api.near.ai/v1`)**, and **NEAR Intents (`1click.chaindefuser.com`)**.

---

## 1. Deterministic Multichain Address Derivation (`web/src/lib/mpcAddresses.ts`)

Every Company NFT sub-account (`c-1.incorpr.near`) deterministically controls native **Bitcoin (`bc1q...`)**, **Ethereum/Base/Arbitrum (`0x...`)**, and **Solana (`Base58`)** addresses via `v1.signer` (`chainsig.js` / `@near-js`):

```bash
npm install chainsig.js viem @solana/web3.js openai near-api-js @near-wallet-selector/core
```

```typescript
// web/src/lib/mpcAddresses.ts
// Derives deterministic BTC, EVM (ETH/Base/Arb), and Solana addresses for any Company NFT subaccount
import { contracts, chainAdapters } from 'chainsig.js';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const NETWORK_ID = (process.env.NEXT_PUBLIC_NEAR_NETWORK || 'testnet') as 'mainnet' | 'testnet';
const MPC_CONTRACT_ID =
  NETWORK_ID === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet';

export interface CompanyMultichainVaults {
  nearSubaccount: string;    // e.g. "c-1.incorpr.testnet"
  evmAddress: string;        // 0x... (same address across Ethereum, Base, Arbitrum)
  bitcoinAddress: string;    // bc1q... / tb1q...
  solanaAddress: string;     // Base58 Ed25519 address
  derivationPath: string;    // "incorpr-1-treasury"
}

export async function deriveCompanyMultichainAddresses(
  tokenId: string,
  registryAccount: string
): Promise<CompanyMultichainVaults> {
  const nearSubaccount = `c-${tokenId}.${registryAccount}`;
  const derivationPath = `incorpr-${tokenId}-treasury`;

  const mpcContract = new contracts.ChainSignatureContract({
    networkId: NETWORK_ID,
    contractId: MPC_CONTRACT_ID,
  });

  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  const evmAdapter = new chainAdapters.evm.EVM({
    publicClient,
    contract: mpcContract,
  });

  const btcNetwork = NETWORK_ID === 'mainnet' ? 'mainnet' : 'testnet';
  const btcAdapter = new chainAdapters.btc.BTC({
    network: btcNetwork,
    btcRpcAdapter: new chainAdapters.btc.Mempool(
      btcNetwork === 'mainnet'
        ? 'https://mempool.space/api'
        : 'https://mempool.space/testnet4/api'
    ),
    contract: mpcContract,
  });

  const [{ address: evmAddress }, { address: bitcoinAddress }] = await Promise.all([
    evmAdapter.deriveAddressAndPublicKey(nearSubaccount, derivationPath),
    btcAdapter.deriveAddressAndPublicKey(nearSubaccount, derivationPath),
  ]);

  // Solana Ed25519 derivation (domain_id = 1 on v1.signer)
  let solanaAddress = '';
  if ((chainAdapters as any).solana) {
    const solAdapter = new (chainAdapters as any).solana.Solana({ contract: mpcContract });
    const solDerived = await solAdapter.deriveAddressAndPublicKey(nearSubaccount, derivationPath);
    solanaAddress = solDerived.address;
  }

  return {
    nearSubaccount,
    evmAddress,
    bitcoinAddress,
    solanaAddress,
    derivationPath,
  };
}
```

---

## 2. NEAR AI Cloud TEE Worker + Hardware Signature Verifier (`web/src/lib/nearAiTee.ts`)

Runs each Company NFT's paid AI skill AND its autonomous Treasury Rebalance advisor inside **NEAR AI Cloud (`https://cloud-api.near.ai/v1`)**, then fetches the cryptographic **ECDSA TEE signature** (`GET /v1/signature/{chatId}`) so any user or judge can verify the output came from genuine Intel TDX + NVIDIA Confidential GPU silicon!

```typescript
// web/src/lib/nearAiTee.ts
import OpenAI from 'openai';
import { verifyMessage } from 'viem';

const NEAR_AI_BASE_URL =
  process.env.NEAR_AI_CLOUD_URL || 'https://cloud-api.near.ai/v1';

export const nearAiClient = new OpenAI({
  baseURL: NEAR_AI_BASE_URL,
  apiKey: process.env.NEAR_AI_API_KEY || '',
});

export interface VerifiedTeeResponse {
  content: string;
  chatId: string;
  model: string;
  signingAddress: string;
  signature: string;
  signedText: string;
  ecdsaVerified: boolean;
}

export async function runAttestedNearAiInference(params: {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}): Promise<VerifiedTeeResponse> {
  const model = params.model || 'deepseek-ai/DeepSeek-V3.1';

  // 1. Run confidential inference inside NEAR AI Cloud TEE
  const completion = await nearAiClient.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userPrompt },
    ],
  });

  const content = completion.choices[0]?.message?.content || '';
  const chatId = completion.id;

  // 2. Fetch cryptographic TEE signature bundle from NEAR AI Cloud
  const sigUrl = `${NEAR_AI_BASE_URL}/signature/${encodeURIComponent(
    chatId
  )}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;

  const sigRes = await fetch(sigUrl, {
    headers: {
      Authorization: `Bearer ${process.env.NEAR_AI_API_KEY}`,
    },
  });

  if (!sigRes.ok) {
    throw new Error(`Failed to retrieve NEAR AI TEE signature for ${chatId}`);
  }

  const sigData = await sigRes.json();
  // sigData contains: { text, signature, signing_address, signing_algo }
  const ecdsaVerified = await verifyMessage({
    address: sigData.signing_address as `0x${string}`,
    message: sigData.text,
    signature: sigData.signature as `0x${string}`,
  }).catch(() => false);

  return {
    content,
    chatId,
    model,
    signingAddress: sigData.signing_address,
    signature: sigData.signature,
    signedText: sigData.text,
    ecdsaVerified,
  };
}
```

---

## 3. NEAR Intents 1Click Client (`web/src/lib/nearIntents.ts`)

Powers **all 3 cross-chain money loops** in Incorpr without bridges:
1. **Customer API Payment:** Customer pays in `SOL`, `Base USDC`, `ETH`, or `NEAR` $\rightarrow$ settles as `USDC` into `c-<id>.incorpr.near`.
2. **Treasury Rebalancing:** `c-<id>.incorpr.near` swaps surplus `USDC` into native `BTC` (`bc1q...`) and `SOL` (`Ed25519`) inside its own MPC addresses.
3. **Credit & M&A Settlement:** Lender disburses `USDC` or Acquirer buys the entire `NEP-171` Company NFT from any chain.

```typescript
// web/src/lib/nearIntents.ts
const ONE_CLICK_API = 'https://1click.chaindefuser.com/v0';

export interface OneClickQuoteParams {
  originAsset: string;       // e.g. "nep141:wrap.near" or Base/Solana USDC asset ID from /v0/tokens
  destinationAsset: string;  // e.g. "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" (NEAR native USDC)
  amountSmallestUnit: string;
  recipientAddress: string;  // e.g. "c-1.incorpr.near" or derived BTC/SOL address
  refundAddress: string;
  recipientType?: 'DESTINATION_CHAIN' | 'INTENTS';
  dry?: boolean;
}

export async function fetchSupportedIntentTokens() {
  const res = await fetch(`${ONE_CLICK_API}/tokens`, { next: { revalidate: 300 } });
  if (!res.ok) throw new Error('Failed to load NEAR Intents supported tokens');
  return res.json();
}

export async function createNearIntentQuote(params: OneClickQuoteParams) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (process.env.NEAR_INTENTS_JWT) {
    headers['Authorization'] = `Bearer ${process.env.NEAR_INTENTS_JWT}`;
  }

  const deadline = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const res = await fetch(`${ONE_CLICK_API}/quote`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      dry: params.dry ?? false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100, // 1.00% in bps
      originAsset: params.originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: params.destinationAsset,
      amount: params.amountSmallestUnit,
      refundTo: params.refundAddress,
      refundType: 'ORIGIN_CHAIN',
      recipient: params.recipientAddress,
      recipientType: params.recipientType ?? 'DESTINATION_CHAIN',
      deadline,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`NEAR Intents 1Click quote error: ${errText}`);
  }

  // Returns { quote: { depositAddress, amountIn, amountOut, timeEstimate }, signature }
  return res.json();
}

export async function checkNearIntentStatus(depositAddress: string) {
  const res = await fetch(
    `${ONE_CLICK_API}/status?depositAddress=${encodeURIComponent(depositAddress)}`
  );
  if (!res.ok) throw new Error('Failed to check intent execution status');
  return res.json();
}
```

---

## 4. TEE L1 State-Freshness Oracle (`web/src/app/api/verify-l1/route.ts`)

Before `incorpr-registry` finalizes an M&A sale or unlocks loan collateral, this endpoint runs inside/with **NEAR AI Cloud** to inspect live **Mempool.space (BTC UTXOs + unconfirmed mempool spends)**, **Solana RPC**, and **Base/Ethereum RPC (`eth_getTransactionCount` pending vs. latest)**—returning a signed attestation proving **zero unconfirmed mempool drain transactions exist** on any derived L1 address!

```typescript
// web/src/lib/l1FreshnessCheck.ts
export async function checkMultichainMempoolCleanliness(params: {
  bitcoinAddress: string;
  evmAddress: string;
  evmRpcUrl?: string;
}) {
  // 1. Check Bitcoin mempool_stats for any unconfirmed outgoing tx (`funded_txo_sum` vs `spent_txo_sum`)
  const btcRes = await fetch(`https://mempool.space/api/address/${params.bitcoinAddress}`);
  const btcData = btcRes.ok ? await btcRes.json() : null;
  const btcPendingOutgoing = (btcData?.mempool_stats?.spent_txo_count || 0) > 0;

  // 2. Check EVM `latest` vs `pending` nonce parity (if pending > latest, an unconfirmed tx is in flight!)
  const rpc = params.evmRpcUrl || 'https://mainnet.base.org';
  const [latestNonceRes, pendingNonceRes] = await Promise.all([
    fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionCount',
        params: [params.evmAddress, 'latest'],
      }),
    }).then((r) => r.json()),
    fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_getTransactionCount',
        params: [params.evmAddress, 'pending'],
      }),
    }).then((r) => r.json()),
  ]);

  const evmPendingOutgoing = latestNonceRes?.result !== pendingNonceRes?.result;

  return {
    clean: !btcPendingOutgoing && !evmPendingOutgoing,
    btcPendingOutgoing,
    evmPendingOutgoing,
    checkedAtIso: new Date().toISOString(),
  };
}
```
