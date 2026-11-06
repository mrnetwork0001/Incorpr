'use client';

// Treasury agent: the policy the vault enforces, a dry run of /api/rebalance, and, when the server
// allows it, execution: key registration, deposit, live quote, TEE approval, agent_swap_intent,
// solver relay publish and settlement. Every step shown here comes from the route's answer, which
// reads it from chain, the relay or NEAR AI Cloud.

import { useEffect, useState } from 'react';
import type { Policy, SignedIntent } from '@/lib/contracts';
import { Button, Glass, GlassHeader, KeyValue, Notice, TxHash, TxResult, type KeyValueItem } from '../../ui';
import s from './cockpit.module.css';
import { assetName, bpsToPercent, formatAsset, formatTime, formatUsdc } from './format';
import { Mono } from './mono';

export interface AgentProps {
  tokenId: string;
  policy: Policy;
  usdcToken: string;
  targetBps: [number, number, number];
  spendWindow: number;
  spentThisWindow: [string, string][];
  frozen: boolean;
  intentsKeyRegistered: boolean;
  latestIntentDeadlineMs: number;
}

interface Proposal {
  sell_token: string;
  sell_amount: string;
  buy_token: string;
  min_buy_amount: string;
  nonce_b64: string;
}

interface QuoteInfo {
  source: string;
  amount_in: string;
  amount_out: string;
  quote_hash: string | null;
  expiration_time: string | null;
  floor_min_buy: string;
}

interface PlanFields {
  proposal: Proposal;
  quote_source: string;
  quote: QuoteInfo;
  price_floor_min_buy: string;
  drift_bps: number[];
  total_micro_usd: string;
  capped_by_epoch_limit: boolean;
  skipped: { buy_token: string; reason: string }[];
  execution_enabled: boolean;
}

interface StepTx {
  tx_hash: string;
  explorer_url: string | null;
}

interface TeeInfo {
  chat_id: string;
  model: string;
  proposal_hash: string;
  signer: string;
  signer_in_policy: boolean;
  verification_summary: { passed: string[]; failed: string[]; notRun?: string[] } & Record<string, unknown>;
}

interface Executed extends PlanFields {
  setup: { intents_key: StepTx | null; deposit: (StepTx & { amount: string }) | null };
  tee: TeeInfo;
  firewall: string;
  sign: StepTx & { signed_intent: SignedIntent; nep413_hash: string; signature_verifies: boolean; failures: string[] };
  relay:
    | { state: 'not_submitted'; reason: string }
    | { state: 'failed'; error: string }
    | { state: 'published'; intent_hash: string; status: string; status_details: string | null; settlement_tx: string | null; settlement_explorer_url: string | null };
  balances: { before: Record<string, string>; after: Record<string, string> | null };
}

type Answer =
  | { state: 'noop'; reason: string; drift_bps: number[]; total_micro_usd: string }
  | {
      state: 'no_quote';
      quote_source: string;
      reason: string;
      planned: { sell_token: string; sell_amount: string; buy_token: string; price_floor_min_buy: string };
      skipped?: { buy_token: string; reason: string }[];
    }
  | ({ state: 'dry_run' } & PlanFields)
  | ({ state: 'rejected'; reason: string; model_output: string | null; chat_id: string } & PlanFields)
  | ({ state: 'quote_expired'; reason: string } & PlanFields)
  | ({ state: 'signed' | 'settled' | 'published' } & Executed);

type RunState =
  | { status: 'idle' }
  | { status: 'running'; mode: 'dry' | 'execute' }
  | { status: 'ok'; body: Answer }
  | { status: 'error'; code: string; message: string };

interface ServerInfo {
  prompt_sha256: string;
  network: string;
  execution_enabled: boolean;
  tee_configured: boolean;
}

const QUOTE_SOURCE: Record<string, string> = {
  solver_relay: 'NEAR Intents solver relay',
  '1click_dry_quote': '1Click dry quote (dry: true, commits nothing)',
};

const RELAY_STATUS: Record<string, string> = {
  PENDING: 'received by the relay, waiting for execution',
  TX_BROADCASTED: 'sent to intents.near',
  SETTLED: 'settled on intents.near',
  NOT_FOUND_OR_NOT_VALID: 'not settled: the relay did not find it or it failed',
};

