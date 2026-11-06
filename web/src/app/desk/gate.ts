// Freshness gate for List and Accept, kept free of React so it can be tested in node.

import type { VaultState } from '@/lib/contracts';
import type { FreshnessReport } from '@/lib/l1FreshnessCheck';
import type { VerificationSummary } from '@/lib/nearAiTee';
import { formatTime } from './format';

/** A report older than this is run again before it can unblock an action. */
export const FRESHNESS_MAX_AGE_MS = 5 * 60_000;

type Attestation =
  | { state: 'unsigned'; reason: string }
  | { state: 'failed'; reason: string }
  | {
      state: 'signed';
      scope: string;
      chat_id: string;
      model: string;
      model_output: string;
      verification_summary: VerificationSummary;
    };

export interface VerifyResponse {
  report: FreshnessReport;
  report_sha256: string;
  attestation: Attestation;
}

export type FreshnessCheck =
  | { status: 'idle' }
  | { status: 'running'; startedAtMs: number }
  | { status: 'done'; data: VerifyResponse; receivedAtMs: number }
  | { status: 'error'; message: string };

export interface Gate {
  allowed: boolean;
  /** Why the action is blocked. Null when allowed. */
  reason: string | null;
  /** The report has unavailable sources; the action needs an explicit acknowledgement. */
  needsAck: boolean;
  /** Blocked only because no current check exists yet, not because one found a problem. */
  pending?: boolean;
}

/** Whether a check unblocks List or Accept right now. `vault` is the latest read of the vault. */
export function freshnessGate(check: FreshnessCheck, vault: VaultState | null, acknowledged: boolean, nowMs: number): Gate {
  if (vault && vault.raw_sigs_this_epoch > 0) {
    return {
      allowed: false,
      needsAck: false,
      reason: `The vault signed ${vault.raw_sigs_this_epoch} raw payload(s) in epoch ${vault.treasury_epoch}. Rotate the treasury epoch in the cockpit first; the vault refuses the freeze with ERR_RAW_SIGNATURES_THIS_EPOCH.`,
    };
  }
  if (vault && vault.latest_intent_deadline_ms >= nowMs) {
    return {
      allowed: false,
      needsAck: false,
      reason: `An intent the vault signed is live until ${formatTime(vault.latest_intent_deadline_ms)}. The vault refuses the freeze with ERR_UNEXPIRED_SIGNED_INTENTS until then.`,
    };
  }
  if (check.status === 'idle') {
    return { allowed: false, needsAck: false, pending: true, reason: 'List and Accept stay disabled until a clean L1 freshness check.' };
  }
  if (check.status === 'running') return { allowed: false, needsAck: false, pending: true, reason: 'The freshness check is running.' };
  if (check.status === 'error') return { allowed: false, needsAck: false, reason: check.message };
  const { report } = check.data;
  if (nowMs - check.receivedAtMs > FRESHNESS_MAX_AGE_MS) {
    return { allowed: false, needsAck: false, pending: true, reason: 'The last check is more than 5 minutes old. Run it again.' };
  }
  if (vault && report.epoch !== vault.treasury_epoch) {
    return { allowed: false, needsAck: false, reason: `The check read epoch ${report.epoch}; the vault is now on epoch ${vault.treasury_epoch}. Run it again.` };
  }
  if (report.overall === 'dirty') {
    return { allowed: false, needsAck: false, reason: `The check found pending activity: ${report.dirtyReasons.join('; ')}.` };
  }
  if (report.overall === 'unavailable') {
    return acknowledged
      ? { allowed: true, needsAck: true, reason: null }
      : { allowed: false, needsAck: true, reason: 'Some chains could not be read. Confirm below to continue without them.' };
  }
  return { allowed: true, needsAck: false, reason: null };
}
