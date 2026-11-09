// Builds src/timing.json (absolute frames @30fps) from script.json + generated VO.
//   node scripts/timing.mjs
// Reads word timings from .cache/words/*.json and music bpm/offset from .cache/music.json
// (written by music.mjs; falls back to 100 bpm, offset 0).
// Budget: 5370f (2:59), the hard ceiling being 3:00 including the end card. Voices play at natural pace (no atempo). If over, it tightens gaps,
// then trims planned scene length where there is picture slack after the VO, in TRIM_ORDER
// (montage first, then idea, then the demo scenes). The close always keeps >= 60f after its last word.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const FPS = 30, MAX = 5370; // 2:59 ceiling
const END_HOLD = { close: 130, turn: 30, open: 24 }; // min frames after last word, per scene
const TRIM_ORDER = ["incorporate", "earn", "treasury", "sell", "borrow", "rob", "whynear", "problem", "proof", "open"];
const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
const dur = (f) => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString());
const rawWordsOf = (id) => JSON.parse(readFileSync(join(ROOT, ".cache/words", `${id}.json`), "utf8"));
// The voice reads `say` ("N F T", "Incorper"); captions show `text` ("NFT", "Incorpr"). Each written word
// takes the timing of the spoken tokens it expands to: the token counts of text and say are aligned word by word.
const tokens = (s) => s.trim().split(/\s+/);
function wordsOf(id) {
  const [sid, i] = id.split(/_(?=\d+$)/);
  const line = script.scenes.find((s) => s.id === sid).lines[Number(i)];
  const raw = rawWordsOf(id);
  if (!line.say) return raw;
  const text = tokens(line.text), say = tokens(line.say), spoken = raw.words;
  if (say.length !== spoken.length) { console.warn(`${id}: ${spoken.length} timed tokens for ${say.length} say tokens; captions use the spoken form`); return raw; }
  // Map each text word to how many say tokens it became, by re-deriving its say form.
  const out = []; let k = 0;
  for (const w of text) {
    const n = tokens(SAY(w)).length;
    const seg = spoken.slice(k, k + n);
    out.push({ word: w, start: seg[0].start, end: seg.at(-1).end });
    k += n;
  }
  if (k !== spoken.length) { console.warn(`${id}: alignment off (${k}/${spoken.length}); captions use the spoken form`); return raw; }
  return { ...raw, words: out };
}
const MAP = { NEAR: "near", NFT: "N F T", USDC: "U S D C", TEE: "T E E", AI: "A I", EVM: "E V M", UTC: "U T C", Incorpr: "Incorper", PM: "P M" };
function SAY(w) { return w.replace(/\b(NEAR|NFT|USDC|TEE|AI|EVM|UTC|Incorpr|PM)\b/g, (m) => MAP[m]); }
const show = (w) => w;

const LOOSE = { lead: 12, dialogue: 10, narration: 16, tail: 16 };
const TIGHT = { lead: 8, dialogue: 6, narration: 8, tail: 8 };

function build(sp, trim = {}) {
  let t = 0;
  const scenes = [];
  for (const scene of script.scenes) {
    const from = t;
    let cur = from + sp.lead;
    let prevVoice = null;
    const lines = [];
    for (const [i, line] of scene.lines.entries()) {
      const id = `${scene.id}_${i}`;
      if (prevVoice) cur += prevVoice === "narrator" || line.voice === "narrator" ? sp.narration : sp.dialogue;
      const { tempo, words } = wordsOf(id);
      const file = `audio/vo/${id}.mp3`;
      const fileFrames = Math.ceil(dur(join(ROOT, "public", file)) * FPS);
      const w = words.map((x) => ({
        word: show(x.word),
        start: cur + Math.round((x.start / tempo) * FPS),
        end: cur + Math.max(1, Math.round((x.end / tempo) * FPS)),
      }));
      const speechEnd = w.at(-1).end;
      lines.push({ voice: line.voice, text: line.text, file, audio: true, startFrame: cur, durationFrames: fileFrames, speechEndFrame: speechEnd, words: w });
      cur = speechEnd;
      prevVoice = line.voice;
    }
    const durationInFrames = Math.max(Math.round(scene.seconds * FPS) - (trim[scene.id] || 0), cur + Math.max(sp.tail, END_HOLD[scene.id] || 0) - from);
    // keep each clip inside its scene (trailing mp3 silence only)
    for (const l of lines) l.durationFrames = Math.min(l.durationFrames, from + durationInFrames - l.startFrame);
    scenes.push({ id: scene.id, from, durationInFrames, plannedFrames: Math.round(scene.seconds * FPS), lines });
    t = from + durationInFrames;
  }
  return { scenes, totalFrames: t };
}

let sp = LOOSE;
let res = build(sp);
if (res.totalFrames > MAX) { sp = TIGHT; res = build(sp); console.log(`over budget with loose spacing; tightened -> ${res.totalFrames}f`); }

// Then trim planned lengths in TRIM_ORDER, keeping >= RESERVE frames of picture after each scene's VO.
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
const bpm = music.bpm || 100;
const offset = music.offsetSec || 0;
const beats = [];
for (let b = offset; b * FPS < res.totalFrames; b += 60 / bpm) beats.push(Math.round(b * FPS));

const out = {
  fps: FPS,
  totalFrames: res.totalFrames,
  bpm,
  beats,
  music: existsSync(join(ROOT, "public/audio/music.mp3")) ? { file: "audio/music.mp3", source: music.source || "unknown" } : null,
  sfx: existsSync(join(ROOT, "public/audio/sfx")) ? readdirSync(join(ROOT, "public/audio/sfx")).filter((f) => f.endsWith(".mp3")).map((f) => f.slice(0, -4)) : [],
  scenes: res.scenes.map(({ plannedFrames, ...s }) => ({ ...s, lines: s.lines.map(({ speechEndFrame, ...l }) => l) })),
};
writeFileSync(join(ROOT, "src/timing.json"), JSON.stringify(out, null, 1));

const tempos = res.scenes.flatMap((s) => s.lines.map((_, i) => `${s.id}_${i}`)).map((id) => [id, wordsOf(id).tempo]).filter(([, t]) => t !== 1);
console.log(`spacing: ${sp === LOOSE ? "loose" : "tight"}; atempo lines: ${tempos.map(([id, t]) => `${id}x${t}`).join(" ") || "none"}`);
console.log("scene        from   dur(f)  planned  sec    lines words");
for (const s of res.scenes) {
  console.log(`${s.id.padEnd(12)} ${String(s.from).padStart(5)} ${String(s.durationInFrames).padStart(7)} ${String(s.plannedFrames).padStart(8)} ${(s.durationInFrames / FPS).toFixed(1).padStart(5)} ${String(s.lines.length).padStart(6)} ${String(s.lines.reduce((n, l) => n + l.words.length, 0)).padStart(5)}`);
}
console.log(`total ${res.totalFrames}f = ${(res.totalFrames / FPS).toFixed(2)}s (max ${MAX}), bpm ${bpm}, ${beats.length} beats`);
