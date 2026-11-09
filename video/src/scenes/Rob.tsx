import React from "react";
import { Sequence, interpolate } from "remotion";
import { C, mono } from "../theme";
import { D, short } from "../data";
import { Browser, clip } from "../ui/Footage";
import { clamp } from "../ui/motion";
import { Card, Em, Fill, Head, Kicker, Pill, Stamp, useCue } from "./common";

/**
 * 08. Rob it. The live /rob page on 2026-11-09: a visitor's message, the treasury agent agreeing
 * (signed in the TEE), then the real attempts, each refused by the vault on mainnet.
 */
export const Rob: React.FC = () => {
  const { f, rel, dur } = useCue("rob");
  const live = D.live_rob;
  const codes = Object.fromEntries(live.attempts.map((a: any) => [a.method + (a.errors[0] ?? ""), a]));
  const find = (code: string) => live.attempts.find((a: any) => a.errors.includes(code));
  const attacks = [
    { at: rel("drain", 94), label: "drain the treasury", code: "ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION" },
    { at: rel("Forge", 146), label: "forge the AI's approval", code: "ERR_TEE_SIGNATURE_UNTRUSTED" },
    { at: rel("Sell", 216), label: "sell for 1 satoshi", code: "ERR_FIREWALL_PRICE_BELOW_FLOOR" },
  ];
  void codes;
  const segB = 250, segC = rel("fooled.", 474) - 44;
  const last = (clip("rob")?.durationFrames ?? 1150) - 3;
  const tFooled = rel("fooled.", 474), tCant = rel("can't.", 526);
  const red = interpolate(f, [rel("refuses", 375) - 4, rel("refuses", 375) + 8, dur], [0, 0.22, 0.1], clamp);
  return (
    <Fill>
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(50% 60% at 70% 50%, rgba(255,107,94,${red}), transparent 70%)` }} />
      <div style={{ position: "absolute", left: 90, top: 110, width: 600 }}>
        <Kicker color={C.danger} dot={C.danger}>tryincorpr.vercel.app/rob</Kicker>
        <Head size={66} style={{ marginTop: 20 }}>We invited people <Em>to rob it.</Em></Head>
      </div>
      <Sequence durationInFrames={segB + 6} layout="none">
        <Browser name="rob" url="tryincorpr.vercel.app/rob" width={1120} left={720} top={140} enter={2} startFrom={80} rate={1.3} cams={[{ f: 0, z: 1 }, { f: 120, rect: "chat", z: 1.35 }]} />
      </Sequence>
      <Sequence from={segB} durationInFrames={segC - segB + 6} layout="none">
        <Browser name="rob" url="tryincorpr.vercel.app/rob" width={1120} left={720} top={140} startFrom={640} rate={1.8} />
      </Sequence>
      <Sequence from={segC} layout="none">
        <Browser name="rob" url="tryincorpr.vercel.app/rob" width={1120} left={720} top={140} startFrom={last} cams={[{ f: 0, z: 1 }, { f: tFooled - segC - 4, rect: "chat", z: 1.7 }, { f: tCant - segC - 6, rect: { x: 840, y: 160, w: 665, h: 560 }, z: 1.45 }]} />
      </Sequence>
      {attacks.map((a, i) => {
        const hit = find(a.code);
        return (
          <Card key={a.code} at={a.at - 4} left={90} top={360 + i * 150} width={600} out={segC - 10} style={{ padding: "16px 22px" }}>
            <div style={{ fontSize: 26, letterSpacing: "-0.01em" }}>{a.label}</div>
            <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center" }}>
              <Pill tone="danger" size={14}>{a.code}</Pill>
              {hit ? <span style={{ fontFamily: mono, fontSize: 14, color: C.grey2 }}>{short(hit.hash, 6, 4)}</span> : null}
            </div>
          </Card>
        );
      })}
      <div style={{ position: "absolute", left: 90, top: 840 }}>
        <Stamp at={rel("refuses", 375)} size={34}>{live.verdict.toUpperCase()}</Stamp>
      </div>
      <Card at={tFooled - 6} left={90} top={380} width={600}>
        <Kicker color={C.grey1}>the agent, signed in the TEE</Kicker>
        <div style={{ marginTop: 14, fontSize: 30, lineHeight: 1.3 }}>“{live.agent_reply_excerpt}…”</div>
        <div style={{ marginTop: 14, fontFamily: mono, fontSize: 18, color: C.danger }}>The AI said yes. The vault said no.</div>
      </Card>
    </Fill>
  );
};
