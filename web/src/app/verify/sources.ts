import 'server-only';

// Reads repo files at render: the contract test sources, the built wasm and ABI, and the evidence
// log written by scripts/deploy.mjs and scripts/demo.mjs. A deployment that ships only `web/` has
// none of these, and every reader returns null so the page can say so.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

let cachedRoot: string | null | undefined;

/** The repo root: the first of `cwd/..` and `cwd` that holds contracts/res. `next dev` runs in web/. */
export function repoRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
  const candidates = [path.resolve(process.cwd(), '..'), process.cwd()];
  cachedRoot = candidates.find((dir) => existsSync(path.join(dir, 'contracts', 'res'))) ?? null;
  return cachedRoot;
}

function readRepoFile(relative: string): Buffer | null {
  const root = repoRoot();
  if (!root) return null;
  try {
    return readFileSync(path.join(root, relative));
  } catch {
    return null;
  }
}

function readRepoText(relative: string): string | null {
  return readRepoFile(relative)?.toString('utf8') ?? null;
}

// ---------------------------------------------------------------------------- Tests

export interface TestLocation {
  file: string;
  line: number;
  kind: 'sandbox' | 'unit';
}

export const TEST_FILES: { file: string; kind: TestLocation['kind'] }[] = [
  { file: 'contracts/integration-tests/tests/sandbox.rs', kind: 'sandbox' },
  { file: 'contracts/company-vault/src/lib.rs', kind: 'unit' },
  { file: 'contracts/company-vault/src/chain.rs', kind: 'unit' },
  { file: 'contracts/incorpr-registry/src/lib.rs', kind: 'unit' },
  { file: 'contracts/incorpr-registry/src/charter.rs', kind: 'unit' },
];

export interface TestIndex {
  tests: Map<string, TestLocation>;
  sandbox: number;
  unit: number;
  /** Files that could not be read. */
  missing: string[];
}

/** Every `#[test]` and `#[tokio::test]` function in the contract sources, by name. */
export function testIndex(): TestIndex {
  const tests = new Map<string, TestLocation>();
  const missing: string[] = [];
  let sandbox = 0;
  let unit = 0;
  for (const { file, kind } of TEST_FILES) {
    const text = readRepoText(file);
    if (text === null) {
      missing.push(file);
      continue;
    }
    const lines = text.split('\n');
    let pending = false;
    lines.forEach((line, i) => {
      if (/^\s*#\[(tokio::)?test\]/.test(line)) {
        pending = true;
        return;
      }
      if (!pending) return;
      const fn = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/.exec(line);
      if (fn?.[1]) {
        tests.set(fn[1], { file, line: i + 1, kind });
        if (kind === 'sandbox') sandbox++;
        else unit++;
        pending = false;
      }
    });
  }
  return { tests, sandbox, unit, missing };
}

// ---------------------------------------------------------------------------- Built artifacts

export function repoWasm(name: 'company_vault' | 'incorpr_registry'): Uint8Array | null {
  const bytes = readRepoFile(`contracts/res/${name}.wasm`);
  return bytes ? new Uint8Array(bytes) : null;
}

/** Public method names in a contract ABI written by `cargo near build`. */
export function abiMethods(name: 'company_vault' | 'incorpr_registry'): string[] | null {
  const text = readRepoText(`contracts/res/${name}_abi.json`);
  if (!text) return null;
  try {
    const abi = JSON.parse(text) as { body?: { functions?: { name: string; modifiers?: string[] }[] } };
    return (abi.body?.functions ?? []).filter((f) => !(f.modifiers ?? []).includes('private')).map((f) => f.name);
  } catch {
    return null;
  }
}

export interface SourceFact {
  label: string;
  file: string;
  line: number | null;
  /** The matching source line, trimmed. */
  excerpt: string | null;
  ok: boolean;
}

function findLine(text: string, pattern: RegExp): { line: number; excerpt: string } | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (pattern.test(line)) return { line: i + 1, excerpt: line.trim() };
  }
  return null;
}

/**
 * Facts read from the contract source on each render: how the registry embeds and deploys the vault,
 * and that the vault source never builds a key or code action.
 */
