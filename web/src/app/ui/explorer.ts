// Explorer links for the kit. Hosts come from getNetworkConfig() in lib/near.ts, so a testnet build
// links testnet.nearblocks.io, mempool.space/testnet4, Solscan devnet and Base Sepolia.

import {
  accountExplorerUrl,
  btcAddressUrl,
  btcTxUrl,
  evmAddressUrl,
  evmTxUrl,
  solAddressUrl,
  solTxUrl,
  txExplorerUrl,
} from '@/lib/near';

export type Chain = 'near' | 'btc' | 'sol' | 'evm';
export type ExplorerTarget = 'address' | 'tx';

export const EXPLORER_NAME: Record<Chain, string> = {
  near: 'NearBlocks',
  btc: 'mempool.space',
  sol: 'Solscan',
  evm: 'BaseScan',
};

export const CHAIN_NAME: Record<Chain, string> = {
  near: 'NEAR',
  btc: 'Bitcoin',
  sol: 'Solana',
  evm: 'Base',
};

const URLS: Record<Chain, Record<ExplorerTarget, (value: string) => string>> = {
  near: { address: (v) => accountExplorerUrl(v), tx: (v) => txExplorerUrl(v) },
  btc: { address: (v) => btcAddressUrl(v), tx: (v) => btcTxUrl(v) },
  sol: { address: (v) => solAddressUrl(v), tx: (v) => solTxUrl(v) },
  evm: { address: (v) => evmAddressUrl(v), tx: (v) => evmTxUrl(v) },
};

/** Explorer URL for an address or transaction. Null when the network config cannot be read. */
export function explorerHref(chain: Chain, target: ExplorerTarget, value: string): string | null {
  try {
    return URLS[chain][target](value);
  } catch {
    return null;
  }
}

/** `abcdef12…7890ab`. Values that already fit are returned unchanged. */
export function middleTruncate(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
