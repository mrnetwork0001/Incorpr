'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { APP_NAV } from './nav-items';
import s from './shell.module.css';

export { APP_NAV };

/** App nav links. The current route gets aria-current="page" and the amber active pill. */
export function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname() ?? '';
  return (
    <nav className={className} aria-label="App">
      {APP_NAV.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} className={`${s.link} ${active ? s.linkActive : ''}`} aria-current={active ? 'page' : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
