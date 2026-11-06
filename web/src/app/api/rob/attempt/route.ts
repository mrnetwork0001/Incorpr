import { NextResponse } from 'next/server';
import { z } from 'zod';
import { clientIp, enforceRateLimit, errorResponse, parseJsonBody } from '@/lib/api';
import { getNetworkConfig } from '@/lib/near';
import { ATTACK_ORDER, isBtcAddressShape, type AttackKind } from '@/lib/rob/attacks';
import { attemptsDisabledReason, executeAttempts, loadTarget, planAttempts, robSettings, sendCount } from '@/lib/rob/server';
import { limiter } from '@/lib/rob/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const RATE_LIMIT = { route: 'rob-attempt', perIpPerMinute: 30, globalPerMinute: 120 };

const Body = z.strictObject({
  kinds: z
    .array(z.enum(ATTACK_ORDER as [AttackKind, ...AttackKind[]]))
    .min(1)
    .max(ATTACK_ORDER.length)
    .optional(),
  destination: z
    .string()
    .trim()
    .max(100)
    .refine((v) => v === '' || isBtcAddressShape(v), 'must be a Bitcoin address')
    .optional(),
  chat_id: z.string().min(1).max(200).optional(),
});

/**
 * Sends real transactions that try to move the house company's money, from keys this server holds,
 * and returns each one's hash and the error the vault answered with. Attempts that could not be sent
 * come back as `not_sent` with no hash.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    enforceRateLimit(request, RATE_LIMIT);
    const body = await parseJsonBody(request, Body);
    const settings = robSettings();
    const disabled = attemptsDisabledReason(settings);
    if (disabled) {
      return NextResponse.json({ error: { code: 'attempts_disabled', message: disabled } }, { status: 503 });
    }
    const target = await loadTarget(settings.tokenId);
    const planned = await planAttempts(
      { kinds: body.kinds ?? [...ATTACK_ORDER], destination: body.destination || undefined, chatId: body.chat_id },
      settings,
      target,
    );

    const ip = clientIp(request);
    const toSend = sendCount(planned);
    const attempts = limiter('rob-attempt', settings.attemptLimits);
    if (toSend > 0) {
      const reservation = attempts.reserve(ip, toSend);
      if (!reservation.ok) {
        return NextResponse.json(
          { error: { code: 'rate_limited', message: reservation.message, retry_after_ms: reservation.retryAfterMs } },
          { status: 429 },
        );
      }
    }
    const results = await executeAttempts(planned, settings, target);
    const unsent = results.filter((r, i) => r.status === 'not_sent' && planned[i]?.call && !planned[i]?.skip).length;
    attempts.release(ip, unsent);

    return NextResponse.json({
      network: getNetworkConfig().network,
      token_id: target.company.token_id,
      vault: target.company.vault,
      results,
      usage: attempts.usage(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
