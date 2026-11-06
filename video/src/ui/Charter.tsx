import React from "react";
import { C, mono, sans } from "../theme";

export type State = "FREE" | "LISTED" | "PLEDGED";
const PILL: Record<State, string> = { FREE: "#16a34a", LISTED: "#d97706", PLEDGED: "#7c3aed" };

/**
 * The NFT's charter, drawn after the registry's own SVG (incorpr-registry/src/charter.rs): the same
 * rows and state pill. It shows the field names and where each value comes from, never invented values.
 */
export const Charter: React.FC<{ width?: number; state?: State; style?: React.CSSProperties; glow?: number }> = ({ width = 480, state = "FREE", style, glow = 0.6 }) => {
  const k = width / 600;
  const row = (a: string, b: string) => (
    <div style={{ display: "flex", fontSize: 14 * k * 1.25, lineHeight: 2.05 }}>
      <span style={{ width: 190 * k, color: "#94a3b8", flexShrink: 0 }}>{a}</span>
      <span style={{ color: "#f8fafc", whiteSpace: "nowrap" }}>{b}</span>
    </div>
  );
  return (
    <div style={{
      width, height: width * 0.53, boxSizing: "border-box", background: "#0b0f14", borderRadius: 10 * k, padding: `${26 * k}px ${30 * k}px`, fontFamily: mono, position: "relative",
      boxShadow: `0 0 0 1px #334155, 0 30px 70px rgba(0,0,0,0.6), 0 0 ${80 * glow}px rgba(240,162,76,${0.35 * glow})`, ...style,
    }}>
      <div style={{ fontFamily: sans, fontSize: 30 * k, fontWeight: 500, color: "#f8fafc", letterSpacing: "-0.02em" }}>Company charter</div>
      <div style={{ fontSize: 15 * k, color: "#94a3b8", marginTop: 4 * k }}>NEP-171 token · vault c-&lt;id&gt;.&lt;registry&gt;</div>
      <div style={{ position: "absolute", right: 30 * k, top: 28 * k, padding: `${5 * k}px ${16 * k}px`, borderRadius: 5 * k, background: PILL[state], color: "#fff", fontSize: 15 * k, letterSpacing: "0.04em" }}>{state}</div>
      <div style={{ marginTop: 20 * k }}>
        {row("Service", "set at incorporation")}
        {row("Price per call", "USDC")}
        {row("Treasury", "BTC / SOL / USDC")}
        {row("30d revenue", "from ft_on_transfer")}
        {row("Owner", "nft_token(token_id)")}
      </div>
      <div style={{ position: "absolute", inset: 0, borderRadius: 10 * k, pointerEvents: "none", boxShadow: `inset 0 1px 0 ${C.amber}` }} />
    </div>
  );
};
