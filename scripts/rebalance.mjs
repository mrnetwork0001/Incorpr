#!/usr/bin/env node
// Executes one treasury swap for a company vault through NEAR Intents, end to end:
//
//   a  key       the vault's intents key (MPC-derived ed25519, domain 1, path incorpr-<id>-intents)
//                is registered on intents.near: vault.setup_intents_key, checked with has_public_key
//   b  deposit   intents.near holds enough of the vault's USDC: vault.agent_deposit_to_intents moves
//                retained earnings in. With --fund-from, the shareholder pays the vault first when
//                retained earnings are short (related-party revenue, outside revenue_30d)
//   c  balances  intents.near balances of the vault before the swap (mt_balance_of)
//   d  quote     live solver relay quote (exact_amount_in), checked against the vault's price floor,
//                epoch cap and allowlist before anything else happens
//   e  approve   the vault's swap_tee_request body sent unchanged to NEAR AI Cloud; the reply must be
//                exactly "APPROVE <proposal_hash>"; the TEE signature is fetched and must recover to an
//                address in the vault's tee_signers
//   f  sign      operator calls vault.agent_swap_intent; the vault re-checks everything, signs the
//                NEP-413 token_diff through the MPC signer and returns it; checked here against the
//                vault's registered key before it leaves this machine
//   g  publish   publish_intent to the solver relay with the quote hash, get_status until SETTLED,
//                then balances again (mainnet only: the relay settles on intents.near)
//
//   node scripts/rebalance.mjs --network mainnet --dry-run --sell-usdc 0.5
//   node scripts/rebalance.mjs --network mainnet --confirm-mainnet --sell-usdc 0.5 --fund-from demo-customer.incorpr.near
//     (the shareholder demo-buyer pays the vault; demo-customer sends it the USDC it lacks first)
//   node scripts/rebalance.mjs --network sandbox --sell-usdc 0.5 --fund-from demo-customer.test.near
//
// --dry-run sends no transaction: it runs a-e read-only (a real quote, and a real TEE approval
// unless --no-approve) and prints what f and g would send. Every transaction is recorded in the
// network's evidence file, and each run in <evidence dir>/rebalance-<network>.json, which is also
// how a rerun resumes a signed but unpublished intent.
//
// SANDBOX: intents.test.near is contracts/test-doubles/intents, which registers keys and takes
// deposits but does not settle; the MPC signer is a double. The quote prices mainnet USDC, and g
// stops after checking the signed intent. The TEE approval is real NEAR AI Cloud inference.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, formatNear, formatUsdc, heading, item, log, parseCli, parseUsdc, requireNetwork, runMain, sleep, tgas } from './lib/cli.mjs';
import { REPO_ROOT, webImport } from './lib/deps.mjs';
import { loadAppEnv } from './lib/envfile.mjs';
import { bestRelayQuote, hasIntentsKey, intentNonce, intentsBalances, publishIntent, rebalanceLib, waitForIntent } from './lib/intents.mjs';
import { BTC_ASSET, MAINNET_USDC_ASSET, networkContext, SOL_ASSET } from './lib/network.mjs';

const { secp256k1 } = await webImport('@noble/curves/secp256k1.js');
const { keccak_256 } = await webImport('@noble/hashes/sha3.js');
const { bytesToHex, hexToBytes } = await webImport('@noble/hashes/utils.js');

const LIB = await rebalanceLib();

/** Attached gas per call, shared with the app route: REBALANCE_GAS_TGAS in web/src/lib/rebalance.ts. */
export const GAS = Object.fromEntries(Object.entries(LIB.REBALANCE_GAS_TGAS).map(([k, v]) => [k, tgas(v)]));

const ASSETS = { sol: SOL_ASSET, btc: BTC_ASSET };
const NONCE_TTL_MS = 15 * 60_000;
const MIN_QUOTE_LIFE_MS = 45_000;
const MAX_TEE_TRIES = 3;
const MAX_TEE_RESPONSE_BYTES = 16_384;
/** Same map as KNOWN_DIRECT_ENDPOINTS in web/src/lib/nearAiTee.ts. The vault needs the model host's own signature (model:request:response). */
const DIRECT_ENDPOINTS = { 'Qwen/Qwen3-VL-30B-A3B-Instruct': 'https://qwen3-vl-30b.completions.near.ai/v1' };

const OPTIONS = {
  network: { type: 'string' },
  token: { type: 'string', default: '1' },
  'sell-usdc': { type: 'string' },
  to: { type: 'string', default: 'sol' },
  'dry-run': { type: 'boolean', default: false },
  'no-approve': { type: 'boolean', default: false },
  'confirm-mainnet': { type: 'boolean', default: false },
  'fund-from': { type: 'string' },
  'swap-gas-tgas': { type: 'string' },
  registry: { type: 'string' },
  rpc: { type: 'string' },
  'credentials-dir': { type: 'string' },
  help: { type: 'boolean', default: false },
};

const USAGE = `usage: node scripts/rebalance.mjs --network mainnet|sandbox --sell-usdc <amount> [--to sol|btc] [--token 1]
                                  [--dry-run] [--no-approve] [--confirm-mainnet] [--fund-from <account>]
                                  [--swap-gas-tgas N] [--registry ID] [--rpc URL] [--credentials-dir DIR]`;

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const isFree = (state) => state === 'Free';
const json = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

