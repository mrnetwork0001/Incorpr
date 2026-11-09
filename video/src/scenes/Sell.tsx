import React from "react";
import { interpolate } from "remotion";
import { C, mono } from "../theme";
import { D, short, tx, usdc } from "../data";
import { Browser } from "../ui/Footage";
import { Seal } from "../ui/Seal";
import { clamp, expo } from "../ui/motion";
import { Card, Em, Fill, Head, Kicker, Pill, Row, useCue } from "./common";

/** 09. Sell: the live company page as Listed, then the sale, and the owner frozen while listed. */
export const Sell: React.FC = () => {
  const { f, rel } = useCue("sell");
  const list = tx("film_list"), buy = tx("film_buy");
  const tList = rel("List", 52), tChange = rel("change", 253), tOne = rel("one", 282), tWhile = rel("While", 331);
  const move = interpolate(f, [tChange - 6, tOne + 10], [0, 1], { ...clamp, easing: expo });
  const frozen = [tx("rug_sign_listed"), tx("rug_transfer_listed"), tx("rug_claim_listed")];
  return (
    <Fill>
      <div style={{ position: "absolute", left: 90, top: 110, width: 640 }}>
        <Kicker>The business part</Kicker>
        <Head size={70} style={{ marginTop: 20 }}>Sold in <Em>one transaction.</Em></Head>
      </div>
      {f < tChange - 10 ? (
        <>
          <Browser name="state_listed" url="tryincorpr.vercel.app/company/1" width={1060} left={780} top={150} enter={tList - 10} startFrom={20} cams={[{ f: 0, z: 1 }, { f: 60, rect: { x: 450, y: 90, w: 720, h: 320 }, z: 1.55 }]} />
          <Card at={tList - 2} left={90} top={380} width={640}>
            <Kicker color={C.grey1}>list_company · {list.utc.slice(11, 16)} UTC</Kicker>
            <Row k="ask" v={`0.45 USDC`} color={C.amber} />
            <Row k="state" v="LISTED" color={C.amber} />
            <Row k="tx" v={short(list.hash, 8, 6)} />
          </Card>
          <Card at={rel("pays.", 106) - 6} left={90} top={640} width={640}>
            <Kicker color={C.grey1}>buyer pays · ft_transfer_call</Kicker>
            <Row k="tx" v={short(buy.hash, 8, 6)} />
            <Row k="block" v={buy.block.toLocaleString("en-US")} />
          </Card>
        </>
      ) : (
        <>
          {/* The seal and the NFT move together from the seller to the buyer. */}
          <div style={{ position: "absolute", left: 240, top: 430, fontFamily: mono, fontSize: 20, color: C.grey1, opacity: 1 - move * 0.6 }}>demo-buyer.incorpr.near</div>
          <div style={{ position: "absolute", left: 1270, top: 430, fontFamily: mono, fontSize: 20, color: C.ink, opacity: 0.4 + move * 0.6 }}>{short(buy.signer, 10, 8)}</div>
          <Seal at={tChange - 14} size={300} x={420 + 960 * move} y={640} orbitAt={tChange - 10} sub="keys, still" />
          <div style={{ position: "absolute", left: 90, top: 850, display: "flex", gap: 12, opacity: interpolate(f, [tWhile - 4, tWhile + 8], [0, 1], clamp) }}>
            <span style={{ fontFamily: mono, fontSize: 17, color: C.grey1, alignSelf: "center", marginRight: 6 }}>while listed, the owner was refused:</span>
            {frozen.map((t) => <Pill key={t.hash} tone="danger" size={14}>{t.errors[0]}</Pill>)}
          </div>
          <div style={{ position: "absolute", left: 90, top: 280, fontFamily: mono, fontSize: 22, color: C.grey1, opacity: interpolate(f, [tChange, tChange + 10], [0, 1], clamp) }}>
            NFT + vault + revenue + BTC · SOL · EVM treasury · tx {short(buy.hash, 8, 6)} · {usdc(450000)} USDC
          </div>
        </>
      )}
    </Fill>
  );
};
