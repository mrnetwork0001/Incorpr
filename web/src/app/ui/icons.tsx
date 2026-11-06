// Small stroke icons for the kit. 16px grid, currentColor.

type IconProps = { className?: string };

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};


export function ExternalIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path d="M6.5 3.5h-3v9h9v-3M9 3.5h3.5V7M12.5 3.5 7 9" {...stroke} />
    </svg>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" {...stroke} />
      <path d="M10.5 3.5V3a.5.5 0 0 0-.5-.5H3a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h.5" {...stroke} />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path d="m3.5 8.5 3 3 6-7" {...stroke} />
    </svg>
  );
}

export function CrossIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" {...stroke} />
    </svg>
  );
}

export function InfoIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <circle cx="8" cy="8" r="6" {...stroke} />
      <path d="M8 7.2v4M8 4.9v.1" {...stroke} />
    </svg>
  );
}

export function AlertIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path d="M8 2.2 14.2 13H1.8L8 2.2Z" {...stroke} />
      <path d="M8 6.5v3M8 11.2v.1" {...stroke} />
    </svg>
  );
}

export function EmptyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <rect x="2.5" y="3.5" width="11" height="9" rx="2" {...stroke} />
      <path d="M2.5 8.5h3l1 1.5h3l1-1.5h3" {...stroke} />
    </svg>
  );
}

export function SparkleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path d="M8 0.8c.4 3.6 2.6 5.9 6.2 6.4-3.6.5-5.8 2.8-6.2 6.4C7.6 10 5.4 7.7 1.8 7.2 5.4 6.7 7.6 4.4 8 .8Z" fill="currentColor" />
    </svg>
  );
}
