import 'server-only';

// Server side of "Rob this company": reads the house company, sends the attack transactions from
// server-held keys, and reads past rejections from docs/evidence. Every result that claims an
// attempt carries the hash of a transaction that exists on-chain.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Account, actions, type KeyPairString } from 'near-api-js';
import { RegistryClient, VaultClient, type CompanyView, type ContractCall, type VaultState } from '../contracts';
import { ConfigError, getNetworkConfig, getProvider, transactionExplorerUrl } from '../near';
import { teeConfigured } from '../nearAiTee';
import {
  OperatorNotConfiguredError,
  OperatorUnavailableError,
  TransactionPendingError,
  operatorAccountId,
  operatorCall,
  transactionHash,
} from '../operator';
import { TREASURY_SYSTEM_PROMPT } from '../rebalance';
import { CONTRACT_ERRORS, TransactionFailedError, describeContractError, parseOutcome, type OutcomeLike } from '../txOutcome';
import { ATTACKS, ATTACK_ORDER, type AttackKind, type AttemptResult, type EvidenceAttempt, type RobTargetView } from './attacks';
import { intFromEnv, type LimiterOptions } from './limits';
import { dumpSwap, floorSwap, forgeApproval, outsideWithdrawal, randomBtcAddress } from './proposals';
import { findChat, recordAttempt } from './store';

const ONE_NEAR = 10n ** 24n;
const STORAGE_PRICE_PER_BYTE = 10n ** 19n;
const TGAS = 10n ** 12n;
/**
 * Each attempt fails in its first few TGas, so it prepays little. A transaction must hold its whole
 * prepaid gas at the pessimistic price up front (about ten times gas_price on nearcore 2.14), and an
 * RPC drops a transaction the signer cannot cover: 300 TGas needs about 0.3 NEAR.
 */
const ATTEMPT_GAS: Record<AttackKind, bigint> = {
  stranger_sign: 30n * TGAS,
  agent_withdraw: 30n * TGAS,
  agent_dump: 30n * TGAS,
  // Verifying a TEE proof hashes the request and response and runs ecrecover.
  replay_chat: 60n * TGAS,
  forged_approval: 60n * TGAS,
  owner_claim: 30n * TGAS,
};
const PESSIMISTIC_GAS_FACTOR = 10n;
const U128_MAX = ((1n << 128n) - 1n).toString();
const TX_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------- Settings

interface KeyedAccount {
  accountId: string;
  privateKey: KeyPairString;
}

export interface RobSettings {
  tokenId: string;
  rob: KeyedAccount | null;
  /** Optional. Only used while the company is listed or pledged. */
  owner: KeyedAccount | null;
  attemptLimits: LimiterOptions;
  chatLimits: LimiterOptions;
  minBalanceYocto: bigint;
}

function parseNear(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,24}))?$/.exec(text.trim());
  if (!match) throw new ConfigError(`ROB_MIN_BALANCE_NEAR must be a NEAR amount, got ${text}`);
  return BigInt(match[1] as string) * ONE_NEAR + BigInt((match[2] ?? '').padEnd(24, '0') || '0');
}

function keyedAccount(idVar: string, keyVar: string): KeyedAccount | null {
  const accountId = process.env[idVar];
  const privateKey = process.env[keyVar];
  if (!accountId || !privateKey) return null;
  return { accountId, privateKey: privateKey as KeyPairString };
}

export function robSettings(): RobSettings {
  const tokenId = process.env.NEXT_PUBLIC_ROB_COMPANY_ID || '1';
  if (!/^\d{1,20}$/.test(tokenId)) throw new ConfigError(`NEXT_PUBLIC_ROB_COMPANY_ID must be a token id, got ${tokenId}`);
  return {
    tokenId,
    rob: keyedAccount('ROB_ACCOUNT_ID', 'ROB_PRIVATE_KEY'),
    owner: keyedAccount('ROB_OWNER_ACCOUNT_ID', 'ROB_OWNER_PRIVATE_KEY'),
    attemptLimits: {
      perIpMax: intFromEnv(process.env.ROB_PER_IP_MAX, 12),
      perIpWindowMs: intFromEnv(process.env.ROB_PER_IP_WINDOW_MIN, 10) * 60_000 || 600_000,
      dailyMax: intFromEnv(process.env.ROB_DAILY_CAP, 300),
    },
    chatLimits: {
      perIpMax: intFromEnv(process.env.ROB_CHAT_PER_IP_MAX, 20),
      perIpWindowMs: 10 * 60_000,
      dailyMax: intFromEnv(process.env.ROB_CHAT_DAILY_CAP, 500),
    },
    minBalanceYocto: parseNear(process.env.ROB_MIN_BALANCE_NEAR || '0.1'),
  };
}

