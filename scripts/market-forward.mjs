#!/usr/bin/env node
// Books Agent Market earnings into a company's vault on NEAR.
//
//   node scripts/market-forward.mjs --network mainnet --amount 4.50 --dry-run
//   node scripts/market-forward.mjs --network mainnet --amount 4.50 --confirm-mainnet [--from <account>] [--token 1]
//
// Agent Market (market.near.ai) pays a hire into the owner's marketplace balance, not into the vault.
// After the owner withdraws that USDC to a NEAR account, this sends it to the vault with
// usdc.ft_transfer_call and the vault's payment message {"call_id": ...}, the same path a paying
// customer uses (scripts/demo.mjs step pay, /api/run-service). company-vault ft_on_transfer is the
// only path that books revenue; a plain ft_transfer would not be booked.
//
// How the vault books it (contracts/company-vault/src/lib.rs, ft_on_transfer):
//   - sender == the vault's current shareholder: related_party_revenue += amount
//   - any other sender:                          gross_revenue += amount, and revenue_30d
//   - either way compute_reserve and retained_earnings grow, and a payment record is stored
//   - amount < price_micro_usdc, or a reused call_id: the vault returns the full amount, books nothing
// The money is the owner's own withdrawal, so by default --from is the shareholder and it is booked as
// related-party funds. Sending from another account would book it as third-party gross revenue, so that
// needs --allow-non-shareholder and is labelled in the evidence.
//
// The payment stays unserved (no record_service_call): it is not a per-call API payment, and
// api_calls_served does not change. The call_id commits to a text naming Agent Market; the salt and
// text are written to docs/evidence/agent-market-forward-<timestamp>.json so anyone can recompute it.
// The transaction is recorded in docs/evidence/<network>.json like every other script transaction.

import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, formatUsdc, heading, item, log, parseCli, parseUsdc, requireNetwork, runMain, tgas } from './lib/cli.mjs';
import { DOCS_DIR } from './lib/evidence.mjs';
import { networkContext } from './lib/network.mjs';

const ONE_YOCTO = 1n;
const MEMO = 'Agent Market payout forward (market.near.ai)';

const args = parseCli({
  network: { type: 'string' },
  amount: { type: 'string' },
  from: { type: 'string' },
  token: { type: 'string', default: '1' },
  note: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'confirm-mainnet': { type: 'boolean', default: false },
  'allow-non-shareholder': { type: 'boolean', default: false },
  deployer: { type: 'string' },
  registry: { type: 'string' },
  rpc: { type: 'string' },
  'credentials-dir': { type: 'string' },
  help: { type: 'boolean', default: false },
});

const HELP = `Usage: node scripts/market-forward.mjs --network <mainnet|testnet|sandbox> --amount <usdc> [options]

  --amount <usdc>            USDC to forward, for example 4.50 (at least the company's price per call)
  --from <account>           payer; default the vault's shareholder (booked as related-party funds)
  --token <id>               company token id, default 1
  --note <text>              added to the committed text, for example the marketplace withdrawal reference
  --dry-run                  read state and print the plan; send nothing and read no key file
  --confirm-mainnet          required to send on mainnet
  --allow-non-shareholder    allow a payer other than the shareholder (booked as gross_revenue)
  --deployer, --registry, --rpc, --credentials-dir   as in scripts/demo.mjs
`;

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

