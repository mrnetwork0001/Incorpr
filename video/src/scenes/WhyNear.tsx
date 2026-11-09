import React from "react";
import { C, LIGHT, mono } from "../theme";
import { D, short, tx } from "../data";
import { Logo } from "../ui/Seal";
import { Words } from "../ui/Words";
import { Card, Em, Fill, Head, In, Row, useCue } from "./common";

/** 04. Why NEAR, on paper: the four primitives, each with the proof that it ran for this company. */
export const WhyNear: React.FC = () => {
  const { rel } = useCue("whynear");
  const swap = tx("rebalance_swap");
  const cards = [
    { at: rel("Accounts", 100), n: "01", title: "Keyless accounts", body: "A sub-account that runs code and holds zero keys.",
      proof: [["account", D.vault.account], ["access keys", String(D.vault.access_keys)]] },
    { at: rel("Chain", 194), n: "02", title: "Chain Signatures", body: "One NEAR contract signs for Bitcoin, Solana and EVM.",
      proof: [["signer", "v1.signer"], ["chains", "BTC · SOL · EVM"]], logos: ["bitcoin", "solana", "ethereum-mark"] },
    { at: rel("Intents,", 396), n: "03", title: "NEAR Intents", body: "Cross-chain swaps settled in one step.",
      proof: [["verifier", "intents.near"], ["swap", short(swap.hash, 8, 6)]] },
    { at: rel("Cloud,", 545), n: "04", title: "NEAR AI Cloud", body: "The model runs in a TEE and signs every answer.",
      proof: [["TEE", "Intel TDX + NVIDIA"], ["signer", short(D.agent_market.test_job.signer, 6, 4)]], logos: ["near-ai"] },
  ];
  return (
    <Fill tone="light">
      <div style={{ position: "absolute", left: 120, top: 120, display: "flex", alignItems: "center", gap: 26 }}>
        <In at={4}><Logo name="near" size={70} /></In>
        <Head size={76} style={{ color: LIGHT.ink }}>
          <Words text="This needs four things." at={6} every={4} /> <In at={rel("NEAR", 52) - 2} style={{ display: "inline-block" }}><Em>NEAR has all four.</Em></In>
        </Head>
      </div>
      {cards.map((c, i) => (
        <Card key={c.n} light at={c.at - 6} left={120 + i * 425} top={330} width={400} height={560}>
          <div style={{ fontFamily: mono, fontSize: 20, color: C.amber }}>{c.n}</div>
          <div style={{ marginTop: 12, fontSize: 40, fontWeight: 500, letterSpacing: "-0.03em", color: LIGHT.ink, lineHeight: 1.05 }}>{c.title}</div>
          <div style={{ marginTop: 16, fontSize: 25, lineHeight: 1.35, color: LIGHT.sub, minHeight: 104 }}>{c.body}</div>
          <div style={{ marginTop: 18, display: "flex", gap: 12, height: 48 }}>
            {(c.logos ?? []).map((l) => <Logo key={l} name={l} size={44} />)}
          </div>
          <div style={{ position: "absolute", left: 30, right: 30, bottom: 26, borderTop: `1px solid ${LIGHT.line}`, paddingTop: 14 }}>
            <div style={{ fontFamily: mono, fontSize: 14, color: LIGHT.sub, letterSpacing: "0.14em", marginBottom: 4 }}>ON MAINNET</div>
            {c.proof.map(([k, v]) => <Row key={k} k={k} v={v} light size={18} />)}
          </div>
        </Card>
      ))}
    </Fill>
  );
};
