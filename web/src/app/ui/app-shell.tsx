import Link from 'next/link';
import type { ReactNode } from 'react';
import { WalletStatus } from '../wallet-status';
import { MobileNav } from './mobile-nav';
import { APP_NAV, LANDING_SECTIONS } from './nav-items';
import { NavLinks } from './nav-links';
import { NetworkBadge } from './network-badge';
import s from './shell.module.css';
import { SiteFooter } from './site-footer';
import { ToastProvider } from './toast';
import { BrandLogo } from './brand-logo';

export type AppShellProps = {
  children: ReactNode;
};

/**
 * Frame for every app screen: sticky header (brand, nav, network, wallet), the shared content
 * container (max-width --content-max, padding 0 --gutter), the landing footer, and the toast host.
 */
export function AppShell({ children }: AppShellProps) {
  return (
    <ToastProvider>
      <div className={s.shell}>
        <header className={s.header}>
          <div className={s.bar}>
            <Link href="/" className={s.brand}>
              <BrandLogo height={34} />
            </Link>
            <div className={s.right}>
              <NavLinks className={s.navDesktop} />
              <span className={s.badgeInBar}>
                <NetworkBadge />
              </span>
              <WalletStatus />
              <MobileNav
                hideFrom={1100}
                groups={[
                  { title: 'App', links: APP_NAV },
                  { title: 'Incorpr', links: [{ href: '/', label: 'Home' }, ...LANDING_SECTIONS] },
                ]}
                footer={<NetworkBadge />}
              />
            </div>
          </div>
        </header>
        <main className={s.main}>{children}</main>
        <SiteFooter />
      </div>
    </ToastProvider>
  );
}
