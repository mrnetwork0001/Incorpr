import type { ReactNode } from 'react';
import { SparkleIcon } from './icons';
import k from './kit.module.css';

export type PageHeaderProps = {
  /** Pill text above the title. */
  eyebrow: string;
  /** Two-digit step shown in the amber chip, e.g. "02". Without it the pill shows a sparkle. */
  index?: string;
  /** First line, white. */
  title: string;
  /** Optional second line with the white-to-sand gradient. Without it the whole title takes the gradient. */
  accent?: string;
  intro?: ReactNode;
  /** Right column on wide screens: stats, a badge or an action. */
  aside?: ReactNode;
  /** Use h2 when the page already has an h1. */
  as?: 'h1' | 'h2';
};

export function PageHeader({ eyebrow, index, title, accent, intro, aside, as: Heading = 'h1' }: PageHeaderProps) {
  return (
    <header className={aside ? `${k.pageHeader} ${k.pageHeaderSplit}` : k.pageHeader}>
      <div>
        <p className={k.eyebrow}>
          {index ? <span className={k.eyebrowIndex}>{index}</span> : <SparkleIcon className={k.sparkle} />}
          {eyebrow}
        </p>
        <Heading className={k.title}>
          {accent ? (
            <>
              <span className={k.titleLine}>{title}</span>
              <span className={k.titleAccent}>{accent}</span>
            </>
          ) : (
            <span className={`${k.titleSolo} block`}>{title}</span>
          )}
        </Heading>
        {intro && <div className={k.intro}>{intro}</div>}
      </div>
      {aside && <div className={k.headerAside}>{aside}</div>}
    </header>
  );
}