export function AgentPanel({
  tokenId,
  policy,
  usdcToken,
  targetBps,
  spendWindow,
  spentThisWindow,
  frozen,
  intentsKeyRegistered,
  latestIntentDeadlineMs,
}: AgentProps) {
  const [run, setRun] = useState<RunState>({ status: 'idle' });
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void fetch('/api/rebalance', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<ServerInfo>) : null))
      .then((body) => setServer(body))
      .catch(() => setServer(null));
  }, []);

  async function call(mode: 'dry' | 'execute') {
    setConfirming(false);
    setRun({ status: 'running', mode });
    try {
      const res = await fetch('/api/rebalance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token_id: tokenId, dry_run: mode === 'dry', next_asset_if_unquoted: true }),
      });
      const body = (await res.json()) as Answer & { error?: { code?: string; message?: string } };
      if (body.error) {
        setRun({ status: 'error', code: body.error.code ?? `http_${res.status}`, message: body.error.message ?? `/api/rebalance answered HTTP ${res.status}` });
        return;
      }
      setRun({ status: 'ok', body });
    } catch (error) {
      setRun({ status: 'error', code: 'network', message: error instanceof Error ? error.message : String(error) });
    }
  }

  // The vault resets per-token spend each UTC day (EPOCH_MS); an older window counts as nothing spent.
  const spent = new Map(spendWindow === Math.floor(Date.now() / 86_400_000) ? spentThisWindow : []);
  const name = (asset: string) => assetName(asset, usdcToken);
  const promptMatches = server === null ? null : server.prompt_sha256 === policy.tee_prompt_hash;
  const intentLive = latestIntentDeadlineMs > Date.now();
  const canExecute = Boolean(server?.execution_enabled && server.tee_configured) && !frozen;
  const mainnet = server?.network === 'mainnet';

  return (
    <Glass as="section" pad="lg" aria-labelledby="agent-title">
      <GlassHeader
        title={<span id="agent-title">Treasury agent</span>}
        meta={frozen ? 'Frozen while encumbered' : canExecute ? 'Execution enabled' : 'Dry run only'}
      />

      {canExecute ? (
        <Notice tone="info" title={mainnet ? 'Execution moves real funds' : 'Execution on a test network'}>
          Execute registers the vault&apos;s intents key if needed, moves retained earnings onto intents.near, gets a live quote, asks the
          pinned TEE model to approve the exact proposal, and calls agent_swap_intent. The vault checks its allowlist, 24-hour cap, price floor
          and the TEE signature before the MPC signer signs. {mainnet ? 'The signed intent then goes to the solver relay.' : 'Only mainnet has a solver relay, so nothing settles here.'}
        </Notice>
      ) : (
        <Notice tone="info" title="Dry run on this server">
          The dry run reads balances, the charter target and a live quote, and builds the swap proposal the vault would check. It moves
          nothing. {server && !server.execution_enabled ? 'This server has execution switched off (INCORPR_ALLOW_MAINNET_REBALANCE).' : ''}
          {server && server.execution_enabled && !server.tee_configured ? 'This server has no NEAR AI key, so it cannot get a TEE approval.' : ''}
        </Notice>
      )}

      <KeyValue
        className={s.ledgerRows}
        items={[
          { label: 'Target', value: `BTC ${bpsToPercent(targetBps[0])}, SOL ${bpsToPercent(targetBps[1])}, USDC ${bpsToPercent(targetBps[2])}`, mono: true },
          { label: 'Operator', value: policy.operator, mono: true },
          { label: 'Allowed tokens', value: policy.allowed_tokens.map(name).join(', ') || 'none', mono: true },
          {
            label: '24-hour caps',
            value:
              policy.epoch_caps.length === 0 ? (
                'none set'
              ) : (
                <ul className={s.plainList}>
                  {policy.epoch_caps.map(([asset, cap]) => (
                    <li key={asset}>
                      {formatAsset(cap, asset, usdcToken)}, {formatAsset(spent.get(asset) ?? '0', asset, usdcToken)} spent in the current window
                    </li>
                  ))}
                </ul>
              ),
            mono: true,
          },
          { label: 'Price floors', value: `${policy.price_floors.length} pair(s)`, mono: true },
          { label: 'TEE models', value: policy.tee_models.join(', ') || 'none', mono: true },
          {
            label: 'TEE signers',
            value:
              policy.tee_signers.length === 0 ? 'none' : (
                <span className={s.stackTight}>
                  {policy.tee_signers.map((signer) => (
                    <Mono key={signer} value={signer} label="TEE signer address" full />
                  ))}
                </span>
              ),
          },
          {
            label: 'Pinned prompt',
            value: (
              <span className={s.stackTight}>
                <Mono value={policy.tee_prompt_hash || '(none)'} label="pinned prompt hash" />
                <span className={s.mutedSmall}>
                  {promptMatches === null
                    ? 'Could not read this server’s prompt hash.'
                    : promptMatches
                      ? 'Matches the sha256 of this server’s treasury prompt.'
                      : 'Differs from this server’s treasury prompt. The vault would refuse its approvals.'}
                </span>
              </span>
            ),
          },
          { label: 'Intents key', value: intentsKeyRegistered ? 'registered on the intents contract' : 'not registered: execute registers it (setup_intents_key)', mono: true },
          { label: 'Latest intent deadline', value: `${formatTime(latestIntentDeadlineMs)}${intentLive ? ' (live: blocks listing and pledging)' : ''}`, mono: true },
        ]}
      />

      <div className={s.actionRow}>
        <Button variant="quiet" onClick={() => void call('dry')} busy={run.status === 'running' && run.mode === 'dry'} busyLabel="Planning" disabled={frozen || run.status === 'running'}>
          Run a dry rebalance
        </Button>
        {canExecute && !confirming && (
          <Button variant="secondary" onClick={() => setConfirming(true)} busy={run.status === 'running' && run.mode === 'execute'} busyLabel="Executing" disabled={run.status === 'running'}>
            Execute rebalance
          </Button>
        )}
        {canExecute && confirming && (
          <>
            <Button variant="primary" onClick={() => void call('execute')}>
              {mainnet ? 'Confirm: sign and publish on mainnet' : 'Confirm: sign'}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        )}
        {frozen && <span className={s.mutedSmall}>The vault refuses agent calls while the company is listed, pledged or in transit.</span>}
      </div>
      {run.status === 'running' && run.mode === 'execute' && (
        <p className={s.mutedSmall}>Quote, TEE approval, MPC signature and settlement take up to two minutes.</p>
      )}

      {run.status === 'error' && <TxResult status="rejected" title="Rebalance refused" code={run.code} message={run.message} />}
      {run.status === 'ok' && <RunResult body={run.body} usdcToken={usdcToken} />}
    </Glass>
  );
}

