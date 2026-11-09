// Builds src/timing.json (absolute frames @30fps) from script.json and the generated VO.
//   node scripts/timing.mjs
// Word timings come from .cache/words/<scene>_<i>.json (voiceover.mjs). A line with no VO yet gets
// estimated timings (ESTIMATE_WPS words per second) and `audio: false`, so the film renders in
// title-card mode before any audio exists; the estimate is replaced as soon as the VO is generated.
// Music bpm/offset come from .cache/music.json (music.mjs; falls back to 100 bpm, offset 0).
// Budget: MAX frames (2:10). If over, it tightens gaps, then trims planned scene length where there is
// picture slack after the VO, in TRIM_ORDER. The close keeps at least END_HOLD.close frames after its last word.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const FPS = 30, MAX = 3900; // 2:10 ceiling (X plays long videos poorly)
const ESTIMATE_WPS = 2.6;
const END_HOLD = { close: 90, hook: 24 }; // min frames after last word, per scene
const TRIM_ORDER = ["incorporate", "earn", "sell", "borrow", "rob", "hook"];
const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
const PRON = script.pronounce || {};
const dur = (f) => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString());

/**
 * The voice reads `say` (e.g. "N F T"); captions show `text` ("NFT"). Each written word maps to as many
 * spoken words as its entry in script.json `pronounce` has; the written word spans all of them.
 */
function display(text, spoken) {
  const written = text.split(/\s+/).filter(Boolean);
  const counts = written.map((w) => (PRON[w] ? PRON[w].split(/\s+/).length : 1));
  if (counts.reduce((a, b) => a + b, 0) !== spoken.length) return null;
  let k = 0;
  return written.map((w, i) => {
    const a = spoken[k], z = spoken[k + counts[i] - 1];
    k += counts[i];
    return { word: w, start: a.start, end: z.end };
  });
}

function wordsOf(id, line) {
  const p = join(ROOT, ".cache/words", `${id}.json`);
  const mp3 = join(ROOT, "public/audio/vo", `${id}.mp3`);
  if (existsSync(p) && existsSync(mp3)) {
    const { tempo, words } = JSON.parse(readFileSync(p, "utf8"));
    const shown = display(line.text, words);
    if (!shown) console.warn(`${id}: spoken words do not line up with the text; captions show the spoken form`);
    return { audio: true, tempo, words: shown ?? words, seconds: dur(mp3) };
  }
  const words = line.text.split(/\s+/).filter(Boolean).map((w, i) => {
    const t = i / ESTIMATE_WPS;
    return { word: w, start: t, end: t + 0.85 / ESTIMATE_WPS };
  });
  // Sentence ends get a short breath.
  let shift = 0;
  for (const w of words) { w.start += shift; w.end += shift; if (/[.:?]$/.test(w.word)) shift += 0.25; }
  return { audio: false, tempo: 1, words, seconds: words.at(-1).end + 0.3 };
}

const LOOSE = { lead: 12, narration: 16, tail: 16 };
const TIGHT = { lead: 8, narration: 8, tail: 8 };

function build(sp, trim = {}) {
  let t = 0;
  const scenes = [];
  for (const scene of script.scenes) {
    const from = t;
    let cur = from + sp.lead;
    const lines = [];
    for (const [i, line] of scene.lines.entries()) {
      const id = `${scene.id}_${i}`;
      if (i) cur += sp.narration;
      const { audio, tempo, words, seconds } = wordsOf(id, line);
      const w = words.map((x) => ({
        word: x.word,
        start: cur + Math.round((x.start / tempo) * FPS),
        end: cur + Math.max(1, Math.round((x.end / tempo) * FPS)),
      }));
      lines.push({ voice: line.voice, text: line.text, file: `audio/vo/${id}.mp3`, audio, startFrame: cur, durationFrames: Math.ceil(seconds * FPS), words: w });
      cur = w.at(-1).end;
    }
    const durationInFrames = Math.max(Math.round(scene.seconds * FPS) - (trim[scene.id] || 0), cur + Math.max(sp.tail, END_HOLD[scene.id] || 0) - from);
    for (const l of lines) l.durationFrames = Math.min(l.durationFrames, from + durationInFrames - l.startFrame);
    scenes.push({ id: scene.id, from, durationInFrames, plannedFrames: Math.round(scene.seconds * FPS), lines });
    t = from + durationInFrames;
  }
  return { scenes, totalFrames: t };
}

let sp = LOOSE;
let res = build(sp);
if (res.totalFrames > MAX) { sp = TIGHT; res = build(sp); console.log(`over budget with loose spacing; tightened -> ${res.totalFrames}f`); }

const RESERVE = 45;
const trim = {};
if (res.totalFrames > MAX) {
  let left = res.totalFrames - MAX;
  for (const id of TRIM_ORDER) {
    if (left <= 0) break;
    const s = res.scenes.find((x) => x.id === id);
    const voEnd = s.lines.at(-1).words.at(-1).end - s.from;
    const n = Math.min(left, Math.max(0, s.durationInFrames - voEnd - RESERVE));
    if (n) { trim[id] = n; left -= n; }
  }
  res = build(sp, trim);
  console.log(`trimmed: ${Object.entries(trim).map(([k, v]) => `${k}-${v}`).join(" ") || "none"}`);
  if (res.totalFrames > MAX) console.error(`STILL OVER: ${res.totalFrames}f > ${MAX}f`);
}

const music = existsSync(join(ROOT, ".cache/music.json")) ? JSON.parse(readFileSync(join(ROOT, ".cache/music.json"), "utf8")) : {};
const hasMusic = existsSync(join(ROOT, "public/audio/music.mp3"));
const bpm = music.bpm || 100;
const offset = music.offsetSec || 0;
const beats = [];
for (let b = offset; b * FPS < res.totalFrames; b += 60 / bpm) beats.push(Math.round(b * FPS));
const sfxDir = join(ROOT, "public/audio/sfx");
const sfx = existsSync(sfxDir) ? readdirSync(sfxDir).filter((f) => f.endsWith(".mp3")).map((f) => f.slice(0, -4)).sort() : [];

const out = {
  fps: FPS,
  totalFrames: res.totalFrames,
  bpm,
  beats,
  music: hasMusic ? { file: "audio/music.mp3", source: music.source || "unknown" } : null,
  sfx,
  scenes: res.scenes.map(({ plannedFrames, ...s }) => s),
};
writeFileSync(join(ROOT, "src/timing.json"), JSON.stringify(out, null, 1));

const est = res.scenes.flatMap((s) => s.lines.map((l, i) => [`${s.id}_${i}`, l.audio])).filter(([, a]) => !a).map(([id]) => id);
console.log(`spacing: ${sp === LOOSE ? "loose" : "tight"}; estimated (no VO yet): ${est.join(" ") || "none"}; music: ${hasMusic ? "yes" : "no"}; sfx: ${sfx.length}`);
console.log("scene        from   dur(f)  sec    words");
for (const s of res.scenes) {
  console.log(`${s.id.padEnd(12)} ${String(s.from).padStart(5)} ${String(s.durationInFrames).padStart(7)} ${(s.durationInFrames / FPS).toFixed(1).padStart(5)} ${String(s.lines.reduce((n, l) => n + l.words.length, 0)).padStart(7)}`);
}
console.log(`total ${res.totalFrames}f = ${(res.totalFrames / FPS).toFixed(2)}s (max ${MAX}), bpm ${bpm}, ${beats.length} beats`);
