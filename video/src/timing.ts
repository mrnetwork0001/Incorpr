import raw from "./timing.json";

export interface Word { word: string; start: number; end: number }
/** `audio: false` means no VO has been generated yet: the word timings are estimates (scripts/timing.mjs). */
export interface Line { voice: string; text: string; file: string; audio: boolean; startFrame: number; durationFrames: number; words: Word[] }
export interface Scene { id: string; from: number; durationInFrames: number; lines: Line[] }
export interface Timing { fps: number; totalFrames: number; bpm: number; beats: number[]; music: { file: string; source: string } | null; sfx: string[]; scenes: Scene[] }

export const T = raw as unknown as Timing;
export const FPS = T.fps;
export const scene = (id: string): Scene => {
  const s = T.scenes.find((x) => x.id === id);
  if (!s) throw new Error(`scene ${id} missing from timing.json`);
  return s;
};
/** Absolute frame where `word` (first match, case-insensitive, punctuation ignored) starts in a scene. */
export const wordAt = (sceneId: string, word: string, nth = 0): number => {
  const clean = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  const hits = scene(sceneId).lines.flatMap((l) => l.words).filter((w) => clean(w.word) === clean(word));
  const hit = hits[nth] ?? hits[0];
  if (!hit) throw new Error(`word "${word}" not in ${sceneId}`);
  return hit.start;
};
/** Like wordAt, but falls back to `fallback` (absolute frame) when the word is not in the line. */
export const wordAtOr = (sceneId: string, word: string, fallback: number, nth = 0): number => {
  try { return wordAt(sceneId, word, nth); } catch { return fallback; }
};
export const lineStart = (sceneId: string, i: number) => scene(sceneId).lines[i].startFrame;
export const lineEnd = (sceneId: string, i: number) => {
  const l = scene(sceneId).lines[i];
  return l.words[l.words.length - 1].end;
};
