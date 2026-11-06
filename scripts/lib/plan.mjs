// What deploy.mjs creates: the companies and the registry's default policy. Caps and price floors
// are derived from live 1Click prices at deploy time, never from constants.

import { CliError } from './cli.mjs';
import { BTC_ASSET, MAINNET_USDC_ASSET, SOL_ASSET, usdcAsset } from './network.mjs';
import { pricesFor } from './oneclick.mjs';

/**
 * service_template is the system prompt the run-service route sends with every paid call. The
 * registry caps name and template at 64 bytes (MAX_TEXT_LEN). target_bps is BTC, SOL, USDC.
 */
export const COMPANIES = [
  {
    name: 'Ledgerline Audit',
    service_template: 'Audit this smart contract. List each bug, its severity, a fix.',
    price_micro_usdc: '50000',
    target_bps: [4000, 3000, 3000],
    founder_royalty_bps: 500,
    compute_reserve_bps: 2000,
    sample_input: 'pragma solidity ^0.8.0; contract Vault { mapping(address=>uint) b; function withdraw() external { (bool ok,) = msg.sender.call{value: b[msg.sender]}(""); require(ok); b[msg.sender] = 0; } }',
  },
  {
    name: 'Tessera Translate',
    service_template: 'Translate the text into English. Reply with the translation.',
    price_micro_usdc: '20000',
    target_bps: [2000, 2000, 6000],
    founder_royalty_bps: 500,
    compute_reserve_bps: 2000,
    sample_input: 'La empresa paga sus propias facturas de computación con los ingresos de cada llamada.',
  },
  {
    name: 'Brief Desk',
    service_template: 'Summarize the text in three bullet points of at most 20 words.',
    price_micro_usdc: '10000',
    target_bps: [3000, 1000, 6000],
    founder_royalty_bps: 500,
    compute_reserve_bps: 2000,
    sample_input:
      'Each company NFT owns a NEAR sub-account with no access keys. Customers pay it in USDC per call through ft_transfer_call. The vault splits each payment into a compute reserve and retained earnings, and the shareholder can claim retained earnings as dividends while the company is not listed or pledged.',
  },
];

for (const c of COMPANIES) {
  for (const field of ['name', 'service_template']) {
    const bytes = Buffer.byteLength(c[field]);
    if (bytes > 64) throw new Error(`plan.mjs: ${c.name} ${field} is ${bytes} bytes; the registry allows 64`);
  }
}

/**
 * allowed_tokens, epoch_caps and price_floors for the registry's default policy.
 * - Caps: `capUsd` worth of each token per 24 h window, at the live price.
 * - Floors: for every ordered pair, the live cross rate less `haircutBps`, as min_buy per one
 *   whole sell token. A floor is a lower bound the shareholder set, not an oracle (ARCHITECTURE.md 4).
 */
export async function derivePolicy(ctx, { capUsd, haircutBps }) {
  const local = usdcAsset(ctx);
  const marketId = (asset) => (asset === local ? MAINNET_USDC_ASSET : asset);
  const assets = [local, BTC_ASSET, SOL_ASSET];
  const prices = await pricesFor([MAINNET_USDC_ASSET, BTC_ASSET, SOL_ASSET]);
  const info = (asset) => prices.get(marketId(asset));

  // Integer maths in micro-USD to keep every amount exact.
  const microUsd = (asset) => BigInt(Math.round(info(asset).price * 1e6));
  const unit = (asset) => 10n ** BigInt(info(asset).decimals);

  const capMicroUsd = BigInt(Math.round(capUsd * 1e6));
  const epochCaps = assets.map((asset) => {
    const cap = (capMicroUsd * unit(asset)) / microUsd(asset);
    if (cap <= 0n) throw new CliError(`epoch cap for ${asset} rounds to zero`);
    return [asset, cap.toString()];
  });

  const keep = 10_000n - BigInt(haircutBps);
  const priceFloors = [];
  for (const sell of assets) {
    for (const buy of assets) {
      if (sell === buy) continue;
      const perSell = unit(sell);
      const minBuy = (microUsd(sell) * unit(buy) * keep) / (microUsd(buy) * 10_000n);
      if (minBuy <= 0n) throw new CliError(`price floor ${sell} -> ${buy} rounds to zero`);
      priceFloors.push({ sell_token: sell, buy_token: buy, min_buy: minBuy.toString(), per_sell: perSell.toString() });
    }
  }

  return {
    allowedTokens: assets,
    epochCaps,
    priceFloors,
    prices: Object.fromEntries([...prices].map(([id, p]) => [id, { usd: p.price, decimals: p.decimals, updated_at: p.priceUpdatedAt }])),
  };
}