function planItems(body: PlanFields, usdcToken: string): KeyValueItem[] {
  const p = body.proposal;
  const items: KeyValueItem[] = [
    { label: 'Sell', value: formatAsset(p.sell_amount, p.sell_token, usdcToken), mono: true },
    { label: 'Buy at least', value: formatAsset(p.min_buy_amount, p.buy_token, usdcToken), mono: true },
    { label: 'Price floor', value: formatAsset(body.price_floor_min_buy, p.buy_token, usdcToken), mono: true },
    { label: 'Drift', value: `${body.drift_bps.map((d) => bpsToPercent(d)).join(' / ')}${body.capped_by_epoch_limit ? ', capped by the 24-hour limit' : ''}`, mono: true },
    { label: 'Quote', value: QUOTE_SOURCE[body.quote_source] ?? body.quote_source },
  ];
  if (body.quote?.quote_hash) {
    items.push({ label: 'Quote hash', value: <Mono value={body.quote.quote_hash} label="solver quote hash" /> });
  }
  if (body.quote?.expiration_time) items.push({ label: 'Quote expires', value: body.quote.expiration_time, mono: true });
  for (const skip of body.skipped ?? []) {
    items.push({ label: `Skipped ${assetName(skip.buy_token, usdcToken)}`, value: skip.reason });
  }
  items.push({ label: 'Nonce', value: <Mono value={p.nonce_b64} label="intent nonce" /> });
  return items;
}

function balanceRows(balances: Executed['balances'], usdcToken: string): KeyValueItem[] {
  return Object.keys(balances.before).map((asset) => {
    const before = balances.before[asset] ?? '0';
    const after = balances.after?.[asset];
    const change = after === undefined ? '' : ` -> ${formatAsset(after, asset, usdcToken)} (${BigInt(after) - BigInt(before) >= 0n ? '+' : ''}${formatAsset((BigInt(after) - BigInt(before)).toString(), asset, usdcToken)})`;
    return { label: assetName(asset, usdcToken), value: `${formatAsset(before, asset, usdcToken)}${change}`, mono: true };
  });
}

function RunResult({ body, usdcToken }: { body: Answer; usdcToken: string }) {
  if (body.state === 'noop') {
    return (
      <TxResult status="ok" title="Nothing to rebalance" message={body.reason}>
        <p className={s.mutedSmall}>
          Drift {body.drift_bps.map((d) => bpsToPercent(d)).join(' / ')} on ${formatUsdc(body.total_micro_usd)} of treasury, counting retained earnings.
        </p>
      </TxResult>
    );
  }
  if (body.state === 'no_quote') {
    return (
      <TxResult status="rejected" title="No market for the planned swap" message={body.reason}>
        <p className={s.mutedSmall}>
          Planned: sell {formatAsset(body.planned.sell_amount, body.planned.sell_token, usdcToken)} for {assetName(body.planned.buy_token, usdcToken)}, floor{' '}
          {formatAsset(body.planned.price_floor_min_buy, body.planned.buy_token, usdcToken)}. Source: {QUOTE_SOURCE[body.quote_source] ?? body.quote_source}.
        </p>
      </TxResult>
    );
  }
  if (body.state === 'dry_run') {
    return (
      <TxResult status="ok" title="Proposal the vault would check" message="Not approved, not signed and not submitted.">
        <KeyValue items={planItems(body, usdcToken)} />
      </TxResult>
    );
  }
  if (body.state === 'rejected') {
    return (
      <TxResult status="rejected" title="The TEE model did not approve" message={`${body.reason}. Nothing was signed.`}>
        <KeyValue
          items={[
            { label: 'Model output', value: body.model_output ?? '(none)', mono: true },
            { label: 'Chat id', value: <Mono value={body.chat_id} label="NEAR AI chat id" /> },
            ...planItems(body, usdcToken),
          ]}
        />
      </TxResult>
    );
  }
  if (body.state === 'quote_expired') {
    return (
      <TxResult status="rejected" title="Quote expired before signing" message={body.reason}>
        <KeyValue items={planItems(body, usdcToken)} />
      </TxResult>
    );
  }
  return <Executed body={body} usdcToken={usdcToken} />;
}

