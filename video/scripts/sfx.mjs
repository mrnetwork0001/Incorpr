// Sound effects via ElevenLabs /v1/sound-generation. Skips files that already exist.
//   node scripts/sfx.mjs                 all missing
//   ONLY=stamp,lock node scripts/sfx.mjs   force regenerate some
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";

const SFX = {
  tick: ["Single crisp clock tick, close, dry, short", 0.5],
  whoosh: ["Soft fast airy whoosh, smooth cinematic transition, no music", 1.0],
  click: ["Soft modern UI click, single, clean, short", 0.5],
  chime: ["Bright clean confirmation chime, two soft ascending notes, modern, short tail", 1.5],
  coin: ["A small soft cascade of coins landing, short, clean", 1.2],
  riser: ["Tension riser, rising airy synth swell building to a peak, cinematic, no drums", 3],
  impact: ["Deep clean cinematic impact with a warm sub tail, modern, single hit", 2],
  denied: ["Heavy digital access denied buzz, low and firm, single, clean, like a vault door refusing", 1.0],
  stamp: ["Firm soft rubber stamp hit on paper, single, close, dry", 0.6],
  typing: ["Fast soft keyboard typing on a laptop, close, dry, a few seconds, no music", 2.5],
  lock: ["Heavy metal vault bolt sliding shut, single, clean, close", 1.0],
  link: ["Soft magnetic click as two pieces lock together, satisfying, clean, short", 0.6],
  glitch: ["Short digital glitch stutter, a voice-like synth breaking up, clean, no music", 0.8],
  sign: ["Quick confident pen signature scratch on paper, close, dry", 0.8],
  slide: ["Smooth heavy object sliding across a table then settling, satisfying, short", 1.0],
};

const dir = join(ROOT, "public/audio/sfx");
mkdirSync(dir, { recursive: true });
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;

for (const [name, [text, dur]] of Object.entries(SFX)) {
  const f = join(dir, `${name}.mp3`);
  if (only ? !only.includes(name) : existsSync(f)) { console.log(`${name}: skip`); continue; }
  try {
    const buf = await retry(async () => {
      const res = await post("/sound-generation?output_format=mp3_44100_128", { text, duration_seconds: dur, prompt_influence: 0.5 });
      return Buffer.from(await res.arrayBuffer());
    });
    writeFileSync(f, buf);
    console.log(`${name}: ${(buf.length / 1024).toFixed(0)}kb`);
  } catch (e) { console.error(`${name}: FAILED ${e.message}`); }
}