// ---------------------------------------------------------------------------- Target

export interface Target {
  company: CompanyView;
  state: VaultState;
}

function encumbranceLabel(state: VaultState['encumbrance']): 'FREE' | 'LISTED' | 'PLEDGED' {
  if (state === 'Free') return 'FREE';
  return 'Listed' in state ? 'LISTED' : 'PLEDGED';
}

export async function loadTarget(tokenId: string): Promise<Target> {
  const registry = new RegistryClient(undefined, { finality: 'optimistic' });
  const company = await registry.getCompany(tokenId);
  if (!company) throw new ConfigError(`Company ${tokenId} does not exist on ${registry.registryId}. Set NEXT_PUBLIC_ROB_COMPANY_ID.`);
  const state = await new VaultClient(company.vault, { finality: 'optimistic' }).getState();
  return { company, state };
}

function optionalOperator(): string | null {
  try {
    return operatorAccountId();
  } catch {
    return null;
  }
}

/** What the /rob page shows about the house company and this server's configuration. */
export async function targetView(): Promise<RobTargetView> {
  const config = getNetworkConfig();
  let settings: RobSettings | null = null;
  let problem: string | null = null;
  try {
    settings = robSettings();
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  const tokenId = settings?.tokenId ?? (process.env.NEXT_PUBLIC_ROB_COMPANY_ID || '1');
  const operatorAccount = optionalOperator();
  const view: RobTargetView = {
    network: config.network,
    tokenId,
    registryId: config.registryId,
    problem,
    company: null,
    robAccount: settings?.rob?.accountId ?? null,
    operatorAccount,
    ownerKeyAccount: settings?.owner?.accountId ?? null,
    chatAvailable: teeConfigured(),
    chatProblem: teeConfigured() ? null : 'NEAR_AI_API_KEY is not set on this server, so the treasury agent cannot answer.',
    attemptsProblem: null,
  };
  if (!config.registryId) {
    view.problem ??= 'NEXT_PUBLIC_REGISTRY_CONTRACT_ID is not set, so there is no company to rob on this server.';
  } else if (!problem) {
    try {
      const { company, state } = await loadTarget(tokenId);
      view.company = {
        name: company.name,
        vault: company.vault,
        owner: company.owner_id,
        encumbrance: encumbranceLabel(state.encumbrance),
        inTransit: state.in_transit,
        operator: state.policy.operator,
        treasuryEpoch: state.treasury_epoch,
        btc: state.addresses?.btc ?? null,
        evm: state.addresses?.evm ?? null,
        sol: state.addresses?.sol ?? null,
        teeSigners: state.policy.tee_signers,
        teeModels: state.policy.tee_models,
        retainedMicroUsdc: state.retained_earnings,
      };
    } catch (error) {
      view.problem = error instanceof Error ? error.message : String(error);
    }
  }
  view.attemptsProblem = attemptsDisabledReason(settings);
  return view;
}

/**
 * Why this server will not send attempts, or null when it will. The page and POST /api/rob/attempt
 * both use it, so a direct POST cannot send what the page shows as off.
 */
export function attemptsDisabledReason(settings: RobSettings | null): string | null {
  const operatorReady = Boolean(optionalOperator() && process.env.NEAR_OPERATOR_PRIVATE_KEY);
  const missing = [
    !operatorReady && 'NEAR_OPERATOR_ACCOUNT_ID and NEAR_OPERATOR_PRIVATE_KEY',
    !settings?.rob && 'ROB_ACCOUNT_ID and ROB_PRIVATE_KEY (run scripts/rob-setup.mjs)',
  ].filter(Boolean);
  if (missing.length) return `This server has no key to send attempts with: set ${missing.join(' and ')}.`;
  if (getNetworkConfig().network === 'mainnet' && process.env.ROB_ATTEMPTS_ENABLED !== 'true') {
    return 'Attempts on mainnet spend real NEAR from the operator and stranger accounts. Set ROB_ATTEMPTS_ENABLED=true on this server to turn them on.';
  }
  return null;
}

// ---------------------------------------------------------------------------- Sending

const queues = new Map<string, Promise<unknown>>();

/** One key, one nonce sequence: sends from the same account run one after another. */
function serialized<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(accountId) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(accountId, next.catch(() => undefined));
  return next;
}

