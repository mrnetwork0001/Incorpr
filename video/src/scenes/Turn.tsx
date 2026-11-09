import React from "react";
import { Img, interpolate, staticFile } from "remotion";
import { LIGHT, mono } from "../theme";
import { clamp, pop } from "../ui/motion";
import { Words } from "../ui/Words";
import { Em, Fill, Head, In, useCue } from "./common";

/** 03. The turn, full-bleed amber: the name, the idea, the three verbs. */
export const Turn: React.FC = () => {
  const { f, rel } = useCue("turn");
  const tName = rel("Incorpr.", 18);
  const tEvery = rel("Every", 46);
  const logo = pop(f, tName - 6);
  const verbs = [["owns its treasury", rel("owns", 118)], ["earns per call", rel("earns", 154)], ["sells in one transaction", rel("sells", 195)]] as const;
  return (
    <Fill tone="amber">
      <div style={{ position: "absolute", left: 0, right: 0, top: 170, display: "flex", alignItems: "center", justifyContent: "center", gap: 34, transform: `scale(${0.8 + 0.2 * logo})`, opacity: interpolate(f, [tName - 6, tName + 4], [0, 1], clamp) }}>
        <Img src={staticFile("brand/incorpr-icon.png")} style={{ width: 150, height: 150, borderRadius: 34, boxShadow: "0 30px 60px rgba(90,52,24,0.35)" }} />
        <div style={{ fontSize: 150, fontWeight: 600, letterSpacing: "-0.06em", color: LIGHT.ink }}>Incorpr</div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 440, textAlign: "center", color: LIGHT.ink }}>
        <Head size={96}>
          <Words text="Every NFT is an AI" at={tEvery - 4} every={4} /> {f >= rel("company.", 93) - 4 ? <In at={rel("company.", 93) - 4} style={{ display: "inline-block" }}><Em color="#3a1f0c">company.</Em></In> : null}
        </Head>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 690, display: "flex", justifyContent: "center", gap: 22 }}>
        {verbs.map(([t, at]) => (
          <In key={t} at={at - 4}>
            <div style={{ padding: "14px 28px", borderRadius: 999, background: "rgba(20,17,16,0.88)", color: "#f7d9b5", fontFamily: mono, fontSize: 26, letterSpacing: "0.02em" }}>{t}</div>
          </In>
        ))}
      </div>
    </Fill>
  );
};
