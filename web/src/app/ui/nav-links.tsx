'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import s from './shell.module.css';

export const APP_NAV: { href: string; label: string }[] = [
  { href: '/exchange', label: 'Exchange' },
  { href: '/incorporate', label: 'Incorporate' },
  { href: '/desk', label: 'Desk' },
  { href: '/rob', label: 'Rob this company' },
  { href: '/verify', label: 'Verify' },
];

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
