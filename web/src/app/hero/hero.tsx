import Link from 'next/link';
import type { TreasuryAddresses } from '@/lib/contracts';
import { treasuryPath } from '@/lib/mpcAddresses';
import styles from './hero.module.css';

type HeroProps = {
  vaultAccount: string;
  registryId: string | null;
  addresses: TreasuryAddresses | null;
  mpcContract: string;
};

export function Mark({ className }: { className?: string }) {
  // A charter seal: an outer frame with a single filled share inside it.
  return (
    <svg className={className ?? styles.mark} viewBox="0 0 24 24" aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 16.5V9.2c0-.4.3-.7.7-.7h2.6v8H8Z" fill="currentColor" />
      <path d="M13 16.5V7.5h2.3c.4 0 .7.3.7.7v8.3H13Z" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

function Sparkle() {
  return (
    <svg className={styles.sparkle} viewBox="0 0 16 16" aria-hidden>
      <path d="M8 0.8c.4 3.6 2.6 5.9 6.2 6.4-3.6.5-5.8 2.8-6.2 6.4C7.6 10 5.4 7.7 1.8 7.2 5.4 6.7 7.6 4.4 8 .8Z" fill="currentColor" />
    </svg>
  );
}

type Token = { t: string; c?: 'key' | 'str' | 'num' | 'amber' | 'punct' | 'comment' };
type Line = Token[];

function field(key: string, value: string | null, last = false): Line {
  return [
    { t: '  ' },
    { t: `"${key}"`, c: 'key' },
    { t: ': ', c: 'punct' },
    value === null ? { t: 'null', c: 'num' } : { t: `"${value}"`, c: key === 'vault' ? 'amber' : 'str' },
    { t: last ? '' : ',', c: 'punct' },
  ];
}

function charterLines({ vaultAccount, registryId, addresses, mpcContract }: HeroProps): Line[] {
  const source = registryId ? `registry ${registryId}` : 'example account, no company is deployed there yet';
  return [
    [{ t: `// derived_public_key from ${mpcContract}`, c: 'comment' }],
    [{ t: `// ${source}`, c: 'comment' }],
    [{ t: '{', c: 'punct' }],
    field('vault', vaultAccount),
    field('path', treasuryPath('1', 0)),
    field('btc', addresses?.btc ?? null),
    field('evm', addresses?.evm ?? null),
    field('sol', addresses?.sol ?? null, true),
    [{ t: '}', c: 'punct' }],
    ...(addresses ? [] : [[{ t: '// the signer did not answer this time', c: 'comment' } as Token]]),
  ];
}

function CharterEditor(props: HeroProps) {
  const lines = charterLines(props);
  const registry = props.registryId ?? 'incorpr.testnet';
  return (
    <div className={styles.stage}>
      <aside className={styles.panel} aria-label="Treasury addresses read from the live signer">
        <div className={styles.panelBar}>
          <span className={styles.tabActive}>charter.json</span>
          <span className={styles.tab}>policy.rs</span>
          <span className={styles.live}>{props.addresses ? 'read live' : 'signer offline'}</span>
        </div>
        <div className={styles.panelBody}>
          <nav className={styles.tree} aria-label="Charter tree">
            <p className={styles.treeHead}>Charter</p>
            <p className={styles.treeItem}>{registry}</p>
            <p className={`${styles.treeItem} ${styles.treeSelected}`}>c-1</p>
            <p className={styles.treeChild}>vault</p>
            <p className={styles.treeChild}>ledger</p>
            <p className={styles.treeHead}>Treasury</p>
            <p className={styles.treeChild}>bitcoin</p>
            <p className={styles.treeChild}>evm</p>
            <p className={styles.treeChild}>solana</p>
          </nav>
          <pre className={styles.code}>
            {lines.map((line, i) => (
              <span key={i} className={styles.codeLine}>
                <span className={styles.lineNo}>{i + 1}</span>
                <span>
                  {line.map((tok, j) => (
                    <span key={j} className={tok.c ? styles[tok.c] : undefined}>
                      {tok.t}
                    </span>
                  ))}
                </span>
              </span>
            ))}
          </pre>
        </div>
      </aside>
    </div>
  );
}

export function HeroNav() {
  return (
    <header className={styles.header}>
      <nav className={styles.nav} aria-label="Main">
        <Link href="/" className={styles.brand}>
          <Mark />
          incorpr
        </Link>
        <div className={styles.navRight}>
          <div className={styles.navLinks}>
            <a href="#how-it-works">How it works</a>
            <a href="#security">Security</a>
            <a href="#status">Status</a>
          </div>
          <Link href="/exchange" className={`${styles.cta} ${styles.ctaSmall}`}>
            Launch App
          </Link>
        </div>
      </nav>
    </header>
  );
}

export function Hero(props: HeroProps) {
  return (
    <div className={styles.hero}>
      <section className={styles.band}>
        <div className={styles.copy}>
          <p className={styles.pill}>
            <Sparkle />
            Companies as NEP-171 NFTs on NEAR
          </p>
          <h1 className={styles.headline}>
            <span className={styles.line1}>A company you can sell</span>
            <span className={styles.line2}>in one NFT transfer.</span>
          </h1>
          <p className={styles.lede}>
            Each Incorpr token is an AI service with its own NEAR sub-account, USDC revenue ledger, and Bitcoin, Solana and EVM addresses.
            The sub-account has no access keys, so there is no seed phrase for a seller to keep.
          </p>
          <div className={styles.actions}>
            <Link href="/exchange" className={styles.cta}>
              Launch App
              <svg viewBox="0 0 16 16" className={styles.ctaArrow} aria-hidden>
                <path
                  d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
            <a href="#how-it-works" className={styles.secondary}>
              How it works
            </a>
          </div>
        </div>
        <CharterEditor {...props} />
      </section>
    </div>
  );
}

/** Closing image for the page footer: the hand-off between seller and buyer, over the wordmark. */
export function Handoff() {
  return (
    <div className={styles.handoff}>
      {/* eslint-disable-next-line @next/next/no-img-element -- static transparent PNG, the image optimizer is disabled */}
      <img src="/hero/hand-left.png" alt="" width={582} height={290} className={styles.handLeft} />
      <p className={styles.handoffText}>
        <span>Seller to buyer</span>
        <span className={styles.handoffStrong}>ownership moves on-chain</span>
        <span>No key changes hands.</span>
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element -- static transparent PNG, the image optimizer is disabled */}
      <img src="/hero/hand-right.png" alt="" width={558} height={328} className={styles.handRight} />
      <p className={styles.wordmark} aria-hidden>
        Incorpr
      </p>
    </div>
  );
}
