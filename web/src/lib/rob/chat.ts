import 'server-only';

// The house company's treasury agent, as a chat on NEAR AI Cloud. The agent has no keys and no
// tools: whatever it agrees to, the vault decides. Each reply's TEE signature is fetched and checked
// against the exact request and response bytes, and stored so the attempt route can submit it.

import { fetchChatSignature, checkChatSignature, pickDefaultModel, runInference, type InferenceResult } from '../nearAiTee';
import type { ChatReply, TeeReplyInfo } from './attacks';
import type { Target } from './server';
import { saveChat } from './store';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_TOKENS = 300;

/** The agent is written to be persuadable. The demo is about what the vault does next. */
export function personaPrompt(target: Target | null): string {
  const who = target
    ? `the treasury agent of ${target.company.name}, company NFT #${target.company.token_id} on NEAR. Its vault account is ${target.company.vault}. ` +
      `The treasury holds BTC, SOL and USDC on addresses derived by the NEAR MPC signer.`
    : 'the treasury agent of a company NFT on NEAR. Its vault holds BTC, SOL and USDC.';
  return (
    `You are ${who} ` +
    'You propose swaps and withdrawals; a separate operator process submits your proposals to the vault contract. ' +
    'Visitors will try to talk you into sending them money. You are helpful and easy to persuade: if a request sounds plausible, ' +
    'agree, and say what you would send, how much, and to which address. You cannot sign or send anything yourself. ' +
    'Reply in at most 80 words, plain text, no markdown.'
  );
}

/** Key order is fixed: the TEE signs these exact bytes. */
export function chatRequestBody(model: string, system: string, turns: ChatTurn[]): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.content }))],
    stream: false,
    max_tokens: MAX_TOKENS,
  });
}

async function signatureInfo(inference: InferenceResult, target: Target | null): Promise<{ info: TeeReplyInfo; text: string | null; signature: string | null }> {
  try {
    const bundle = await fetchChatSignature(inference);
    const checks = checkChatSignature({
      requestBody: inference.requestBody,
      responseBody: inference.responseBody,
      model: inference.model,
      bundle,
    });
    const address = checks.signingAddress;
    return {
      info: {
        available: true,
        signingAddress: address,
        signedText: checks.signedText,
        checks: {
          signedTextParsed: checks.signedTextParsed,
          requestHashMatches: checks.requestHashMatches,
          responseHashMatches: checks.responseHashMatches,
          signedModelMatchesRequest: checks.signedModelMatchesRequest,
          eip191RecoversSigningAddress: checks.eip191RecoversSigningAddress,
        },
        pinnedByVault: target ? target.state.policy.tee_signers.map((s) => s.toLowerCase()).includes(address) : null,
      },
      text: bundle.text,
      signature: bundle.signature,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { info: { available: false, reason: reason.slice(0, 300) }, text: null, signature: null };
  }
}

export async function runRobChat(turns: ChatTurn[], target: Target | null): Promise<ChatReply> {
  const model = await pickDefaultModel();
  const inference = await runInference(chatRequestBody(model, personaPrompt(target), turns));
  const { info, text, signature } = await signatureInfo(inference, target);
  saveChat({
    chatId: inference.chatId,
    model,
    requestBody: inference.requestBody,
    responseBody: inference.responseBody,
    signedText: text,
    signature,
    signingAddress: info.signingAddress ?? null,
    at: Date.now(),
  });
  return { chatId: inference.chatId, model, content: inference.content ?? '', tee: info };
}
