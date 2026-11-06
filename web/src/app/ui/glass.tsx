import type { HTMLAttributes, ReactNode } from 'react';
import k from './kit.module.css';

const PAD = { none: undefined, sm: k.padSm, md: k.padMd, lg: k.padLg } as const;

export type GlassProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'article' | 'aside' | 'li';
  /** Glowing amber top edge, for the featured panel on a screen. */
  lit?: boolean;
  /** Lift and glow on hover, for clickable cards. */
  hover?: boolean;
  pad?: keyof typeof PAD;
};

/** Dark amber glass panel, 18px radius, amber hairline. */
export function Glass({ as: Tag = 'div', lit, hover, pad = 'md', className, children, ...rest }: GlassProps) {
  const classes = [k.glass, lit && k.lit, hover && k.hover, PAD[pad], className].filter(Boolean).join(' ');
  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}

/** Title row inside a Glass panel, with optional meta text or an action on the right. */
export function GlassHeader({ title, meta, as: Heading = 'h2' }: { title: ReactNode; meta?: ReactNode; as?: 'h2' | 'h3' }) {
  return (
    <div className={k.glassHead}>
      <Heading className={k.glassTitle}>{title}</Heading>
      {meta && <div className={k.glassMeta}>{meta}</div>}
    </div>
  );
}
