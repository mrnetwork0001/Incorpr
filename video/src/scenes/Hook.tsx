import React from "react";
import { Img, interpolate, staticFile } from "remotion";
import { C, amberButton, mono } from "../theme";
import { useFilm } from "../evidence";
import { Charter } from "../ui/Charter";
import { Words } from "../ui/Words";
import { clamp, expo } from "../ui/motion";
import { Fill, In, TxChip, useCue } from "./common";

/** 01: the headline, and the marble hands handing one charter across (the landing's own image). */
export const Hook: React.FC = () => {
  const { f, rel } = useCue("hook");
  const { assets } = useFilm();
  const tIs = rel("This", 60);
  const reach = interpolate(f, [4, 70], [0, 1], { ...clamp, easing: expo });
  const card = interpolate(f, [14, 46], [0, 1], { ...clamp, easing: expo });
  return (
    <Fill>
      <div style={{ position: "absolute", left: 0, right: 0, top: 170, textAlign: "center" }}>
        <div style={{ fontSize: 100, fontWeight: 480, letterSpacing: "-0.045em", lineHeight: 1.02 }}>
          <Words text="A company you can sell" at={6} every={3} /><br />
          <Words text="in one NFT transfer." at={22} every={3} accent={{ "NFT": C.amber }} />
        </div>
      </div>
      {assets.hands ? (
        <>
          <Img src={staticFile("hero/hand-left.png")} style={{ position: "absolute", left: -330 + 290 * reach, top: 610, width: 640, opacity: reach, filter: "drop-shadow(0 30px 40px rgba(0,0,0,0.6))" }} />
          <Img src={staticFile("hero/hand-right.png")} style={{ position: "absolute", right: -320 + 290 * reach, top: 560, width: 620, opacity: reach, filter: "drop-shadow(0 30px 40px rgba(0,0,0,0.6))" }} />
        </>
      ) : null}
      <div style={{ position: "absolute", left: 960 - 230, top: 470, opacity: card, transform: `translateY(${(1 - card) * 40}px) rotate(${-3 + 3 * card}deg)` }}>
        <Charter width={460} glow={0.9} />
      </div>
      <In at={tIs - 4} style={{ position: "absolute", left: 0, right: 0, top: 790, display: "flex", justifyContent: "center", gap: 18 }}>
        <div style={{ ...amberButton, padding: "14px 30px", fontSize: 26, fontWeight: 500, letterSpacing: "-0.01em" }}>Incorpr, on NEAR</div>
        <div style={{ padding: "14px 26px", borderRadius: 999, background: C.pillBg, boxShadow: "inset 0 0 0 1px rgba(240,162,76,0.32)", fontFamily: mono, fontSize: 22, color: C.pillInk }}>
          nft_transfer(receiver_id, token_id)
        </div>
      </In>
      <TxChip scene="hook" at={tIs + 10} left={660} top={870} label="sale" />
    </Fill>
  );
};
