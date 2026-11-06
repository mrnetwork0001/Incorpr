import { getNetworkConfig } from '@/lib/near';
import s from './shell.module.css';

/** NEAR network the app is configured for: testnet teal, mainnet amber. */
export function NetworkBadge() {
  let network: string;
  try {
    network = getNetworkConfig().network;
  } catch {
    return (
      <span className={`${s.network} ${s.misconfigured}`} title="NEXT_PUBLIC_NEAR_NETWORK must be testnet or mainnet">
        network misconfigured
      </span>
    );
  }
  return (
    <span className={`${s.network} ${network === 'mainnet' ? s.mainnet : s.testnet}`} title={`Connected to NEAR ${network}`}>
      {network}
    </span>
  );
}