function directEndpointFor(model) {
  const extra = process.env.NEAR_AI_DIRECT_ENDPOINTS ? JSON.parse(process.env.NEAR_AI_DIRECT_ENDPOINTS) : {};
  return ({ ...DIRECT_ENDPOINTS, ...extra })[model]?.replace(/\/$/, '') ?? null;
}

/** EIP-191 personal_sign recovery, as the vault does with env::ecrecover. */
function recoverEip191(text, signatureHex) {
  const message = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const digest = keccak_256(new Uint8Array([...prefix, ...message]));
  const raw = hexToBytes(signatureHex.replace(/^0x/i, ''));
  if (raw.length !== 65) throw new Error(`expected a 65-byte signature, got ${raw.length}`);
  const v = raw[64] >= 27 ? raw[64] - 27 : raw[64];
  const point = secp256k1.Signature.fromBytes(raw.subarray(0, 64), 'compact').addRecoveryBit(v).recoverPublicKey(digest);
  return `0x${bytesToHex(keccak_256(point.toBytes(false).subarray(1)).slice(12))}`;
}

function formatAsset(amount, asset) {
  const value = BigInt(amount);
  if (asset === SOL_ASSET) return `${value} lamports (${(Number(value) / 1e9).toFixed(9)} SOL)`;
  if (asset === BTC_ASSET) return `${value} sats (${(Number(value) / 1e8).toFixed(8)} BTC)`;
  return formatUsdc(value);
}

/** Refuses while an intent the vault signed earlier can still settle (`latest_intent_deadline_ms`). */
function assertNoLiveIntent(state) {
  const until = Number(state.latest_intent_deadline_ms ?? 0);
  if (Date.now() <= until) {
    throw new CliError(`an intent the vault signed is live until ${new Date(until).toISOString()}; it can still settle, so no second one is signed before then. Rerun after that time.`);
  }
}

/** Per-network run log: the record of each rebalance, and the state a rerun resumes from. */
class RunLog {
  constructor(path) {
    this.path = path;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { note: 'Written by scripts/rebalance.mjs. One entry per run; nothing here is edited by hand.', runs: [] };
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(JSON.parse(json(this.data)), null, 2)}\n`);
    renameSync(tmp, this.path);
  }

  pending(vault) {
    return [...this.data.runs].reverse().find((r) => r.vault === vault && (r.status === 'signed' || r.status === 'published')) ?? null;
  }
}

export class Rebalancer {
  /**
   * @param {import('./lib/network.mjs').NetworkContext} ctx
   * @param {{ token: string, sellAmount: bigint, to: 'sol'|'btc', dryRun: boolean, approve: boolean, fundFrom?: string, swapGas?: bigint }} opts
   */
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.near = ctx.near;
    this.opts = opts;
    this.mainnet = ctx.network === 'mainnet';
    this.buyAsset = ASSETS[opts.to];
    if (!this.buyAsset) throw new CliError('--to must be sol or btc', 2);
    this.runLog = new RunLog(join(dirname(ctx.evidence.jsonPath), `rebalance-${ctx.network}.json`));
    this.record = null;
    this.lib = null;
  }

  async vaultState() {
    return this.near.view(this.vault, 'get_state');
  }

  /** Sends one transaction, or in a dry run prints it and returns null. */
  async send(signer, receiver, method, args, { gas, deposit = 0n, purpose, step }) {
    if (this.opts.dryRun) {
      item('would send', `${method} ${signer} -> ${receiver}, gas ${gas / 10n ** 12n} TGas, deposit ${deposit} yocto`);
      return null;
    }
    const result = await this.near.call(signer, receiver, method, args, { gas, deposit, step: `rebalance:${step}`, purpose });
    item('gas burnt', `${result.gasBurnt / 10n ** 12n} TGas of ${gas / 10n ** 12n} attached (${formatNear(result.tokensBurnt)})`);
    this.record?.txs.push({ step, method, tx_hash: result.hash, explorer_url: result.explorerUrl, gas_attached: gas.toString(), gas_burnt: result.gasBurnt.toString() });
    return result;
  }

  async run() {
    const { ctx } = this;
    this.lib = await rebalanceLib();
    const company = await this.near.view(ctx.registry, 'get_company', { token_id: this.opts.token });
    if (!company) throw new CliError(`token ${this.opts.token} does not exist on ${ctx.registry}`);
    this.company = company;
    this.vault = company.vault;
    this.sellAsset = `nep141:${ctx.usdc}`;
    this.marketSell = this.mainnet ? this.sellAsset : MAINNET_USDC_ASSET;

    let state = await this.vaultState();
    heading(`Rebalance ${ctx.network}: ${company.name} (token ${company.token_id}), vault ${this.vault}`);
    item('mode', this.opts.dryRun ? 'dry run: no transactions' : 'execute');
    item('swap', `${formatUsdc(this.opts.sellAmount)} -> ${this.buyAsset}`);
    item('operator', `${state.policy.operator}${state.policy.operator === ctx.operator ? '' : `  (this script signs as ${ctx.operator})`}`);
    item('encumbrance', `${typeof state.encumbrance === 'string' ? state.encumbrance : Object.keys(state.encumbrance)[0]}${state.in_transit ? ', in transit' : ''}`);
    if (!isFree(state.encumbrance) || state.in_transit) throw new CliError('the vault is listed, pledged or in transit; the agent is frozen (ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN)');
    if (state.policy.operator !== ctx.operator) throw new CliError(`the vault's operator is ${state.policy.operator}, not ${ctx.operator}`);
    if (state.intents_contract !== ctx.intents) throw new CliError(`the vault names ${state.intents_contract} as intents contract, not ${ctx.intents}`);

