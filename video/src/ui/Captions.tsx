import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, sans } from "../theme";
import { T } from "../timing";
import { clamp } from "./motion";

/** Narration captions on a dark glass pill: the current phrase, each word lighting up as it is spoken. */
export const Captions: React.FC<{ hidden?: (frame: number) => boolean; bottom?: number }> = ({ hidden, bottom = 84 }) => {
  const frame = useCurrentFrame();
  if (hidden?.(frame)) return null;
  const line = T.scenes.flatMap((s) => s.lines).find((l) => frame >= l.startFrame - 4 && frame <= l.words[l.words.length - 1].end + 14);
  if (!line) return null;
  const chunks: (typeof line.words)[] = [];
  let cur: typeof line.words = [];
  for (const w of line.words) {
    cur.push(w);
    if ((/[.,:;?]$/.test(w.word) && cur.length >= 4) || cur.length >= 10) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  let shown = chunks[0];
  for (const c of chunks) if (frame >= c[0].start - 3) shown = c;
  const lastEnd = line.words[line.words.length - 1].end;
  const op = interpolate(frame, [line.startFrame - 4, line.startFrame + 4, lastEnd + 6, lastEnd + 14], [0, 1, 1, 0], clamp);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom, display: "flex", justifyContent: "center", opacity: op, pointerEvents: "none" }}>
      <div style={{
        maxWidth: 1320, textAlign: "center", fontFamily: sans, fontSize: 30, fontWeight: 450, lineHeight: 1.35, letterSpacing: "-0.01em",
        padding: "10px 28px", borderRadius: 999, background: "rgba(13,13,13,0.72)", backdropFilter: "blur(18px)",
        boxShadow: "inset 0 1px 0 rgba(240,162,76,0.35), 0 0 0 1px rgba(255,255,255,0.08), 0 12px 34px rgba(0,0,0,0.35)",
      }}>
        {shown.map((w, i) => (
          <span key={i} style={{ color: C.ink, opacity: frame >= w.start - 2 ? 1 : 0.36 }}>{w.word} </span>
        ))}
      </div>
    </div>
  );
};
