import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { BG, C, mono, sans } from "./theme";
import { type FilmProps } from "./evidence";
import { Charter } from "./ui/Charter";
import { Grain } from "./ui/Grain";

/**
 * 1500x500 X header. X covers the lower left with the avatar and crops top and bottom on some
 * screens, so the copy sits right of centre and inside the middle 400px.
 */
export const Banner: React.FC<FilmProps> = ({ assets }) => (
  <AbsoluteFill style={{ background: BG, color: "#fff", fontFamily: sans, overflow: "hidden" }}>
    {assets.hands ? (
      <Img src={staticFile("hero/hand-left.png")} style={{ position: "absolute", left: -60, top: 170, width: 420, filter: "drop-shadow(0 20px 26px rgba(0,0,0,0.6))" }} />
    ) : null}
    <div style={{ position: "absolute", left: 370, top: 120, transform: "rotate(-4deg)" }}>
      <Charter width={330} glow={1} />
    </div>
    <div style={{ position: "absolute", left: 790, top: 120, width: 660 }}>
      <div style={{ fontFamily: mono, fontSize: 16, letterSpacing: "0.16em", color: C.amber, textTransform: "uppercase" }}>incorpr · built on near</div>
      <div style={{ marginTop: 16, fontSize: 58, fontWeight: 500, letterSpacing: "-0.045em", lineHeight: 1.02 }}>
        A company you can sell in <span style={{ color: C.amber }}>one NFT transfer.</span>
      </div>
      <div style={{ marginTop: 18, fontSize: 21, color: C.grey1, lineHeight: 1.4 }}>Keyless vault account, Chain Signatures treasury, on-chain firewall.</div>
    </div>
    <Grain opacity={0.06} />
  </AbsoluteFill>
);
