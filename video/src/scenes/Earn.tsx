import React from "react";
import { C, mono } from "../theme";
import { Words } from "../ui/Words";
import { In, Panel, Stage, useCue } from "./common";

const Step: React.FC<{ at: number; n: string; title: string; sub: string; ok?: boolean }> = ({ at, n, title, sub, ok }) => (
  <In at={at} style={{ display: "flex", gap: 20, alignItems: "flex-start", marginBottom: 20 }}>
    <div style={{ width: 40, height: 40, borderRadius: 20, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: 18, color: ok ? C.bg : C.amber, background: ok ? C.ok : "rgba(240,162,76,0.12)", boxShadow: ok ? "none" : "inset 0 0 0 1px rgba(240,162,76,0.5)" }}>{n}</div>
    <div>
      <div style={{ fontSize: 27, fontWeight: 500, letterSpacing: "-0.02em" }}>{title}</div>
      <div style={{ fontFamily: mono, fontSize: 18, color: C.grey1, marginTop: 3 }}>{sub}</div>
    </div>
  </In>
);

/** 03: earn. Pay per call in USDC (or via NEAR Intents); revenue is booked on arrival; the TEE signs the answer. */
export const Earn: React.FC = () => {
  const { rel } = useCue("earn");
  const tBooks = rel("books", 120);
  const tModel = rel("model", 220);
  const tVerifies = rel("verifies", 300);
  return (
    <Stage
      id="earn"
      kicker="Earn"
      head={<Words text="Paid per call. Booked on arrival." at={6} every={3} accent={{ "arrival.": C.amber }} />}
      sub="USDC on NEAR, or any supported token from another chain through NEAR Intents."
      footage={[{ name: "company", url: "localhost:3010/company" }]}
      codeAt={tModel}
      code={[
        { t: "// company-vault", c: "dim" },
        { t: "ft_on_transfer(sender_id, amount, msg) -> U128", c: "amber" },
        { t: "record_service_call(call_id, tee_chat_id)", c: "amber" },
        { t: "GET cloud-api.near.ai/v1/signature/{chat_id}", c: "dim" },
      ]}
    >
      <Panel at={10} left={1010} top={190} width={790} glow={0.9}>
        <Step at={16} n="1" title="Customer pays the vault" sub="ft_transfer_call · USDC" />
        <Step at={tBooks - 4} n="2" title="Vault books the revenue" sub="only inside ft_on_transfer" />
        <Step at={tModel - 2} n="3" title="Model runs in a NEAR AI Cloud TEE" sub="Intel TDX + NVIDIA confidential compute" />
        <Step at={tVerifies - 2} n="✓" ok title="Browser verifies the signature" sub="ECDSA over the request and response hashes" />
      </Panel>
    </Stage>
  );
};
