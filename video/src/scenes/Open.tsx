import React from "react";
import { interpolate } from "remotion";
import { C, mono } from "../theme";
import { D, short, tx } from "../data";
import { Browser } from "../ui/Footage";
import { Seal } from "../ui/Seal";
import { clamp } from "../ui/motion";
import { Count } from "../ui/Count";
import { Card, Fill, In, Kicker, Row } from "./common";

/** 01. Cold open on a real moment: the vault's Bitcoin spend (data/onchain.json bitcoin + btc_sign). */
export const Open: React.FC = () => {
  const { f, rel } = useOpenCue();
  const b = D.bitcoin;
  const sign = tx("btc_sign");
  const tBtc = rel("Bitcoin", 117);
  const tNear = rel("NEAR", 198);
  const tNobody = rel("Nobody", 265);
  const typed = "2026-11-06  19:04 UTC";
  const chars = Math.floor(interpolate(f, [8, 70], [0, typed.length], clamp));
  const browserDim = interpolate(f, [tNobody - 6, tNobody + 14], [1, 0.25], clamp);
  return (
    <Fill>
      <div style={{ position: "absolute", left: 120, top: 150, fontFamily: mono, fontSize: 44, color: C.amber, letterSpacing: "0.04em" }}>
        {typed.slice(0, chars)}<span style={{ opacity: f % 30 < 15 ? 1 : 0 }}>▌</span>
      </div>
      <div style={{ opacity: browserDim }}>
        <Browser name="btc" url={`mempool.space/tx/${short(b.txid, 8, 6)}`} width={980} left={820} top={250} enter={tBtc - 6} startFrom={60} />
      </div>
      <Card at={tBtc + 8} left={120} top={300} width={600} out={tNobody - 4}>
        <Kicker>Bitcoin mainnet</Kicker>
        <div style={{ marginTop: 18, fontSize: 64, fontWeight: 500, letterSpacing: "-0.04em" }}>
          <Count to={b.amount_sats} at={tBtc + 10} dur={30} /> <span style={{ fontSize: 30, color: C.grey1 }}>sats</span>
        </div>
        <div style={{ marginTop: 14 }}>
          <Row k="txid" v={short(b.txid, 10, 8)} />
          <Row k="confirmed" v={`block ${b.block.toLocaleString("en-US")}`} color={C.ok} />
          <Row k="signed via" v="v1.signer" />
        </div>
      </Card>
      <In at={tNear - 4} out={tNobody - 4} style={{ position: "absolute", left: 120, top: 700, width: 640 }}>
        <div style={{ fontFamily: mono, fontSize: 21, color: C.grey1, lineHeight: 1.6 }}>
          requested by <span style={{ color: C.amber }}>{sign.receiver}</span><br />
          NEAR tx {short(sign.hash, 8, 6)} · block {sign.block.toLocaleString("en-US")}
        </div>
      </In>
      <Seal at={tNobody - 8} size={460} x={960} y={500} label={sign.receiver} />
    </Fill>
  );
};

import { useCue } from "./common";
const useOpenCue = () => useCue("open");
