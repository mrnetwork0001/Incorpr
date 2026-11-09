import React from "react";
import { interpolate } from "remotion";
import { C, mono } from "../theme";
import { D, short, usdc } from "../data";
import { Browser, markOf } from "../ui/Footage";
import { Count } from "../ui/Count";
import { clamp } from "../ui/motion";
import { Card, Em, Fill, Head, In, Kicker, Pill, Row, useCue } from "./common";

/** 06. Earn: the owner's real paid call from a wallet, then the same company on Agent Market. */
export const Earn: React.FC = () => {
  const { f, rel } = useCue("earn");
  const pay = D.owner_pay.payment, book = D.owner_pay.booking;
  const am = D.agent_market;
  const tListed = rel("listed", 330);
  const RATE = 1.9;
  // Owner clip from "connect"; the payment chip lands with the wallet approval, the booking with the answer.
  const atClip = (m: string) => Math.round(markOf("owner_pay", m) / RATE) + 4;
  const marketIn = tListed - 14;
  return (
    <Fill>
      {f < marketIn + 20 ? (
        <div style={{ opacity: interpolate(f, [marketIn - 8, marketIn + 2], [1, 0], clamp) }}>
          <div style={{ position: "absolute", left: 90, top: 120, width: 560 }}>
            <Kicker>A real payment from a wallet</Kicker>
            <Head size={64} style={{ marginTop: 22 }}>Pay <Em>per call.</Em></Head>
          </div>
          <Browser name="owner_pay" url="tryincorpr.vercel.app/company/1" width={1140} left={690} top={130} enter={2} rate={RATE} exit={marketIn} />
          <Card at={atClip("approve")} left={90} top={340} width={560} out={marketIn}>
            <Kicker color={C.grey1}>payment · ft_transfer_call</Kicker>
            <div style={{ marginTop: 10 }}>
              <Row k="from" v={pay.signer} />
              <Row k="to" v={pay.args.receiver_id} />
              <Row k="amount" v={`${usdc(pay.args.amount)} USDC`} color={C.amber} />
              <Row k="tx" v={short(pay.hash, 8, 6)} />
            </div>
          </Card>
          <Card at={atClip("answer")} left={90} top={640} width={560} out={marketIn}>
            <Kicker color={C.grey1}>booked · record_service_call</Kicker>
            <div style={{ marginTop: 10 }}>
              <Row k="TEE chat" v={short(book.args.tee_chat_id, 12, 6)} />
              <Row k="tx" v={short(book.hash, 8, 6)} />
              <Row k="calls served" v={<><span style={{ color: C.grey2 }}>4 →</span> <span style={{ color: C.ok }}>{D.vault.state.api_calls_served}</span></>} />
            </div>
          </Card>
        </div>
      ) : null}
      {f >= marketIn + 2 ? (
        <div style={{ opacity: interpolate(f, [marketIn + 2, marketIn + 16], [0, 1], clamp) }}>
          <div style={{ position: "absolute", left: 90, top: 120, width: 600 }}>
            <Kicker>Also hired on</Kicker>
            <Head size={64} style={{ marginTop: 22 }}>NEAR's <Em>Agent Market</Em></Head>
            <In at={marketIn + 10} style={{ marginTop: 20, fontFamily: mono, fontSize: 20, color: C.grey1 }}>market.near.ai/a/{am.handle}</In>
          </div>
          <Browser name="market" url="market.near.ai/a/ledgerline-audit" width={1100} left={730} top={130} enter={marketIn} startFrom={30} />
          <Card at={rel("delivered", 427) - 10} left={90} top={420} width={600}>
            <Kicker color={C.grey1}>first test job · {am.test_job.created_utc.slice(0, 10)}</Kicker>
            <div style={{ display: "flex", gap: 40, marginTop: 14 }}>
              <div>
                <div style={{ fontSize: 76, fontWeight: 500, letterSpacing: "-0.04em" }}><Count to={am.test_job.seconds_to_delivery} at={rel("sixteen", 444) - 6} dur={20} /><span style={{ fontSize: 30, color: C.grey1 }}> s</span></div>
                <div style={{ fontFamily: mono, fontSize: 16, color: C.grey2, letterSpacing: "0.1em" }}>HIRE TO DELIVERY</div>
              </div>
              <div>
                <div style={{ fontSize: 76, fontWeight: 500, letterSpacing: "-0.04em", color: C.ok }}><Count to={am.test_job.tee_checks_passed} at={rel("seventeen", 485) - 6} dur={20} /><span style={{ fontSize: 30, color: C.grey1 }}>/17</span></div>
                <div style={{ fontFamily: mono, fontSize: 16, color: C.grey2, letterSpacing: "0.1em" }}>TEE CHECKS PASSED</div>
              </div>
            </div>
            <div style={{ marginTop: 18 }}><Pill tone="ok" size={16}>{short(am.test_job.chat_id, 14, 6)}</Pill></div>
          </Card>
        </div>
      ) : null}
    </Fill>
  );
};
