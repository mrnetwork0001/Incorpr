import type { CSSProperties } from 'react';
import k from './kit.module.css';

type Size = number | string;

const px = (v: Size | undefined) => (typeof v === 'number' ? `${v}px` : v);

/** Placeholder block while a value loads. Static under prefers-reduced-motion. */
export function Skeleton({ width = '100%', height = 14, radius, className }: { width?: Size; height?: Size; radius?: Size; className?: string }) {
  const style: CSSProperties = { width: px(width), height: px(height), borderRadius: px(radius) };
  return <span className={[k.skeleton, className].filter(Boolean).join(' ')} style={style} aria-hidden />;
}

/** A few text-height lines, the last one shorter. Announces "Loading" to screen readers. */
export function SkeletonText({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div className={k.skeletonText} role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 && lines > 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}
