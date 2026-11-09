import React from "react";
import { C, mono } from "../theme";
import { Charter } from "../ui/Charter";
import { Words } from "../ui/Words";
import { In, Panel, Stage, useCue } from "./common";

/** 06: borrow. accept_offer pledges the NFT; the vault refuses owner signatures until repay. */
export const Borrow: React.FC = () => {
  const { f, rel } = useCue("borrow");
  const tPledge = rel("Pledge", 50);
  const tLoan = rel("loan,", 90);
  const tFrozen = rel("frozen", 140);
  return (
    <Stage
      id="borrow"
      kicker="Borrow"
      head={<Words text="Borrow USDC against the company." at={6} every={3} accent={{ "USDC": C.amber }} />}
      sub="While the loan is open, the vault refuses the owner's signing requests."
      footage={[{ name: "desk", url: "localhost:3010/desk" }]}
      codeAt={tFrozen - 6}
      code={[
        { t: "// incorpr-registry", c: "dim" },
        { t: "accept_offer(offer_id)", c: "amber" },
        { t: "vault: apply_encumbrance(Pledged)", c: "dim", indent: 1 },
        { t: "// company-vault", c: "dim" },
        { t: "request_shareholder_signature(..)", c: "amber" },
        { t: "ERR_ACCOUNT_ENCUMBERED_SIGNING_FROZEN", c: "danger", indent: 1 },
      ]}
    >
      <Panel at={tPledge - 6} left={1010} top={190} width={790} height={300} glow={0.9}>
        <div style={{ transform: "scale(0.62)", transformOrigin: "0 0", position: "absolute", left: 32, top: 30 }}>
          <Charter width={600} state={f < tPledge + 4 ? "FREE" : "PLEDGED"} glow={0.4} />
        </div>
        <div style={{ position: "absolute", left: 430, top: 40, width: 330 }}>
          <In at={tLoan - 2}>
            <div style={{ fontFamily: mono, fontSize: 16, letterSpacing: "0.12em", color: C.grey2, textTransform: "uppercase" }}>lender to owner</div>
            <div style={{ fontSize: 34, fontWeight: 500, color: C.amber, marginTop: 6 }}>USDC principal</div>
          </In>
          <In at={tFrozen - 2} style={{ marginTop: 34 }}>
            <div style={{ fontFamily: mono, fontSize: 16, letterSpacing: "0.12em", color: C.grey2, textTransform: "uppercase" }}>until repaid</div>
            <div style={{ fontSize: 30, fontWeight: 500, marginTop: 6 }}>Owner signing frozen</div>
            <div style={{ fontSize: 22, color: C.grey1, marginTop: 6 }}>Treasury agent frozen</div>
          </In>
        </div>
      </Panel>
    </Stage>
  );
};
