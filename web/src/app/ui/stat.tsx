import type { ReactNode } from 'react';
import k from './kit.module.css';

export type Tone = 'default' | 'amber' | 'teal' | 'lilac' | 'peach' | 'coral' | 'muted';

export const TONE_CLASS: Record<Tone, string | undefined> = {
  default: undefined,
  amber: k.toneAmber,
  teal: k.toneTeal,
  lilac: k.toneLilac,
  peach: k.tonePeach,
  coral: k.toneCoral,
  muted: k.toneMuted,
};

export type StatProps = {
  label: ReactNode;
  /** Rendered in IBM Plex Mono with tabular numbers. Pass the formatted string. */
  value: ReactNode;
  /** Small trailing unit, e.g. "USDC". */
  unit?: string;
  hint?: ReactNode;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
};

export function Stat({ label, value, unit, hint, tone = 'default', size = 'md' }: StatProps) {
  const sizeClass = size === 'lg' ? k.statLg : size === 'sm' ? k.statSm : undefined;
  return (
    <div className={k.stat}>
      <span className={k.statLabel}>{label}</span>
      <span className={[k.statValue, sizeClass, TONE_CLASS[tone]].filter(Boolean).join(' ')}>
        {value}
        {unit && <span className={k.statUnit}>{unit}</span>}
      </span>
      {hint && <span className={k.statHint}>{hint}</span>}
    </div>
  );
}

/** Responsive grid for Stat: as many 170px columns as fit, one column on a phone. */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={[k.statGrid, className].filter(Boolean).join(' ')}>{children}</div>;
}
