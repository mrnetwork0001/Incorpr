// Transcribes each VO clip with ElevenLabs speech-to-text and prints it under the script line,
// to catch misreads (names, acronyms). node scripts/vocheck.mjs [id ...]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, key, API } from "./env.mjs";
const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
const want = process.argv.slice(2);
for (const s of script.scenes) for (const [i, l] of s.lines.entries()) {
  const id = `${s.id}_${i}`;
  if (want.length && !want.includes(id)) continue;
  const fd = new FormData();
  fd.append("model_id", "scribe_v1");
  fd.append("file", new Blob([readFileSync(join(ROOT, "public/audio/vo", `${id}.mp3`))]), `${id}.mp3`);
  const res = await fetch(`${API}/speech-to-text`, { method: "POST", headers: { "xi-api-key": key }, body: fd });
  const body = await res.json();
  console.log(`${id}\n  script: ${l.text}\n  heard:  ${res.ok ? body.text : JSON.stringify(body).slice(0, 200)}`);
}
