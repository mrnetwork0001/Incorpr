import React from "react";
import { C, LIGHT, mono } from "../theme";
import { D } from "../data";
import { Browser } from "../ui/Footage";
import { Count } from "../ui/Count";
import { Em, Fill, Head, In, useCue } from "./common";

/** 11. Proof, on paper: the evidence log re-checked against the chain (docs/evidence/mainnet.verified.json). */
export const Proof: React.FC = () => {
  const { rel } = useCue("proof");
  const s = D.evidence_summary;
  return (
    <Fill tone="light">
      <div style={{ position: "absolute", left: 120, top: 130, width: 700 }}>
        <Head size={76} style={{ color: LIGHT.ink }}>Every claim links to <Em>a transaction.</Em></Head>
        <div style={{ marginTop: 60, display: "flex", gap: 70 }}>
          <In at={rel("on", 109) - 20}>
            <div style={{ fontSize: 150, fontWeight: 500, letterSpacing: "-0.05em", lineHeight: 1 }}><Count to={s.matched} at={rel("on", 109) - 20} dur={30} /></div>
            <div style={{ fontFamily: mono, fontSize: 18, color: LIGHT.sub, letterSpacing: "0.12em" }}>MAINNET TXS RE-CHECKED</div>
          </In>
          <In at={rel("eleven", 201) - 6}>
            <div style={{ fontSize: 150, fontWeight: 500, letterSpacing: "-0.05em", lineHeight: 1, color: C.danger }}><Count to={s.expected_refusals_confirmed} at={rel("eleven", 201) - 6} dur={20} /></div>
            <div style={{ fontFamily: mono, fontSize: 18, color: LIGHT.sub, letterSpacing: "0.12em" }}>REFUSALS CONFIRMED</div>
          </In>
        </div>
        <In at={rel("re-checked", 134)} style={{ marginTop: 40, fontFamily: mono, fontSize: 20, color: LIGHT.sub }}>node scripts/evidence.mjs --network mainnet</In>
      </div>
      <Browser name="verify" url="tryincorpr.vercel.app/verify" width={900} left={920} top={170} enter={10} startFrom={60} light />
    </Fill>
  );
};
