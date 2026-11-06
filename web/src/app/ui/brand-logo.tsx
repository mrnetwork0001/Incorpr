/* eslint-disable @next/next/no-img-element -- static brand PNG; the image optimizer is disabled in next.config */

/** Incorpr logo (mark and wordmark) for the header, footer and drawer. Source: public/brand/incorpr-header.png, 366x120. */
export function BrandLogo({ height = 34, className }: { height?: number; className?: string }) {
  return (
    <img
      src="/brand/incorpr-header.png"
      alt="Incorpr"
      width={Math.round((height * 366) / 120)}
      height={height}
      className={className}
      style={{ display: 'block', height, width: 'auto' }}
    />
  );
}
