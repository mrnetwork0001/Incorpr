import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { BG, C, mono, sans } from "./theme";
import { Seal } from "./ui/Seal";
import { Em } from "./scenes/common";

/** YouTube thumbnail, 1920x1080: one line, the seal, the logo. Readable at small size. */
export const Poster: React.FC = () => (
  <AbsoluteFill style={{ background: BG, fontFamily: sans, color: C.ink }}>
    <div style={{ position: "absolute", left: 110, top: 100, display: "flex", alignItems: "center", gap: 22 }}>
      <Img src={staticFile("brand/incorpr-icon.png")} style={{ width: 96, height: 96, borderRadius: 22 }} />
      <div style={{ fontSize: 80, fontWeight: 600, letterSpacing: "-0.05em" }}>Incorpr</div>
    </div>
    <div style={{ position: "absolute", left: 110, top: 300, width: 1000, fontSize: 132, fontWeight: 600, letterSpacing: "-0.055em", lineHeight: 0.98 }}>
      Every NFT is an AI <Em>company.</Em>
    </div>
    <div style={{ position: "absolute", left: 114, top: 800, fontFamily: mono, fontSize: 38, color: C.amber, letterSpacing: "0.04em" }}>0 keys · BTC · SOL · EVM</div>
    <div style={{ position: "absolute", left: 114, top: 870, fontFamily: mono, fontSize: 28, color: C.grey1, letterSpacing: "0.14em" }}>LIVE ON NEAR MAINNET</div>
    <Seal at={-200} size={600} x={1470} y={560} spin={0} orbitAt={-200} />
  </AbsoluteFill>
);
