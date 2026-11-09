import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { BG, C, amberButton, mono, sans } from "./theme";
import { type FilmProps } from "./evidence";
import { Charter } from "./ui/Charter";
import { Grain } from "./ui/Grain";

/** 1280x720 thumbnail: the headline, the charter between the two marble hands, and the event. */
export const Poster: React.FC<FilmProps> = ({ assets }) => (
  <AbsoluteFill style={{ background: BG, color: "#fff", fontFamily: sans, overflow: "hidden" }}>
    <div style={{ position: "absolute", left: 64, top: 56, fontFamily: mono, fontSize: 18, letterSpacing: "0.16em", color: C.amber, textTransform: "uppercase" }}>incorpr · near hackathon</div>
    <div style={{ position: "absolute", left: 60, top: 100, width: 1160, fontSize: 84, fontWeight: 520, letterSpacing: "-0.05em", lineHeight: 0.98 }}>
      A company you can sell in <span style={{ color: C.amber, textShadow: "0 0 40px rgba(240,162,76,0.45)" }}>one NFT transfer.</span>
    </div>
    {assets.hands ? (
      <>
        <Img src={staticFile("hero/hand-left.png")} style={{ position: "absolute", left: -120, top: 430, width: 470, filter: "drop-shadow(0 24px 30px rgba(0,0,0,0.6))" }} />
        <Img src={staticFile("hero/hand-right.png")} style={{ position: "absolute", right: -110, top: 390, width: 440, filter: "drop-shadow(0 24px 30px rgba(0,0,0,0.6))" }} />
      </>
    ) : null}
    <div style={{ position: "absolute", left: 430, top: 360, transform: "rotate(-3deg)" }}>
      <Charter width={420} glow={1} />
    </div>
    <div style={{ position: "absolute", right: 60, top: 44, ...amberButton, padding: "10px 22px", fontSize: 22, fontWeight: 500 }}>Built on NEAR</div>
    <Grain opacity={0.06} />
  </AbsoluteFill>
);
