import React from "react";
import { interpolate } from "remotion";
import { C, mono } from "../theme";
import { clamp, pop } from "../ui/motion";
import { Words } from "../ui/Words";
import { Card, Em, Fill, Head, In, Kicker, useCue } from "./common";

/** 02. The problem: one hot key guards the money, and an AI business cannot change hands without trust. */
export const Problem: React.FC = () => {
  const { f, rel } = useCue("problem");
  const tKey = rel("hot", 114);
  const tLeak = rel("Leak", 141);
  const tTalk = rel("talk", 163);
  const tGone = rel("gone.", 229);
  const tSell = rel("sell", 271);
  const tKeys = rel("keys", 388);
  const tStranger = rel("stranger.", 419);
  const drain = interpolate(f, [tGone - 20, tGone + 8], [1, 0], clamp);
  const half = f < tSell - 10;
  const keyPop = pop(f, tKey - 4);
  return (
    <Fill>
      {half ? (
        <>
          <div style={{ position: "absolute", left: 120, top: 170, width: 900 }}>
            <Head size={92}><Words text="AI agents already earn money." at={4} every={4} accent={{ "money.": C.amber }} /></Head>
            <In at={rel("behind", 96)} style={{ marginTop: 36, fontSize: 34, color: C.grey1, lineHeight: 1.4 }}>
              That money sits behind <Em>one</Em> hot key.
            </In>
          </div>
          <div style={{ position: "absolute", left: 1180, top: 210, width: 600, height: 520 }}>
            <div style={{ position: "absolute", left: 160, top: 40, width: 280, height: 280, borderRadius: 140, transform: `scale(${keyPop})`,
              background: "radial-gradient(circle, rgba(255,107,94,0.22), transparent 70%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 150 }}>
              <svg width="170" height="170" viewBox="0 0 64 64" fill="none" stroke={C.danger} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="22" cy="32" r="11" /><circle cx="22" cy="32" r="3.5" />
                <path d="M33 32h24M50 32v8M44 32v6" />
              </svg>
            </div>
            <Card at={tLeak - 2} left={0} top={340} width={290} style={{ padding: "18px 22px" }}>
              <div style={{ fontFamily: mono, fontSize: 16, color: C.danger, letterSpacing: "0.12em" }}>LEAK THE KEY</div>
              <div style={{ marginTop: 8, fontSize: 22, color: C.grey1 }}>whoever holds it moves the money</div>
            </Card>
            <Card at={tTalk - 2} left={310} top={340} width={290} style={{ padding: "18px 22px" }}>
              <div style={{ fontFamily: mono, fontSize: 16, color: C.danger, letterSpacing: "0.12em" }}>TALK THE MODEL INTO IT</div>
              <div style={{ marginTop: 8, fontSize: 22, color: C.grey1 }}>the agent signs what it is told</div>
            </Card>
          </div>
          <In at={tGone - 24} style={{ position: "absolute", left: 120, top: 640 }}>
            <Kicker color={C.danger} dot={C.danger}>treasury</Kicker>
            <div style={{ marginTop: 10, fontFamily: mono, fontSize: 72, color: drain < 0.05 ? C.danger : C.ink }}>
              {(drain * 100).toFixed(0)}<span style={{ fontSize: 34, color: C.grey2 }}> % left</span>
            </div>
          </In>
        </>
      ) : (
        <>
          <div style={{ position: "absolute", left: 120, top: 200, width: 1100 }}>
            <Head size={84}><Words text="And you can't sell an AI business," at={tSell - 12} every={3} /></Head>
            <Head size={84} style={{ color: C.grey1 }}><Words text="or borrow against it." at={rel("borrow", 326) - 4} every={3} /></Head>
          </div>
          {["hand over the keys", "hand over the logins", "trust a stranger"].map((t, i) => (
            <Card key={t} at={(i < 2 ? tKeys - 14 : tStranger - 8) + i * 6} left={120 + i * 420} top={600} width={390} style={{ padding: "20px 24px" }}>
              <div style={{ fontFamily: mono, fontSize: 16, color: C.amber, letterSpacing: "0.12em" }}>TODAY</div>
              <div style={{ marginTop: 8, fontSize: 32, letterSpacing: "-0.02em" }}>{t}</div>
            </Card>
          ))}
        </>
      )}
    </Fill>
  );
};
