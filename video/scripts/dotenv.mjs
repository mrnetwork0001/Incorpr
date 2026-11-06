// Reads /Users/mrnetwork/Incorpr/video/.env (this project's own file, nothing else) into an
// object. process.env wins over the file. Values are never logged.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_FILE = join(ROOT, ".env");

const file = {};
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) file[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/** A setting from the environment, then video/.env, then the fallback. Empty strings count as unset. */
export function setting(name, fallback = undefined) {
  const v = process.env[name] ?? file[name];
  return v != null && String(v).trim() !== "" ? String(v).trim() : fallback;
}
