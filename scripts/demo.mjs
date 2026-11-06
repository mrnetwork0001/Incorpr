#!/usr/bin/env node
// Runs the Incorpr company lifecycle against a deployed registry and records every transaction,
// including the ones the contracts are expected to refuse.
//
//   node scripts/demo.mjs --network sandbox --all --skip serve
//   node scripts/demo.mjs --network mainnet --confirm-mainnet --step pay --token 1
//
// Steps, in --all order:
//   actors       create demo-customer, demo-buyer and demo-lender accounts; fund NEAR and USDC
//   pay          customer pays one call: usdc.ft_transfer_call to the vault with {"call_id"}
//   serve        NEAR AI Cloud inference with TEE signature checks, then operator record_service_call
//   list         owner lists the company for --ask USDC
//   rug-listed   owner tries to claim, sign a raw payload, and transfer the NFT while listed (all refused)
//   buy          buyer acquires the company with usdc.ft_transfer_call {"action":"acquire"}
//   lend         lender prepays offer storage and funds a loan offer
//   borrow       owner accepts the offer; the vault freezes as Pledged and the principal is paid out
//   rug-pledged  owner tries to claim and transfer while pledged (refused)
//   repay        owner repays the debt; the vault returns to Free
//   rebalance    planned BTC/SOL trade for retained earnings, priced with real 1Click dry quotes (not executed)
//   dividends    owner claims retained earnings
//   btc-send     vault signs a P2WPKH spend from its bc1/tb1 address through the MPC signer (needs UTXOs)

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError, formatNear, formatUsdc, heading, item, log, MILLI_NEAR, ONE_NEAR, parseCli, parseNear, parseUsdc, requireNetwork, runMain, tgas } from './lib/cli.mjs';
import { REPO_ROOT } from './lib/deps.mjs';
import { loadAppEnv } from './lib/envfile.mjs';
import { actions } from './lib/near.mjs';
import { BTC_ASSET, MAINNET_USDC_ASSET, networkContext, SOL_ASSET, usdcAsset } from './lib/network.mjs';
import { dryQuote } from './lib/oneclick.mjs';
import { COMPANIES } from './lib/plan.mjs';

const STEPS = ['actors', 'pay', 'serve', 'list', 'rug-listed', 'buy', 'lend', 'borrow', 'rug-pledged', 'repay', 'rebalance', 'dividends', 'btc-send'];
const ONE_YOCTO = 1n;

const OPTIONS = {
  network: { type: 'string' },
  step: { type: 'string', multiple: true },
  all: { type: 'boolean', default: false },
  skip: { type: 'string' },
  'confirm-mainnet': { type: 'boolean', default: false },
  token: { type: 'string', default: '1' },
  deployer: { type: 'string' },
  registry: { type: 'string' },
  rpc: { type: 'string' },
  'credentials-dir': { type: 'string' },
  ask: { type: 'string', default: '1' },
  principal: { type: 'string', default: '1' },
  repay: { type: 'string', default: '1.01' },
  'term-ms': { type: 'string', default: '86400000' },
  'actor-near': { type: 'string' },
  'quote-usdc': { type: 'string' },
  execute: { type: 'boolean', default: false },
  'btc-to': { type: 'string' },
  'btc-sats': { type: 'string' },
  'btc-fee-rate': { type: 'string' },
  'no-broadcast': { type: 'boolean', default: false },
  'sign-deposit-yocto': { type: 'string', default: '1' },
  help: { type: 'boolean', default: false },
};

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const isFree = (state) => state === 'Free';
const encumbranceName = (state) => (typeof state === 'string' ? state : Object.keys(state)[0]);

