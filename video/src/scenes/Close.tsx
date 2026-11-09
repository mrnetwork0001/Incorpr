import React from "react";
import { Img, interpolate, staticFile } from "remotion";
import { LIGHT, mono } from "../theme";
import { Logo } from "../ui/Seal";
import { clamp, pop } from "../ui/motion";
import { Em, Fill, In, useCue } from "./common";

/** 12. Close, full-bleed amber: the name, the line, the URL, the event. */
export const Close: React.FC = () => {
  const { f, rel } = useCue("close");
  const p = pop(f, 2);
  return (
    <Fill tone="amber">
      <div style={{ position: "absolute", left: 0, right: 0, top: 230, display: "flex", alignItems: "center", justifyContent: "center", gap: 34, transform: `scale(${0.85 + 0.15 * p})`, opacity: interpolate(f, [0, 8], [0, 1], clamp) }}>
        <Img src={staticFile("brand/incorpr-icon.png")} style={{ width: 160, height: 160, borderRadius: 36, boxShadow: "0 30px 60px rgba(90,52,24,0.35)" }} />
        <div style={{ fontSize: 170, fontWeight: 600, letterSpacing: "-0.06em", color: LIGHT.ink }}>Incorpr</div>
      </div>
      <In at={rel("AI", 45) - 4} style={{ position: "absolute", left: 0, right: 0, top: 500, textAlign: "center", color: LIGHT.ink, fontSize: 64, fontWeight: 500, letterSpacing: "-0.04em" }}>
        AI companies you can own, sell, and <Em color="#3a1f0c">borrow against.</Em>
      </In>
      <In at={rel("Live", 140) - 4} style={{ position: "absolute", left: 0, right: 0, top: 680, display: "flex", justifyContent: "center", alignItems: "center", gap: 26, color: LIGHT.ink }}>
        <Logo name="near" size={46} />
        <span style={{ fontFamily: mono, fontSize: 30 }}>Live on NEAR mainnet · tryincorpr.vercel.app</span>
      </In>
      <In at={rel("Live", 140) + 10} style={{ position: "absolute", left: 0, right: 0, top: 790, textAlign: "center", fontFamily: mono, fontSize: 22, letterSpacing: "0.2em", color: "#3a1f0c" }}>
        NEAR HACKATHON 2026
      </In>
    </Fill>
  );
};
