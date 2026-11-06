import React from "react";
import { C, mono } from "../theme";
import { Words } from "../ui/Words";
import { In, Panel, Stage, useCue } from "./common";

const Node: React.FC<{ title: string; sub: string; accent?: boolean }> = ({ title, sub, accent }) => (
  <div style={{ padding: "16px 22px", borderRadius: 14, background: accent ? "rgba(240,162,76,0.10)" : "rgba(255,255,255,0.04)", boxShadow: `inset 0 0 0 1px ${accent ? "rgba(240,162,76,0.5)" : "rgba(255,255,255,0.10)"}` }}>
    <div style={{ fontFamily: mono, fontSize: 24, color: accent ? C.amber : C.ink }}>{title}</div>
    <div style={{ fontSize: 19, color: C.grey1, marginTop: 4 }}>{sub}</div>
  </div>
);

/** 02: incorporate. The registry creates a keyless vault sub-account; v1.signer derives its foreign addresses. */
export const Incorporate: React.FC = () => {
  const { rel } = useCue("incorporate");
  const tVault = rel("vault:", 60);
  const tChain = rel("Chain", 150);
  return (
    <Stage
      id="incorporate"
      kicker="Incorporate"
      head={<Words text="A vault account with no owner key." at={6} every={3} accent={{ "no": C.amber, "owner": C.amber, "key.": C.amber }} />}
      sub="Bitcoin, Solana and EVM addresses come from NEAR Chain Signatures. There is no seed phrase."
      footage={[{ name: "incorporate", url: "localhost:3010/incorporate" }, { name: "company", url: "localhost:3010/company" }]}
      codeAt={tChain}
      code={[
        { t: "// incorpr-registry", c: "dim" },
        { t: "incorporate_company(args) -> Promise", c: "amber" },
        { t: "creates c-<id>.<registry>, deploys company-vault", c: "dim", indent: 1 },
        { t: "// company-vault", c: "dim" },
        { t: "refresh_treasury_keys() -> v1.signer", c: "amber" },
      ]}
    >
      <Panel at={tVault - 6} left={1010} top={190} width={790} glow={0.9}>
        <In at={tVault - 2}><Node title="<registry>.near" sub="NEP-171 registry and factory" /></In>
        <In at={tVault + 8} style={{ marginTop: 16, marginLeft: 40 }}><Node accent title="c-<id>.<registry>.near" sub="company vault: contract code only, no full-access key" /></In>
        <div style={{ display: "flex", gap: 14, marginTop: 16, marginLeft: 80 }}>
          {[["BTC", "secp256k1"], ["SOL", "ed25519"], ["EVM", "secp256k1"]].map(([a, b], i) => (
            <In key={a} at={tChain + 6 + i * 6} style={{ flex: 1 }}><Node title={a} sub={`${b} via v1.signer`} /></In>
          ))}
        </div>
      </Panel>
    </Stage>
  );
};
