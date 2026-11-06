/** App routes, shared by the desktop nav, the mobile drawer and the landing drawer. Plain module so server components can import it. */
export const APP_NAV: { href: string; label: string }[] = [
  { href: '/exchange', label: 'Exchange' },
  { href: '/incorporate', label: 'Incorporate' },
  { href: '/desk', label: 'Desk' },
  { href: '/rob', label: 'Rob this company' },
  { href: '/verify', label: 'Verify' },
];

/** Landing page sections, reachable from the app drawer too. */
export const LANDING_SECTIONS: { href: string; label: string }[] = [
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/#security', label: 'Security model' },
  { href: '/#status', label: 'Build status' },
];