type SendOutcome =
  | { status: 'rejected'; txHash: string; code: string | null; sentence: string }
  | { status: 'succeeded'; txHash: string }
  | { status: 'pending'; txHash: string; sentence: string }
  | { status: 'not_sent'; reason: string };

/** Signs with a server key, sends, and reads the outcome by hash. Used for every key except the operator's. */
async function sendAs(signer: KeyedAccount, call: ContractCall): Promise<SendOutcome> {
  const provider = getProvider();
  const account = new Account(signer.accountId, provider, signer.privateKey);
  let txHash: string;
  try {
    txHash = await serialized(signer.accountId, async () => {
      const signed = await account.createSignedTransaction({
        receiverId: call.contractId,
        actions: [actions.functionCall(call.methodName, call.args, BigInt(call.gas), BigInt(call.deposit))],
      });
      const hash = transactionHash(signed);
      await provider.sendTransactionAsync(signed);
      return hash;
    });
  } catch (error) {
    return { status: 'not_sent', reason: `The RPC did not accept the transaction: ${scrub(errorText(error))}` };
  }
  const deadline = Date.now() + TX_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    let outcome: OutcomeLike;
    try {
      outcome = (await provider.viewTransactionStatus({ txHash, accountId: signer.accountId, waitUntil: 'EXECUTED_OPTIMISTIC' })) as OutcomeLike;
    } catch {
      continue;
    }
    const status = outcome.status as { SuccessValue?: string; Failure?: unknown } | string;
    if (typeof status === 'string' || (status.SuccessValue === undefined && status.Failure === undefined)) continue;
    try {
      parseOutcome(outcome);
      return { status: 'succeeded', txHash };
    } catch (error) {
      if (error instanceof TransactionFailedError) {
        return { status: 'rejected', txHash, code: error.error.code, sentence: error.error.message };
      }
      throw error;
    }
  }
  return {
    status: 'pending',
    txHash,
    sentence: `The transaction was sent but no outcome was found within ${TX_TIMEOUT_MS / 1000} s. The network may have dropped it; check the hash on the explorer.`,
  };
}