function Executed({ body, usdcToken }: { body: Executed & { state: 'signed' | 'settled' | 'published' }; usdcToken: string }) {
  const { setup, tee, sign, relay } = body;
  const failedChecks = tee.verification_summary.failed ?? [];
  return (
    <div className={s.stack}>
      <TxResult status="ok" title="1. Plan and live quote" message="Firewall pre-checks passed: allowlist, 24-hour cap and price floor.">
        <KeyValue items={planItems(body, usdcToken)} />
      </TxResult>

      {(setup.intents_key || setup.deposit) && (
        <TxResult status="ok" title="2. Setup on intents.near">
          <KeyValue
            items={[
              ...(setup.intents_key ? [{ label: 'setup_intents_key', value: <TxHash value={setup.intents_key.tx_hash} /> }] : []),
              ...(setup.deposit
                ? [{ label: `Deposit ${formatAsset(setup.deposit.amount, body.proposal.sell_token, usdcToken)}`, value: <TxHash value={setup.deposit.tx_hash} /> }]
                : []),
            ]}
          />
        </TxResult>
      )}

      <TxResult
        status={failedChecks.length === 0 && tee.signer_in_policy ? 'ok' : 'rejected'}
        title="3. TEE approval"
        message={`The model answered APPROVE ${tee.proposal_hash.slice(0, 12)}…, and its signature recovers to a signer in the vault policy.`}
      >
        <KeyValue
          items={[
            { label: 'Model', value: tee.model, mono: true },
            { label: 'Chat id', value: <Mono value={tee.chat_id} label="NEAR AI chat id" /> },
            { label: 'Signer', value: <Mono value={tee.signer} label="TEE signer" full /> },
            { label: 'Checks', value: `${tee.verification_summary.passed?.length ?? 0} passed, ${failedChecks.length} failed${failedChecks.length ? `: ${failedChecks.join(', ')}` : ''}`, mono: true },
          ]}
        />
      </TxResult>

      <TxResult status={sign.signature_verifies ? 'ok' : 'rejected'} title="4. Vault firewall and MPC signature" hash={sign.tx_hash} message={body.firewall}>
        <KeyValue
          items={[
            { label: 'NEP-413 hash', value: <Mono value={sign.nep413_hash} label="NEP-413 hash" /> },
            { label: 'Signer key', value: <Mono value={sign.signed_intent.public_key} label="vault intents key" /> },
            { label: 'Signature', value: sign.signature_verifies ? 'verifies against the vault intents key' : `fails: ${sign.failures.join('; ')}` },
            { label: 'Message', value: <Mono value={sign.signed_intent.payload.message} label="intent message" full /> },
          ]}
        />
      </TxResult>

      {relay.state === 'published' ? (
        <TxResult
          status={relay.status === 'SETTLED' ? 'ok' : relay.status === 'NOT_FOUND_OR_NOT_VALID' ? 'rejected' : 'pending'}
          title="5. Solver relay"
          message={`${relay.status}: ${RELAY_STATUS[relay.status] ?? relay.status}${relay.status_details ? ` (${relay.status_details})` : ''}`}
          hash={relay.settlement_tx}
        >
          <KeyValue items={[{ label: 'Intent hash', value: <Mono value={relay.intent_hash} label="intent hash" /> }]} />
        </TxResult>
      ) : (
        <TxResult status="rejected" title="5. Solver relay" message={relay.state === 'failed' ? `Publish failed: ${relay.error}` : `Not submitted: ${relay.reason}`} />
      )}

      <TxResult status="ok" title={body.balances.after ? '6. intents.near balances, before -> after' : '6. intents.near balances before'}>
        <KeyValue items={balanceRows(body.balances, usdcToken)} />
      </TxResult>
    </div>
  );
}
