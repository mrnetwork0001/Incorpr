// ElevenLabs access for the audio scripts. The key is read at runtime from ELEVENLABS_API_KEY in
// the environment or in this project's video/.env (see dotenv.mjs). Never log or persist it.
import { ROOT, setting } from "./dotenv.mjs";

export { ROOT };
export const key = setting("ELEVENLABS_API_KEY", null);
if (!key) {
  console.error("ELEVENLABS_API_KEY is not set (environment or video/.env). Copy .env.example to .env and fill it in.");
  process.exit(1);
}

export const API = "https://api.elevenlabs.io/v1";

export async function retry(fn, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (/\b(401|402|403|422)\b/.test(String(e.message))) break; // not retryable
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw last;
}

// Error text never includes the key (only response bodies are echoed).
export async function post(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}
