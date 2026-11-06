// PARSER TESTS ONLY. These use a key generated on this machine, signed with viem, to exercise the
// hash, text and recovery code paths. Nothing here touches a TEE, and a pass proves nothing about
// any TEE. nearAiTee.live.test.ts covers the real attestation.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  TeeApiKeyMissingError,
  buildChatBody,
  checkChatSignature,
  checkReportData,
  failedGpuClaims,
  fetchChatSignature,
  parseSignedText,
  recoverEip191Address,
  reportDataFromQuote,
  runInference,
  sha256Hex,
  summarizeVerification,
} from '@/lib/nearAiTee';

const MODEL = 'parser/test-model';
const REQUEST = buildChatBody({ model: MODEL, system: 'S', user: 'U' });
const RESPONSE = '{"id":"chat-1","choices":[]}';

async function fixture(text: string) {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    address: account.address.toLowerCase(),
    signature: await account.signMessage({ message: text }),
  };
}

describe('chat signature parser (locally generated key, not a TEE)', () => {
  it('recovers the address viem signed with, for v of 27/28 and 0/1', async () => {
    const { address, signature } = await fixture('hello');
    expect(recoverEip191Address('hello', signature)).toBe(address);
    const lowered = signature.slice(0, -2) + (parseInt(signature.slice(-2), 16) - 27).toString(16).padStart(2, '0');
    expect(recoverEip191Address('hello', lowered)).toBe(address);
    expect(recoverEip191Address('other', signature)).not.toBe(address);
  });

  it('parses three-field and two-field signed text, and refuses others', () => {
    const r = 'a'.repeat(64);
    const s = 'b'.repeat(64);
    expect(parseSignedText(`m/x:${r}:${s}`)).toEqual({ kind: 'provider_tee', model: 'm/x', requestHash: r, responseHash: s });
    expect(parseSignedText(`${r}:${s}`)).toEqual({ kind: 'gateway', model: null, requestHash: r, responseHash: s });
    expect(parseSignedText(`a:b:${r}:${s}`)).toBeNull();
    expect(parseSignedText(`m:${r}:short`)).toBeNull();
  });

  it('passes each check for a consistent bundle', async () => {
    const text = `${MODEL}:${sha256Hex(REQUEST)}:${sha256Hex(RESPONSE)}`;
    const { address, signature } = await fixture(text);
    const checks = checkChatSignature({
      requestBody: REQUEST,
      responseBody: RESPONSE,
      model: MODEL,
      bundle: { text, signature, signing_address: address, signing_algo: 'ecdsa' },
    });
    expect(checks.signatureKind).toBe('provider_tee');
    expect(checks.requestHashMatches).toBe(true);
    expect(checks.responseHashMatches).toBe(true);
    expect(checks.signedModelMatchesRequest).toBe(true);
    expect(checks.eip191RecoversSigningAddress).toBe(true);
  });

  it('fails the specific check that a tampered field breaks', async () => {
    const text = `${MODEL}:${sha256Hex(REQUEST)}:${sha256Hex(RESPONSE)}`;
    const { address, signature } = await fixture(text);
    const bundle = { text, signature, signing_address: address, signing_algo: 'ecdsa' };

    const tamperedResponse = checkChatSignature({ requestBody: REQUEST, responseBody: `${RESPONSE} `, model: MODEL, bundle });
    expect(tamperedResponse.responseHashMatches).toBe(false);
    expect(tamperedResponse.requestHashMatches).toBe(true);

    const tamperedRequest = checkChatSignature({ requestBody: `${REQUEST} `, responseBody: RESPONSE, model: MODEL, bundle });
    expect(tamperedRequest.requestHashMatches).toBe(false);

    const otherModel = checkChatSignature({ requestBody: REQUEST, responseBody: RESPONSE, model: 'other/model', bundle });
    expect(otherModel.signedModelMatchesRequest).toBe(false);

    const otherSigner = checkChatSignature({
      requestBody: REQUEST,
      responseBody: RESPONSE,
      model: MODEL,
      bundle: { ...bundle, signing_address: `0x${'1'.repeat(40)}` },
    });
    expect(otherSigner.eip191RecoversSigningAddress).toBe(false);

    const badSignature = checkChatSignature({
      requestBody: REQUEST,
      responseBody: RESPONSE,
      model: MODEL,
      bundle: { ...bundle, signature: '0x1234' },
    });
    expect(badSignature.eip191RecoversSigningAddress).toBe(false);
    expect(badSignature.recoveredAddress).toBeNull();
  });

  it('reports hash checks as not run when the text does not parse, never as a pass', async () => {
    const { address, signature } = await fixture('nonsense');
    const checks = checkChatSignature({
      requestBody: REQUEST,
      responseBody: RESPONSE,
      model: MODEL,
      bundle: { text: 'nonsense', signature, signing_address: address, signing_algo: 'ecdsa' },
    });
    expect(checks.signedTextParsed).toBe(false);
    expect(checks.requestHashMatches).toMatch(/^not run/);
    expect(checks.responseHashMatches).toMatch(/^not run/);
  });

  it('builds the request in the key order the vault uses', () => {
    expect(REQUEST).toBe(
      '{"model":"parser/test-model","messages":[{"role":"system","content":"S"},{"role":"user","content":"U"}],"stream":false}',
    );
  });
});

