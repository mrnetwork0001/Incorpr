'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import s from './mobile-nav.module.css';
import { BrandLogo } from './brand-logo';

export type DrawerLink = { href: string; label: string };
export type DrawerGroup = { title: string; links: DrawerLink[] };

export type MobileNavProps = {
  groups: DrawerGroup[];
  /** Primary action pinned to the bottom of the drawer. */
  cta?: DrawerLink;
  /** Extra content above the CTA, for example the network badge. */
  footer?: ReactNode;
  /** Viewport width from which the burger is hidden and the desktop nav takes over. */
  hideFrom: 900 | 1100;
};

/**
 * Burger button and left drawer for phones and tablets.
 *
 * The drawer is portalled to <body>: the sticky headers use backdrop-filter, which would make a fixed
 * child position against the header instead of the viewport. It closes on the backdrop, Esc, the close
 * button, any link tap, and route changes, and it locks page scroll while open.
 */
export function MobileNav({ groups, cta, footer, hideFrom }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname() ?? '';
  const burgerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => setMounted(true), []);
  useEffect(() => close(), [pathname, close]);

  useEffect(() => {
    if (!open) return;
    const burger = burgerRef.current;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKey);
      burger?.focus({ preventScroll: true });
    };
  }, [open]);

  const isActive = (href: string) => !href.startsWith('#') && (pathname === href || pathname.startsWith(`${href}/`));

  const drawer = (
    <>
      <button type="button" className={`${s.backdrop} ${open ? s.show : ''}`} aria-label="Close menu" tabIndex={-1} onClick={close} />
      <div id="mobile-drawer" className={`${s.drawer} ${open ? s.open : ''}`} role="dialog" aria-modal="true" aria-label="Menu" aria-hidden={!open}>
        <div className={s.head}>
          <Link href="/" className={s.brand} onClick={close}>
            <BrandLogo height={32} />
          </Link>
          <button ref={closeRef} type="button" className={s.close} aria-label="Close menu" onClick={close}>
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <nav className={s.body} aria-label="Menu">
          {groups.map((group) => (
            <div key={group.title} className={s.group}>
              <p className={s.groupTitle}>{group.title}</p>
              {group.links.map(({ href, label }, i) => {
                const active = isActive(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`${s.link} ${active ? s.active : ''}`}
                    style={{ '--i': i } as React.CSSProperties}
                    aria-current={active ? 'page' : undefined}
                    onClick={close}
                  >
                    <span>{label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className={s.foot}>
          {footer}
          {cta && (
            <Link href={cta.href} className={s.cta} onClick={close}>
              {cta.label}
            </Link>
          )}
        </div>
      </div>
    </>
  );

  return (
    <>
      <button
        ref={burgerRef}
        type="button"
        className={`${s.burger} ${hideFrom === 900 ? s.hideFrom900 : s.hideFrom1100} ${open ? s.burgerOpen : ''}`}
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="mobile-drawer"
        onClick={() => setOpen((o) => !o)}
      >
        <span />
        <span />
        <span />
      </button>
      {mounted && createPortal(drawer, document.body)}
    </>
  );
}
