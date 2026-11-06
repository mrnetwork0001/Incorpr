#!/usr/bin/env node
// Pays a company for one call with a token other than USDC, through NEAR Intents 1Click.
//
//   node scripts/pay-in-any-token.mjs --network mainnet --confirm-mainnet [--amount-near 0.5] [--token 1]
//
// Two steps, both on mainnet:
//   1. The deployer wraps NEAR to wNEAR and deposits it to a 1Click deposit address. 1Click swaps it
//      through intents.near and delivers USDC to the customer account (demo-customer.<registry>).
//   2. The customer pays the company's per-call price with ft_transfer_call. The vault books revenue
//      only in ft_on_transfer, so a 1Click delivery straight to the vault (plain ft_transfer) would not
//      count; this is why the payment is a second transaction.
// Every NEAR transaction is recorded in docs/evidence/mainnet.json. The 1Click status, including the
// settlement transaction hashes it reports, is printed and kept in docs/evidence/pay-in-<timestamp>.json.

import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, formatNear, formatUsdc, heading, item, log, MILLI_NEAR, parseCli, parseNear, requireNetwork, runMain, sleep, tgas } from './lib/cli.mjs';
import { DOCS_DIR } from './lib/evidence.mjs';
import { actions } from './lib/near.mjs';
import { networkContext } from './lib/network.mjs';

const ONE_CLICK = 'https://1click.chaindefuser.com/v0';
const WRAP = 'wrap.near';
const WNEAR_ASSET = 'nep141:wrap.near';
const FT_STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, the NEP-145 minimum on wrap.near and USDC
const ONE_YOCTO = 1n;

const args = parseCli({
  network: { type: 'string' },
  'confirm-mainnet': { type: 'boolean' },
  'amount-near': { type: 'string' },
  token: { type: 'string' },
  customer: { type: 'string' },
});

