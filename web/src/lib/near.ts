import { JsonRpcProvider } from 'near-api-js';

/**
 * `sandbox` is a local near-sandbox node started by scripts/lib/sandbox.mjs. `scripts/deploy.mjs
 * --network sandbox` writes its RPC URL and contract ids to <sandbox home>/web.env.local.
 */
export type NearNetwork = 'testnet' | 'mainnet' | 'sandbox';

export const NEAR_NETWORKS: readonly NearNetwork[] = ['mainnet', 'testnet', 'sandbox'];

export interface ExplorerHosts {
  /** nearblocks.io: `/txns/<hash>`, `/address/<account>`. Null on a sandbox, which no explorer indexes. */
  near: string | null;
  /** mempool.space: `/tx/<txid>`, `/address/<address>`. */
  btc: string;
  /** solscan.io: `/tx/<sig>`, `/account/<address>`, plus `cluster` on devnet. */
  sol: string;
  solCluster: string | null;
  /** basescan.org: `/tx/<hash>`, `/address/<address>`. */
  evm: string;
}

export interface NetworkConfig {
  network: NearNetwork;
  /** First entry is used; later entries take over when it cannot be reached. */
  rpcUrls: string[];
  /** `rpcUrls[0]`. */
  rpcUrl: string;
  mpcContract: string;
  /** `intents.near` on mainnet. There is no testnet deployment, so null unless a test contract is set. */
  intentsContract: string | null;
  registryId: string | null;
  usdcToken: string | null;
  btcHrp: 'bc' | 'tb';
  /** Same as `explorers.near`. */
  explorerUrl: string | null;
  explorers: ExplorerHosts;
}

type Defaults = Omit<NetworkConfig, 'network' | 'registryId' | 'rpcUrl'>;

/** Native USDC on NEAR (Circle), 6 decimals. */
export const MAINNET_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

