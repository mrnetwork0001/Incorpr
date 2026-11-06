import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { clamp, expo } from "./motion";

/**
 * Kinetic type: each word rises, un-blurs and settles in turn from `at` (scene-local frames),
 * `every` frames apart. Words named in `accent` are set in that colour.
 */
export const Words: React.FC<{
  text: string; at: number; every?: number; accent?: Record<string, string>; out?: number; style?: React.CSSProperties;
}> = ({ text, at, every = 3, accent = {}, out, style }) => {
  const f = useCurrentFrame();
  const words = text.split(" ");
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9$'-]/g, "");
  const acc = Object.fromEntries(Object.entries(accent).map(([k, v]) => [norm(k), v]));
  const fade = out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1;
  return (
    <span style={{ display: "inline", opacity: fade, ...style }}>
      {words.map((w, i) => {
        const t = at + i * every;
        const p = interpolate(f, [t, t + 16], [0, 1], { ...clamp, easing: expo });
        const a = acc[norm(w)];
        return (
          <span key={i} style={{
            display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 0.4}em)`,
            filter: p < 1 ? `blur(${(1 - p) * 8}px)` : undefined, marginRight: "0.24em",
            ...(a ? { color: a, textShadow: `0 0 40px ${a}55` } : {}),
          }}>{w}</span>
        );
      })}
    </span>
  );
};
