import styles from './ui/pill.module.css';

export type EncumbranceLabel = 'FREE' | 'LISTED' | 'PLEDGED';

const STYLES: Record<EncumbranceLabel, string | undefined> = {
  FREE: styles.free,
  LISTED: styles.listed,
  PLEDGED: styles.pledged,
};

const DESCRIPTION: Record<EncumbranceLabel, string> = {
  FREE: 'Free: the shareholder can sign, claim and change policy',
  LISTED: 'Listed for sale: shareholder rights are frozen',
  PLEDGED: 'Pledged as loan collateral: shareholder rights are frozen',
};

/** FREE teal circle, LISTED amber diamond, PLEDGED lilac square. */
export function EncumbrancePill({ state }: { state: EncumbranceLabel }) {
  return (
    <span className={`${styles.pill} ${STYLES[state]}`} title={DESCRIPTION[state]}>
      {state}
    </span>
  );
}
