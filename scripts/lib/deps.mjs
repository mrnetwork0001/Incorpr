// Loads packages from web/node_modules, so the scripts need no install of their own.
// Node resolves bare specifiers relative to the importing file, and scripts/ has no node_modules,
// so this follows each package's `exports` map with the conditions Node uses for `import`.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WEB_DIR = join(REPO_ROOT, 'web');
const WEB_MODULES = join(WEB_DIR, 'node_modules');
const CONDITIONS = new Set(['node', 'import', 'default']);

function pickTarget(target) {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const entry of target) {
      const picked = pickTarget(entry);
      if (picked) return picked;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    for (const [condition, value] of Object.entries(target)) {
      if (!CONDITIONS.has(condition)) continue;
      const picked = pickTarget(value);
      if (picked) return picked;
    }
  }
  return null;
}

function resolveExports(exportsField, subpath) {
  const map =
    typeof exportsField === 'string' || Array.isArray(exportsField) || !Object.keys(exportsField).some((k) => k.startsWith('.'))
      ? { '.': exportsField }
      : exportsField;
  if (map[subpath] !== undefined) return pickTarget(map[subpath]);
  for (const [pattern, target] of Object.entries(map)) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
      const picked = pickTarget(target);
      return picked ? picked.replaceAll('*', middle) : null;
    }
  }
  return null;
}

export function resolveWebModule(specifier) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = `.${specifier.slice(name.length)}`;
  const root = join(WEB_MODULES, name);
  const manifestPath = join(root, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`${name} is not installed in web/node_modules. Run: cd web && npm ci`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let target;
  if (manifest.exports !== undefined) {
    target = resolveExports(manifest.exports, subpath);
    if (!target) throw new Error(`${specifier}: not exported by ${name}`);
  } else {
    target = subpath === '.' ? manifest.module ?? manifest.main ?? 'index.js' : subpath;
  }
  return join(root, target);
}

const cache = new Map();

export function webImport(specifier) {
  let loaded = cache.get(specifier);
  if (!loaded) {
    loaded = import(pathToFileURL(resolveWebModule(specifier)).href);
    cache.set(specifier, loaded);
  }
  return loaded;
}

/**
 * The prompt shareholders pin with `tee_prompt_hash` lives in web/src/lib/rebalance.ts. It is
 * imported, not copied, so the deployed hash always matches what the app sends. Node strips the
 * TypeScript types; the file's only runtime imports are @noble/hashes, resolved from web/.
 */
export async function loadTreasuryPrompt() {
  // web/package.json has no "type" field, so Node warns before parsing the file as ESM. Harmless.
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
    if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
    return emitWarning.call(process, warning, ...rest);
  };
  try {
    const mod = await import(pathToFileURL(join(WEB_DIR, 'src', 'lib', 'rebalance.ts')).href);
    return { prompt: mod.TREASURY_SYSTEM_PROMPT, hash: mod.treasuryPromptHash() };
  } finally {
    process.emitWarning = emitWarning;
  }
}
