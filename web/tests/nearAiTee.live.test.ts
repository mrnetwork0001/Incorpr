// Live: real /v1/models, real attestation report with a fresh nonce, real NVIDIA NRAS and real Intel
// quote verification with Intel PCS collateral. None of these need an API key today, though the
// vendored docs say the attestation endpoint does.
// Inference itself needs NEAR_AI_API_KEY and is skipped without it.

import { describe, expect, it } from 'vitest';
import {
  attestedChat,
  buildChatBody,
  directEndpointFor,
  fetchAttestationReport,
  isPrivateTeeModel,
  listLiveModels,
  pickDefaultModel,
  summarizeVerification,
  verifyAttestation,
} from '@/lib/nearAiTee';

describe('NEAR AI Cloud, live', () => {
  it('picks a default from the live list: ready, Private, with a direct host, and not DeepSeek-V3.1', async () => {
    const saved = process.env.NEAR_AI_DEFAULT_MODEL;
    delete process.env.NEAR_AI_DEFAULT_MODEL;
    try {
      const models = await listLiveModels();
      const model = await pickDefaultModel();
      const live = models.find((m) => m.id === model);
      expect(live).toBeDefined();
      expect(isPrivateTeeModel(live!)).toBe(true);
      expect(directEndpointFor(model)).not.toBeNull();
      expect(model).not.toBe('deepseek-ai/DeepSeek-V3.1');
      expect(models.some((m) => m.id === 'deepseek-ai/DeepSeek-V3.1')).toBe(false);
    } finally {
      if (saved !== undefined) process.env.NEAR_AI_DEFAULT_MODEL = saved;
    }
  });

  it('refuses a configured model that is not Private or not live', async () => {
    const saved = process.env.NEAR_AI_DEFAULT_MODEL;
    try {
      process.env.NEAR_AI_DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3.1';
      await expect(pickDefaultModel()).rejects.toThrow(/not in the live model list/);
      process.env.NEAR_AI_DEFAULT_MODEL = 'openai/gpt-6-luna';
      await expect(pickDefaultModel()).rejects.toThrow(/not a ready Private TEE model/);
    } finally {
      if (saved === undefined) delete process.env.NEAR_AI_DEFAULT_MODEL;
      else process.env.NEAR_AI_DEFAULT_MODEL = saved;
    }
  });

  it('the direct host for the default model serves that model', async () => {
    const model = await pickDefaultModel();
    const res = await fetch(`${directEndpointFor(model)}/models`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((m) => m.id)).toContain(model);
  });

  it('verifies a real model attestation: fresh nonce, TDX binding, Intel quote, NVIDIA NRAS', async () => {
    const model = await pickDefaultModel();
    const checks = await verifyAttestation({ model });
    console.log('[live attestation]', JSON.stringify({ model, ...checks }, null, 1));

    expect(checks.attestationNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(checks.attestedSigningAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(checks.attestationEchoesNonce).toBe(true);
    expect(checks.tdxReportDataBindsSigningAddress).toBe(true);
    expect(checks.tdxReportDataBindsNonce).toBe(true);
    // If Intel or NVIDIA is unreachable these are reason strings and this test fails, by design.
    expect(checks.intelQuoteVerified).toBe(true);
    expect(checks.composeHashMatchesMrConfig).toBe(true);
    expect(checks.nrasPayloadNonceMatches).toBe(true);
    expect(checks.nrasOverallResult).toBe(true);
    expect(checks.nrasEatNonceMatches).toBe(true);
    expect(checks.nrasGpuClaims).toBe(true);
    expect(checks.nrasJwtSignatures).toBe(true);
    expect(checks.nrasTokensUnexpired).toBe(true);
    expect(checks.nrasGpuCount).toBeGreaterThan(0);
  });

  it('reports false, not a pass, when the signer is not an attested node', async () => {
    const model = await pickDefaultModel();
    const checks = await verifyAttestation({ model, signingAddress: `0x${'1'.repeat(40)}` });
    expect(checks.signingAddressInFreshAttestation).toBe(false);
    expect(checks.intelQuoteVerified).toMatch(/^not run/);
    expect(checks.nrasOverallResult).toMatch(/^not run/);
  });

  it('reports the gateway TEE without GPU evidence as not run', async () => {
    const model = await pickDefaultModel();
    const report = await fetchAttestationReport(model, 'ab'.repeat(32));
    const gateway = report.gateway_attestation?.signing_address;
    expect(gateway).toMatch(/^0x[0-9a-f]{40}$/);
    const checks = await verifyAttestation({ model, signingAddress: gateway, kind: 'gateway' });
    expect(checks.signingAddressInFreshAttestation).toBe(true);
    expect(checks.tdxReportDataBindsNonce).toBe(true);
    expect(checks.intelQuoteVerified).toBe(true);
    expect(checks.nrasOverallResult).toMatch(/^not run/);
  });

  it.runIf(process.env.NEAR_AI_API_KEY)('runs real inference and verifies the whole chain', async () => {
    const model = await pickDefaultModel();
    const { inference, verification } = await attestedChat({
      model,
      system: 'Reply with one word.',
      user: 'Say ready.',
      maxTokens: 16,
    });
    console.log('[live chat]', buildChatBody({ model, system: '', user: '' }).length, inference.chatId);
    const summary = summarizeVerification(verification);
    console.log('[live chat summary]', JSON.stringify(summary));
    expect(summary.failed).toEqual([]);
    expect(verification.signatureKind).toBe('provider_tee');
    expect(verification.requestHashMatches).toBe(true);
    expect(verification.responseHashMatches).toBe(true);
    expect(verification.eip191RecoversSigningAddress).toBe(true);
    expect(verification.signingAddressInFreshAttestation).toBe(true);
    expect(verification.intelQuoteVerified).toBe(true);
    expect(verification.nrasOverallResult).toBe(true);
  });
});
