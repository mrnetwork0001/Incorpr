import { CopyButton } from './copy-button';
import { CHAIN_NAME, EXPLORER_NAME, explorerHref, middleTruncate, type Chain, type ExplorerTarget } from './explorer';
import k from './kit.module.css';

export type AddressProps = {
  /** Account id, L1 address or transaction hash. */
  value: string;
  chain?: Chain;
  /** "address" links the explorer's account page, "tx" its transaction page. */
  target?: ExplorerTarget;
  /** Characters kept at each end. Defaults 8 and 6. */
  head?: number;
  tail?: number;
  /** Show the whole value, wrapping anywhere, instead of truncating the middle. */
  full?: boolean;
  /** No explorer link, e.g. for a value that is not on-chain yet. */
  noLink?: boolean;
  /** Small chain tag before the value: NEAR, BTC, SOL, EVM. */
  showChain?: boolean;
  className?: string;
};

/** Mono value, middle-truncated, with a copy button and a link to the right explorer. */
export function Address({
  value,
  chain = 'near',
  target = 'address',
  head = 8,
  tail = 6,
  full,
  noLink,
  showChain,
  className,
}: AddressProps) {
  const href = noLink ? null : explorerHref(chain, target, value);
  const shown = full ? value : middleTruncate(value, head, tail);
  const textClass = [k.addressText, full && k.addressWrap].filter(Boolean).join(' ');
  const kind = target === 'tx' ? 'transaction' : 'address';
  return (
    <span className={[k.address, className].filter(Boolean).join(' ')}>
      {showChain && <span className={k.addressChain}>{chain}</span>}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={textClass}
          title={`${value}\nOpen on ${EXPLORER_NAME[chain]}`}
          aria-label={`${CHAIN_NAME[chain]} ${kind} ${value}, open on ${EXPLORER_NAME[chain]}`}
        >
          {shown}
        </a>
      ) : (
        <span className={textClass} title={value}>
          {shown}
        </span>
      )}
      <CopyButton value={value} label={`${CHAIN_NAME[chain]} ${kind}`} />
    </span>
  );
}

/** A transaction hash: Address with target "tx". */
export function TxHash(props: Omit<AddressProps, 'target'>) {
  return <Address {...props} target="tx" />;
}
