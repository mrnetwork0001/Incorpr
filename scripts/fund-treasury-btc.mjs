#!/usr/bin/env node
// Funds a company's Bitcoin treasury address with real BTC, swapped from NEAR through NEAR Intents 1Click.
//
//   node scripts/fund-treasury-btc.mjs --network mainnet --confirm-mainnet [--amount-near 2.3] [--token 1]
//
// The deployer wraps NEAR to wNEAR and deposits it to a 1Click deposit address; 1Click swaps it through
// intents.near and pays native BTC to the vault's current treasury address (read from the vault's
// treasury_addresses view, which the vault derived from v1.signer). Every NEAR transaction is recorded in
// docs/evidence/mainnet.json; the 1Click status, including the Bitcoin transaction it reports, is kept in
// docs/evidence/fund-btc-<timestamp>.json.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, formatNear, heading, item, log, MILLI_NEAR, parseCli, parseNear, requireNetwork, runMain, sleep, tgas } from './lib/cli.mjs';
import { DOCS_DIR } from './lib/evidence.mjs';
import { networkContext } from './lib/network.mjs';

const ONE_CLICK = 'https://1click.chaindefuser.com/v0';
const WRAP = 'wrap.near';
const BTC_ASSET = 'nep141:btc.omft.near';
const FT_STORAGE = 1_250_000_000_000_000_000_000n;

const args = parseCli({
  network: { type: 'string' },
  'confirm-mainnet': { type: 'boolean' },
  'amount-near': { type: 'string' },
  token: { type: 'string' },
});

async function oneClick(path, init) {
  const res = await fetch(`${ONE_CLICK}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new CliError(`1Click ${path} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

runMain(async () => {
  const network = requireNetwork(args.network);
  if (network !== 'mainnet') throw new CliError('1Click runs on mainnet only; use --network mainnet', 2);
  if (!args['confirm-mainnet']) throw new CliError('this sends mainnet transactions; add --confirm-mainnet', 2);
  const ctx = await networkContext({ network });
  const amount = parseNear(args['amount-near'] ?? '2.3');
  if (amount < 500n * MILLI_NEAR) throw new CliError('--amount-near must be at least 0.5', 2);
  const tokenId = args.token ?? '1';
  const company = await ctx.near.view(ctx.registry, 'get_company', { token_id: tokenId });
  if (!company) throw new CliError(`token ${tokenId} does not exist on ${ctx.registry}`);
  const addresses = await ctx.near.view(company.vault, 'treasury_addresses');
  if (!addresses?.btc) throw new CliError(`${company.vault} has no treasury addresses yet (refresh_treasury_keys)`);
  const payer = ctx.deployer;

  heading(`Fund ${company.name}'s Bitcoin treasury through 1Click`);
  item('vault', company.vault);
  item('treasury BTC address', `${addresses.btc} (epoch ${addresses.epoch})`);
  item('swap', `${formatNear(amount)} NEAR -> BTC`);

  const storage = await ctx.near.view(WRAP, 'storage_balance_of', { account_id: payer });
  if (!storage) {
    await ctx.near.call(payer, WRAP, 'storage_deposit', { account_id: payer, registration_only: true }, { gas: tgas(15), deposit: FT_STORAGE, step: 'fund-btc', purpose: `register ${payer} on ${WRAP}` });
  }
  await ctx.near.call(payer, WRAP, 'near_deposit', {}, { gas: tgas(15), deposit: amount, step: 'fund-btc', purpose: `wrap ${formatNear(amount)} for a 1Click swap to BTC` });

  const quoted = await oneClick('/quote', {
    method: 'POST',
    body: JSON.stringify({
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: `nep141:${WRAP}`,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: BTC_ASSET,
      amount: amount.toString(),
      refundTo: payer,
      refundType: 'ORIGIN_CHAIN',
      recipient: addresses.btc,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
  });
  const quote = quoted.quote ?? {};
  if (!quote.depositAddress) throw new CliError(`1Click returned no deposit address: ${JSON.stringify(quoted).slice(0, 300)}`);
  item('deposit address', quote.depositAddress);
  item('quoted out', `${quote.amountOut} sats (min ${quote.minAmountOut}), about ${quote.timeEstimate} s`);

  const depositStorage = await ctx.near.view(WRAP, 'storage_balance_of', { account_id: quote.depositAddress });
  if (!depositStorage) {
    await ctx.near.call(payer, WRAP, 'storage_deposit', { account_id: quote.depositAddress, registration_only: true }, { gas: tgas(15), deposit: FT_STORAGE, step: 'fund-btc', purpose: `register the 1Click deposit address on ${WRAP}` });
  }
  const deposit = await ctx.near.call(payer, WRAP, 'ft_transfer', { receiver_id: quote.depositAddress, amount: amount.toString(), memo: 'incorpr treasury btc' }, {
    gas: tgas(15),
    deposit: 1n,
    step: 'fund-btc',
    purpose: `deposit ${formatNear(amount)} wNEAR to 1Click for BTC paid to ${addresses.btc}`,
  });
  await oneClick('/deposit/submit', { method: 'POST', body: JSON.stringify({ txHash: deposit.hash, depositAddress: quote.depositAddress }) }).catch((e) => log(`   deposit/submit: ${e.message}`));

  heading('Waiting for 1Click settlement (Bitcoin can take several minutes)');
  let status;
  const until = Date.now() + 45 * 60_000;
  for (;;) {
    status = await oneClick(`/status?depositAddress=${encodeURIComponent(quote.depositAddress)}`);
    log(`   ${new Date().toISOString()}  ${status.status}`);
    if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(status.status)) break;
    if (Date.now() > until) throw new CliError(`1Click still ${status.status} after 45 minutes; check ${ONE_CLICK}/status?depositAddress=${quote.depositAddress}`);
    await sleep(15000);
  }
  const record = join(DOCS_DIR, 'evidence', `fund-btc-${Date.now()}.json`);
  writeFileSync(record, `${JSON.stringify({ quote: quoted, deposit_tx: deposit.hash, to: addresses.btc, status }, null, 2)}\n`);
  item('1Click record', record);
  if (status.status !== 'SUCCESS') throw new CliError(`1Click ended ${status.status}; details in ${record}`);
  const details = status.swapDetails ?? {};
  for (const [k, v] of Object.entries(details)) if (/hash|tx/i.test(k) && v && (Array.isArray(v) ? v.length : true)) item(k, JSON.stringify(v));
  log(`   Check the funds: https://mempool.space/address/${addresses.btc}`);
});
