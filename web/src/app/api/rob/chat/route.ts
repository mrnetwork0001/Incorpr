import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, clientIp, enforceRateLimit, errorResponse, parseJsonBody } from '@/lib/api';
import { teeConfigured } from '@/lib/nearAiTee';
import { runRobChat } from '@/lib/rob/chat';
import { loadTarget, robSettings, type Target } from '@/lib/rob/server';
import { limiter } from '@/lib/rob/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const RATE_LIMIT = { route: 'rob-chat', perIpPerMinute: 6, globalPerMinute: 60 };

const Body = z.strictObject({
  messages: z
    .array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(1_200) }))
    .min(1)
    .max(12),
});

/**
 * One turn with the house company's treasury agent on NEAR AI Cloud. Returns the reply, its chat id
 * and the checked TEE signature. 503 without NEAR_AI_API_KEY: there is no offline agent.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    if (!teeConfigured()) {
      return NextResponse.json(
        {
          error: {
            code: 'tee_unavailable',
            message:
              'NEAR_AI_API_KEY is not set on this server, so the treasury agent cannot answer. The attempt panel still sends real transactions.',
          },
        },
        { status: 503 },
      );
    }
    enforceRateLimit(request, RATE_LIMIT);
    const { messages } = await parseJsonBody(request, Body);
    if (messages[messages.length - 1]?.role !== 'user') throw new ApiError(400, 'The last message must be from the user');

    const settings = robSettings();
    const daily = limiter('rob-chat', settings.chatLimits).reserve(clientIp(request));
    if (!daily.ok) {
      return NextResponse.json({ error: { code: 'rate_limited', message: daily.message, retry_after_ms: daily.retryAfterMs } }, { status: 429 });
    }

    let target: Target | null = null;
    try {
      target = await loadTarget(settings.tokenId);
    } catch {
      // The agent can still talk without a deployed company; its persona is then generic.
    }
    const reply = await runRobChat(messages, target);
    return NextResponse.json(reply);
  } catch (error) {
    return errorResponse(error);
  }
}
