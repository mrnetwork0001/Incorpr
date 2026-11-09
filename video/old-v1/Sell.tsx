import React from "react";
import { interpolate } from "remotion";
import { C, mono } from "../theme";
import { Charter } from "../ui/Charter";
import { Words } from "../ui/Words";
import { clamp, soft } from "../ui/motion";
import { In, Panel, Stage, useCue } from "./common";

const Party: React.FC<{ name: string; sub: string }> = ({ name, sub }) => (
  <div style={{ width: 170, textAlign: "center" }}>
    <div style={{ fontSize: 26, fontWeight: 500 }}>{name}</div>
    <div style={{ fontFamily: mono, fontSize: 16, color: C.grey2, marginTop: 4 }}>{sub}</div>
  </div>
);

/** 05: sell. list_company freezes the vault; the buyer's USDC transfer settles NFT and vault together. */
export const Sell: React.FC = () => {
  const { f, rel } = useCue("sell");
  const tLists = rel("lists", 40);
  const tPays = rel("pays,", 100);
  const tOne = rel("one", 190);
  const move = interpolate(f, [tPays + 10, tPays + 50], [0, 1], { ...clamp, easing: soft });
  const usdc = interpolate(f, [tPays - 4, tPays + 30], [0, 1], { ...clamp, easing: soft });
  const state = f < tLists + 6 ? "FREE" : move < 1 ? "LISTED" : "FREE";
  return (
    <Stage
      id="sell"
      kicker="Sell"
      head={<Words text="The NFT and the company move together." at={6} every={3} accent={{ "together.": C.amber }} />}
      sub="One buyer transaction pays the seller and hands over the NFT and the vault."
      footage={[{ name: "desk", url: "localhost:3010/desk" }, { name: "exchange", url: "localhost:3010/exchange" }]}
      codeAt={tOne - 10}
      code={[
        { t: "// incorpr-registry", c: "dim" },
        { t: "list_company(token_id, ask)", c: "amber" },
        { t: "vault: apply_encumbrance(Listed)", c: "dim", indent: 1 },
        { t: "ft_on_transfer(buyer, amount, {Acquire})", c: "amber" },
        { t: "on_acquire_settled -> buyer owns NFT and vault", c: "dim", indent: 1 },
      ]}
    >
      <Panel at={tLists - 6} left={1010} top={190} width={790} height={350} glow={0.9}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <Party name="Owner" sub="seller" />
          <Party name="Buyer" sub="ft_transfer_call" />
        </div>
        <div style={{ position: "absolute", left: 40 + 330 * move, top: 110, transform: "scale(0.62)", transformOrigin: "0 0" }}>
          <Charter width={600} state={state} glow={0.5} />
        </div>
        <In at={tPays - 4} style={{ position: "absolute", right: 40 + 470 * usdc, top: 112, fontFamily: mono, fontSize: 22, color: C.amber, padding: "8px 16px", borderRadius: 999, background: "rgba(240,162,76,0.12)", boxShadow: "inset 0 0 0 1px rgba(240,162,76,0.5)" }}>
          USDC
        </In>
      </Panel>
    </Stage>
  );
};
