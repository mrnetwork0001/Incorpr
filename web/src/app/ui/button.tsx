import Link from 'next/link';
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react';
import k from './kit.module.css';

/** primary: glossy amber glass. quiet: dark glass pill for actions inside panels. secondary: underlined grey text link. */
export type ButtonVariant = 'primary' | 'quiet' | 'secondary';
export type ButtonSize = 'sm' | 'md';

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ignored: buttons carry no arrows. Kept so older call sites still type-check. */
  arrow?: boolean;
  full?: boolean;
};

function classes({ variant = 'primary', size = 'md', full }: Common, extra?: string): string {
  return [k.btn, k[variant], size === 'sm' && k.sm, full && k.full, extra].filter(Boolean).join(' ');
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  Common & {
    /** Shows a spinner, sets aria-busy and disables the button. */
    busy?: boolean;
    busyLabel?: ReactNode;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, arrow: _arrow, full, busy, busyLabel, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={classes({ variant, size, full }, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className={k.spinner} aria-hidden />}
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
});

export type ButtonLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> &
  Common & {
    href: string;
    /** Opens in a new tab with rel="noreferrer". Use for explorers and other sites. */
    external?: boolean;
  };

export function ButtonLink({ href, variant, size, arrow: _arrow, full, external, className, children, ...rest }: ButtonLinkProps) {
  const cls = classes({ variant, size, full }, className);
  const content = children;
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls} {...rest}>
        {content}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} {...rest}>
      {content}
    </Link>
  );
}
