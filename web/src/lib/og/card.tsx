// Share card building blocks for next/og (Satori). 1200x630, the landing page's design system:
// #0D0D0D with grain and amber glows, Google Sans Flex headlines with a white-to-#d9c2a8 second
// line, IBM Plex Mono for data, amber pills and glass panels with a lit top edge.
//
// Satori rules that shape this file: every element with more than one child needs display flex,
// styles are inline objects, and text interpolation must be a single string.

import { ImageResponse } from 'next/og';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { loadOgFonts, MONO, SANS } from './fonts';
import { OG_SIZE, type StateLabel } from './format';

export { OG_SIZE };
export const OG_CONTENT_TYPE = 'image/png';

export const C = {
  bg: '#0d0d0d',
  amber: '#f0a24c',
  amberBright: '#f7b866',
  peach: '#f6c9a2',
  lilac: '#c9b3ff',
  teal: '#79d4c0',
  coral: '#f08f7d',
  cream: '#e9d3bb',
  grey1: '#adadad',
  grey2: '#7d7d7d',
  grey3: '#717171',
  hair: 'rgba(255, 255, 255, 0.07)',
  amberHair: 'rgba(240, 162, 76, 0.16)',
};

const sans = `'${SANS}', 'Noto Sans', sans-serif`;
const mono = `'${MONO}', monospace`;

// Background: #0d0d0d, two soft amber glows and film grain, drawn as one SVG. resvg renders SVG
// radial gradients and feTurbulence cleanly, where CSS radial-gradient in Satori bands. The grain is
// white noise in the alpha channel only, at about 5% strength.
const BACKGROUND =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='630' viewBox='0 0 1200 630'>" +
      "<defs>" +
      "<radialGradient id='a' cx='0.5' cy='0.5' r='0.5'><stop offset='0' stop-color='#f0a24c' stop-opacity='0.17'/><stop offset='0.55' stop-color='#f0a24c' stop-opacity='0.06'/><stop offset='1' stop-color='#f0a24c' stop-opacity='0'/></radialGradient>" +
      "<radialGradient id='b' cx='0.5' cy='0.5' r='0.5'><stop offset='0' stop-color='#f0a24c' stop-opacity='0.10'/><stop offset='1' stop-color='#f0a24c' stop-opacity='0'/></radialGradient>" +
      "<filter id='n' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.09 0'/></filter>" +
      "</defs>" +
      "<rect width='1200' height='630' fill='#0d0d0d'/>" +
      "<ellipse cx='950' cy='190' rx='560' ry='420' fill='url(#a)'/>" +
      "<ellipse cx='560' cy='660' rx='520' ry='220' fill='url(#b)'/>" +
      "<rect width='1200' height='630' filter='url(#n)'/>" +
      "</svg>",
  );

export function Mark({ size = 30, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke={color} strokeWidth="1.6" />
      <path d="M8 16.5V9.2c0-.4.3-.7.7-.7h2.6v8H8Z" fill={color} />
      <path d="M13 16.5V7.5h2.3c.4 0 .7.3.7.7v8.3H13Z" fill={color} opacity="0.55" />
    </svg>
  );
}

function Sparkle({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M8 0.8c.4 3.6 2.6 5.9 6.2 6.4-3.6.5-5.8 2.8-6.2 6.4C7.6 10 5.4 7.7 1.8 7.2 5.4 6.7 7.6 4.4 8 .8Z" fill={C.amber} />
    </svg>
  );
}

interface FrameProps {
  /** Right side of the header, for example "NEAR testnet". */
  network?: string | null;
  /** Left side of the footer, mono. */
  footer: string;
  children: ReactNode;
}

/** Background, header with the mark, and footer. Content fills the middle band. */
export function Frame({ network, footer, children }: FrameProps) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        background: C.bg,
        color: '#fff',
        fontFamily: sans,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text -- Satori draws <img>, not next/image */}
      <img src={BACKGROUND} width={1200} height={630} style={{ position: 'absolute', left: 0, top: 0 }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '44px 64px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Mark />
          <span style={{ fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}>incorpr</span>
        </div>
        {network ? (
          <span
            style={{
              display: 'flex',
              padding: '6px 14px',
              borderRadius: 999,
              border: `1px solid ${C.hair}`,
              background: 'rgba(255, 255, 255, 0.03)',
              fontFamily: mono,
              fontSize: 15,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: C.grey1,
            }}
          >
            {network}
          </span>
        ) : null}
      </div>

      <div style={{ display: 'flex', flex: 1, padding: '0 64px', alignItems: 'center' }}>{children}</div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          margin: '0 64px',
          padding: '18px 0 34px',
          borderTop: `1px solid ${C.hair}`,
          fontFamily: mono,
          fontSize: 16,
          color: C.grey3,
        }}
      >
        <span>{footer || ' '}</span>
        <span>NEP-171 companies on NEAR</span>
      </div>
    </div>
  );
}

