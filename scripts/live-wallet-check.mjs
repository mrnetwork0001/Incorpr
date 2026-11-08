#!/usr/bin/env node
// Runs the two wallet flows of the hosted app against its own API, signing as a wallet would with a
// mainnet key file from ~/.near-credentials/mainnet:
//
//   owner   the holder of the token signs the app's NEP-413 sign-in challenge; the app must set a
//           session cookie, open /company/<id>/owner and issue a holder credential.
//   pay     a customer pays one call (usdc.ft_transfer_call to the vault with {"call_id"}), then
//           POSTs the input and salt to /api/run-service; the app must run NEAR AI Cloud inference,
//           verify the TEE signature and book the call with record_service_call.
//
//   node scripts/live-wallet-check.mjs --url https://tryincorpr.vercel.app --confirm-mainnet
//   node scripts/live-wallet-check.mjs --url ... --only owner            # signs only, no transaction
//
// The payment is a real mainnet transaction and is recorded in docs/evidence/mainnet.json.

import { createHash, randomBytes } from 'node:crypto';
import { CliError, formatUsdc, heading, item, log, parseCli, runMain, tgas } from './lib/cli.mjs';
import { networkContext } from './lib/network.mjs';

const args = parseCli({
  url: { type: 'string', default: 'https://tryincorpr.vercel.app' },
  token: { type: 'string', default: '1' },
  only: { type: 'string' },
  customer: { type: 'string' },
  'confirm-mainnet': { type: 'boolean' },
});

const BASE = args.url.replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const NEP413_TAG = 2 ** 31 + 413;

function borshString(s) {
  const bytes = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function nep413Hash({ message, nonce, recipient, callbackUrl }) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const callback = callbackUrl == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]);
  return createHash('sha256').update(Buffer.concat([tag, borshString(message), nonce, borshString(recipient), callback])).digest();
}

async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = { origin: ORIGIN };
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.() ?? [] };
}

function expect(ok, label, detail) {
  if (!ok) throw new CliError(`${label}: ${detail}`);
  item(label, 'ok');
}

async function ownerFlow(ctx, tokenId) {
  heading(`Owner room sign-in on ${BASE}`);
  const token = await ctx.near.view(ctx.registry, 'nft_token', { token_id: tokenId });
  const holder = token.owner_id;
  item('holder', holder);
  const keyPair = ctx.near.loadKeyPair(holder);

  const challenge = await api('/api/owner/challenge', { method: 'POST', body: { token_id: tokenId } });
  expect(challenge.status === 200, 'challenge issued', `HTTP ${challenge.status} ${challenge.text.slice(0, 200)}`);
  const { challenge_id, message, nonce, recipient } = challenge.json;
  expect(recipient === new URL(BASE).host, 'recipient is this host', recipient);

  const hash = nep413Hash({ message, nonce: Buffer.from(nonce, 'base64'), recipient, callbackUrl: null });
  const signature = Buffer.from(keyPair.sign(hash).signature).toString('base64');
  const session = await api('/api/owner/session', {
    method: 'POST',
    body: { challenge_id, account_id: holder, public_key: keyPair.getPublicKey().toString(), signature },
  });
  expect(session.status === 200, 'signature accepted, session set', `HTTP ${session.status} ${session.text.slice(0, 300)}`);
  const cookie = session.setCookie.map((c) => c.split(';')[0]).join('; ');
  expect(cookie.length > 0, 'session cookie returned', 'no Set-Cookie header');

  const room = await api(`/api/owner/room?token_id=${tokenId}`, { cookie });
  expect(room.status === 200, 'owner room data opens with the cookie', `HTTP ${room.status} ${room.text.slice(0, 200)}`);
  const page = await api(`/company/${tokenId}/owner`, { cookie });
  expect(page.status === 200 && page.text.includes(holder), 'owner room page shows the holder', `HTTP ${page.status}`);

  const credential = await api('/api/owner/credential', { method: 'POST', body: { token_id: tokenId }, cookie });
  expect(credential.status === 200 && /signature/.test(credential.text), 'holder credential issued', `HTTP ${credential.status} ${credential.text.slice(0, 200)}`);

  const stranger = await api(`/api/owner/room?token_id=${tokenId}`);
  expect(stranger.status === 401, 'room refuses a request without the cookie', `HTTP ${stranger.status}`);
}

async function payFlow(ctx, tokenId) {
  heading(`Paid call on ${BASE}`);
  if (!args['confirm-mainnet']) throw new CliError('the paid call sends a mainnet USDC payment; add --confirm-mainnet', 2);
  const company = await ctx.near.view(ctx.registry, 'get_company', { token_id: tokenId });
  const price = BigInt(company.price_micro_usdc);
  const customer = args.customer ?? `demo-customer.${ctx.registry}`;
  const before = await ctx.near.view(company.vault, 'get_state');
  item('company', `${company.name} (${company.vault}), ${formatUsdc(price)} per call`);
  item('customer', customer);

  const input = `pragma solidity ^0.8.20;\ncontract Vault {\n  mapping(address => uint256) public balance;\n  function deposit() external payable { balance[msg.sender] += msg.value; }\n  function withdraw(uint256 amount) external {\n    (bool ok, ) = msg.sender.call{value: amount}("");\n    require(ok);\n    balance[msg.sender] -= amount;\n  }\n}`;
  const salt = randomBytes(24).toString('hex');
  const callId = createHash('sha256').update(`${salt}:${input}`).digest('hex');
  const paid = await ctx.near.call(customer, ctx.usdc, 'ft_transfer_call', { receiver_id: company.vault, amount: price.toString(), msg: JSON.stringify({ call_id: callId }) }, {
    gas: tgas(100),
    deposit: 1n,
    step: 'live-pay',
    purpose: `pay ${formatUsdc(price)} for one call through the hosted app ${BASE}`,
  });
  item('payment tx', ctx.near.txUrl(paid.hash));

  const started = Date.now();
  const served = await api('/api/run-service', { method: 'POST', body: { token_id: tokenId, call_id: callId, salt, input } });
  log(`   /api/run-service answered HTTP ${served.status} after ${Math.round((Date.now() - started) / 1000)} s`);
  expect(served.status === 200, 'call served', served.text.slice(0, 400));
  const out = served.json;
  const text = JSON.stringify(out);
  const recordTx = text.match(/"(?:record|served|tx|txHash|record_tx)[A-Za-z_]*"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{43,44})"/)?.[1];
  item('answer', JSON.stringify(out.content ?? out.answer ?? out.output ?? '').slice(0, 160));
  item('record_service_call tx', recordTx ? ctx.near.txUrl(recordTx) : '(not found in the response)');
  const after = await ctx.near.view(company.vault, 'get_state');
  const servedBefore = Number(before.api_calls_served ?? 0);
  const servedAfter = Number(after.api_calls_served ?? 0);
  item('vault served calls', `${servedBefore} -> ${servedAfter}`);
  return { out, recordTx };
}

runMain(async () => {
  const ctx = await networkContext({ network: 'mainnet' });
  const only = args.only;
  if (!only || only === 'owner') await ownerFlow(ctx, args.token);
  if (!only || only === 'pay') await payFlow(ctx, args.token);
  log('\nAll checks passed.');
});
