'use client';

// Treasury agent: the policy the vault enforces, and a dry run of /api/rebalance. Execution is cut
// from this build, so this panel never asks the agent to sign.

import { useEffect, useState } from 'react';
import type { Policy } from '@/lib/contracts';
import { Button, Glass, GlassHeader, KeyValue, Notice, TxResult } from '../../ui';
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

type DryRun =
  | { state: 'noop'; reason: string; drift_bps: number; total_micro_usd: string }
  | { state: 'no_quote'; quote_source: string; reason: string; planned: { sell_token: string; sell_amount: string; buy_token: string; price_floor_min_buy: string; drift_bps: number } }
  | {
      state: 'dry_run';
      proposal: Proposal;
      quote_source: string;
      price_floor_min_buy: string;
      drift_bps: number;
      total_micro_usd: string;
      capped_by_epoch_limit: boolean;
    };

type RunState = { status: 'idle' } | { status: 'running' } | { status: 'ok'; body: DryRun } | { status: 'error'; code: string; message: string };

const QUOTE_SOURCE: Record<string, string> = {
  solver_relay: 'NEAR Intents solver relay',
  '1click_dry_quote': '1Click dry quote (dry: true, commits nothing)',
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
  const [serverPrompt, setServerPrompt] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/rebalance', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<{ prompt_sha256: string }>) : null))
      .then((body) => setServerPrompt(body?.prompt_sha256 ?? null))
      .catch(() => setServerPrompt(null));
  }, []);

  async function dryRun() {
    setRun({ status: 'running' });
    try {
      const res = await fetch('/api/rebalance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token_id: tokenId, dry_run: true }),
      });
      const body = (await res.json()) as DryRun & { error?: { code?: string; message?: string } };
      if (!res.ok || body.error) {
        setRun({ status: 'error', code: body.error?.code ?? `http_${res.status}`, message: body.error?.message ?? `/api/rebalance answered HTTP ${res.status}` });
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
  const promptMatches = serverPrompt === null ? null : serverPrompt === policy.tee_prompt_hash;
  const intentLive = latestIntentDeadlineMs > Date.now();

  return (
    <Glass as="section" pad="lg" aria-labelledby="agent-title">
      <GlassHeader title={<span id="agent-title">Treasury agent</span>} meta={frozen ? 'Frozen while encumbered' : 'Dry run only'} />

      <Notice tone="info" title="Execution is cut from this build">
        The dry run below reads balances, the charter target and a live quote, and builds the swap proposal the vault would check. It does not
        ask the TEE to approve it, does not call agent_swap_intent, and moves nothing.
      </Notice>

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
          { label: 'Intents key', value: intentsKeyRegistered ? 'registered on the intents contract' : 'not registered: anyone can call setup_intents_key', mono: true },
          { label: 'Latest intent deadline', value: `${formatTime(latestIntentDeadlineMs)}${intentLive ? ' (live: blocks listing and pledging)' : ''}`, mono: true },
        ]}
      />

      <div className={s.actionRow}>
        <Button variant="quiet" onClick={() => void dryRun()} busy={run.status === 'running'} busyLabel="Planning" disabled={frozen}>
          Run a dry rebalance
        </Button>
        {frozen && <span className={s.mutedSmall}>The vault refuses agent calls while the company is listed, pledged or in transit.</span>}
      </div>

      {run.status === 'error' && <TxResult status="rejected" title="Dry run refused" code={run.code} message={run.message} />}
      {run.status === 'ok' && <DryRunResult body={run.body} usdcToken={usdcToken} />}
    </Glass>
  );
}

function DryRunResult({ body, usdcToken }: { body: DryRun; usdcToken: string }) {
  if (body.state === 'noop') {
    return (
      <TxResult status="ok" title="Nothing to rebalance" message={body.reason}>
        <p className={s.mutedSmall}>
          Drift {bpsToPercent(body.drift_bps)} on ${formatUsdc(body.total_micro_usd)} of treasury.
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
  const p = body.proposal;
  return (
    <TxResult status="ok" title="Proposal the vault would check" message="Not signed and not submitted.">
      <KeyValue
        items={[
          { label: 'Sell', value: formatAsset(p.sell_amount, p.sell_token, usdcToken), mono: true },
          { label: 'Buy at least', value: formatAsset(p.min_buy_amount, p.buy_token, usdcToken), mono: true },
          { label: 'Price floor', value: formatAsset(body.price_floor_min_buy, p.buy_token, usdcToken), mono: true },
          { label: 'Drift', value: `${bpsToPercent(body.drift_bps)}${body.capped_by_epoch_limit ? ', capped by the 24-hour limit' : ''}`, mono: true },
          { label: 'Quote', value: QUOTE_SOURCE[body.quote_source] ?? body.quote_source },
          { label: 'Nonce', value: <Mono value={p.nonce_b64} label="intent nonce" /> },
        ]}
      />
    </TxResult>
  );
}
