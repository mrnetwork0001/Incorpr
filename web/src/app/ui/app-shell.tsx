import Link from 'next/link';
import type { ReactNode } from 'react';
import { Mark } from '../hero/hero';
import { WalletStatus } from '../wallet-status';
import { NavLinks } from './nav-links';
import { NetworkBadge } from './network-badge';
import s from './shell.module.css';
import { SiteFooter } from './site-footer';
import { ToastProvider } from './toast';

export type AppShellProps = {
  children: ReactNode;
  /** Hand-off image under the footer. Default true, as on the landing page. */
  handoff?: boolean;
};

/**
 * Frame for every app screen: sticky header (brand, nav, network, wallet), the shared content
 * container (max-width --content-max, padding 0 --gutter), the landing footer, and the toast host.
 */
export function AppShell({ children, handoff = true }: AppShellProps) {
  return (
    <ToastProvider>
      <div className={s.shell}>
        <header className={s.header}>
          <div className={s.bar}>
            <Link href="/" className={s.brand}>
              <Mark className={s.mark} />
              incorpr
            </Link>
            <div className={s.right}>
              <NavLinks className={s.navDesktop} />
              <NetworkBadge />
              <WalletStatus />
            </div>
          </div>
          <NavLinks className={s.navMobile} />
        </header>
        <main className={s.main}>{children}</main>
        <SiteFooter handoff={handoff} />
      </div>
    </ToastProvider>
  );
}