class Demo {
  constructor(ctx, args) {
    this.ctx = ctx;
    this.near = ctx.near;
    this.args = args;
    this.token = args.token;
    this.registry = ctx.registry;
    const parent = ctx.demoParent;
    this.customer = `demo-customer.${parent}`;
    this.buyer = `demo-buyer.${parent}`;
    this.lender = `demo-lender.${parent}`;
    this.ask = parseUsdc(args.ask);
    this.principal = parseUsdc(args.principal);
    this.repayAmount = parseUsdc(args.repay);
    if (this.repayAmount < this.principal) throw new CliError('--repay must be at least --principal', 2);
    this.statePath = join(this.near.credentialsDir, `incorpr-demo-${this.registry}.json`);
    this.state = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, 'utf8')) : { payments: [] };
  }

  saveState() {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
  }

  view(contract, method, args) {
    return this.near.view(contract, method, args);
  }

  async company() {
    const company = await this.view(this.registry, 'get_company', { token_id: this.token });
    if (!company) throw new CliError(`token ${this.token} does not exist on ${this.registry}`);
    return company;
  }

  async vault() {
    const company = await this.company();
    return { company, vault: company.vault, state: await this.view(company.vault, 'get_state') };
  }

  usdcBalance(account) {
    return this.view(this.ctx.usdc, 'ft_balance_of', { account_id: account }).then(BigInt);
  }

  /** The current NFT owner, which must be an account this machine holds a key for. */
  async owner() {
    const { owner_id: owner } = await this.company();
    if (!this.near.hasCredentials(owner)) throw new CliError(`token ${this.token} is owned by ${owner}, and there is no key file for it in ${this.near.credentialsDir}`);
    return owner;
  }

  /**
   * Tops `account` up to `need`. Mainnet: ft_transfer from the deployer, which must hold the USDC.
   * Elsewhere: Test USDC's public mint.
   */
  async ensureUsdc(account, need, step) {
    const have = await this.usdcBalance(account);
    if (have >= need) return;
    const amount = need - have;
    const { ctx, near } = this;
    if (ctx.network !== 'mainnet') {
      await near.call(ctx.deployer, ctx.usdc, 'mint', { account_id: account, amount: amount.toString() }, {
        gas: tgas(10),
        step,
        purpose: `mint ${formatUsdc(amount)} Test USDC (no value) to ${account}`,
      });
      return;
    }
    if (account === ctx.deployer) throw new CliError(`${account} holds ${formatUsdc(have)} and needs ${formatUsdc(need)}; fund it with native USDC`);
    const deployerUsdc = await this.usdcBalance(ctx.deployer);
    if (deployerUsdc < amount) throw new CliError(`${ctx.deployer} holds ${formatUsdc(deployerUsdc)}; ${account} needs ${formatUsdc(amount)} more`);
    await near.call(ctx.deployer, ctx.usdc, 'ft_transfer', { receiver_id: account, amount: amount.toString(), memo: 'incorpr demo funding' }, {
      gas: tgas(30),
      deposit: ONE_YOCTO,
      step,
      purpose: `send ${formatUsdc(amount)} to ${account}`,
    });
  }

  ftTransferCall(signer, receiver, amount, msg, purpose, step) {
    return this.near.call(signer, this.ctx.usdc, 'ft_transfer_call', { receiver_id: receiver, amount: amount.toString(), msg: JSON.stringify(msg) }, {
      gas: tgas(300),
      deposit: ONE_YOCTO,
      step,
      purpose,
    });
  }

  // ------------------------------------------------------------------ steps

  async actors() {
    const { near, ctx } = this;
    const parent = ctx.demoParent;
    const perActor = this.args['actor-near'] ? parseNear(this.args['actor-near']) : ctx.network === 'mainnet' ? 150n * MILLI_NEAR : 5n * ONE_NEAR;
    const lenderExtra = 30n * MILLI_NEAR;
    const company = await this.company();
    const price = BigInt(company.price_micro_usdc);
    const usdcNeeds = {
      [this.customer]: price * 2n,
      [this.buyer]: this.ask + (this.repayAmount - this.principal),
      [this.lender]: this.principal,
    };

    const missing = [];
    for (const id of [this.customer, this.buyer, this.lender]) {
      if (await near.viewAccount(id)) {
        if (!(await near.controls(id))) throw new CliError(`${id} exists but this machine has no key for it`);
      } else missing.push(id);
    }
    const nearNeeded = missing.reduce((sum, id) => sum + perActor + (id === this.lender ? lenderExtra : 0n), 0n);

    // On mainnet the deployer is an implicit account and cannot have sub-accounts, so the demo
    // accounts live under the registry account. The deployer tops it up first, so creating them
    // never draws on the registry's 0.5 NEAR settlement reserve.
    if (missing.length && parent !== ctx.deployer) {
      await near.send({
        signerId: ctx.deployer,
        receiverId: parent,
        actions: [actions.transfer(nearNeeded + 10n * MILLI_NEAR)],
        label: { step: 'actors', purpose: `top up ${parent} to pay for demo account creation`, method: 'Transfer', deposit: nearNeeded + 10n * MILLI_NEAR },
      });
    }
    for (const id of missing) {
      const key = near.keyFileFor(id);
      const funding = perActor + (id === this.lender ? lenderExtra : 0n);
      await near.send({
        signerId: parent,
        receiverId: id,
        actions: [actions.createAccount(), actions.transfer(funding), actions.addFullAccessKey(key.getPublicKey())],
        label: { step: 'actors', purpose: `create demo account ${id} (demo account; its key file is on the deployer's machine)`, method: 'CreateAccount+Transfer+AddKey', deposit: funding },
      });
    }

    const bounds = await this.view(ctx.usdc, 'storage_balance_bounds');
    for (const id of [this.customer, this.buyer, this.lender]) {
      const registered = await this.view(ctx.usdc, 'storage_balance_of', { account_id: id });
      if (!registered) {
        await near.call(ctx.deployer, ctx.usdc, 'storage_deposit', { account_id: id, registration_only: true }, {
          gas: tgas(10),
          deposit: BigInt(bounds.min),
          step: 'actors',
          purpose: `register ${id} on USDC`,
        });
      }
      await this.ensureUsdc(id, usdcNeeds[id], 'actors');
    }
    ctx.evidence.setDeployment({ demo_accounts: { customer: this.customer, buyer: this.buyer, lender: this.lender } });
    for (const id of [this.customer, this.buyer, this.lender]) item(id, `${formatUsdc(await this.usdcBalance(id))}`);
    return 'done';
  }

  async pay() {
    const company = await this.company();
    const plan = COMPANIES.find((c) => c.name === company.name);
    const input = plan?.sample_input ?? `Describe what ${company.name} does in one sentence.`;
    const salt = randomBytes(16).toString('hex');
    const callId = sha256Hex(`${salt}:${input}`);
    const price = BigInt(company.price_micro_usdc);
    await this.ensureUsdc(this.customer, price, 'pay');
    const result = await this.ftTransferCall(this.customer, company.vault, price, { call_id: callId }, `pay ${formatUsdc(price)} for one call to ${company.name}`, 'pay');
    const payment = await this.view(company.vault, 'get_payment', { call_id: callId });
    if (!payment) throw new CliError(`the vault booked no payment for ${callId} (refunded). tx ${result.hash}`);
    this.state.payments.push({ registry: this.registry, token_id: this.token, call_id: callId, salt, input, paid_tx: result.hash, served: false });
    this.saveState();
    item('call_id', callId);
    item('payment', `${formatUsdc(payment.amount)} from ${payment.payer}, served=${payment.served}`);
    return 'done';
  }

  async serve() {
    const { attestedChat } = await import('./lib/tee.mjs');
    const company = await this.company();
    const pending = this.state.payments.find((p) => p.token_id === this.token && p.registry === this.registry && !p.served);
    if (!pending) return 'skipped: no unserved payment recorded by this machine; run --step pay';
    const model = process.env.NEAR_AI_DEFAULT_MODEL || (this.ctx.evidence.data.deployment.tee?.model ?? 'Qwen/Qwen3-VL-30B-A3B-Instruct');
    const chat = await attestedChat({ model, system: company.service_template, user: pending.input });
    item('chat id', chat.chatId);
    item('signing address', chat.signingAddress);
    for (const [k, v] of Object.entries(chat.checks)) item(k, String(v));
    this.ctx.evidence.addTeeCall({ token_id: this.token, call_id: pending.call_id, model, chat_id: chat.chatId, host: chat.baseUrl, signing_address: chat.signingAddress, signed_text: chat.signedText, checks: chat.checks });
    if (chat.failed.length) throw new CliError(`TEE checks failed: ${chat.failed.join(', ')}. The payment stays unserved.`);
    log(`   answer: ${String(chat.content ?? '').slice(0, 400).replaceAll('\n', ' ')}`);
    await this.near.call(this.ctx.operator, company.vault, 'record_service_call', { call_id: pending.call_id, tee_chat_id: chat.chatId }, {
      gas: tgas(40),
      step: 'serve',
      purpose: `operator marks call ${pending.call_id.slice(0, 12)} served by TEE chat ${chat.chatId}`,
    });
    const payment = await this.view(company.vault, 'get_payment', { call_id: pending.call_id });
    if (!payment?.served) throw new CliError('record_service_call landed but the payment is not marked served');
    pending.served = true;
    pending.tee_chat_id = chat.chatId;
    this.saveState();
    return 'done';
  }

  async list() {
    const { company, vault, state } = await this.vault();
    if (encumbranceName(state.encumbrance) === 'Listed') return 'skipped: already listed';
    if (!isFree(state.encumbrance)) throw new CliError(`company is ${encumbranceName(state.encumbrance)}; it must be Free to list`);
    if (state.raw_sigs_this_epoch > 0) {
      throw new CliError(`the vault signed ${state.raw_sigs_this_epoch} raw payload(s) this epoch, so listing would fail with ERR_RAW_SIGNATURES_THIS_EPOCH. Move funds and call rotate_treasury_epoch first.`);
    }
    const owner = await this.owner();
    await this.near.call(owner, this.registry, 'list_company', { token_id: this.token, ask: this.ask.toString() }, {
      gas: tgas(300),
      deposit: ONE_YOCTO,
      step: 'list',
      purpose: `list "${company.name}" for ${formatUsdc(this.ask)}`,
    });
    const listing = await this.view(this.registry, 'get_listing', { token_id: this.token });
    const after = await this.view(vault, 'get_state');
    if (!listing || encumbranceName(after.encumbrance) !== 'Listed') throw new CliError('list_company landed but the company is not Listed');
    item('listing', `seller ${listing.seller}, ask ${formatUsdc(listing.ask)}, sync_nonce ${listing.sync_nonce}`);
    return 'done';
  }

  /** Each attempt must fail with exactly `code`; any other result means the demo proves nothing. */
  async expectRejected(signer, receiver, method, args, { code, gas, deposit, step, purpose }) {
    const result = await this.near.call(signer, receiver, method, args, { gas, deposit, step, purpose, expectFailure: true });
    if (result.error !== code) throw new CliError(`${method} failed with ${result.error}, expected ${code}. tx ${result.hash}`);
    return result;
  }

  async rugAttempts(expected, step) {
    const { vault, state } = await this.vault();
    if (encumbranceName(state.encumbrance) !== expected) {
      return `skipped: company is ${encumbranceName(state.encumbrance)}, not ${expected}`;
    }
    const owner = state.shareholder;
    if (!this.near.hasCredentials(owner)) throw new CliError(`no key file for shareholder ${owner}`);
    await this.expectRejected(owner, vault, 'claim_dividends', { amount: '1' }, {
      code: 'ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN',
      gas: tgas(100),
      deposit: ONE_YOCTO,
      step,
      purpose: `shareholder tries to pay itself retained earnings while ${expected}`,
    });
    if (expected === 'Listed') {
      // Any 32-byte digest: the vault refuses before it reaches the signer.
      const digest = sha256Hex(`incorpr demo ${this.registry} token ${this.token}: raw signature request while listed`);
      await this.expectRejected(owner, vault, 'request_shareholder_signature', { domain_id: 0, payload_hex: digest, subpath: 'treasury' }, {
        code: 'ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN',
        gas: tgas(300),
        deposit: ONE_YOCTO,
        step,
        purpose: 'shareholder asks the MPC signer to sign a payload for the BTC treasury key while listed',
      });
    }
    await this.expectRejected(owner, this.registry, 'nft_transfer', { receiver_id: this.customer, token_id: this.token, approval_id: null, memo: null }, {
      code: 'ERR_TOKEN_ENCUMBERED',
      gas: tgas(100),
      deposit: ONE_YOCTO,
      step,
      purpose: `owner tries to move the company NFT to another account while ${expected}`,
    });
    return 'done';
  }

  async buy() {
    const listing = await this.view(this.registry, 'get_listing', { token_id: this.token });
    if (!listing) return `skipped: token ${this.token} is not listed (owner ${(await this.company()).owner_id}); run --step list`;
    // The first sale goes from the founder to demo-buyer. On a rerun the buyer is the seller, so
    // the founder buys it back: the same path with the roles swapped.
    const purchaser = listing.seller === this.buyer ? this.ctx.deployer : this.buyer;
    await this.ensureUsdc(purchaser, BigInt(listing.ask), 'buy');
    await this.ftTransferCall(
      purchaser,
      this.registry,
      BigInt(listing.ask),
      { action: 'acquire', token_id: this.token, expected_sync_nonce: listing.sync_nonce },
      `buy token ${this.token} for ${formatUsdc(listing.ask)} at sync_nonce ${listing.sync_nonce}`,
      'buy',
    );
    const { company, state } = await this.vault();
    if (company.owner_id !== purchaser || state.shareholder !== purchaser || !isFree(state.encumbrance)) {
      throw new CliError(`acquire did not settle for ${purchaser}: owner ${company.owner_id}, shareholder ${state.shareholder}, ${encumbranceName(state.encumbrance)}`);
    }
    item('new owner', `${company.owner_id} (vault shareholder ${state.shareholder}, ${encumbranceName(state.encumbrance)})`);
    return 'done';
  }

  async lend() {
    const offers = await this.view(this.registry, 'get_offers', { token_id: this.token });
    const mine = offers.find((o) => o.lender === this.lender && !o.settling);
    if (mine) return `skipped: offer ${mine.id} from ${this.lender} is open`;
    if (await this.view(this.registry, 'get_loan', { token_id: this.token })) return 'skipped: token already has a loan';

    const perOffer = BigInt(await this.view(this.registry, 'offer_storage_cost'));
    const storage = await this.view(this.registry, 'storage_balance_of', { account_id: this.lender });
    if (!storage || BigInt(storage.available) < perOffer) {
      const bounds = await this.view(this.registry, 'storage_balance_bounds');
      const deposit = perOffer + (storage ? 0n : BigInt(bounds.min));
      await this.near.call(this.lender, this.registry, 'storage_deposit', { account_id: null, registration_only: null }, {
        gas: tgas(30),
        deposit,
        step: 'lend',
        purpose: 'lender prepays registry storage for one loan offer',
      });
    }
    await this.ftTransferCall(
      this.lender,
      this.registry,
      this.principal,
      { action: 'fund_offer', token_id: this.token, repay_amount: this.repayAmount.toString(), term_ms: Number(this.args['term-ms']) },
      `offer ${formatUsdc(this.principal)} against token ${this.token}, repay ${formatUsdc(this.repayAmount)}`,
      'lend',
    );
    const offer = (await this.view(this.registry, 'get_offers', { token_id: this.token })).find((o) => o.lender === this.lender && !o.settling);
    if (!offer) throw new CliError('fund_offer landed but no offer is open (principal refunded)');
    item('offer', `id ${offer.id}, principal ${formatUsdc(offer.principal)}, repay ${formatUsdc(offer.repay_amount)}, term ${offer.term_ms} ms`);
    return 'done';
  }

  async borrow() {
    if (await this.view(this.registry, 'get_loan', { token_id: this.token })) return 'skipped: loan already active';
    const offer = (await this.view(this.registry, 'get_offers', { token_id: this.token })).find((o) => o.lender === this.lender && !o.settling);
    if (!offer) throw new CliError('no open offer from the demo lender; run --step lend');
    const { state: vaultState } = await this.vault();
    if (!isFree(vaultState.encumbrance) || vaultState.in_transit) {
      throw new CliError(`company is ${encumbranceName(vaultState.encumbrance)}; accept_offer needs Free (unlist it, or run --step buy first)`);
    }
    const owner = await this.owner();
    const before = await this.usdcBalance(owner);
    await this.near.call(owner, this.registry, 'accept_offer', { offer_id: offer.id }, {
      gas: tgas(300),
      deposit: ONE_YOCTO,
      step: 'borrow',
      purpose: `owner pledges token ${this.token} and borrows ${formatUsdc(offer.principal)}`,
    });
    const loan = await this.view(this.registry, 'get_loan', { token_id: this.token });
    const { state } = await this.vault();
    if (!loan || encumbranceName(state.encumbrance) !== 'Pledged') throw new CliError('accept_offer landed but there is no active loan');
    item('loan', `debt ${formatUsdc(loan.debt)} to ${loan.lender}, due ${new Date(loan.due_ms).toISOString()}`);
    item('borrower USDC', `${formatUsdc(before)} -> ${formatUsdc(await this.usdcBalance(owner))}`);
    return 'done';
  }

  async repay() {
    const loan = await this.view(this.registry, 'get_loan', { token_id: this.token });
    if (!loan) return 'skipped: no active loan';
    if (!this.near.hasCredentials(loan.borrower)) throw new CliError(`no key file for borrower ${loan.borrower}`);
    await this.ensureUsdc(loan.borrower, BigInt(loan.debt), 'repay');
    await this.ftTransferCall(loan.borrower, this.registry, BigInt(loan.debt), { action: 'repay', token_id: this.token }, `repay ${formatUsdc(loan.debt)} on token ${this.token}`, 'repay');
    const { state } = await this.vault();
    if (await this.view(this.registry, 'get_loan', { token_id: this.token })) throw new CliError('repay landed but the loan is still open');
    item('vault', encumbranceName(state.encumbrance));
    return 'done';
  }

  async rebalance() {
    if (this.args.execute) {
      throw new CliError(
        'rebalance execution is cut from this release and listed as future work: the script shows the planned trade and live 1Click dry quotes only.',
        2,
      );
    }
    const { company, vault, state } = await this.vault();
    const retained = BigInt(state.retained_earnings);
    const sizing = this.args['quote-usdc'] ? parseUsdc(this.args['quote-usdc']) : retained;
    item('retained earnings', formatUsdc(retained));
    item('held on intents.near', formatUsdc(state.deposited_to_intents));
    item('target BTC/SOL/USDC', company.target_bps.map((b) => `${b / 100}%`).join(' / '));
    if (sizing === 0n) return 'skipped: retained earnings are zero, so there is nothing to plan; pass --quote-usdc to price a size';
    const local = usdcAsset(this.ctx);
    const recipient = this.ctx.network === 'mainnet' ? vault : 'intents.near';
    for (const [index, asset] of [[0, BTC_ASSET], [1, SOL_ASSET]]) {
      const amount = (sizing * BigInt(company.target_bps[index])) / 10_000n;
      if (amount === 0n) continue;
      const floor = state.policy.price_floors.find((f) => f.sell_token === local && f.buy_token === asset);
      const floorMinBuy = floor ? (amount * BigInt(floor.min_buy) + BigInt(floor.per_sell) - 1n) / BigInt(floor.per_sell) : null;
      const entry = {
        token_id: this.token,
        vault,
        planned: `agent_deposit_to_intents ${amount} then agent_swap_intent ${local} -> ${asset}`,
        origin_asset: MAINNET_USDC_ASSET,
        destination_asset: asset,
        amount_in: amount.toString(),
        floor_min_buy: floorMinBuy?.toString() ?? null,
        note: this.ctx.network === 'mainnet' ? 'not executed' : `priced as mainnet USDC; ${local} is Test USDC. Not executed`,
      };
      try {
        const quote = await dryQuote({ originAsset: MAINNET_USDC_ASSET, destinationAsset: asset, amount, recipient });
        entry.amount_out = quote.quote.amountOut;
        entry.min_amount_out = quote.quote.minAmountOut ?? quote.quote.amountOut;
        entry.amount_out_usd = quote.quote.amountOutUsd;
        entry.passes_floor = floorMinBuy === null ? null : BigInt(entry.min_amount_out) >= floorMinBuy;
        entry.note += entry.passes_floor === false ? '; quote is below the vault price floor, the vault would refuse it' : '';
        item(`quote USDC -> ${asset}`, `${formatUsdc(amount)} -> ${entry.amount_out} (min ${entry.min_amount_out}, floor ${entry.floor_min_buy}, $${entry.amount_out_usd})`);
      } catch (error) {
        entry.error = `1Click: ${error.message}`;
        item(`quote USDC -> ${asset}`, `1Click refused: ${error.message}`);
      }
      this.ctx.evidence.addQuote(entry);
    }
    return 'done';
  }

  async dividends() {
    const { vault, state } = await this.vault();
    if (!isFree(state.encumbrance)) throw new CliError(`company is ${encumbranceName(state.encumbrance)}; dividends need Free`);
    const retained = BigInt(state.retained_earnings);
    if (retained === 0n) return 'skipped: retained earnings are zero';
    const owner = state.shareholder;
    if (!this.near.hasCredentials(owner)) throw new CliError(`no key file for shareholder ${owner}`);
    const before = await this.usdcBalance(owner);
    await this.near.call(owner, vault, 'claim_dividends', { amount: retained.toString() }, {
      gas: tgas(100),
      deposit: ONE_YOCTO,
      step: 'dividends',
      purpose: `shareholder claims ${formatUsdc(retained)} of retained earnings`,
    });
    const after = await this.view(vault, 'get_state');
    item('dividends paid', `${formatUsdc(state.dividends_paid)} -> ${formatUsdc(after.dividends_paid)}`);
    item('shareholder USDC', `${formatUsdc(before)} -> ${formatUsdc(await this.usdcBalance(owner))}`);
    return 'done';
  }

  async btcSend() {
    const btc = await import('./lib/btc.mjs');
    const { vault, state } = await this.vault();
    const addresses = await this.view(vault, 'treasury_addresses');
    if (!addresses) return 'skipped: the vault has no treasury addresses yet (refresh_treasury_keys)';
    const utxos = await btc.fetchUtxos(this.ctx.btcApi, addresses.btc);
    const confirmed = utxos.filter((u) => u.status?.confirmed);
    item('treasury BTC address', `${addresses.btc} (epoch ${addresses.epoch})`);
    item('confirmed UTXOs', `${confirmed.length} (${confirmed.reduce((s, u) => s + u.value, 0)} sats) via ${this.ctx.btcApi}`);
    if (confirmed.length === 0) return `skipped: ${addresses.btc} holds no confirmed UTXOs. Send BTC to it and rerun with --btc-to <address>`;
    const to = this.args['btc-to'];
    if (!to) return 'skipped: pass --btc-to <address> to spend these UTXOs';
    if (!isFree(state.encumbrance) || state.in_transit) throw new CliError(`company is ${encumbranceName(state.encumbrance)}; raw signing needs Free`);
    const owner = state.shareholder;
    if (!this.near.hasCredentials(owner)) throw new CliError(`no key file for shareholder ${owner}`);

    const pubkey = btc.compressedFromNearKey(addresses.secp256k1_key);
    const feeRate = this.args['btc-fee-rate'] ? BigInt(this.args['btc-fee-rate']) : await btc.recommendedFeeRate(this.ctx.btcApi);
    const spend = btc.buildSpend({
      utxos,
      from: addresses.btc,
      to,
      amountSats: this.args['btc-sats'] ? BigInt(this.args['btc-sats']) : null,
      feeRate,
      hrp: this.ctx.btcHrp,
      pubkey,
    });
    item('spend', `${spend.amount} sats to ${to}, change ${spend.change}, fee ${spend.fee} (${feeRate} sat/vB)`);
    log('   Each signature marks this epoch dirty: listing or pledging needs rotate_treasury_epoch afterwards.');

    const signatures = [];
    const nearTxs = [];
    for (const [index, sighash] of spend.sighashes.entries()) {
      const result = await this.near.call(owner, vault, 'request_shareholder_signature', { domain_id: 0, payload_hex: btc.bytesToHex(sighash), subpath: 'treasury' }, {
        gas: tgas(300),
        deposit: BigInt(this.args['sign-deposit-yocto']),
        step: 'btc-send',
        purpose: `MPC signature for input ${index} of a BTC spend from ${addresses.btc}`,
      });
      nearTxs.push(result.hash);
      const signature = btc.signatureFromMpc(result.value);
      if (!btc.verifySignature(signature, sighash, pubkey)) throw new CliError(`signature for input ${index} does not verify against ${addresses.secp256k1_key}`);
      signatures.push(signature);
    }
    const signed = btc.finalize(spend.tx, signatures, pubkey);
    item('txid', `${signed.txid} (${signed.vsize} vB)`);
    let broadcastTxid = null;
    if (this.args['no-broadcast']) {
      log(`   --no-broadcast: signed hex ${signed.hex}`);
    } else {
      broadcastTxid = await btc.broadcast(this.ctx.btcApi, signed.hex);
      if (broadcastTxid !== signed.txid) throw new CliError(`broadcast returned ${broadcastTxid}, expected ${signed.txid}`);
    }
    this.ctx.evidence.addBitcoin({
      token_id: this.token,
      from: addresses.btc,
      to,
      amount_sats: spend.amount.toString(),
      fee_sats: spend.fee.toString(),
      txid: signed.txid,
      broadcast: Boolean(broadcastTxid),
      explorer_url: broadcastTxid ? `${this.ctx.btcExplorer}/tx/${signed.txid}` : null,
      near_signature_txs: nearTxs,
    });
    return broadcastTxid ? 'done' : 'done (signed, not broadcast)';
  }
}