const DEFAULTS: Record<NearNetwork, Defaults> = {
  testnet: {
    rpcUrls: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
    mpcContract: 'v1.signer-prod.testnet',
    intentsContract: null,
    usdcToken: null,
    btcHrp: 'tb',
    explorerUrl: 'https://testnet.nearblocks.io',
    explorers: {
      near: 'https://testnet.nearblocks.io',
      btc: 'https://mempool.space/testnet4',
      sol: 'https://solscan.io',
      solCluster: 'devnet',
      evm: 'https://sepolia.basescan.org',
    },
  },
  mainnet: {
    rpcUrls: ['https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com'],
    mpcContract: 'v1.signer',
    intentsContract: 'intents.near',
    usdcToken: MAINNET_USDC,
    btcHrp: 'bc',
    explorerUrl: 'https://nearblocks.io',
    explorers: {
      near: 'https://nearblocks.io',
      btc: 'https://mempool.space',
      sol: 'https://solscan.io',
      solCluster: null,
      evm: 'https://basescan.org',
    },
  },
  // Contract ids follow scripts/lib/network.mjs (root test.near), with the SANDBOX ONLY doubles from
  // contracts/test-doubles for the signer, intents and USDC. The default RPC is scripts/lib/sandbox.mjs's
  // port. The vault derives testnet-format L1 addresses there, so L1 links go to the test networks.
  sandbox: {
    rpcUrls: ['http://127.0.0.1:32123'],
    mpcContract: 'mpc.test.near',
    intentsContract: 'intents.test.near',
    usdcToken: 'usdc.test.near',
    btcHrp: 'tb',
    explorerUrl: null,
    explorers: {
      near: null,
      btc: 'https://mempool.space/testnet4',
      sol: 'https://solscan.io',
      solCluster: 'devnet',
      evm: 'https://sepolia.basescan.org',
    },
  },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Each NEXT_PUBLIC_ variable is read by its full name, because Next inlines them textually.
export function getNetworkConfig(): NetworkConfig {
  const raw = process.env.NEXT_PUBLIC_NEAR_NETWORK || 'testnet';
  if (raw !== 'testnet' && raw !== 'mainnet' && raw !== 'sandbox') {
    throw new ConfigError(`NEXT_PUBLIC_NEAR_NETWORK must be mainnet, testnet or sandbox, got ${raw}`);
  }
  const defaults = DEFAULTS[raw];
  // An explicit RPC URL replaces the defaults entirely: a sandbox or a private node has no fallback.
  const override = process.env.NEXT_PUBLIC_NEAR_RPC_URL;
  const rpcUrls = override ? [override] : defaults.rpcUrls;
  return {
    network: raw,
    rpcUrls,
    rpcUrl: rpcUrls[0] as string,
    mpcContract: process.env.NEXT_PUBLIC_MPC_CONTRACT_ID || defaults.mpcContract,
    intentsContract: process.env.NEXT_PUBLIC_INTENTS_CONTRACT_ID || defaults.intentsContract,
    registryId: process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID || null,
    usdcToken: process.env.NEXT_PUBLIC_USDC_CONTRACT_ID || defaults.usdcToken,
    btcHrp: defaults.btcHrp,
    explorerUrl: defaults.explorerUrl,
    explorers: defaults.explorers,
  };
}

export function requireRegistryId(config: NetworkConfig = getNetworkConfig()): string {
  if (!config.registryId) {
    throw new ConfigError('NEXT_PUBLIC_REGISTRY_CONTRACT_ID is not set');
  }
  return config.registryId;
}

export function requireUsdcToken(config: NetworkConfig = getNetworkConfig()): string {
  if (!config.usdcToken) {
    throw new ConfigError('NEXT_PUBLIC_USDC_CONTRACT_ID is not set');
  }
  return config.usdcToken;
}

// ---------------------------------------------------------------------------- Explorer links
// Bitcoin links go to mempool.space (testnet4 off mainnet), Solana to solscan (devnet off mainnet),
// EVM to basescan (Base Sepolia off mainnet). No explorer indexes a local sandbox, so the NEAR helpers
// throw ConfigError there; `addressExplorerUrl` and `transactionExplorerUrl` return null instead.

function nearExplorer(config: NetworkConfig): string {
  if (!config.explorers.near) throw new ConfigError(`No public NEAR explorer indexes the ${config.network} network`);
  return config.explorers.near;
}

export function txExplorerUrl(txHash: string, config: NetworkConfig = getNetworkConfig()): string {
  return `${nearExplorer(config)}/txns/${txHash}`;
}

export function accountExplorerUrl(accountId: string, config: NetworkConfig = getNetworkConfig()): string {
  return `${nearExplorer(config)}/address/${accountId}`;
}

export function btcAddressUrl(address: string, config: NetworkConfig = getNetworkConfig()): string {
  return `${config.explorers.btc}/address/${address}`;
}

export function btcTxUrl(txid: string, config: NetworkConfig = getNetworkConfig()): string {
  return `${config.explorers.btc}/tx/${txid}`;
}

function solscan(path: string, config: NetworkConfig): string {
  const cluster = config.explorers.solCluster;
  return `${config.explorers.sol}${path}${cluster ? `?cluster=${cluster}` : ''}`;
}

export function solAddressUrl(address: string, config: NetworkConfig = getNetworkConfig()): string {
  return solscan(`/account/${address}`, config);
}

export function solTxUrl(signature: string, config: NetworkConfig = getNetworkConfig()): string {
  return solscan(`/tx/${signature}`, config);
}

/** Base. The vault's EVM address is the same on every EVM chain; Base is the one the UI links. */
export function evmAddressUrl(address: string, config: NetworkConfig = getNetworkConfig()): string {
  return `${config.explorers.evm}/address/${address}`;
}

export function evmTxUrl(txHash: string, config: NetworkConfig = getNetworkConfig()): string {
  return `${config.explorers.evm}/tx/${txHash}`;
}

export type ExplorerChain = 'near' | 'btc' | 'sol' | 'evm';

/** An address or account link on any of the four chains, or null when the network has no explorer. */
export function addressExplorerUrl(chain: ExplorerChain, address: string, config: NetworkConfig = getNetworkConfig()): string | null {
  switch (chain) {
    case 'near':
      return config.explorers.near ? accountExplorerUrl(address, config) : null;
    case 'btc':
      return btcAddressUrl(address, config);
    case 'sol':
      return solAddressUrl(address, config);
    case 'evm':
      return evmAddressUrl(address, config);
  }
}

/** A transaction link on any of the four chains, or null when the network has no explorer. */
export function transactionExplorerUrl(chain: ExplorerChain, hash: string, config: NetworkConfig = getNetworkConfig()): string | null {
  switch (chain) {
    case 'near':
      return config.explorers.near ? txExplorerUrl(hash, config) : null;
    case 'btc':
      return btcTxUrl(hash, config);
    case 'sol':
      return solTxUrl(hash, config);
    case 'evm':
      return evmTxUrl(hash, config);
  }
}

// ---------------------------------------------------------------------------- RPC

const providers = new Map<string, JsonRpcProvider>();

export function getProvider(rpcUrl: string = getNetworkConfig().rpcUrl): JsonRpcProvider {
  let provider = providers.get(rpcUrl);
  if (!provider) {
    provider = new JsonRpcProvider({ url: rpcUrl });
    providers.set(rpcUrl, provider);
  }
  return provider;
}

export type ViewFailure = 'account_not_found' | 'no_contract' | 'method_not_found' | 'contract_panic' | 'rpc';

export class NearViewError extends Error {
  constructor(
    readonly failure: ViewFailure,
    readonly contractId: string,
    readonly method: string,
    detail: string,
  ) {
    super(`${contractId}.${method}: ${detail}`);
    this.name = 'NearViewError';
  }
}

export function classifyViewError(message: string): ViewFailure {
  if (/does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(message)) return 'account_not_found';
  if (/MethodNotFound|MethodResolveError/i.test(message)) return 'method_not_found';
  if (/CodeDoesNotExist|contract is not deployed|NO_CONTRACT_CODE|has no contract/i.test(message)) return 'no_contract';
  if (/wasm execution failed|Smart contract panicked|GuestPanic|HostError/i.test(message)) return 'contract_panic';
  return 'rpc';
}

export interface ViewOptions {
  /** One endpoint, no fallback. Defaults to the network's `rpcUrls`. */
  rpcUrl?: string;
  /** Use `optimistic` where a read must see a payment made seconds ago. */
  finality?: 'final' | 'optimistic';
}

/**
 * Read-only contract call. Returns the JSON value the method returned. Next caches fetches made
 * during a server component render, including these, so a page reading live state needs
 * `export const dynamic = 'force-dynamic'`.
 *
 * Moves to the next RPC endpoint only on a transport failure. A panic or a missing account is the
 * chain's answer, and every endpoint would give the same one.
 */
export async function viewFunction<T>(
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
  options: ViewOptions = {},
): Promise<T> {
  const urls = options.rpcUrl ? [options.rpcUrl] : getNetworkConfig().rpcUrls;
  let last: NearViewError | null = null;
  for (const url of urls) {
    try {
      const result = await getProvider(url).callFunctionRaw({
        contractId,
        method,
        args,
        blockQuery: { finality: options.finality ?? 'final' },
      });
      return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      last = error instanceof NearViewError ? error : new NearViewError(classifyViewError(message), contractId, method, message);
      if (last.failure !== 'rpc') throw last;
    }
  }
  throw last as NearViewError;
}
