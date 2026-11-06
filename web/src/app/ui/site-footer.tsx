import Link from 'next/link';
import { getNetworkConfig } from '@/lib/near';
import { Handoff, Mark } from '../hero/hero';
import s from './shell.module.css';

const APP_LINKS: [string, string][] = [
  ['/exchange', 'Exchange'],
  ['/incorporate', 'Incorporate'],
  ['/desk', 'Capital markets desk'],
  ['/rob', 'Rob this company'],
  ['/verify', 'Verify the claims'],
];

const PROTOCOL_LINKS: [string, string][] = [
  ['how-it-works', 'How it works'],
  ['states', 'Company state'],
  ['security', 'Security model'],
  ['status', 'Build status'],
];

function liveNetwork(): { network: string; mpcContract: string; registryId: string | null } | null {
  try {
    const { network, mpcContract, registryId } = getNetworkConfig();
    return { network, mpcContract, registryId };
  } catch {
    return null;
  }
}

export type SiteFooterProps = {
  /** On the landing page the protocol links are in-page anchors; elsewhere they go to /#section. */
  onLanding?: boolean;
  /** The seller-to-buyer hand-off image and wordmark under the footer. Default true. */
  handoff?: boolean;
};

/** Footer shared by the landing page and every app screen. */
export function SiteFooter({ onLanding = false, handoff = true }: SiteFooterProps) {
  const live = liveNetwork();
  const anchor = (id: string) => (onLanding ? `#${id}` : `/#${id}`);
  return (
    <div className={s.footerWrap}>
      <footer className={s.footer}>
        <div className={s.footGrid}>
          <div>
            <Link href="/" className={s.footBrand}>
              <Mark className={s.mark} />
              incorpr
            </Link>
            <p className={s.footBlurb}>Companies as NEP-171 NFTs on NEAR, each with its own keyless vault and treasury.</p>
          </div>
          <div>
            <p className={s.footHead}>App</p>
            <div className={s.footLinks}>
              {APP_LINKS.map(([href, label]) => (
                <Link key={href} href={href}>
                  {label}
                </Link>
              ))}
            </div>
          </div>
          <div>
            <p className={s.footHead}>Protocol</p>
            <div className={s.footLinks}>
              {PROTOCOL_LINKS.map(([id, label]) => (
                <a key={id} href={anchor(id)}>
                  {label}
                </a>
              ))}
            </div>
          </div>
          <div>
            <p className={s.footHead}>Live network</p>
            <div className={s.footLinks}>
              {live ? (
                <>
                  <p className={s.netRow}>
                    <span className={s.netKey}>Network</span>
                    <span className={s.netVal}>{live.network}</span>
                  </p>
                  <p className={s.netRow}>
                    <span className={s.netKey}>Signer</span>
                    <span className={s.netVal}>{live.mpcContract}</span>
                  </p>
                  <p className={s.netRow}>
                    <span className={s.netKey}>Registry</span>
                    <span className={s.netVal}>{live.registryId ?? 'not configured'}</span>
                  </p>
                </>
              ) : (
                <p className={s.netRow}>
                  <span className={s.netKey}>Network</span>
                  <span className={s.netVal}>NEXT_PUBLIC_NEAR_NETWORK is not testnet or mainnet</span>
                </p>
              )}
            </div>
          </div>
        </div>
        <div className={s.footLegal}>
          <span>&copy;2026 Incorpr</span>
          <span>NEAR Hackathon 2026</span>
        </div>
      </footer>
      {handoff && <Handoff />}
    </div>
  );
}