/** Dark amber pill with a numbered chip or a sparkle. */
export function Pill({ index, children, tone = 'amber' }: { index?: string; children: string; tone?: 'amber' | 'coral' }) {
  const accent = tone === 'coral' ? C.coral : C.amber;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        alignSelf: 'flex-start',
        padding: index ? '6px 18px 6px 7px' : '8px 18px 8px 13px',
        borderRadius: 999,
        background: '#1d1510',
        boxShadow: `inset 0 0 0 1px ${tone === 'coral' ? 'rgba(240, 143, 125, 0.4)' : 'rgba(240, 162, 76, 0.32)'}, 0 0 24px rgba(240, 162, 76, 0.08)`,
        fontSize: 19,
        color: C.cream,
      }}
    >
      {index ? (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 30,
            height: 30,
            padding: '0 8px',
            borderRadius: 999,
            background: tone === 'coral' ? 'linear-gradient(180deg, #f6ab9c, #f08f7d)' : `linear-gradient(180deg, ${C.amberBright}, ${C.amber})`,
            color: '#1a120b',
            fontFamily: mono,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {index}
        </span>
      ) : (
        <Sparkle />
      )}
      <span style={{ color: tone === 'coral' ? '#f6d2c8' : C.cream }}>{children}</span>
    </div>
  );
}

/** White first line, white-to-#d9c2a8 second line. */
export function Headline({ line1, line2, size = 70 }: { line1: string; line2?: string; size?: number }) {
  const base: CSSProperties = { fontSize: size, fontWeight: 500, letterSpacing: '-0.042em', lineHeight: 1.04 };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 26 }}>
      <span style={{ ...base, color: '#fff' }}>{line1}</span>
      {line2 ? (
        <span
          style={{
            ...base,
            backgroundImage: 'linear-gradient(180deg, #ffffff 30%, #d9c2a8 130%)',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          {line2}
        </span>
      ) : null}
    </div>
  );
}

export function Lede({ children, width = 560 }: { children: string; width?: number }) {
  return <p style={{ margin: '24px 0 0', width, fontSize: 22, lineHeight: 1.45, color: C.grey1 }}>{children}</p>;
}

/** Glass panel with an amber hairline and a lit top edge. */
export function Panel({ children, width = 500, title, meta }: { children: ReactNode; width?: number; title?: string; meta?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        width,
        padding: '26px 28px 28px',
        borderRadius: 18,
        border: `1px solid ${C.amberHair}`,
        backgroundImage: 'linear-gradient(160deg, rgba(40, 31, 23, 0.94), rgba(16, 14, 13, 0.96) 62%)',
        boxShadow: '0 30px 80px rgba(0, 0, 0, 0.55), 0 0 60px rgba(240, 162, 76, 0.06)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 48,
          right: 48,
          top: -1,
          height: 2,
          display: 'flex',
          backgroundImage: `linear-gradient(90deg, rgba(255, 210, 154, 0), #ffd29a 30%, ${C.amber} 70%, rgba(240, 162, 76, 0))`,
        }}
      />
      {title ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <span style={{ fontFamily: mono, fontSize: 15, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.grey2 }}>{title}</span>
          {meta ? <span style={{ fontFamily: mono, fontSize: 15, color: C.grey3 }}>{meta}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

const STATE_COLOR: Record<StateLabel, string> = { FREE: C.teal, LISTED: C.amber, PLEDGED: C.lilac };

/** FREE teal circle, LISTED amber diamond, PLEDGED lilac square, as in encumbrance-pill.tsx. */
export function StatePill({ state, size = 'md' }: { state: StateLabel; size?: 'sm' | 'md' }) {
  const color = STATE_COLOR[state];
  const dot = size === 'md' ? 9 : 7;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: size === 'md' ? '6px 16px 6px 13px' : '4px 12px 4px 10px',
        borderRadius: 999,
        border: `1px solid ${color}66`,
        background: `${color}17`,
        fontFamily: mono,
        fontSize: size === 'md' ? 18 : 14,
        fontWeight: 500,
        letterSpacing: '0.1em',
        color,
      }}
    >
      <span
        style={{
          display: 'flex',
          width: dot,
          height: dot,
          background: color,
          borderRadius: state === 'FREE' ? 999 : state === 'PLEDGED' ? 2 : 1,
          ...(state === 'LISTED' ? { transform: 'rotate(45deg)' } : {}),
          boxShadow: `0 0 8px ${color}`,
        }}
      />
      <span>{state}</span>
    </div>
  );
}

/** Label over a mono value. */
export function Datum({ label, value, color = '#fff', size = 30, width }: { label: string; value: string; color?: string; size?: number; width?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...(width ? { width } : {}) }}>
      <span style={{ fontFamily: mono, fontSize: 13, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.grey2 }}>{label}</span>
      <span style={{ fontFamily: mono, fontSize: size, fontWeight: 500, letterSpacing: '-0.02em', color }}>{value}</span>
    </div>
  );
}

/** One mono row: short label, then a value. */
export function Row({ label, value, color = C.peach, size = 19 }: { label: string; value: string; color?: string; size?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '9px 0', borderTop: `1px solid ${C.hair}` }}>
      <span style={{ width: 64, fontFamily: mono, fontSize: 14, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.grey2 }}>{label}</span>
      <span style={{ fontFamily: mono, fontSize: size, color }}>{value}</span>
    </div>
  );
}

export const fontFamilies = { sans, mono };

/** Renders a card. Fonts load from Google Fonts; without them next/og's bundled font is used. */
export async function renderCard(node: ReactElement, { maxAge = 300 }: { maxAge?: number } = {}): Promise<ImageResponse> {
  const fonts = await loadOgFonts();
  return new ImageResponse(node, {
    ...OG_SIZE,
    // An empty list makes next/og fail with "No fonts are loaded"; leave it out to use the bundled font.
    ...(fonts.length > 0 ? { fonts: fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: f.style })) } : {}),
    headers: { 'cache-control': `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 4}` },
  });
}
