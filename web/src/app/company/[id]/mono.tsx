import { CopyButton, middleTruncate } from '../../ui';
import s from './cockpit.module.css';

/** A hash, id or key that is not an on-chain account: mono, middle-truncated, with a copy button. */
export function Mono({ value, label, head = 12, tail = 8, full }: { value: string; label: string; head?: number; tail?: number; full?: boolean }) {
  return (
    <span className={s.monoValue}>
      <span className={full ? s.wrapMono : s.mono} title={value}>
        {full ? value : middleTruncate(value, head, tail)}
      </span>
      <CopyButton value={value} label={label} />
    </span>
  );
}
