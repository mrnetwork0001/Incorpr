import React from "react";
import { interpolate } from "remotion";
import { C, mono } from "../theme";
import { D, short, tx } from "../data";
import { Browser } from "../ui/Footage";
import { clamp } from "../ui/motion";
import { Card, Em, Fill, Head, Kicker, Pill, useCue } from "./common";

/** 07. The treasury agent: propose, TEE approval, on-chain signature check, then the real swap. */
export const Treasury: React.FC = () => {
  const { f, rel } = useCue("treasury");
  const swap = tx("rebalance_swap");
  const steps = [
    { at: rel("asks", 73), who: "Treasury agent", what: "proposes a swap", detail: "agent_swap_intent" },
    { at: rel("signs", 119), who: "NEAR AI Cloud TEE", what: "replies APPROVE, signed", detail: short(D.agent_market.test_job.signer, 6, 4) },
    { at: rel("checks", 171), who: "Vault, on-chain", what: "recovers the signer, runs the firewall", detail: "ecrecover · 18 checks" },
    { at: rel("moves", 238), who: "v1.signer", what: "signs the intent", detail: "intents.near" },
  ];
  const tHalf = rel("Half", 302);
  const line = interpolate(f, [steps[0].at, steps[3].at + 10], [0, 1], clamp);
  return (
    <Fill>
      <div style={{ position: "absolute", left: 120, top: 120 }}>
        <Kicker>Treasury</Kicker>
        <Head size={72} style={{ marginTop: 20 }}>Profit goes <Em>to work.</Em></Head>
      </div>
      <div style={{ position: "absolute", left: 140, top: 395, width: 1640 * line, height: 3, background: `linear-gradient(90deg, ${C.amber}, ${C.amber}55)`, boxShadow: `0 0 16px ${C.amber}` }} />
      {steps.map((s, i) => (
        <Card key={s.who} at={s.at - 6} left={120 + i * 420} top={330} width={390} out={tHalf - 8}>
          <div style={{ fontFamily: mono, fontSize: 16, color: C.amber, letterSpacing: "0.12em" }}>{String(i + 1).padStart(2, "0")} · {s.who.toUpperCase()}</div>
          <div style={{ marginTop: 12, fontSize: 30, letterSpacing: "-0.02em", lineHeight: 1.2 }}>{s.what}</div>
          <div style={{ marginTop: 16 }}><Pill size={16}>{s.detail}</Pill></div>
        </Card>
      ))}
      {f >= tHalf - 10 ? (
        <>
          <Browser name="pk_swap" url={`pikespeak.ai/transaction-viewer/${short(swap.hash, 8, 6)}`} width={1000} left={820} top={300} enter={tHalf - 10} startFrom={20} />
          <Card at={tHalf - 2} left={120} top={420} width={620}>
            <Kicker color={C.grey1}>settled on intents.near · {swap.utc.slice(0, 10)}</Kicker>
            <div style={{ marginTop: 16, fontSize: 44, whiteSpace: "nowrap", fontWeight: 500, letterSpacing: "-0.03em" }}>0.50 USDC <span style={{ color: C.amber }}>→</span> 0.0055 SOL</div>
            <div style={{ marginTop: 14, fontFamily: mono, fontSize: 19, color: C.grey1, lineHeight: 1.6 }}>5,545,636 lamports, above the 4,956,169 floor<br />tx {short(swap.hash, 8, 6)} · block {swap.block.toLocaleString("en-US")}</div>
          </Card>
        </>
      ) : null}
    </Fill>
  );
};