async function oneClick(path, init) {
  const res = await fetch(`${ONE_CLICK}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new CliError(`1Click ${path} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

async function ensureFtStorage(ctx, token, accountId, payer, step) {
  const balance = await ctx.near.view(token, 'storage_balance_of', { account_id: accountId });
  if (balance) return;
  await ctx.near.call(payer, token, 'storage_deposit', { account_id: accountId, registration_only: true }, {
    gas: tgas(15),
    deposit: FT_STORAGE,
    step,
    purpose: `register ${accountId} on ${token}`,
  });
}

runMain(async () => {
  const network = requireNetwork(args.network);
  if (network !== 'mainnet') throw new CliError('1Click runs on mainnet only; use --network mainnet', 2);
  if (!args['confirm-mainnet']) throw new CliError('this sends mainnet transactions; add --confirm-mainnet', 2);

  const ctx = await networkContext({ network });
  const amount = parseNear(args['amount-near'] ?? '0.5');
  if (amount < 100n * MILLI_NEAR) throw new CliError('--amount-near must be at least 0.1', 2);
  const tokenId = args.token ?? '1';
  const customer = args.customer ?? `demo-customer.${ctx.registry}`;
  const payer = ctx.deployer;

  const company = await ctx.near.view(ctx.registry, 'get_company', { token_id: tokenId });
  if (!company) throw new CliError(`token ${tokenId} does not exist on ${ctx.registry}`);
  const price = BigInt(company.price_micro_usdc);

  heading(`Pay ${company.name} in wNEAR through 1Click`);
  item('payer', payer);
  item('customer', customer);
  item('vault', company.vault);
  item('wrap', formatNear(amount));
  item('price per call', formatUsdc(price));

  heading('Step 1: wrap NEAR and send it to 1Click');
  await ensureFtStorage(ctx, WRAP, payer, payer, 'pay-in');
  await ctx.near.call(payer, WRAP, 'near_deposit', {}, { gas: tgas(15), deposit: amount, step: 'pay-in', purpose: `wrap ${formatNear(amount)} for a 1Click swap` });

  const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
  const quoted = await oneClick('/quote', {
    method: 'POST',
    body: JSON.stringify({
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: WNEAR_ASSET,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: `nep141:${ctx.usdc}`,
      amount: amount.toString(),
      refundTo: payer,
      refundType: 'ORIGIN_CHAIN',
      recipient: customer,
      recipientType: 'DESTINATION_CHAIN',
      deadline,
    }),
  });
  const quote = quoted.quote ?? {};
  if (!quote.depositAddress) throw new CliError(`1Click returned no deposit address: ${JSON.stringify(quoted).slice(0, 300)}`);
  item('deposit address', quote.depositAddress);
  item('quoted out', `${formatUsdc(BigInt(quote.amountOut))} (min ${formatUsdc(BigInt(quote.minAmountOut))})`);

  const usdcBefore = BigInt((await ctx.near.view(ctx.usdc, 'ft_balance_of', { account_id: customer })) ?? '0');
  await ensureFtStorage(ctx, WRAP, quote.depositAddress, payer, 'pay-in');
  const deposit = await ctx.near.call(payer, WRAP, 'ft_transfer', { receiver_id: quote.depositAddress, amount: amount.toString(), memo: 'incorpr pay-in' }, {
    gas: tgas(15),
    deposit: ONE_YOCTO,
    step: 'pay-in',
    purpose: `deposit ${formatNear(amount)} wNEAR to 1Click for USDC delivered to ${customer}`,
  });
  await oneClick('/deposit/submit', { method: 'POST', body: JSON.stringify({ txHash: deposit.hash, depositAddress: quote.depositAddress }) }).catch((e) => log(`   deposit/submit: ${e.message}`));

  heading('Waiting for 1Click settlement');
  let status;
  const until = Date.now() + 10 * 60_000;
  for (;;) {
    status = await oneClick(`/status?depositAddress=${encodeURIComponent(quote.depositAddress)}`);
    log(`   ${new Date().toISOString()}  ${status.status}`);
    if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(status.status)) break;
    if (Date.now() > until) throw new CliError(`1Click still ${status.status} after 10 minutes; check ${ONE_CLICK}/status?depositAddress=${quote.depositAddress}`);
    await sleep(5000);
  }
  const record = join(DOCS_DIR, 'evidence', `pay-in-${Date.now()}.json`);
  writeFileSync(record, `${JSON.stringify({ quote: quoted, deposit_tx: deposit.hash, status }, null, 2)}\n`);
  item('1Click record', record);
  if (status.status !== 'SUCCESS') throw new CliError(`1Click ended ${status.status}; nothing was delivered. Details in ${record}`);
  const details = status.swapDetails ?? {};
  if (details.nearTxHashes?.length) item('settlement txs', details.nearTxHashes.join(', '));

  const usdcAfter = BigInt((await ctx.near.view(ctx.usdc, 'ft_balance_of', { account_id: customer })) ?? '0');
  item('customer USDC', `${formatUsdc(usdcBefore)} -> ${formatUsdc(usdcAfter)}`);
  if (usdcAfter - usdcBefore < price) throw new CliError('the swap delivered less USDC than one call costs');

  heading('Step 2: the customer pays one call with the swapped USDC');
  const input = `Audit this contract: ${company.name} pay-in test`;
  const salt = randomBytes(16).toString('hex');
  const callId = createHash('sha256').update(`${salt}:${input}`).digest('hex');
  await ctx.near.call(customer, ctx.usdc, 'ft_transfer_call', { receiver_id: company.vault, amount: price.toString(), msg: JSON.stringify({ call_id: callId }) }, {
    gas: tgas(150),
    deposit: ONE_YOCTO,
    step: 'pay-in',
    purpose: `pay ${formatUsdc(price)} for one call to ${company.name} with USDC swapped from wNEAR through 1Click`,
  });
  const payment = await ctx.near.view(company.vault, 'get_payment', { call_id: callId });
  if (!payment) throw new CliError(`the vault booked no payment for ${callId}`);
  item('booked', `${formatUsdc(BigInt(payment.amount))} from ${payment.payer}, call ${callId}`);
});
