import 'server-only';

// Process memory for the /rob routes: rate limiters, recent attempts and signed chat replies.
// Kept on globalThis because Next may load a module once per route bundle; every /rob route and
// the page must see the same counters. Nothing here survives a restart, and a multi-instance
// deployment multiplies the limits by its instance count.

import type { AttemptResult } from './attacks';
import { AttemptLimiter, type LimiterOptions } from './limits';

/** A chat reply this server received from NEAR AI Cloud, with its TEE signature. */
export interface StoredChat {
  chatId: string;
  model: string;
  requestBody: string;
  responseBody: string;
  signedText: string | null;
  signature: string | null;
  signingAddress: string | null;
  at: number;
}

interface RobStore {
  limiters: Map<string, AttemptLimiter>;
  attempts: AttemptResult[];
  chats: Map<string, StoredChat>;
}

const MAX_ATTEMPTS = 100;
const MAX_CHATS = 500;
const CHAT_TTL_MS = 60 * 60_000;

const globalStore = globalThis as typeof globalThis & { __incorprRob?: RobStore };

function store(): RobStore {
  globalStore.__incorprRob ??= { limiters: new Map(), attempts: [], chats: new Map() };
  return globalStore.__incorprRob;
}

/** One limiter per name and option set, so a changed setting starts a fresh count. */
export function limiter(name: string, options: LimiterOptions): AttemptLimiter {
  const key = `${name}:${options.perIpMax}:${options.perIpWindowMs}:${options.dailyMax}`;
  const limiters = store().limiters;
  let found = limiters.get(key);
  if (!found) {
    for (const existing of limiters.keys()) if (existing.startsWith(`${name}:`)) limiters.delete(existing);
    found = new AttemptLimiter(options);
    limiters.set(key, found);
  }
  return found;
}

/** Only attempts with a transaction hash are kept: an attempt without one did not happen. */
export function recordAttempt(result: AttemptResult): void {
  if (!result.txHash) return;
  const attempts = store().attempts;
  attempts.unshift(result);
  if (attempts.length > MAX_ATTEMPTS) attempts.length = MAX_ATTEMPTS;
}

export function recentAttempts(limit = 40): AttemptResult[] {
  return store().attempts.slice(0, limit);
}

export function saveChat(chat: StoredChat): void {
  const chats = store().chats;
  chats.set(chat.chatId, chat);
  const cutoff = Date.now() - CHAT_TTL_MS;
  for (const [id, entry] of chats) {
    if (chats.size <= MAX_CHATS && entry.at >= cutoff) break;
    chats.delete(id);
  }
}

export function findChat(chatId: string): StoredChat | null {
  const chat = store().chats.get(chatId);
  if (!chat || chat.at < Date.now() - CHAT_TTL_MS) return null;
  return chat;
}
