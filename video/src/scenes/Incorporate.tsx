import React from "react";
import { C, mono } from "../theme";
import { D, addresses, short, tx, utc } from "../data";
import { Browser } from "../ui/Footage";
import { Seal, Logo } from "../ui/Seal";
import { Card, Em, Fill, Head, In, Row, useCue } from "./common";

/** 05. Incorporate: the wizard, then the vault as the seal with its three derived addresses. */
export const Incorporate: React.FC = () => {
  const { rel, f } = useCue("incorporate");
  const inc = tx("incorporate");
  const a = addresses();
  const tVault = rel("vault", 119);
  const tZero = rel("zero", 148);
  const tDerives = rel("derives", 210);
  const rows = [["bitcoin", "BTC", a.btc, rel("Bitcoin,", 230)], ["solana", "SOL", a.sol, rel("Solana", 247)], ["ethereum-mark", "EVM", a.evm, rel("EVM", 266)]] as const;
  const first = f < tVault - 6;
  return (
    <Fill>
      <div style={{ position: "absolute", left: 120, top: 150, width: 640 }}>
        <Head size={78}>Incorporate in <Em>one mint.</Em></Head>
        <In at={20} style={{ marginTop: 26 }}>
          <div style={{ fontFamily: mono, fontSize: 20, color: C.grey1, lineHeight: 1.7 }}>
            incorporate_company · {utc(inc.utc)}<br />tx {short(inc.hash, 8, 6)} · block {inc.block.toLocaleString("en-US")}
          </div>
        </In>
      </div>
      {first ? (
        <Browser name="incorporate" url="tryincorpr.vercel.app/incorporate" width={1000} left={820} top={180} enter={4} startFrom={30} />
      ) : (
        <>
          <Seal at={tVault - 8} size={440} x={1340} y={500} label={D.vault.account} orbitAt={tDerives - 6} />
          <Card at={tZero - 4} left={120} top={420} width={680}>
            <Row k="vault" v={D.vault.account} />
            <Row k="access keys" v={`${D.vault.access_keys}, no upgrade method`} color={C.amber} />
            <Row k="NFT owner" v={D.vault.owner} />
          </Card>
          {rows.map(([logo, k, addr, at], i) => (
            <Card key={k} at={at - 4} left={120} top={640 + i * 100} width={680} style={{ padding: "16px 24px", display: "flex", alignItems: "center", gap: 20 }}>
              <Logo name={logo} size={40} />
              <span style={{ fontFamily: mono, fontSize: 18, color: C.amber, width: 50 }}>{k}</span>
              <span style={{ fontFamily: mono, fontSize: 22 }}>{short(addr, 14, 10)}</span>
            </Card>
          ))}
        </>
      )}
    </Fill>
  );
};
