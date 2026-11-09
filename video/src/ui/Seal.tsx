import React from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { C, mono, sans } from "../theme";
import { clamp, expo } from "./motion";

/**
 * The film's motif: the vault as a seal. An amber ring that draws itself, "0" keys at its centre, and
 * the three chains it signs for orbiting it (Bitcoin, Solana, EVM). It recurs in the open, the turn,
 * incorporation, the sale and the close.
 */
export const Seal: React.FC<{
  at: number; size?: number; x: number; y: number; label?: string; center?: React.ReactNode;
  orbitAt?: number; spin?: number; dim?: number; ink?: string; ring?: string; sub?: string;
}> = ({ at, size = 420, x, y, label, center, orbitAt, spin = 0.25, dim = 1, ink = C.ink, ring = C.amber, sub = "access keys" }) => {
  const f = useCurrentFrame();
  const draw = interpolate(f, [at, at + 34], [0, 1], { ...clamp, easing: expo });
  const r = size / 2 - 8;
  const circ = 2 * Math.PI * r;
  const orbit = orbitAt != null ? interpolate(f, [orbitAt, orbitAt + 26], [0, 1], { ...clamp, easing: expo }) : 0;
  const rot = (f - at) * spin;
  const nodes = [
    { logo: "logos/bitcoin.svg", a: -90 },
    { logo: "logos/solana.svg", a: 30 },
    { logo: "logos/ethereum-mark.svg", a: 150 },
  ];
  return (
    <div style={{ position: "absolute", left: x - size / 2, top: y - size / 2, width: size, height: size, opacity: dim }}>
      <svg width={size} height={size} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ring} strokeOpacity={0.18 * draw} strokeWidth={2} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ring} strokeWidth={4} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - draw)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ filter: `drop-shadow(0 0 18px ${ring}88)` }} />
        <circle cx={size / 2} cy={size / 2} r={r - 22} fill="none" stroke={ring} strokeOpacity={0.25 * draw} strokeWidth={1} strokeDasharray="2 10" transform={`rotate(${rot} ${size / 2} ${size / 2})`} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", opacity: draw, color: ink }}>
        {center ?? (
          <>
            <div style={{ fontFamily: sans, fontWeight: 500, fontSize: size * 0.36, letterSpacing: "-0.05em", lineHeight: 1 }}>0</div>
            <div style={{ fontFamily: mono, fontSize: Math.max(14, size * 0.042), letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.7, marginTop: size * 0.02 }}>{sub}</div>
          </>
        )}
      </div>
      {label ? (
        <div style={{ position: "absolute", left: -200, right: -200, top: size + 18, textAlign: "center", fontFamily: mono, fontSize: Math.max(16, size * 0.05), color: ink, opacity: draw * 0.85 }}>{label}</div>
      ) : null}
      {nodes.map((n, i) => {
        const a = ((n.a + rot * 0.6) * Math.PI) / 180;
        const p = interpolate(orbit, [i * 0.15, i * 0.15 + 0.7], [0, 1], clamp);
        const nx = size / 2 + Math.cos(a) * r - 30;
        const ny = size / 2 + Math.sin(a) * r - 30;
        return (
          <div key={n.logo} style={{ position: "absolute", left: nx, top: ny, width: 60, height: 60, borderRadius: 30, background: "#141110",
            boxShadow: `0 0 0 2px ${ring}, 0 8px 24px rgba(0,0,0,0.5)`, display: "flex", alignItems: "center", justifyContent: "center",
            opacity: p, transform: `scale(${0.4 + 0.6 * p})` }}>
            <Img src={staticFile(n.logo)} style={{ width: 34, height: 34, objectFit: "contain" }} />
          </div>
        );
      })}
    </div>
  );
};

/** A chain or partner logo from public/logos, unaltered. */
export const Logo: React.FC<{ name: string; size?: number; style?: React.CSSProperties }> = ({ name, size = 48, style }) => (
  <Img src={staticFile(`logos/${name}.svg`)} style={{ width: size, height: size, objectFit: "contain", ...style }} />
);
