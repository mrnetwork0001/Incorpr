import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, enforceRateLimit, errorResponse, parseJsonBody } from '@/lib/api';
import { RegistryClient, VaultClient, serviceCallId, serviceOperator } from '@/lib/contracts';
import { transactionExplorerUrl } from '@/lib/near';
import {
  TeeApiKeyMissingError,
  buildChatBody,
  pickDefaultModel,
  runInference,
  summarizeVerification,
  teeConfigured,
  verifyChat,
} from '@/lib/nearAiTee';
import {
  OperatorNotConfiguredError,
  OperatorUnavailableError,
  operatorAccountId,
  operatorCall,
  TransactionFailedError,
  TransactionPendingError,
} from '@/lib/operator';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const RATE_LIMIT = { route: 'run-service', perIpPerMinute: 20, globalPerMinute: 120 };
const MAX_COMPLETION_TOKENS = 1024;

const Body = z.strictObject({
  token_id: z.string().regex(/^\d{1,20}$/, 'must be a decimal token id'),
  call_id: z.string().regex(/^[0-9a-f]{64}$/, 'must be serviceCallId(input, salt)'),
  salt: z.string().min(16).max(128),
  input: z.string().min(1).max(8_000),
});

const inFlight = new Set<string>();

interface ServedAnswer {
  model: string;
  inference: Awaited<ReturnType<typeof runInference>>;
  verification: Awaited<ReturnType<typeof verifyChat>>;
  summary: ReturnType<typeof summarizeVerification>;
  at: number;
}

// Verified answers whose record_service_call has not landed, by vault and call id. In process
// memory: a restart forgets them and the next retry runs inference again.
const UNRECORDED_TTL_MS = 6 * 60 * 60 * 1000;
const UNRECORDED_MAX = 500;
const unrecorded = new Map<string, ServedAnswer>();

function rememberUnrecorded(key: string, answer: ServedAnswer) {
  const now = Date.now();
  for (const [k, v] of unrecorded) if (now - v.at > UNRECORDED_TTL_MS) unrecorded.delete(k);
  while (unrecorded.size >= UNRECORDED_MAX) {
    const oldest = unrecorded.keys().next().value;
    if (oldest === undefined) break;
    unrecorded.delete(oldest);
  }
  unrecorded.set(key, answer);
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, RATE_LIMIT);
    const { token_id, call_id, salt, input } = await parseJsonBody(request, Body);

    if (serviceCallId(input, salt) !== call_id) {
      throw new ApiError(403, 'call_id is not the commitment to this input and salt');
    }
    if (!teeConfigured()) throw new TeeApiKeyMissingError();
    const operator = operatorAccountId();

    const company = await new RegistryClient(undefined, { finality: 'optimistic' }).getCompany(token_id);
    if (!company) throw new ApiError(404, `Company ${token_id} does not exist`);
    const vault = new VaultClient(company.vault, { finality: 'optimistic' });

    // The operator is checked before the payment. A client that probes with an unpaid call id gets
    // 402 only when this server could record a paid call on this vault, and 409 when it could not.
    const state = await vault.getState();
    if (serviceOperator(state) !== operator) {
      throw new ApiError(409, `${company.vault} accepts service calls only from ${serviceOperator(state)}`);
    }

    // Checked before inference, so an unpaid or replayed call spends no API credits.
    const payment = await vault.getPayment(call_id);
    if (!payment) throw new ApiError(402, `No payment for call ${call_id} on ${company.vault}`);
    if (payment.served) throw new ApiError(409, `Call ${call_id} was already served in chat ${payment.tee_chat_id}`);

    const key = `${company.vault}:${call_id}`;
    if (inFlight.has(key)) throw new ApiError(409, `Call ${call_id} is already running`);
    inFlight.add(key);
    try {
      // A verified answer whose record transaction did not land is kept here, so a retry of the
      // same paid call re-sends only the record and does not pay for inference again.
      let served = unrecorded.get(key);
      if (!served) {
        const model = await pickDefaultModel();
        const inference = await runInference(
          buildChatBody({ model, system: company.service_template, user: input, maxTokens: MAX_COMPLETION_TOKENS }),
        );
        const verification = await verifyChat(inference);
        served = { model, inference, verification, summary: summarizeVerification(verification), at: Date.now() };
      }
      const { model, inference, verification, summary } = served;

      // A failed check leaves the payment unserved, so the customer can retry the same call id.
      if (summary.failed.length > 0) {
        return NextResponse.json(
          {
            error: {
              code: 'tee_verification_failed',
              message: `TEE verification failed: ${summary.failed.join(', ')}`,
            },
            chat_id: inference.chatId,
            verification,
            verification_summary: summary,
          },
          { status: 502 },
        );
      }

      let record: { state: 'recorded' | 'pending' | 'failed' | 'not_sent'; tx_hash: string | null; error: string | null };
      try {
        const { txHash } = await operatorCall(vault.recordServiceCall(call_id, inference.chatId));
        record = { state: 'recorded', tx_hash: txHash, error: null };
      } catch (error) {
        // The customer keeps the verified answer. The call stays unserved until a record lands.
        if (error instanceof TransactionFailedError) {
          record = { state: 'failed', tx_hash: error.txHash, error: error.reason };
        } else if (error instanceof TransactionPendingError) {
          record = { state: 'pending', tx_hash: error.txHash, error: error.message };
        } else if (error instanceof OperatorUnavailableError || error instanceof OperatorNotConfiguredError) {
          record = { state: 'not_sent', tx_hash: null, error: error.message };
        } else {
          throw error;
        }
      }
      if (record.state === 'recorded') unrecorded.delete(key);
      else rememberUnrecorded(key, served);

      return NextResponse.json({
        content: inference.content,
        chat_id: inference.chatId,
        model,
        vault: company.vault,
        verification,
        verification_summary: summary,
        record,
        tx_hash: record.tx_hash,
        explorer_url: record.tx_hash ? transactionExplorerUrl('near', record.tx_hash) : null,
      });
    } finally {
      inFlight.delete(key);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