async function main() {
  const args = parseCli(OPTIONS);
  if (args.help) {
    log(`usage: node scripts/demo.mjs --network mainnet|testnet|sandbox (--all | --step NAME ...) [--skip a,b]\nsteps: ${STEPS.join(', ')}`);
    return 0;
  }
  const network = requireNetwork(args.network);
  if (network === 'mainnet' && !args['confirm-mainnet']) throw new CliError('the demo sends real mainnet transactions; add --confirm-mainnet', 2);
  const skip = new Set((args.skip ?? '').split(',').filter(Boolean));
  for (const name of [...skip, ...(args.step ?? [])]) if (!STEPS.includes(name)) throw new CliError(`unknown step ${name}. Steps: ${STEPS.join(', ')}`, 2);
  const selected = args.all ? STEPS.filter((s) => !skip.has(s)) : (args.step ?? []);
  if (selected.length === 0) throw new CliError('pass --all or --step NAME', 2);

  loadAppEnv(join(REPO_ROOT, 'web', '.env.local'));
  const ctx = await networkContext({ network, deployer: args.deployer, registry: args.registry, rpc: args.rpc, credentialsDir: args['credentials-dir'] });
  const recorded = ctx.evidence.data.deployment;
  if (!recorded.registry) throw new CliError(`no deployment recorded in ${ctx.evidence.jsonPath}. Run scripts/deploy.mjs --network ${network} first.`);
  if (recorded.registry !== ctx.registry) throw new CliError(`evidence names registry ${recorded.registry}, not ${ctx.registry}`);
  if (recorded.usdc_token) ctx.usdc = recorded.usdc_token;
  if (recorded.intents_contract) ctx.intents = recorded.intents_contract;

  const demo = new Demo(ctx, args);
  heading(`Incorpr demo: ${network}, registry ${ctx.registry}, token ${demo.token}`);
  item('customer / buyer / lender', `${demo.customer} / ${demo.buyer} / ${demo.lender}`);
  const results = [];
  for (const name of selected) {
    heading(`step ${name}`);
    const method = name === 'btc-send' ? 'btcSend' : name === 'rug-listed' ? null : name === 'rug-pledged' ? null : name;
    const outcome =
      name === 'rug-listed'
        ? await demo.rugAttempts('Listed', name)
        : name === 'rug-pledged'
          ? await demo.rugAttempts('Pledged', name)
          : await demo[method]();
    log(`   => ${outcome}`);
    results.push([name, outcome]);
  }
  heading('Summary');
  for (const [name, outcome] of results) item(name, outcome);
  item('evidence', ctx.evidence.markdownPath);
  return 0;
}

runMain(main);