describe('report_data parser (synthetic bytes, not a TEE)', () => {
  it('reads offset 568 of a v4 quote and checks address padding and nonce', () => {
    const address = `0x${'ab'.repeat(20)}`;
    const nonce = 'cd'.repeat(32);
    const quote = new Uint8Array(700);
    quote.set(Buffer.from(`${'ab'.repeat(20)}${'00'.repeat(12)}${nonce}`, 'hex'), 568);
    const reportData = reportDataFromQuote(Buffer.from(quote).toString('hex'));
    expect(checkReportData(reportData, address, nonce)).toEqual({ bindsSigningAddress: true, bindsNonce: true });
    expect(checkReportData(reportData, `0x${'ee'.repeat(20)}`, nonce).bindsSigningAddress).toBe(false);
    expect(checkReportData(reportData, address, 'ee'.repeat(32)).bindsNonce).toBe(false);
    expect(() => reportDataFromQuote('00'.repeat(100))).toThrow(/too short/);
  });
});

describe('NRAS claim parser (synthetic claims, not an NRAS token)', () => {
  const good = {
    secboot: true,
    dbgstat: 'disabled',
    measres: 'success',
    hwmodel: 'GH100 A01 GSP BROM',
    ueid: '1',
    'x-nvidia-attestation-warning': null,
    'x-nvidia-gpu-driver-rim-signature-verified': true,
    'x-nvidia-gpu-attestation-report-nonce-match': true,
  };

  it('accepts the documented values and names each failure', () => {
    expect(failedGpuClaims(good)).toEqual([]);
    expect(failedGpuClaims({ ...good, secboot: false })).toEqual(['secboot']);
    expect(failedGpuClaims({ ...good, dbgstat: 'enabled' })).toEqual(['dbgstat']);
    expect(failedGpuClaims({ ...good, 'x-nvidia-attestation-warning': 'old driver' })).toEqual([
      'x-nvidia-attestation-warning',
    ]);
    expect(failedGpuClaims({ ...good, 'x-nvidia-gpu-driver-rim-signature-verified': false })).toEqual([
      'x-nvidia-gpu-driver-rim-signature-verified',
    ]);
  });
});

describe('verification summary', () => {
  it('keeps pass, fail and not-run apart, and never treats a reason as a pass', () => {
    const summary = summarizeVerification({
      requestHashMatches: true,
      responseHashMatches: false,
      intelQuoteVerified: 'not run: Intel collateral fetch failed',
    });
    expect(summary.passed).toEqual(['requestHashMatches']);
    expect(summary.failed).toEqual(['responseHashMatches']);
    expect(summary.notRun).toEqual({ intelQuoteVerified: 'not run: Intel collateral fetch failed' });
  });
});

describe('without an API key', () => {
  it('throws the typed error that routes map to 503', async () => {
    const saved = process.env.NEAR_AI_API_KEY;
    delete process.env.NEAR_AI_API_KEY;
    try {
      await expect(runInference(REQUEST)).rejects.toBeInstanceOf(TeeApiKeyMissingError);
      await expect(fetchChatSignature({ chatId: 'x', model: MODEL, baseUrl: 'https://cloud-api.near.ai/v1' })).rejects.toBeInstanceOf(
        TeeApiKeyMissingError,
      );
    } finally {
      if (saved !== undefined) process.env.NEAR_AI_API_KEY = saved;
    }
  });
});
