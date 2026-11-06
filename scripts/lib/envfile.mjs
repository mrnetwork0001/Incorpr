// Merges KEY=value pairs into a dotenv file. Lines for other keys and comments are kept as they
// are, so values such as NEAR_AI_API_KEY survive. The file is written with mode 0600.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export function readEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/** Returns the keys whose value changed. */
export function mergeEnvFile(path, updates) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const pending = new Map(Object.entries(updates));
  const changed = [];
  const out = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const key = match[1];
    const value = pending.get(key);
    pending.delete(key);
    if (match[2].trim() !== value) changed.push(key);
    return `${key}=${value}`;
  });
  if (pending.size) {
    out.push('', `# Written by scripts/deploy.mjs on ${new Date().toISOString()}`);
    for (const [key, value] of pending) {
      out.push(`${key}=${value}`);
      changed.push(key);
    }
  }
  writeFileSync(path, `${out.join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return changed;
}

/** Reads NEAR_AI_* settings from web/.env.local into process.env when the shell does not set them. */
export function loadAppEnv(path) {
  const values = readEnvFile(path);
  for (const key of ['NEAR_AI_API_KEY', 'NEAR_AI_CLOUD_URL', 'NEAR_AI_DEFAULT_MODEL', 'NEAR_AI_DIRECT_ENDPOINTS', 'NEAR_INTENTS_JWT', 'NEAR_INTENTS_ONE_CLICK_URL']) {
    if (!process.env[key] && values[key]) process.env[key] = values[key];
  }
}