    const resumed = await this.resume(state);
    if (resumed) return resumed;
    // A signed intent that is still live (from the app route, or a run whose log is gone) can still
    // settle; a second one for the same drift would overshoot the target and spend the cap twice.
    assertNoLiveIntent(state);

    this.record = {
      started_at: new Date().toISOString(),
      network: ctx.network,
      token_id: company.token_id,
      vault: this.vault,
      sell_token: this.sellAsset,
      sell_amount: this.opts.sellAmount.toString(),
      buy_token: this.buyAsset,
      status: 'started',
      txs: [],
    };

    try {
      return await this.execute(state);
    } catch (error) {
      // Keep what already happened on chain (transactions, TEE call, signed intent) in the run log.
      if (this.record.txs.length || this.record.tee) {
        this.record.error = error.message;
        this.persist(this.record.status === 'started' ? 'failed' : this.record.status);
      }
      throw error;
    }
  }

  async execute(initialState) {
    let state = initialState;
    await this.stepKey(state);
    state = await this.vaultState();
    await this.stepDeposit(state);
    state = await this.vaultState();
    const before = await this.stepBalances('c  intents.near balances before');
    const quote = await this.stepQuote(state);
    if (!quote) return this.finish('no_quote');
    if (!this.opts.approve) {
      this.printPlan(state, quote, null);
      this.persist('setup_only');
      return 'planned: the quote passes the firewall pre-checks; no TEE approval requested, nothing signed';
    }
    const approval = await this.stepApprove(state, quote);
    if (!approval) return this.finish('tee_refused');
    if (this.opts.dryRun) {
      this.printPlan(state, quote, approval);
      return 'dry run complete: a-e ran read-only; f and g printed above';
    }
    const signed = await this.stepSign(state, quote, approval);
    this.record.before = before;
    this.persist('signed');
    return this.stepPublish(signed, quote, before);
  }

  persist(status) {
    if (this.opts.dryRun || !this.record) return;
    this.record.status = status;
    this.record.updated_at = new Date().toISOString();
    const index = this.runLog.data.runs.indexOf(this.record);
    if (index < 0) this.runLog.data.runs.push(this.record);
    this.runLog.save();
  }

  finish(status) {
    this.persist(status);
    return status;
  }

  /** A signed intent from an earlier run is published (or its status polled) instead of signing a new one. */
  async resume(state) {
    if (this.opts.dryRun) return null;
    const pending = this.runLog.pending(this.vault);
    if (!pending) return null;
    const deadline = Date.parse(JSON.parse(pending.signed_intent.payload.message).deadline);
    if (pending.status === 'signed' && deadline <= Date.now()) {
      pending.status = 'expired_unpublished';
      this.runLog.save();
      log(`   an earlier signed intent expired at ${new Date(deadline).toISOString()} without being published; starting a new run`);
      return null;
    }
    heading(`Resuming the run from ${pending.started_at} (${pending.status})`);
    this.record = pending;
    this.sellAsset = pending.sell_token;
    this.buyAsset = pending.buy_token;
    if (pending.status === 'signed') {
      return this.stepPublish(pending.signed_intent, pending.quote, pending.before);
    }
    return this.stepSettle(pending.intent_hash, pending.before);
  }

  // ------------------------------------------------------------------ a

  async stepKey(state) {
    heading('a  intents key');
    const derived = await this.near.view(state.mpc_contract, 'derived_public_key', {
      path: `incorpr-${state.token_id}-intents`,
      predecessor: this.vault,
      domain_id: 1,
    });
    item('derived key', `${derived} (${state.mpc_contract}, path incorpr-${state.token_id}-intents, domain 1)`);
    this.derivedKey = derived;
    if (state.intents_key_registered) {
      if (state.intents_key !== derived) throw new CliError(`vault records ${state.intents_key}, the signer derives ${derived}`);
      const listed = await hasIntentsKey(this.near, state.intents_contract, this.vault, state.intents_key);
      item('registered', `vault: yes; ${state.intents_contract}: ${listed ? 'yes' : 'NO'}`);
      if (!listed) throw new CliError(`the vault records its key as registered but ${state.intents_contract} does not list it`);
      return;
    }
    const listed = await hasIntentsKey(this.near, state.intents_contract, this.vault, derived);
    item('registered', `vault: no; ${state.intents_contract}: ${listed ? 'yes' : 'no'}`);
    if (listed) {
      // add_public_key panics on a duplicate, so setup_intents_key would fail; the vault cannot sign in this state.
      throw new CliError(`${state.intents_contract} already lists ${derived} but the vault does not record it; setup_intents_key would fail on the duplicate`);
    }
    const result = await this.send(this.ctx.operator, this.vault, 'setup_intents_key', {}, {
      gas: GAS.setupIntentsKey,
      purpose: `register the vault's MPC-derived intents key ${derived} on ${state.intents_contract}`,
      step: 'key',
    });
    if (!result) return;
    const after = await this.vaultState();
    const nowListed = await hasIntentsKey(this.near, state.intents_contract, this.vault, derived);
    item('registered', `vault: ${after.intents_key_registered ? 'yes' : 'NO'}; ${state.intents_contract}: ${nowListed ? 'yes' : 'NO'}`);
    if (!after.intents_key_registered || !nowListed || after.intents_key !== derived) throw new CliError('setup_intents_key landed but the key is not registered on both sides');
  }

  // ------------------------------------------------------------------ b

  async stepDeposit(state) {
    heading('b  USDC on intents.near');
    const sell = this.opts.sellAmount;
    const onIntents = (await intentsBalances(this.near, state.intents_contract, this.vault, [this.sellAsset]))[this.sellAsset];
    const retained = BigInt(state.retained_earnings);
    item('held on intents.near', formatUsdc(onIntents));
    item('retained earnings', formatUsdc(retained));
    if (onIntents >= sell) return;
    const deposit = sell - onIntents;
    // Without a storage deposit on the token, ft_transfer_call panics and the vault restores the amount.
    const storage = await this.near.view(this.ctx.usdc, 'storage_balance_of', { account_id: state.intents_contract });
    if (!storage) {
      if (this.ctx.network !== 'sandbox') throw new CliError(`${state.intents_contract} has no storage deposit on ${this.ctx.usdc}; a deposit would be refused`);
      await this.send(this.ctx.deployer, this.ctx.usdc, 'storage_deposit', { account_id: state.intents_contract, registration_only: true }, {
        gas: tgas(10),
        deposit: 1_250_000_000_000_000_000_000n,
        purpose: `register the intents stand-in ${state.intents_contract} on ${this.ctx.usdc} (SANDBOX ONLY: intents.near is registered on mainnet USDC)`,
        step: 'deposit',
      });
    }
    if (retained < deposit) {
      const shortfall = deposit - retained;
      const payment = this.lib.fundingPaymentFor(shortfall, state.compute_reserve_bps, BigInt(state.price_micro_usdc));
      const message =
        `the vault needs ${formatUsdc(deposit)} more USDC on intents.near and holds ${formatUsdc(retained)} of retained earnings. ` +
        `One shareholder payment of ${payment === null ? '(impossible: compute_reserve_bps is 10000)' : formatUsdc(payment)} adds the missing ${formatUsdc(shortfall)}: ` +
        `ft_on_transfer books any amount at or above the ${formatUsdc(state.price_micro_usdc)} price and keeps ${10_000 - state.compute_reserve_bps} bps of it as retained earnings; ` +
        `from the shareholder (${state.shareholder}) it counts as related-party revenue, not customer revenue. ` +
        `Pass --fund-from <account with USDC and a key file>: the shareholder's key is needed too, and the account sends the shareholder any USDC it lacks first.`;
      if (!this.opts.fundFrom || payment === null) {
        if (this.opts.dryRun) {
          item('shortfall', message);
          return;
        }
        throw new CliError(message);
      }
      await this.fund(state, payment);
    }
    await this.send(this.ctx.operator, this.vault, 'agent_deposit_to_intents', { amount: deposit.toString() }, {
      gas: GAS.deposit,
      purpose: `move ${formatUsdc(deposit)} of retained earnings to ${state.intents_contract} (ft_transfer_call, msg = vault)`,
      step: 'deposit',
    });
    if (this.opts.dryRun) return;
    const now = (await intentsBalances(this.near, state.intents_contract, this.vault, [this.sellAsset]))[this.sellAsset];
    item('held on intents.near', `${formatUsdc(onIntents)} -> ${formatUsdc(now)}`);
    if (now < sell) throw new CliError(`after the deposit the vault holds ${formatUsdc(now)} on intents.near, less than ${formatUsdc(sell)}; the token refused part of it`);
  }

  /**
   * Tops up retained earnings with a payment from the current shareholder. ft_on_transfer books a
   * shareholder payment as related_party_revenue, outside gross_revenue and revenue_30d, so the
   * top-up does not read as customer revenue. When --fund-from names another account, it first
   * sends the shortfall to the shareholder with a plain ft_transfer (no revenue is booked).
   */
  async fund(state, payment) {
    const { near, ctx } = this;
    const shareholder = state.shareholder;
    const source = this.opts.fundFrom;
    const balanceOf = async (account) => BigInt(await near.view(ctx.usdc, 'ft_balance_of', { account_id: account }));
    const have = await balanceOf(shareholder);
    item('funding payment', `${formatUsdc(payment)} from the shareholder ${shareholder} (holds ${formatUsdc(have)}), booked as related-party revenue`);
    if (have < payment) {
      const missing = payment - have;
      // On the sandbox a short account gets Test USDC minted; elsewhere a dry run reports it and a real run stops.
      const cover = async (account, holds, needs) => {
        if (holds >= needs) return;
        if (ctx.network === 'sandbox') {
          await this.send(ctx.deployer, ctx.usdc, 'mint', { account_id: account, amount: (needs - holds).toString() }, {
            gas: tgas(10),
            purpose: `mint ${formatUsdc(needs - holds)} Test USDC (no value) to ${account}`,
            step: 'fund',
          });
          return;
        }
        const short = `${account} holds ${formatUsdc(holds)} and needs ${formatUsdc(needs)}`;
        if (!this.opts.dryRun) throw new CliError(short);
        item('short', short);
      };
      if (!source || source === shareholder) {
        await cover(shareholder, have, payment);
      } else {
        const sourceHas = await balanceOf(source);
        item('top-up', `${formatUsdc(missing)} from ${source} (holds ${formatUsdc(sourceHas)}) to ${shareholder} by ft_transfer`);
        await cover(source, sourceHas, missing);
        await this.send(source, ctx.usdc, 'ft_transfer', { receiver_id: shareholder, amount: missing.toString(), memo: 'incorpr rebalance funding' }, {
          gas: GAS.transfer,
          deposit: 1n,
          purpose: `move ${formatUsdc(missing)} USDC to the shareholder ${shareholder}, who funds the vault (plain transfer, no revenue booked)`,
          step: 'fund',
        });
      }
    }
    const before = this.opts.dryRun ? null : await this.vaultState();
    const callId = sha256Hex(`rebalance-funding:${this.vault}:${randomBytes(16).toString('hex')}`);
    await this.send(shareholder, ctx.usdc, 'ft_transfer_call', { receiver_id: this.vault, amount: payment.toString(), msg: JSON.stringify({ call_id: callId }) }, {
      gas: GAS.fund,
      deposit: 1n,
      purpose: `shareholder payment of ${formatUsdc(payment)} to ${this.vault} (call_id ${callId.slice(0, 12)}...): related-party revenue that funds retained earnings for the rebalance`,
      step: 'fund',
    });
    if (this.opts.dryRun) return;
    const booked = await near.view(this.vault, 'get_payment', { call_id: callId });
    if (!booked) throw new CliError(`the vault did not book the funding payment ${callId} (refunded)`);
    const after = await this.vaultState();
    item('retained earnings', `${formatUsdc(before.retained_earnings)} -> ${formatUsdc(after.retained_earnings)}`);
    item('related-party revenue', `${formatUsdc(before.related_party_revenue)} -> ${formatUsdc(after.related_party_revenue)}`);
    item('gross revenue', `${formatUsdc(before.gross_revenue)} -> ${formatUsdc(after.gross_revenue)} (unchanged: not customer revenue)`);
    if (after.gross_revenue !== before.gross_revenue) throw new CliError('the funding payment was booked as customer revenue; the shareholder changed between reads');
    this.record.funding = { payer: shareholder, source: source ?? shareholder, amount: payment.toString(), call_id: callId, related_party: true };
  }

  // ------------------------------------------------------------------ c

  async stepBalances(title) {
    heading(title);
    const balances = await intentsBalances(this.near, this.ctx.intents, this.vault, [this.sellAsset, this.buyAsset]);
    for (const [asset, amount] of Object.entries(balances)) item(asset.length > 30 ? `${asset.slice(0, 27)}...` : asset, formatAsset(amount, asset));
    return Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, v.toString()]));
  }

  // ------------------------------------------------------------------ d

  async stepQuote(state) {
    heading('d  solver relay quote and firewall pre-checks');
    const sell = this.opts.sellAmount;
    const lib = this.lib;
    const allowed = state.policy.allowed_tokens;
    const failures = [];
    if (!allowed.includes(this.sellAsset)) failures.push(`${this.sellAsset} is not in allowed_tokens (ERR_FIREWALL_BLOCKED_TOKEN)`);
    if (!allowed.includes(this.buyAsset)) failures.push(`${this.buyAsset} is not in allowed_tokens (ERR_FIREWALL_BLOCKED_TOKEN)`);
    const capLeft = lib.epochCapRemaining(state, Date.now()).get(this.sellAsset) ?? 0n;
    item('epoch cap left', `${formatUsdc(capLeft)} in the current 24 h window`);
    if (sell > capLeft) failures.push(`selling ${formatUsdc(sell)} exceeds the ${formatUsdc(capLeft)} left under the epoch cap (ERR_FIREWALL_EPOCH_CAP_EXCEEDED)`);
    const floor = lib.priceFloorMinBuy(state, this.sellAsset, this.buyAsset, sell);
    if (floor === null) failures.push(`no price floor for ${this.sellAsset} -> ${this.buyAsset} (ERR_FIREWALL_NO_PRICE_FLOOR)`);
    else item('price floor', `at least ${formatAsset(floor, this.buyAsset)} for ${formatUsdc(sell)}`);
    if (failures.length) throw new CliError(`the vault would refuse this swap:\n   - ${failures.join('\n   - ')}`);

    const { quote, attempts } = await bestRelayQuote({ assetIn: this.marketSell, assetOut: this.buyAsset, exactAmountIn: sell });
    item('relay attempts', attempts.map((a) => `${a.min_deadline_ms / 1000}s:${a.offers}`).join(' '));
    if (!quote) {
      item('quote', `no solver quoted ${formatUsdc(sell)} ${this.marketSell} -> ${this.buyAsset}`);
      this.record.quote = null;
      return null;
    }
    item('quote', `${formatUsdc(quote.amount_in)} -> ${formatAsset(quote.amount_out, this.buyAsset)}`);
    item('quote hash', `${quote.quote_hash}, expires ${quote.expiration_time}`);
    if (!this.mainnet) item('note', `priced with mainnet USDC; the vault sells ${this.sellAsset}, which has no market`);
    const passes = BigInt(quote.amount_out) >= floor;
    item('floor check', `${quote.amount_out} ${passes ? '>=' : '<'} ${floor}: ${passes ? 'passes' : 'the vault would refuse it (ERR_FIREWALL_PRICE_BELOW_FLOOR)'}`);
    this.record.quote = { ...quote, source: this.mainnet ? 'solver_relay' : 'solver_relay (mainnet USDC as price)', floor_min_buy: floor.toString(), passes_floor: passes };
    if (!passes) throw new CliError(`the live quote ${quote.amount_out} is below the vault's price floor ${floor}`);
    return quote;
  }

  // ------------------------------------------------------------------ e

  chooseModel(state) {
    const preferred = process.env.NEAR_AI_DEFAULT_MODEL;
    if (preferred && state.policy.tee_models.includes(preferred) && directEndpointFor(preferred)) return preferred;
    const model = state.policy.tee_models.find((m) => directEndpointFor(m));
    if (!model) throw new CliError(`the vault allows models ${JSON.stringify(state.policy.tee_models)}, none with a known direct host (NEAR_AI_DIRECT_ENDPOINTS)`);
    return model;
  }

  async stepApprove(state, quote) {
    heading('e  TEE approval');
    const lib = this.lib;
    const key = process.env.NEAR_AI_API_KEY;
    if (!key) throw new CliError('NEAR_AI_API_KEY is not set (shell or web/.env.local); the vault accepts only a real TEE approval');
    const prompt = lib.TREASURY_SYSTEM_PROMPT;
    if (sha256Hex(prompt) !== state.policy.tee_prompt_hash) {
      throw new CliError(`the vault pins prompt hash ${state.policy.tee_prompt_hash}, TREASURY_SYSTEM_PROMPT hashes to ${sha256Hex(prompt)} (ERR_TEE_PROMPT_NOT_PINNED)`);
    }
    const model = this.chooseModel(state);
    const { nonce, salt } = await intentNonce(this.near, state.intents_contract, Date.now() + NONCE_TTL_MS);
    const proposal = {
      sell_token: this.sellAsset,
      sell_amount: this.opts.sellAmount.toString(),
      buy_token: this.buyAsset,
      min_buy_amount: quote.amount_out,
      nonce_b64: nonce,
    };
    item('nonce', `${nonce} (${salt ? `V1, salt ${salt}, expires ${new Date(Date.now() + NONCE_TTL_MS).toISOString()}` : 'random 32 bytes: the stand-in has no salts'})`);
    const local = lib.buildSwapTeeRequest({ vaultAccount: this.vault, treasuryEpoch: state.treasury_epoch, ownerGeneration: state.owner_generation }, proposal, model, prompt);
    const onChain = await this.near.view(this.vault, 'swap_tee_request', { p: proposal, model, system_prompt: prompt });
    if (local.body !== onChain.body || local.proposal_hash !== onChain.proposal_hash) throw new CliError('the local TEE request differs from the vault swap_tee_request view; refusing to spend a NEAR AI call on it');
    item('proposal hash', onChain.proposal_hash);
    item('request sha256', `${sha256Hex(onChain.body)} (${onChain.body.length} bytes, body from swap_tee_request, sent unchanged)`);

    const base = directEndpointFor(model);
    let approved = null;
    for (let attempt = 1; attempt <= MAX_TEE_TRIES && !approved; attempt += 1) {
      // The vault hashes this exact body, so it carries no temperature or max_tokens: any added field changes the request hash.
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: onChain.body,
        signal: AbortSignal.timeout(120_000),
      });
      const responseBody = await res.text();
      if (!res.ok) throw new CliError(`NEAR AI ${base} answered HTTP ${res.status}: ${responseBody.slice(0, 300)}`);
      const decision = lib.parseApproval(responseBody, onChain.proposal_hash);
      const chatId = JSON.parse(responseBody).id;
      item(`attempt ${attempt}`, `chat ${chatId}: ${decision.approved ? 'APPROVE <proposal_hash>' : `refused (${decision.reason}): ${JSON.stringify(decision.modelOutput)}`}`);
      if (decision.approved) approved = { responseBody, chatId, created: decision.created };
    }
    if (!approved) {
      log('   the model did not approve; nothing was signed and no transaction was sent.');
      return null;
    }
    if (Buffer.byteLength(approved.responseBody) > MAX_TEE_RESPONSE_BYTES) throw new CliError('the TEE response is larger than the vault accepts (ERR_TEE_PROOF_TOO_LARGE)');

    let bundle = null;
    let lastError = '';
    for (let attempt = 0; attempt < 10 && !bundle; attempt += 1) {
      if (attempt) await sleep(750);
      const res = await fetch(`${base}/signature/${encodeURIComponent(approved.chatId)}?signing_algo=ecdsa`, {
        headers: { accept: 'application/json', authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (res.ok) bundle = JSON.parse(text);
      else lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    }
    if (!bundle) throw new CliError(`no TEE signature for chat ${approved.chatId}: ${lastError}`);
    const expectedText = `${model}:${sha256Hex(onChain.body)}:${sha256Hex(approved.responseBody)}`;
    const recovered = recoverEip191(bundle.text, bundle.signature);
    const checks = {
      signedTextIsModelRequestResponse: bundle.text === expectedText,
      recoversToSigningAddress: recovered === String(bundle.signing_address).toLowerCase(),
      signerInVaultPolicy: state.policy.tee_signers.includes(recovered),
      approvalAgeSeconds: Math.floor(Date.now() / 1000) - approved.created,
    };
    item('signed text', bundle.text);
    item('recovered signer', `${recovered} (vault tee_signers: ${state.policy.tee_signers.join(', ')})`);
    for (const [k, v] of Object.entries(checks)) item(k, String(v));
    if (!checks.signedTextIsModelRequestResponse || !checks.recoversToSigningAddress || !checks.signerInVaultPolicy) {
      throw new CliError('the TEE signature does not check out; the vault would refuse it');
    }
    const tee = { text: bundle.text, signature_hex: bundle.signature.replace(/^0x/i, ''), response_body: approved.responseBody, system_prompt: prompt };
    this.record.tee = { model, host: base, chat_id: approved.chatId, created: approved.created, proposal_hash: onChain.proposal_hash, signer: recovered, signed_text: bundle.text, checks };
    // Kept in the run log only: the evidence file's tee_calls list paid service calls, and this
    // approval has no payment behind it.
    return { proposal, tee, model, proposalHash: onChain.proposal_hash };
  }

  // ------------------------------------------------------------------ f

  swapGas() {
    return this.opts.swapGas ?? GAS.swap;
  }

  async stepSign(state, quote, approval) {
    heading('f  agent_swap_intent');
    const life = Date.parse(quote.expiration_time) - Date.now();
    if (life < MIN_QUOTE_LIFE_MS) throw new CliError(`the quote expires in ${Math.round(life / 1000)}s, too soon to sign and publish; rerun for a fresh quote`);
    assertNoLiveIntent(await this.vaultState());
    const result = await this.send(this.ctx.operator, this.vault, 'agent_swap_intent', { p: approval.proposal, tee: approval.tee }, {
      gas: this.swapGas(),
      purpose: `swap ${formatUsdc(approval.proposal.sell_amount)} for ${formatAsset(approval.proposal.min_buy_amount, approval.proposal.buy_token)} on intents.near (TEE chat ${this.record.tee.chat_id})`,
      step: 'sign',
    });
    const signed = result.value;
    if (!signed || typeof signed !== 'object') throw new CliError(`agent_swap_intent returned no signed intent. tx ${result.hash}`);
    const after = await this.vaultState();
    const check = this.lib.checkSignedSwapIntent(signed, {
      vault: this.vault,
      intentsContract: state.intents_contract,
      intentsKey: after.intents_key,
      proposal: approval.proposal,
      nowMs: Date.now(),
    });
    const registered = await hasIntentsKey(this.near, state.intents_contract, this.vault, signed.public_key);
    item('message', signed.payload.message);
    item('nep413 hash', check.nep413HashB58);
    item('public key', `${signed.public_key} (registered on ${state.intents_contract}: ${registered ? 'yes' : 'NO'})`);
    item('signature', `${signed.signature.slice(0, 24)}... ${check.ok ? 'verifies' : 'FAILS'} against it`);
    if (!check.ok || !registered) throw new CliError(`the signed intent fails local checks: ${[...check.failures, ...(registered ? [] : ['key not registered'])].join('; ')}`);
    this.record.signed_intent = signed;
    this.record.quote = { ...this.record.quote, ...quote };
    this.record.sign_tx = result.hash;
    return signed;
  }

  // ------------------------------------------------------------------ g

  async stepPublish(signed, quote, before) {
    heading('g  publish to the solver relay');
    if (!this.mainnet) {
      item('publish', `skipped: the relay settles on intents.near (mainnet). ${this.ctx.intents} is a stand-in that does not settle.`);
      this.persist('signed_not_published');
      return 'signed and checked: intent verifies against the key registered on the stand-in (sandbox does not settle)';
    }
    const life = Date.parse(quote.expiration_time) - Date.now();
    if (life <= 0) {
      this.persist('quote_expired');
      throw new CliError(`quote ${quote.quote_hash} expired at ${quote.expiration_time}; the signed intent cannot be matched. The vault's intent expires on its own deadline. Rerun for a new quote.`);
    }
    const { params, result } = await publishIntent({ network: 'mainnet', signed, quoteHashes: [quote.quote_hash] });
    this.record.publish = { params_quote_hashes: params.quote_hashes, result, at: new Date().toISOString() };
    item('relay answer', json(result));
    if (result.status !== 'OK') {
      this.persist('publish_failed');
      throw new CliError(`publish_intent failed: ${result.reason}`);
    }
    this.record.intent_hash = result.intent_hash;
    this.persist('published');
    return this.stepSettle(result.intent_hash, before);
  }

  async stepSettle(intentHash, before) {
    item('intent hash', intentHash);
    const status = await waitForIntent(intentHash, {
      onStatus: (s) => item('status', `${s.status}${s.status_details ? ` (${s.status_details})` : ''}${s.tx_hash ? ` tx ${s.tx_hash}` : ''}`),
    });
    this.record.settlement = status;
    if (status.tx_hash) {
      this.record.settlement.explorer_url = this.near.txUrl(status.tx_hash);
      item('settlement tx', `${status.tx_hash}  ${this.near.txUrl(status.tx_hash)}`);
    }
    if (status.status !== 'SETTLED') {
      // Still pending after the intent's own deadline means it can no longer settle.
      const deadline = Date.parse(JSON.parse(this.record.signed_intent.payload.message).deadline);
      const terminal = status.status === 'NOT_FOUND_OR_NOT_VALID' || Date.now() > deadline + 60_000;
      this.persist(terminal ? 'not_settled' : 'published');
      throw new CliError(`intent ${intentHash} is ${status.status}${status.status_details ? `: ${status.status_details}` : ''}`);
    }
    const after = await this.stepBalances('g  intents.near balances after');
    const diff = {};
    for (const asset of Object.keys(after)) diff[asset] = (BigInt(after[asset]) - BigInt(before?.[asset] ?? 0)).toString();
    heading('Before / after');
    for (const asset of Object.keys(after)) item(asset.length > 30 ? `${asset.slice(0, 27)}...` : asset, `${before?.[asset] ?? '?'} -> ${after[asset]} (${BigInt(diff[asset]) >= 0n ? '+' : ''}${diff[asset]})`);
    this.record.after = after;
    this.record.diff = diff;
    this.persist('settled');
    return `settled: intent ${intentHash}${status.tx_hash ? `, tx ${status.tx_hash}` : ''}`;
  }

  // ------------------------------------------------------------------ dry-run output

  printPlan(state, quote, approval) {
    heading('f/g  what an execute run would send');
    const proposal = approval?.proposal ?? {
      sell_token: this.sellAsset,
      sell_amount: this.opts.sellAmount.toString(),
      buy_token: this.buyAsset,
      min_buy_amount: quote.amount_out,
      nonce_b64: '<V1 nonce: current_salt, deadline now+15 min>',
    };
    const teeSummary = approval
      ? { text: approval.tee.text, signature_hex: `${approval.tee.signature_hex.slice(0, 16)}... (65 bytes)`, response_body: `<${approval.tee.response_body.length} bytes from chat ${this.record.tee.chat_id}>`, system_prompt: `<TREASURY_SYSTEM_PROMPT, sha256 ${state.policy.tee_prompt_hash}>` }
      : '<TEE proof: not requested>';
    item('f  transaction', `${this.ctx.operator} -> ${this.vault} agent_swap_intent, gas ${this.swapGas() / 10n ** 12n} TGas, deposit 0`);
    log(`      args ${JSON.stringify({ p: proposal, tee: teeSummary }, null, 2).replaceAll('\n', '\n      ')}`);
    const diff = { [proposal.sell_token]: `-${proposal.sell_amount}`, [proposal.buy_token]: proposal.min_buy_amount };
    const message = { signer_id: this.vault, deadline: '<block time + 300 s, ISO 8601 ms>', intents: [{ intent: 'token_diff', diff }] };
    const key = state.intents_key ?? `${this.derivedKey} (registered by setup_intents_key first)`;
    item('f  vault returns', 'SignedIntent (NEP-413), signed by the MPC signer on the intents path, domain 1');
    log(`      ${JSON.stringify({ standard: 'nep413', payload: { message: JSON.stringify(message), nonce: proposal.nonce_b64, recipient: state.intents_contract }, public_key: key, signature: 'ed25519:<from the signer>' })}`);
    item('g  relay', `publish_intent {quote_hashes: ["${quote.quote_hash}"], signed_data: <the SignedIntent above>} to solver-relay-v2.chaindefuser.com, then get_status until SETTLED`);
    item('g  quote expires', `${quote.expiration_time}; an execute run signs and publishes within it`);
  }
}

async function main() {
  const args = parseCli(OPTIONS);
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const network = requireNetwork(args.network);
  if (network === 'testnet') throw new CliError('intents.near and the solver relay exist on mainnet only; use --network mainnet or sandbox', 2);
  const dryRun = args['dry-run'];
  if (network === 'mainnet' && !dryRun && !args['confirm-mainnet']) throw new CliError('this moves real funds on mainnet; add --confirm-mainnet, or --dry-run to send nothing', 2);
  if (!args['sell-usdc']) throw new CliError(`--sell-usdc is required\n${USAGE}`, 2);
  const sellAmount = parseUsdc(args['sell-usdc']);
  if (sellAmount <= 0n) throw new CliError('--sell-usdc must be positive', 2);

  loadAppEnv(join(REPO_ROOT, 'web', '.env.local'));
  const ctx = await networkContext({ network, registry: args.registry, rpc: args.rpc, credentialsDir: args['credentials-dir'] });
  const recorded = ctx.evidence.data.deployment;
  if (!recorded.registry) throw new CliError(`no deployment recorded in ${ctx.evidence.jsonPath}`);
  if (recorded.registry !== ctx.registry) throw new CliError(`evidence names registry ${recorded.registry}, not ${ctx.registry}`);
  if (recorded.usdc_token) ctx.usdc = recorded.usdc_token;
  if (recorded.intents_contract) ctx.intents = recorded.intents_contract;
  if (!ctx.intents) throw new CliError(`no intents contract for ${network}`);

  const rebalancer = new Rebalancer(ctx, {
    token: args.token,
    sellAmount,
    to: args.to,
    dryRun,
    approve: !args['no-approve'],
    fundFrom: args['fund-from'],
    swapGas: args['swap-gas-tgas'] ? tgas(args['swap-gas-tgas']) : undefined,
  });
  const outcome = await rebalancer.run();
  heading('Result');
  item('outcome', outcome);
  if (!dryRun) {
    item('run log', rebalancer.runLog.path);
    item('evidence', ctx.evidence.markdownPath);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runMain(main);