runMain(async () => {
  if (args.help) {
    log(HELP);
    return 0;
  }
  const network = requireNetwork(args.network);
  if (!args.amount) throw new CliError('--amount <usdc> is required', 2);
  const amount = parseUsdc(args.amount);
  if (amount <= 0n) throw new CliError('--amount must be positive', 2);
  if (network === 'mainnet' && !args['dry-run'] && !args['confirm-mainnet']) {
    throw new CliError('this sends a mainnet transaction; add --confirm-mainnet, or --dry-run to only print the plan', 2);
  }
  if (!/^\d{1,20}$/.test(args.token)) throw new CliError('--token must be a numeric token id', 2);

  const ctx = await networkContext({
    network,
    deployer: args.deployer,
    registry: args.registry,
    rpc: args.rpc,
    credentialsDir: args['credentials-dir'],
  });
  const { near } = ctx;

  const company = await near.view(ctx.registry, 'get_company', { token_id: args.token });
  if (!company) throw new CliError(`token ${args.token} does not exist on ${ctx.registry}`);
  const vault = company.vault;
  const before = await near.view(vault, 'get_state');
  const usdc = before.usdc_token;
  if (ctx.usdc && usdc !== ctx.usdc) throw new CliError(`${vault} books ${usdc}, but this network's USDC is ${ctx.usdc}`);
  const price = BigInt(before.price_micro_usdc);
  const shareholder = before.shareholder;
  const from = args.from ?? shareholder;
  const relatedParty = from === shareholder;

  heading(`Forward Agent Market earnings into ${company.name}`);
  item('network', network);
  item('vault', vault);
  item('USDC token', usdc);
  item('shareholder', shareholder);
  item('payer', from);
  item('amount', formatUsdc(amount));
  item('price per call', formatUsdc(price));
  item('booked as', relatedParty ? 'related_party_revenue (payer is the shareholder)' : 'gross_revenue (payer is not the shareholder)');

  if (amount < price) throw new CliError(`the vault returns payments under its price of ${formatUsdc(price)}; forward at least that`);
  if (!relatedParty && !args['allow-non-shareholder']) {
    throw new CliError(
      `${from} is not the shareholder (${shareholder}). The vault would book this as third-party gross_revenue although it is the owner's own withdrawal. ` +
        'Send from the shareholder account, or add --allow-non-shareholder if this account is not the owner\'s.',
      2,
    );
  }
  const balance = BigInt((await near.view(usdc, 'ft_balance_of', { account_id: from })) ?? '0');
  item('payer USDC balance', formatUsdc(balance));
  if (balance < amount) {
    const shortfall = `${from} holds ${formatUsdc(balance)}; withdraw the marketplace balance to it first`;
    if (!args['dry-run']) throw new CliError(shortfall);
    item('warning', shortfall);
  }

  const at = new Date().toISOString();
  const input = [
    `Agent Market payout forwarded to ${vault}`,
    `${formatUsdc(amount)} from ${from} at ${at}`,
    'Source: owner withdrawal of market.near.ai earnings',
    args.note ? `Note: ${args.note.slice(0, 300)}` : null,
  ]
    .filter(Boolean)
    .join('. ');
  const salt = randomBytes(16).toString('hex');
  const callId = sha256Hex(`${salt}:${input}`);
  const msg = JSON.stringify({ call_id: callId });
  item('committed text', input);
  item('salt', salt);
  item('call_id', `${callId} = sha256("<salt>:<text>")`);
  item('msg', msg);
  item('memo', MEMO);

  if (args['dry-run']) {
    log('\n   dry run: nothing sent');
    return 0;
  }

  if (!(await near.controls(from))) {
    throw new CliError(`no full-access key file for ${from} in ${near.credentialsDir}; sign with that account's key file`);
  }

  heading('Send');
  const result = await near.call(from, usdc, 'ft_transfer_call', { receiver_id: vault, amount: amount.toString(), memo: MEMO, msg }, {
    gas: tgas(150),
    deposit: ONE_YOCTO,
    step: 'agent-market',
    purpose: `forward ${formatUsdc(amount)} of Agent Market earnings into ${vault} (${relatedParty ? 'related-party funds' : 'booked as gross revenue'})`,
  });

  const payment = await near.view(vault, 'get_payment', { call_id: callId });
  const after = await near.view(vault, 'get_state');
  const record = join(DOCS_DIR, 'evidence', `agent-market-forward-${Date.now()}.json`);
  writeFileSync(
    record,
    `${JSON.stringify(
      {
        network,
        vault,
        token_id: args.token,
        payer: from,
        shareholder,
        booked_as: relatedParty ? 'related_party_revenue' : 'gross_revenue',
        amount_micro_usdc: amount.toString(),
        call_id: callId,
        salt,
        committed_text: input,
        memo: MEMO,
        tx_hash: result.hash,
        explorer_url: result.explorerUrl,
        payment,
        before: { gross_revenue: before.gross_revenue, related_party_revenue: before.related_party_revenue, retained_earnings: before.retained_earnings },
        after: { gross_revenue: after.gross_revenue, related_party_revenue: after.related_party_revenue, retained_earnings: after.retained_earnings },
      },
      null,
      2,
    )}\n`,
  );

  heading('Result');
  if (!payment) throw new CliError(`the vault booked no payment for ${callId}; it returned the USDC. Details in ${record}`);
  item('booked', `${formatUsdc(BigInt(payment.amount))} from ${payment.payer}`);
  item('related_party_revenue', `${formatUsdc(BigInt(before.related_party_revenue))} -> ${formatUsdc(BigInt(after.related_party_revenue))}`);
  item('gross_revenue', `${formatUsdc(BigInt(before.gross_revenue))} -> ${formatUsdc(BigInt(after.gross_revenue))}`);
  item('retained_earnings', `${formatUsdc(BigInt(before.retained_earnings))} -> ${formatUsdc(BigInt(after.retained_earnings))}`);
  item('record', record);
  return 0;
});
