// The "why it is safe" panel on /rob lists the vault's checks in execution order. This reads
// contracts/company-vault/src/lib.rs, inlines the helper functions each method calls, and checks that
// the listed error codes appear in that order, so the panel cannot drift from the contract.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACKS, ATTACK_ORDER, GUARDED_METHODS } from '@/lib/rob/attacks';
import { CONTRACT_ERRORS } from '@/lib/txOutcome';

const SOURCE = readFileSync(path.resolve(__dirname, '../../contracts/company-vault/src/lib.rs'), 'utf8');

/** Index just past the brace that closes the one at `open`, skipping strings and comments. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (ch === '"') {
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('unbalanced braces');
}

function functionBodies(text: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const re = /\bfn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = text.indexOf('{', m.index);
    if (open < 0) continue;
    // A declaration without a body ends in `;`. Array types such as `[u8; 32]` also hold one.
    if (text.slice(m.index, open).replace(/\[[^\]]*\]/g, '').includes(';')) continue;
    const name = m[1] as string;
    if (!bodies.has(name)) bodies.set(name, text.slice(open, matchBrace(text, open)));
  }
  return bodies;
}

const BODIES = functionBodies(SOURCE);

/** The method body with every call to a function defined in the file replaced by that function's body. */
function inline(name: string, depth = 4, seen = new Set<string>()): string {
  const body = BODIES.get(name);
  if (!body) throw new Error(`fn ${name} not found in company-vault`);
  if (depth === 0) return body;
  const next = new Set(seen).add(name);
  return body.replace(/\b(?:self\.)?([a-z_][a-z0-9_]*)\(/g, (call, callee: string) => {
    if (callee === name || next.has(callee) || !BODIES.has(callee)) return call;
    return `${call}/*inlined*/${inline(callee, depth - 1, next)}`;
  });
}

describe('why-it-is-safe panel matches company-vault', () => {
  it('finds every guarded method in the contract', () => {
    for (const { method } of GUARDED_METHODS) expect(BODIES.has(method), method).toBe(true);
  });

  for (const guarded of GUARDED_METHODS) {
    it(`${guarded.method}: the listed checks run in this order`, () => {
      const code = inline(guarded.method);
      let cursor = 0;
      for (const check of guarded.checks) {
        const found = check.codes.map((c) => code.indexOf(`"${c}"`, cursor)).filter((i) => i >= 0);
        expect(found.length, `${guarded.method}: "${check.what}" (${check.codes.join(', ')}) after position ${cursor}`).toBeGreaterThan(0);
        cursor = Math.min(...found);
      }
    });
  }

  it('every listed code exists in the vault source and has a sentence in txOutcome', () => {
    for (const { checks } of GUARDED_METHODS) {
      for (const { codes } of checks) {
        for (const c of codes) {
          expect(SOURCE.includes(`"${c}"`), c).toBe(true);
          expect(CONTRACT_ERRORS[c], c).toBeTruthy();
        }
      }
    }
  });

  it('every attack targets a guarded method, so the panel explains each refusal', () => {
    const guarded = new Set(GUARDED_METHODS.map((g) => g.method));
    for (const kind of ATTACK_ORDER) expect(guarded.has(ATTACKS[kind].method), kind).toBe(true);
  });

  it('detects a wrong order (self-check of this test)', () => {
    const code = inline('agent_withdraw_intent');
    const destination = code.indexOf('"ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION"');
    const operator = code.indexOf('"ERR_ONLY_TEE_TREASURY_AGENT"');
    expect(operator).toBeGreaterThanOrEqual(0);
    expect(destination).toBeGreaterThan(operator);
    expect(code.indexOf('"ERR_ONLY_TEE_TREASURY_AGENT"', destination)).toBe(-1);
  });
});
