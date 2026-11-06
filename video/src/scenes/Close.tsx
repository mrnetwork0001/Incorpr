import React from "react";
import { C, amberButton, mono } from "../theme";
import { useFilm } from "../evidence";
import { Browser, hasClip } from "../ui/Footage";
import { Words } from "../ui/Words";
import { Fill, In, useCue } from "./common";

/** 07: verify and close. The /verify page if captured; the evidence count only if the file exists. */
export const Close: React.FC = () => {
  const { rel } = useCue("close");
  const { evidence } = useFilm();
  const tEvery = rel("Every", 30);
  const tInc = rel("Incorpr,", 90);
  const live = hasClip("verify");
  return (
    <Fill>
      {live ? <Browser name="verify" url="localhost:3010/verify" width={760} left={1060} top={230} enter={tEvery} /> : null}
      <div style={{ position: "absolute", left: live ? 120 : 0, right: live ? undefined : 0, top: live ? 250 : 300, width: live ? 860 : undefined, textAlign: live ? "left" : "center" }}>
        <div style={{ fontSize: live ? 84 : 112, fontWeight: 480, letterSpacing: "-0.045em", lineHeight: 1.04 }}>
          <Words text="Built on NEAR." at={4} every={3} />
        </div>
        <div style={{ marginTop: 22, fontSize: live ? 46 : 58, fontWeight: 420, letterSpacing: "-0.03em", color: C.grey1 }}>
          <Words text="Every claim links to a transaction." at={tEvery} every={3} accent={{ "transaction.": C.amber }} />
        </div>
        <In at={tEvery + 26} style={{ marginTop: 30, fontFamily: mono, fontSize: 22, color: C.grey2 }}>
          {evidence ? `${evidence.txs.length} transactions in ${evidence.source} · /verify` : "/verify lists each claim with its explorer link"}
        </In>
        <In at={tInc - 4} style={{ marginTop: 60, display: "flex", justifyContent: live ? "flex-start" : "center", gap: 20, alignItems: "center" }}>
          <div style={{ ...amberButton, padding: "16px 34px", fontSize: 32, fontWeight: 500, letterSpacing: "-0.02em" }}>Incorpr</div>
          <div style={{ padding: "16px 30px", borderRadius: 999, background: C.pillBg, boxShadow: "inset 0 0 0 1px rgba(240,162,76,0.4)", fontFamily: mono, fontSize: 26, letterSpacing: "0.16em", color: C.pillInk }}>NEAR HACKATHON</div>
        </In>
      </div>
    </Fill>
  );
};
