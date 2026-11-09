import React from "react";
import { C, mono } from "../theme";
import { D, short, tx } from "../data";
import { Browser } from "../ui/Footage";
import { Card, Em, Fill, Head, Kicker, Pill, Row, useCue } from "./common";

/** 10. Borrow: the live page as Pledged, the loan, and what the owner cannot do until repaid. */
export const Borrow: React.FC = () => {
  const { f, rel } = useCue("borrow");
  const borrow = tx("film_borrow"), repay = tx("film_repay");
  const tPledge = rel("Pledge", 53), tRepay = rel("repay.", 126), tUntil = rel("Until", 152);
  const blocked = [
    { at: rel("sign,", 215), k: "sign", e: tx("rug_sign_listed").errors[0] },
    { at: rel("sell,", 233), k: "sell", e: tx("rug_transfer_pledged").errors[0] },
    { at: rel("pay", 252), k: "pay themselves", e: tx("rug_claim_pledged").errors[0] },
  ];
  void D;
  return (
    <Fill>
      <div style={{ position: "absolute", left: 90, top: 110, width: 640 }}>
        <Kicker>Or keep it</Kicker>
        <Head size={70} style={{ marginTop: 20 }}>Borrow <Em>against it.</Em></Head>
      </div>
      <Browser name={f < tUntil + 120 ? "state_pledged" : "state_final"} url="tryincorpr.vercel.app/company/1" width={1060} left={780} top={150} enter={4} startFrom={20}
        cams={[{ f: 0, z: 1 }, { f: 50, rect: { x: 450, y: 90, w: 720, h: 320 }, z: 1.55 }]} />
      <Card at={tPledge - 4} left={90} top={360} width={640}>
        <Kicker color={C.grey1}>accept_offer · pledged</Kicker>
        <Row k="loan" v="1.00 USDC" color={C.amber} />
        <Row k="repay" v="1.01 USDC to demo-lender" />
        <Row k="tx" v={short(borrow.hash, 8, 6)} />
        <Row k="repaid" v={f >= tRepay - 4 ? short(repay.hash, 8, 6) : "…"} color={f >= tRepay - 4 ? C.ok : C.grey2} />
      </Card>
      <div style={{ position: "absolute", left: 90, top: 660 }}>
        <div style={{ fontFamily: mono, fontSize: 15, letterSpacing: "0.14em", color: C.grey2, marginBottom: 14, opacity: f >= tUntil - 4 ? 1 : 0 }}>REFUSED ON MAINNET WHILE LISTED OR PLEDGED</div>
        {blocked.map((b) => (
          <div key={b.k} style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12, opacity: f >= b.at - 4 ? 1 : 0 }}>
            <span style={{ fontFamily: mono, fontSize: 22, width: 200, color: C.ink }}>can't {b.k}</span>
            <Pill tone="danger" size={14}>{b.e}</Pill>
          </div>
        ))}
      </div>
    </Fill>
  );
};
