import raw from "../data/onchain.json";

/** Every hash, block, time and figure in the film: data/onchain.json, read back by scripts/onchain.mjs. */
export const D = raw as any;
export const tx = (k: string) => {
  const t = D.transactions[k];
  if (!t) throw new Error(`transaction ${k} missing from data/onchain.json`);
  return t as { hash: string; block: number; utc: string; signer: string; receiver: string; method: string; status: string; errors: string[] };
};
export const short = (s: string, a = 6, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
export const utc = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";
export const usdc = (micro: string | number) => (Number(micro) / 1e6).toFixed(2);
/** The vault's current treasury addresses (get_state.addresses). */
export const addresses = () => {
  const a = D.vault.state.addresses ?? {};
  return { btc: a.btc ?? a.bitcoin ?? D.company.btc, sol: a.sol ?? a.solana ?? D.company.sol, evm: a.evm ?? a.ethereum ?? D.company.evm };
};
