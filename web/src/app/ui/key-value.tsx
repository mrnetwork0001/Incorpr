import type { ReactNode } from 'react';
import k from './kit.module.css';

export type KeyValueItem = {
  label: ReactNode;
  value: ReactNode;
  /** IBM Plex Mono, for amounts, ids and hashes given as plain text. */
  mono?: boolean;
};

/** Label / value rows with hairline separators. Stacks on a phone, two columns from 600px. */
export function KeyValue({ items, className }: { items: KeyValueItem[]; className?: string }) {
  return (
    <dl className={[k.kv, className].filter(Boolean).join(' ')}>
      {items.map((item, i) => (
        <div key={i} className={k.kvRow}>
          <dt className={k.kvLabel}>{item.label}</dt>
          <dd className={[k.kvValue, item.mono && k.kvMono].filter(Boolean).join(' ')}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
