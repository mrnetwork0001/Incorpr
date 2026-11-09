import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAtOr } from "../timing";
import { AMBER_BG, BG, C, LIGHT, glass, mono, sans, serif } from "../theme";
import { clamp, expo, pop } from "../ui/motion";

/** Scene-local frame and word cues: rel("word", fallback, n) is when the nth "word" is spoken, scene-local. */
export function useCue(id: string) {
  const s = scene(id);
  const f = useCurrentFrame();
  const rel = (w: string, fallback = 0, n = 0) => wordAtOr(id, w, s.from + fallback, n) - s.from;
  return { s, f, rel, dur: s.durationInFrames };
}

/** The three tones: dark (the site), light (paper) and full-bleed amber. */
export const Fill: React.FC<{ tone?: "dark" | "light" | "amber"; children: React.ReactNode }> = ({ tone = "dark", children }) => (
  <AbsoluteFill style={{
    background: tone === "light" ? LIGHT.bg : tone === "amber" ? AMBER_BG : BG,
    color: tone === "dark" ? C.ink : LIGHT.ink, fontFamily: sans, overflow: "hidden",
  }}>{children}</AbsoluteFill>
);

export const Kicker: React.FC<{ children: React.ReactNode; color?: string; dot?: string; size?: number; style?: React.CSSProperties }> = ({ children, color = C.grey1, dot = C.amber, size = 18, style }) => (
  <div style={{ fontFamily: mono, fontSize: size, letterSpacing: "0.16em", textTransform: "uppercase", color, display: "flex", alignItems: "center", gap: 12, ...style }}>
    <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, boxShadow: `0 0 10px ${dot}` }} />{children}
  </div>
);

/** Fade, rise and un-blur for any block; optional fade out at `out`. */
export const In: React.FC<{ at: number; dur?: number; y?: number; x?: number; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({ at, dur = 16, y = 26, x = 0, children, style, out }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + dur], [0, 1], { ...clamp, easing: expo });
  const o = out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1;
  return <div style={{ opacity: p * o, transform: `translate(${(1 - p) * x}px, ${(1 - p) * y}px)`, filter: p < 1 ? `blur(${(1 - p) * 7}px)` : undefined, ...style }}>{children}</div>;
};

/** A glass card that pops in at `at`. `light`: a paper card for the light tone. */
export const Card: React.FC<{ at: number; left: number; top: number; width: number; height?: number; light?: boolean; out?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at, left, top, width, height, light, out, children, style }) => {
  const f = useCurrentFrame();
  const p = pop(f, at);
  const o = interpolate(f, [at, at + 8], [0, 1], clamp) * (out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1);
  const skin: React.CSSProperties = light
    ? { background: LIGHT.card, borderRadius: 22, boxShadow: "0 0 0 1px rgba(20,17,16,0.08), 0 30px 70px rgba(60,40,20,0.14)" }
    : glass(1);
  return (
    <div style={{ position: "absolute", left, top, width, height, opacity: o, transform: `translateY(${(1 - p) * 30}px) scale(${0.94 + 0.06 * p})`, transformOrigin: "50% 100%", padding: "26px 30px", boxSizing: "border-box", ...skin, ...style }}>
      {children}
    </div>
  );
};

/** Big tight headline; wrap the accent word in <Em>. */
export const Head: React.FC<{ children: React.ReactNode; size?: number; style?: React.CSSProperties }> = ({ children, size = 84, style }) => (
  <div style={{ fontFamily: sans, fontWeight: 500, fontSize: size, letterSpacing: "-0.045em", lineHeight: 1.02, ...style }}>{children}</div>
);
export const Em: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color = C.amber }) => (
  <span style={{ fontFamily: serif, fontStyle: "italic", fontWeight: 400, letterSpacing: "-0.01em", color }}>{children}</span>
);

/** Mono label + value row, for real figures. */
export const Row: React.FC<{ k: string; v: React.ReactNode; light?: boolean; color?: string; size?: number }> = ({ k, v, light, color, size = 20 }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 24, fontFamily: mono, fontSize: size, lineHeight: 1.75 }}>
    <span style={{ color: light ? LIGHT.sub : C.grey2, textTransform: "uppercase", letterSpacing: "0.1em", fontSize: size * 0.8 }}>{k}</span>
    <span style={{ color: color ?? (light ? LIGHT.ink : C.ink), textAlign: "right" }}>{v}</span>
  </div>
);

/** A pill with a hash or an error code. */
export const Pill: React.FC<{ children: React.ReactNode; tone?: "amber" | "danger" | "ok" | "light"; size?: number; style?: React.CSSProperties }> = ({ children, tone = "amber", size = 19, style }) => {
  const col = tone === "danger" ? C.danger : tone === "ok" ? C.ok : tone === "light" ? LIGHT.ink : C.amber;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "8px 16px", borderRadius: 10, fontFamily: mono, fontSize: size, color: col,
      background: tone === "light" ? "rgba(20,17,16,0.05)" : "rgba(0,0,0,0.35)", boxShadow: `inset 0 0 0 1px ${col}66`, whiteSpace: "nowrap", ...style }}>{children}</span>
  );
};

/** Red stamp that slams in at `at`. */
export const Stamp: React.FC<{ at: number; children: React.ReactNode; size?: number; style?: React.CSSProperties }> = ({ at, children, size = 30, style }) => {
  const f = useCurrentFrame();
  const p = pop(f, at);
  const o = interpolate(f, [at - 1, at + 3], [0, 1], clamp);
  return (
    <div style={{ display: "inline-block", padding: "10px 22px", borderRadius: 10, border: `3px solid ${C.danger}`, color: C.danger, fontFamily: mono, fontSize: size,
      letterSpacing: "0.08em", opacity: o, transform: `scale(${1.6 - 0.6 * p}) rotate(-3deg)`, background: "rgba(255,107,94,0.08)", ...style }}>{children}</div>
  );
};
