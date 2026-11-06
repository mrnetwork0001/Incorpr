import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAtOr } from "../timing";
import { BG, C, glass, mono, sans } from "../theme";
import { SCENE_TX, findTx, short, useFilm } from "../evidence";
import { Browser, hasClip, type Cam } from "../ui/Footage";
import { clamp, expo, pop } from "../ui/motion";

/** Scene-local frame and word cues: rel("word", n) is when the nth "word" is spoken, scene-local. */
export function useCue(id: string) {
  const s = scene(id);
  const f = useCurrentFrame();
  const rel = (w: string, fallback = 0, n = 0) => wordAtOr(id, w, s.from + fallback, n) - s.from;
  return { s, f, rel, dur: s.durationInFrames };
}

export const Fill: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: BG, fontFamily: sans, color: C.ink, overflow: "hidden" }}>{children}</AbsoluteFill>
);

/** Small mono kicker with the amber dot. */
export const Kicker: React.FC<{ children: React.ReactNode; color?: string; dot?: string; size?: number; style?: React.CSSProperties }> = ({ children, color = C.grey1, dot = C.amber, size = 17, style }) => (
  <div style={{ fontFamily: mono, fontSize: size, letterSpacing: "0.16em", textTransform: "uppercase", color, display: "flex", alignItems: "center", gap: 12, ...style }}>
    <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, boxShadow: `0 0 10px ${dot}` }} />{children}
  </div>
);

/** Fade, rise and un-blur for any block. */
export const In: React.FC<{ at: number; dur?: number; y?: number; x?: number; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({ at, dur = 16, y = 26, x = 0, children, style, out }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + dur], [0, 1], { ...clamp, easing: expo });
  const o = out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1;
  return <div style={{ opacity: p * o, transform: `translate(${(1 - p) * x}px, ${(1 - p) * y}px)`, filter: p < 1 ? `blur(${(1 - p) * 7}px)` : undefined, ...style }}>{children}</div>;
};

/** A glass panel with the glowing amber top edge that pops in at `at`. */
export const Panel: React.FC<{ at: number; left: number; top: number; width: number; height?: number; glow?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at, left, top, width, height, glow = 1, children, style }) => {
  const f = useCurrentFrame();
  const p = pop(f, at);
  const o = interpolate(f, [at, at + 8], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left, top, width, height, opacity: o, transform: `translateY(${(1 - p) * 28}px) scale(${0.95 + 0.05 * p})`, transformOrigin: "50% 100%", padding: "28px 32px", boxSizing: "border-box", ...glass(glow), ...style }}>
      {children}
    </div>
  );
};

export const Head: React.FC<{ children: React.ReactNode; size?: number; style?: React.CSSProperties }> = ({ children, size = 80, style }) => (
  <div style={{ fontFamily: sans, fontWeight: 480, fontSize: size, letterSpacing: "-0.042em", lineHeight: 1.04, ...style }}>{children}</div>
);

/** A contract call as it appears in the Rust source, set in mono. `c`: amber (method), dim (comment), danger (error). */
export interface CodeLine { t: string; c?: "amber" | "dim" | "danger" | "ok"; indent?: number }
const CODE_COLOR = { amber: C.amber, dim: C.grey3, danger: C.danger, ok: C.ok } as const;
export const Code: React.FC<{ lines: CodeLine[]; at: number; every?: number; size?: number }> = ({ lines, at, every = 5, size = 21 }) => {
  const f = useCurrentFrame();
  return (
    <div style={{ fontFamily: mono, fontSize: size, lineHeight: 1.6, color: C.grey1, whiteSpace: "pre" }}>
      {lines.map((l, i) => (
        <div key={i} style={{ opacity: interpolate(f, [at + i * every, at + i * every + 10], [0, 1], clamp), paddingLeft: (l.indent ?? 0) * 26, color: l.c ? CODE_COLOR[l.c] : undefined }}>{l.t}</div>
      ))}
    </div>
  );
};

/**
 * The scene's transaction from docs/evidence/<network>.json, if there is one. With no evidence file,
 * or no matching entry, it renders nothing: the film never shows a hash it did not read from the file.
 */
export const TxChip: React.FC<{ scene: string; at: number; left: number; top: number; label?: string }> = ({ scene: id, at, left, top, label = "receipt" }) => {
  const { evidence } = useFilm();
  const tx = findTx(evidence, SCENE_TX[id] ?? []);
  if (!tx) return null;
  const failed = /fail|reject|error/i.test(tx.status ?? "") || !!tx.error;
  return (
    <div style={{ position: "absolute", left, top }}>
      <In at={at}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 16, padding: "12px 22px", borderRadius: 999, background: C.pillBg, boxShadow: `inset 0 0 0 1px ${failed ? "rgba(255,107,94,0.5)" : "rgba(240,162,76,0.4)"}`, fontFamily: mono, fontSize: 20, color: C.pillInk }}>
          <span style={{ color: failed ? C.danger : C.amber, textTransform: "uppercase", letterSpacing: "0.12em", fontSize: 15 }}>{failed ? "failed receipt" : label}</span>
          <span>{short(tx.hash, 10, 8)}</span>
        </div>
        <div style={{ marginTop: 10, marginLeft: 22, fontFamily: mono, fontSize: 17, lineHeight: 1.6, color: C.grey2, maxWidth: 780 }}>
          <div>{[tx.method, tx.explorer.replace(/\/txns\/.*/, "/txns/…")].filter(Boolean).join(" · ")}</div>
          {tx.error ? <div style={{ color: C.danger }}>{tx.error}</div> : null}
        </div>
      </In>
    </div>
  );
};

/**
 * The common scene layout. Left: kicker, headline and a short line. Right: the scene's diagram
 * (title-card mode) or, once captured, the first available footage clip in a browser frame.
 */
export const Stage: React.FC<{
  id: string; kicker: string; head: React.ReactNode; sub?: React.ReactNode; footage?: { name: string; url: string; startFrom?: number; cams?: Cam[] }[];
  children?: React.ReactNode; code?: CodeLine[]; codeAt?: number; headSize?: number; codeTop?: number;
}> = ({ id, kicker, head, sub, footage = [], children, code, codeAt = 30, headSize = 76, codeTop = 590 }) => {
  const live = footage.find((c) => hasClip(c.name));
  return (
    <Fill>
      <div style={{ position: "absolute", left: 120, top: 190, width: live ? 640 : 800 }}>
        <In at={0}><Kicker>{kicker}</Kicker></In>
        <div style={{ marginTop: 34 }}><Head size={live ? headSize * 0.82 : headSize}>{head}</Head></div>
        {sub ? <In at={24} style={{ marginTop: 34, fontSize: 30, lineHeight: 1.4, color: C.grey1, fontWeight: 400, letterSpacing: "-0.01em" }}>{sub}</In> : null}
        {code && live ? <div style={{ marginTop: 44 }}><Code lines={code} at={codeAt} size={19} /></div> : null}
      </div>
      {live ? (
        <Browser name={live.name} url={live.url} width={1000} left={820} top={170} startFrom={live.startFrom ?? 0} cams={live.cams ?? []} enter={6} />
      ) : (
        <>
          {children}
          {code ? (
            <Panel at={codeAt} left={1010} top={codeTop} width={790} glow={0.6}>
              <Code lines={code} at={codeAt + 6} />
            </Panel>
          ) : null}
        </>
      )}
      <TxChip scene={id} at={codeAt + 20} left={120} top={live ? 760 : 640} />
    </Fill>
  );
};
