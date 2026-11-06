// Reads the TEE signer addresses for a NEAR AI Cloud model from a fresh attestation report and
// checks each node's Intel TDX quote before the address goes into the registry's tee_signers.
// The checks follow web/src/lib/nearAiTee.ts (report_data layout, dcap-qvl verification).
// Nothing here falls back to a configured or remembered address: no verified report, no deploy.

import { randomBytes } from 'node:crypto';
import { CliError } from './cli.mjs';
import { webImport } from './deps.mjs';

const { keccak_256 } = await webImport('@noble/hashes/sha3.js');
const { bytesToHex, hexToBytes } = await webImport('@noble/hashes/utils.js');

const INTEL_PCS_URL = 'https://api.trustedservices.intel.com/tdx/certification/v4/';
const ACCEPTED_TCB_STATUS = new Set(['UpToDate', 'OutOfDate']);
const TDX_V4_REPORT_DATA_OFFSET = 48 + 520;

export function nearAiBaseUrl() {
  return (process.env.NEAR_AI_CLOUD_URL || 'https://cloud-api.near.ai/v1').replace(/\/$/, '');
}

function authHeaders() {
  const headers = { accept: 'application/json' };
  if (process.env.NEAR_AI_API_KEY) headers.authorization = `Bearer ${process.env.NEAR_AI_API_KEY}`;
  return headers;
}

/** The model must be listed, ready and owned by nearai, the hosts NEAR itself attests. */
export async function checkModelLive(model) {
  const res = await fetch(`${nearAiBaseUrl()}/models`, { headers: authHeaders(), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new CliError(`GET ${nearAiBaseUrl()}/models returned HTTP ${res.status}`);
  const entry = ((await res.json()).data ?? []).find((m) => m.id === model);
  if (!entry) throw new CliError(`model ${model} is not in the live NEAR AI Cloud model list`);
  if (entry.owned_by !== 'nearai' || entry.is_ready !== true) {
    throw new CliError(`model ${model} is not a ready nearai-owned model (owned_by=${entry.owned_by}, is_ready=${entry.is_ready})`);
  }
  return entry;
}

function addressFromPublicKey(publicKeyHex) {
  let raw = hexToBytes(publicKeyHex.replace(/^0x/i, ''));
  if (raw.length === 65 && raw[0] === 4) raw = raw.subarray(1);
  if (raw.length !== 64) return null;
  return `0x${bytesToHex(keccak_256(raw).slice(12))}`;
}

async function verifyIntel(quoteHex, expectedReportData) {
  const qvl = await webImport('@phala/dcap-qvl');
  const quote = Buffer.from(quoteHex.replace(/^0x/i, ''), 'hex');
  let collateral;
  try {
    collateral = await qvl.getCollateral(INTEL_PCS_URL, quote);
  } catch (error) {
    return { intelQuoteVerified: `not run: Intel collateral fetch failed: ${error.message}`, intelTcbStatus: null };
  }
  try {
    const verified = qvl.verify(quote, collateral, Math.floor(Date.now() / 1000));
    const reportData = verified.report?.data?.reportData;
    const matches = reportData ? bytesToHex(reportData) === bytesToHex(expectedReportData) : false;
    return {
      intelQuoteVerified: ACCEPTED_TCB_STATUS.has(String(verified.status)) && matches,
      intelTcbStatus: String(verified.status),
    };
  } catch (error) {
    return { intelQuoteVerified: false, intelTcbStatus: `rejected: ${error.message}` };
  }
}

/**
 * Fetches `/attestation/report?model=..&nonce=..` and returns every model node whose checks pass.
 * Throws when the report cannot be fetched, has no model nodes, or any node fails a check.
 * A check that could not run (Intel PCS unreachable) also throws unless `allowUnverifiedQuote`.
 */
export async function attestedSigners(model, { allowUnverifiedQuote = false } = {}) {
  const nonce = randomBytes(32).toString('hex');
  const params = new URLSearchParams({ model, signing_algo: 'ecdsa', nonce });
  const url = `${nearAiBaseUrl()}/attestation/report?${params}`;
  let report;
  try {
    const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    report = await res.json();
  } catch (error) {
    throw new CliError(`attestation report for ${model} unavailable (${error.message}). Refusing to deploy without real TEE signers.`);
  }
  const entries = report.model_attestations ?? [];
  if (entries.length === 0) throw new CliError(`attestation report for ${model} lists no model nodes`);

  const nodes = [];
  for (const entry of entries) {
    const address = String(entry.signing_address ?? '').toLowerCase();
    const checks = {};
    checks.modelNameMatches = entry.model_name === undefined ? 'not run: no model_name' : entry.model_name === model;
    checks.signingAlgoEcdsa = entry.signing_algo === 'ecdsa';
    checks.echoesNonce = entry.request_nonce === nonce;
    checks.publicKeyMatchesAddress = entry.signing_public_key
      ? addressFromPublicKey(entry.signing_public_key) === address
      : 'not run: no signing_public_key';
    let reportData = null;
    try {
      const quote = hexToBytes(String(entry.intel_quote).replace(/^0x/i, ''));
      reportData = quote.slice(TDX_V4_REPORT_DATA_OFFSET, TDX_V4_REPORT_DATA_OFFSET + 64);
      const expected = new Uint8Array(32);
      expected.set(hexToBytes(address.replace(/^0x/, '')).subarray(0, 32));
      checks.reportDataBindsAddress = bytesToHex(reportData.subarray(0, 32)) === bytesToHex(expected);
      checks.reportDataBindsNonce = bytesToHex(reportData.subarray(32, 64)) === nonce;
    } catch (error) {
      checks.reportDataBindsAddress = false;
      checks.reportDataBindsNonce = false;
    }
    const intel = reportData ? await verifyIntel(entry.intel_quote, reportData) : { intelQuoteVerified: false, intelTcbStatus: null };
    checks.intelQuoteVerified = intel.intelQuoteVerified;
    checks.nvidiaGpuEvidence = 'not run: checked by the app per chat (web/src/lib/nearAiTee.ts verifyNras)';

    const failed = Object.entries(checks).filter(([, v]) => v === false).map(([k]) => k);
    const notRun = Object.entries(checks).filter(([k, v]) => typeof v === 'string' && k !== 'nvidiaGpuEvidence' && k !== 'modelNameMatches');
    if (!/^0x[0-9a-f]{40}$/.test(address)) failed.push('signingAddressFormat');
    if (failed.length) throw new CliError(`attestation node ${address || '(none)'} failed: ${failed.join(', ')}`);
    if (notRun.length && !allowUnverifiedQuote) {
      throw new CliError(
        `attestation node ${address}: ${notRun.map(([k, v]) => `${k} ${v}`).join('; ')}. Rerun when Intel PCS is reachable, or pass --allow-unverified-quote to accept a quote whose signature chain was not checked.`,
      );
    }
    nodes.push({ signing_address: address, intel_tcb_status: intel.intelTcbStatus, checks });
  }
  return { model, nonce, url: `${nearAiBaseUrl()}/attestation/report`, nodes, signers: [...new Set(nodes.map((n) => n.signing_address))] };
}