export function sourceFacts(): SourceFact[] | null {
  const registryFile = 'contracts/incorpr-registry/src/lib.rs';
  const registry = readRepoText(registryFile);
  const vaultFiles = ['contracts/company-vault/src/lib.rs', 'contracts/company-vault/src/chain.rs'];
  const vaultSources = vaultFiles.map((f) => readRepoText(f));
  if (!registry || vaultSources.some((s) => s === null)) return null;

  const embed = findLine(registry, /include_bytes!\(.*company_vault\.wasm/);
  const deploy = findLine(registry, /\.deploy_contract\(VAULT_WASM/);
  const facts: SourceFact[] = [
    {
      label: 'The registry compiles the vault wasm into its own code',
      file: registryFile,
      line: embed?.line ?? null,
      excerpt: embed?.excerpt ?? null,
      ok: embed !== null,
    },
    {
      label: 'Each company account is created, funded and given exactly that code',
      file: registryFile,
      line: deploy?.line ?? null,
      excerpt: deploy?.excerpt ?? null,
      ok: deploy !== null,
    },
  ];

  // The creation batch runs from `Promise::new(vault)` to its `.then(`. It must not add a key.
  const start = registry.indexOf('Promise::new(vault)');
  const batch = start >= 0 ? registry.slice(start, registry.indexOf('.then(', start)) : '';
  facts.push({
    label: 'The creation batch adds no access key',
    file: registryFile,
    line: start >= 0 ? registry.slice(0, start).split('\n').length : null,
    excerpt: batch ? batch.replace(/\s+/g, ' ').trim() : null,
    ok: batch.length > 0 && !/add_(full_access_)?(access_)?key/.test(batch),
  });

  const keyOrCode = /\.(add_full_access_key|add_access_key|deploy_contract|delete_account|use_global_contract)\w*\(/;
  const offending = vaultFiles.flatMap((file, i) => {
    const hit = findLine(vaultSources[i] as string, keyOrCode);
    return hit ? [{ file, ...hit }] : [];
  });
  facts.push({
    label: 'The vault source never adds a key, deploys code or deletes its account',
    file: offending[0]?.file ?? vaultFiles.join(', '),
    line: offending[0]?.line ?? null,
    excerpt: offending[0]?.excerpt ?? null,
    ok: offending.length === 0,
  });
  return facts;
}

// ---------------------------------------------------------------------------- Evidence log

export interface EvidenceTx {
  seq: number;
  at?: string;
  step: string;
  purpose: string;
  method: string;
  signer: string;
  receiver: string;
  tx_hash: string;
  explorer_url?: string | null;
  status: 'success' | 'failure';
  expected_failure?: boolean;
  error?: string | null;
}

export interface EvidenceTeeNode {
  signing_address: string;
  checks?: Record<string, boolean | string>;
}

export interface EvidenceCompany {
  token_id: string;
  name: string;
  vault: string;
  btc?: string | null;
  evm?: string | null;
  sol?: string | null;
}

export interface EvidenceTeeCall {
  token_id: string;
  call_id: string;
  model: string;
  chat_id: string;
  signing_address?: string;
  checks?: Record<string, boolean | string>;
}

export interface EvidenceQuote {
  origin_asset: string;
  destination_asset: string;
  amount_in: string;
  amount_out?: string | null;
  min_amount_out?: string | null;
  floor_min_buy?: string | null;
  error?: string | null;
  at?: string;
}

export interface EvidenceBitcoin {
  at?: string;
  txid?: string | null;
  address?: string | null;
  [key: string]: unknown;
}

export interface Evidence {
  network: string;
  deployment: {
    registry?: string;
    operator?: string;
    deployer?: string;
    mpc_contract?: string;
    intents_contract?: string;
    usdc_token?: string;
    protocol_version?: number;
    registry_code_hash?: string;
    vault_wasm_sha256?: string;
    incorporation_cost_yocto?: string;
    updated_at?: string;
    tee?: { model?: string; prompt_hash?: string; nonce?: string; nodes?: EvidenceTeeNode[] };
  };
  companies: EvidenceCompany[];
  transactions: EvidenceTx[];
  quotes: EvidenceQuote[];
  bitcoin: EvidenceBitcoin[];
  tee_calls: EvidenceTeeCall[];
}

export type EvidenceLoad =
  | { kind: 'ok'; file: string; evidence: Evidence }
  | { kind: 'absent'; file: string }
  | { kind: 'invalid'; file: string; message: string };

/** docs/evidence/<network>.json. The sandbox log lives in the sandbox home and is never read here. */
export function loadEvidence(network: string): EvidenceLoad {
  const file = `docs/evidence/${network}.json`;
  const text = readRepoText(file);
  if (text === null) return { kind: 'absent', file };
  try {
    const raw = JSON.parse(text) as Partial<Evidence>;
    return {
      kind: 'ok',
      file,
      evidence: {
        network: raw.network ?? network,
        deployment: raw.deployment ?? {},
        companies: raw.companies ?? [],
        transactions: raw.transactions ?? [],
        quotes: raw.quotes ?? [],
        bitcoin: raw.bitcoin ?? [],
        tee_calls: raw.tee_calls ?? [],
      },
    };
  } catch (error) {
    return { kind: 'invalid', file, message: error instanceof Error ? error.message : String(error) };
  }
}