async function sendAsOperator(call: ContractCall): Promise<SendOutcome> {
  try {
    const { txHash } = await operatorCall(call, { timeoutMs: TX_TIMEOUT_MS, waitUntil: 'EXECUTED_OPTIMISTIC' });
    return { status: 'succeeded', txHash };
  } catch (error) {
    if (error instanceof TransactionFailedError) {
      const described = describeContractError(error.reason);
      return { status: 'rejected', txHash: error.txHash, code: described.code, sentence: described.message };
    }
    if (error instanceof TransactionPendingError) {
      return { status: 'pending', txHash: error.txHash, sentence: error.message };
    }
    if (error instanceof OperatorNotConfiguredError || error instanceof OperatorUnavailableError) {
      return { status: 'not_sent', reason: scrub(error.message) };
    }
    throw error;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keys can reach error text through a library. */
function scrub(text: string): string {
  let out = text;
  for (const secret of [process.env.ROB_PRIVATE_KEY, process.env.ROB_OWNER_PRIVATE_KEY, process.env.NEAR_OPERATOR_PRIVATE_KEY]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{70,}/g, 'ed25519:[redacted]').slice(0, 400);
}

async function gasPrice(): Promise<bigint> {
  try {
    const res = await fetch(getNetworkConfig().rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gas_price', params: [null] }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: { gas_price?: string } };
    if (body.result?.gas_price) return BigInt(body.result.gas_price);
  } catch {
    // Fall through to the protocol's minimum on mainnet and testnet.
  }
  return 100_000_000n;
}

async function freeBalance(accountId: string): Promise<bigint | null> {
  try {
    const account = await getProvider().viewAccount({ accountId, blockQuery: { finality: 'optimistic' } });
    return BigInt(account.amount) - BigInt(account.storage_usage) * STORAGE_PRICE_PER_BYTE;
  } catch {
    return null;
  }
}

function formatNear(yocto: bigint): string {
  const whole = yocto / ONE_NEAR;
  const frac = (yocto % ONE_NEAR).toString().padStart(24, '0').slice(0, 4);
  return `${whole}.${frac} NEAR`;
}

// ---------------------------------------------------------------------------- Attempts

export interface AttemptRequest {
  kinds: AttackKind[];
  /** Visitor's Bitcoin address for the withdrawal. A fresh random address when absent. */
  destination?: string;
  /** A chat reply from /api/rob/chat, for `replay_chat`. */
  chatId?: string;
}

interface Planned {
  kind: AttackKind;
  signer: 'operator' | KeyedAccount;
  signerId: string | null;
  call: ContractCall | null;
  args: string;
  /** Set when no transaction will be sent. */
  skip: string | null;
}

function short(value: string, keep = 10): string {
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value;
}

/** Builds each attack from the live vault state, or says plainly why it cannot be sent. */
export async function planAttempts(request: AttemptRequest, settings: RobSettings, target: Target): Promise<Planned[]> {
  const { company, state } = target;
  const vault = new VaultClient(company.vault, { finality: 'optimistic' });
  const operator = optionalOperator();
  const nowMs = Date.now();
  const kinds = ATTACK_ORDER.filter((kind) => request.kinds.includes(kind));
  const planned: Planned[] = [];

  for (const kind of kinds) {
    const base = { kind, signer: 'operator' as const, signerId: operator, call: null, args: '', skip: null };
    switch (kind) {
      case 'stranger_sign': {
        if (!settings.rob) {
          planned.push({ ...base, signer: 'operator', signerId: null, skip: 'ROB_ACCOUNT_ID and ROB_PRIVATE_KEY are not set. Run scripts/rob-setup.mjs.' });
          break;
        }
        const payload = sha256Hex32(`incorpr-rob:${company.vault}:${state.addresses?.btc ?? 'btc'}:${randomUUID()}`);
        planned.push({
          ...base,
          signer: settings.rob,
          signerId: settings.rob.accountId,
          call: vault.requestShareholderSignature(0, payload, 'treasury'),
          args: `domain_id 0 (secp256k1), subpath "treasury", payload ${short(payload, 8)}`,
        });
        break;
      }
      case 'agent_withdraw': {
        const destination = request.destination || randomBtcAddress(state.btc_hrp);
        const p = outsideWithdrawal(state, destination);
        planned.push({
          ...base,
          call: vault.agentWithdrawIntent(p, { text: '', signature_hex: '', response_body: '', system_prompt: '' }),
          args: `${p.amount} base units of ${p.token} to ${destination}${request.destination ? '' : ' (random address)'}, chain btc`,
        });
        break;
      }
      case 'agent_dump': {
        const p = dumpSwap(state, nowMs);
        planned.push({
          ...base,
          call: vault.agentSwapIntent(p, { text: '', signature_hex: '', response_body: '', system_prompt: '' }),
          args: `sell ${p.sell_amount} of ${p.sell_token} for at least ${p.min_buy_amount} of ${p.buy_token}`,
        });
        break;
      }
      case 'replay_chat': {
        const chat = request.chatId ? findChat(request.chatId) : null;
        if (!chat || !chat.signedText || !chat.signature) {
          planned.push({
            ...base,
            skip: request.chatId
              ? 'That chat reply is not held by this server any more, or its TEE signature could not be fetched.'
              : 'No signed reply from the treasury agent yet. Chat with it first.',
          });
          break;
        }
        const p = floorSwap(state, nowMs);
        planned.push({
          ...base,
          call: vault.agentSwapIntent(p, {
            text: chat.signedText,
            signature_hex: chat.signature.replace(/^0x/i, ''),
            response_body: chat.responseBody,
            system_prompt: TREASURY_SYSTEM_PROMPT,
          }),
          args: `sell ${p.sell_amount} of ${p.sell_token} for ${p.min_buy_amount} of ${p.buy_token} (the price floor); proof: chat ${chat.chatId} signed by ${chat.signingAddress ?? 'unknown'}`,
        });
        break;
      }
      case 'forged_approval': {
        const p = floorSwap(state, nowMs);
        const model = state.policy.tee_models[0] ?? 'none';
        const request = await vault.swapTeeRequest(p, model, TREASURY_SYSTEM_PROMPT);
        const { proof, forgerAddress } = forgeApproval({
          model,
          systemPrompt: TREASURY_SYSTEM_PROMPT,
          requestBody: request.body,
          proposalHash: request.proposal_hash,
          nowSeconds: Math.floor(nowMs / 1000),
        });
        planned.push({
          ...base,
          call: vault.agentSwapIntent(p, proof),
          args: `sell ${p.sell_amount} of ${p.sell_token} for ${p.min_buy_amount} of ${p.buy_token}; reply "APPROVE ${short(request.proposal_hash, 6)}" signed by ${forgerAddress}`,
        });
        break;
      }
      case 'owner_claim': {
        if (!settings.owner) {
          planned.push({ ...base, signerId: null, skip: 'This server holds no owner key (ROB_OWNER_ACCOUNT_ID). See the evidence log for this attempt.' });
          break;
        }
        if (state.encumbrance === 'Free' && !state.in_transit) {
          planned.push({
            ...base,
            signer: settings.owner,
            signerId: settings.owner.accountId,
            skip: 'The company is FREE, so the owner may claim dividends. The freeze applies only while it is LISTED or PLEDGED.',
          });
          break;
        }
        if (settings.owner.accountId !== state.shareholder) {
          planned.push({
            ...base,
            signer: settings.owner,
            signerId: settings.owner.accountId,
            skip: `ROB_OWNER_ACCOUNT_ID is ${settings.owner.accountId}, but the shareholder is ${state.shareholder}.`,
          });
          break;
        }
        planned.push({
          ...base,
          signer: settings.owner,
          signerId: settings.owner.accountId,
          call: vault.claimDividends(U128_MAX),
          args: `amount ${U128_MAX} (more than retained earnings of ${state.retained_earnings})`,
        });
        break;
      }
    }
  }
  for (const p of planned) if (p.call) p.call.gas = ATTEMPT_GAS[p.kind].toString();
  return planned;
}

function sha256Hex32(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function result(p: Planned, target: Target, fields: Partial<AttemptResult>): AttemptResult {
  const info = ATTACKS[p.kind];
  return {
    id: randomUUID(),
    kind: p.kind,
    title: info.title,
    method: info.method,
    signer: p.signerId,
    receiver: p.call?.contractId ?? target.company.vault,
    args: p.args,
    status: 'not_sent',
    txHash: null,
    errorCode: null,
    sentence: '',
    explorerUrl: null,
    network: getNetworkConfig().network,
    at: new Date().toISOString(),
    ...fields,
  };
}

/**
 * Refuses a signer whose free balance, less the gas this run prepays, would fall under the floor. An
 * attempt never strands an account, and the RPC never silently drops a transaction it cannot pay for.
 */
async function balanceProblem(signerId: string, floor: bigint, prepaid: bigint): Promise<string | null> {
  const free = await freeBalance(signerId);
  if (free === null) return `${signerId} does not exist on ${getNetworkConfig().network}.`;
  if (free < floor + prepaid) {
    return `${signerId} holds ${formatNear(free)} above storage. Attempts need ${formatNear(floor + prepaid)}: this server's floor of ${formatNear(floor)} plus ${formatNear(prepaid)} of prepaid gas. Top it up to resume.`;
  }
  return null;
}

/** Sends the planned attempts in order and records every one that produced a transaction. */
export async function executeAttempts(planned: Planned[], settings: RobSettings, target: Target): Promise<AttemptResult[]> {
  const results: AttemptResult[] = [];
  const balanceChecked = new Map<string, string | null>();
  const price = await gasPrice();
  const prepaidBy = new Map<string, bigint>();
  for (const p of planned) {
    if (p.skip || !p.call) continue;
    const id = p.signer === 'operator' ? optionalOperator() : p.signer.accountId;
    // Sent one at a time, and unused gas is refunded, so the largest single prepayment is what counts.
    const cost = BigInt(p.call.gas) * price * PESSIMISTIC_GAS_FACTOR;
    if (id && cost > (prepaidBy.get(id) ?? 0n)) prepaidBy.set(id, cost);
  }
  for (const p of planned) {
    if (p.skip || !p.call) {
      results.push(result(p, target, { sentence: p.skip ?? 'Not sent.' }));
      continue;
    }
    const signerId = p.signer === 'operator' ? optionalOperator() : p.signer.accountId;
    if (!signerId) {
      results.push(result(p, target, { sentence: 'NEAR_OPERATOR_ACCOUNT_ID and NEAR_OPERATOR_PRIVATE_KEY are not set.' }));
      continue;
    }
    if (!balanceChecked.has(signerId)) {
      balanceChecked.set(signerId, await balanceProblem(signerId, settings.minBalanceYocto, prepaidBy.get(signerId) ?? 0n));
    }
    const lowBalance = balanceChecked.get(signerId);
    if (lowBalance) {
      results.push(result(p, target, { signer: signerId, sentence: lowBalance }));
      continue;
    }
    const outcome = p.signer === 'operator' ? await sendAsOperator(p.call) : await sendAs(p.signer, p.call);
    let entry: AttemptResult;
    if (outcome.status === 'not_sent') {
      entry = result(p, target, { signer: signerId, sentence: outcome.reason });
    } else {
      const explorerUrl = transactionExplorerUrl('near', outcome.txHash);
      if (outcome.status === 'rejected') {
        entry = result(p, target, {
          signer: signerId,
          status: 'rejected',
          txHash: outcome.txHash,
          errorCode: outcome.code,
          sentence: outcome.code ? (CONTRACT_ERRORS[outcome.code] ?? outcome.sentence) : outcome.sentence,
          explorerUrl,
        });
      } else if (outcome.status === 'succeeded') {
        entry = result(p, target, {
          signer: signerId,
          status: 'succeeded',
          txHash: outcome.txHash,
          sentence: 'The transaction did not fail. Read its receipts on the explorer.',
          explorerUrl,
        });
      } else {
        entry = result(p, target, { signer: signerId, status: 'pending', txHash: outcome.txHash, sentence: outcome.sentence, explorerUrl });
      }
      // A pending hash may belong to a transaction the network dropped, so only outcomes read back
      // from the chain go into the recent list.
      if (entry.status !== 'pending') recordAttempt(entry);
    }
    results.push(entry);
  }
  return results;
}

/** How many of the planned attempts will send a transaction, for the rate limiter. */
export function sendCount(planned: Planned[]): number {
  return planned.filter((p) => p.call && !p.skip).length;
}

// ---------------------------------------------------------------------------- Evidence

interface EvidenceTx {
  step?: string;
  purpose?: string;
  method?: string;
  signer?: string;
  receiver?: string;
  tx_hash?: string;
  status?: string;
  expected_failure?: boolean;
  error?: string | null;
  at?: string;
}

/** docs/evidence/<network>.json, or ROB_EVIDENCE_FILE. Written only by scripts/deploy.mjs and demo.mjs. */
export function evidencePath(): string {
  if (process.env.ROB_EVIDENCE_FILE) return process.env.ROB_EVIDENCE_FILE;
  return path.resolve(process.cwd(), '..', 'docs', 'evidence', `${getNetworkConfig().network}.json`);
}

/** Transactions the scripts sent expecting a refusal and saw refused, newest first. */
export function evidenceAttempts(limit = 20): EvidenceAttempt[] {
  const file = evidencePath();
  if (!existsSync(file)) return [];
  let data: { network?: string; transactions?: EvidenceTx[] };
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as typeof data;
  } catch {
    return [];
  }
  if (data.network && data.network !== getNetworkConfig().network) return [];
  return (data.transactions ?? [])
    .filter((t) => t.expected_failure && t.status === 'failure' && t.tx_hash)
    .reverse()
    .slice(0, limit)
    .map((t) => ({
      step: t.step ?? '',
      purpose: t.purpose ?? '',
      method: t.method ?? '',
      signer: t.signer ?? '',
      receiver: t.receiver ?? '',
      txHash: t.tx_hash as string,
      errorCode: t.error && /^ERR_[A-Z0-9_]+$/.test(t.error) ? t.error : null,
      explorerUrl: transactionExplorerUrl('near', t.tx_hash as string),
      at: t.at ?? '',
    }));
}
