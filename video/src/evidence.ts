import React from "react";
import { staticFile } from "remotion";

/**
 * On-screen transaction hashes come only from /Users/mrnetwork/Incorpr/docs/evidence/<network>.json.
 * scripts/sync.mjs copies that file to public/evidence/ before each render; loadEvidence() fetches it at
 * render time (from calculateMetadata). With no file, or no entry for a scene, the scene shows no hash.
 *
 * The file is read loosely: any object with a NEAR tx hash in `hash` (or txHash / tx_hash /
 * transaction_hash) is an entry, named by its `key` / `label` / `step` field or by its JSON key.
 * Optional fields: method, receiver / receiver_id, status, error, explorer / url, block, timestamp.
 */
export interface Tx { key: string; hash: string; method?: string; receiver?: string; status?: string; error?: string; explorer: string; block?: number | string; timestamp?: string }
export interface Evidence { network: string; txs: Tx[]; source: string }

const NEAR_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const explorerFor = (network: string, h: string) => `${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${h}`;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function parseEvidence(raw: unknown, network: string, source: string): Evidence {
  const txs: Tx[] = [];
  const walk = (v: unknown, name: string) => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const h = str(o.hash) ?? str(o.txHash) ?? str(o.tx_hash) ?? str(o.transaction_hash);
    if (h && NEAR_HASH.test(h)) {
      const url = str(o.explorer) ?? str(o.url);
      txs.push({
        key: (str(o.key) ?? str(o.label) ?? str(o.step) ?? name).toLowerCase(),
        hash: h,
        method: str(o.method) ?? str(o.method_name),
        receiver: str(o.receiver) ?? str(o.receiver_id),
        status: str(o.status),
        error: str(o.error),
        explorer: url && /nearblocks\.io\//.test(url) ? url.replace(/^https?:\/\//, "") : explorerFor(network, h),
        block: (o.block ?? o.block_height ?? o.blockHeight) as number | string | undefined,
        timestamp: str(o.timestamp) ?? str(o.time),
      });
    }
    for (const [k, x] of Object.entries(o)) walk(x, Array.isArray(v) ? name : k);
  };
  walk(raw, "tx");
  const net = str((raw as Record<string, unknown> | null)?.network) ?? network;
  return { network: net, txs, source };
}

/** Tries mainnet, then testnet (or only `network` if given). Never throws: no file means no evidence. */
export async function loadEvidence(network?: string): Promise<Evidence | null> {
  for (const n of network ? [network] : ["mainnet", "testnet"]) {
    try {
      const res = await fetch(staticFile(`evidence/${n}.json`));
      if (!res.ok) continue;
      return parseEvidence(await res.json(), n, `docs/evidence/${n}.json`);
    } catch {
      // not present
    }
  }
  return null;
}

/** First entry whose key, method or label contains one of `words`. */
export const findTx = (ev: Evidence | null, words: string[]): Tx | undefined =>
  ev?.txs.find((t) => words.some((w) => t.key.includes(w) || (t.method ?? "").toLowerCase().includes(w)));

/** Scene evidence: which entries each scene may show. */
export const SCENE_TX: Record<string, string[]> = {
  hook: ["acquire", "nft_transfer", "sale"],
  incorporate: ["incorporate", "mint", "create"],
  earn: ["pay", "service", "ft_transfer_call", "revenue"],
  rob: ["rob", "firewall", "reject", "withdraw"],
  sell: ["acquire", "sale", "sell", "buy", "list"],
  borrow: ["pledge", "loan", "borrow", "accept_offer"],
};

export interface Assets { hands: boolean }
export interface FilmProps { evidence: Evidence | null; assets: Assets; [key: string]: unknown }
export const EMPTY: FilmProps = { evidence: null, assets: { hands: false } };

export async function exists(path: string): Promise<boolean> {
  try { return (await fetch(staticFile(path), { method: "HEAD" })).ok; } catch { return false; }
}

export const EvidenceCtx = React.createContext<FilmProps>(EMPTY);
export const useFilm = () => React.useContext(EvidenceCtx);
export const short = (h: string, a = 8, b = 6) => `${h.slice(0, a)}…${h.slice(-b)}`;
