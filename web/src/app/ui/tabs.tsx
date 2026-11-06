'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import k from './kit.module.css';

export type TabItem = {
  id: string;
  label: ReactNode;
  /** Small count after the label. */
  badge?: ReactNode;
  content: ReactNode;
};

export type TabsProps = {
  tabs: TabItem[];
  /** Accessible name of the tab list. */
  label: string;
  defaultTab?: string;
  /** Controlled mode: pass both. */
  value?: string;
  onChange?: (id: string) => void;
};

/** Pill tab list with arrow-key navigation (WAI-ARIA tabs pattern, automatic activation). */
export function Tabs({ tabs, label, defaultTab, value, onChange }: TabsProps) {
  const base = useId();
  const [internal, setInternal] = useState(defaultTab ?? tabs[0]?.id);
  const active = value ?? internal;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function select(id: string) {
    if (value === undefined) setInternal(id);
    onChange?.(id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    select(tab.id);
    refs.current[next]?.focus();
  }

  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

  return (
    <div>
      <div role="tablist" aria-label={label} className={k.tabList}>
        {tabs.map((tab, i) => {
          const selected = tab.id === current?.id;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={k.tab}
              onClick={() => select(tab.id)}
              onKeyDown={(event) => onKeyDown(event, i)}
            >
              {tab.label}
              {tab.badge !== undefined && <span className={k.tabBadge}>{tab.badge}</span>}
            </button>
          );
        })}
      </div>
      {current && (
        <div
          key={current.id}
          role="tabpanel"
          id={`${base}-panel-${current.id}`}
          aria-labelledby={`${base}-tab-${current.id}`}
          tabIndex={0}
          className={k.tabPanel}
        >
          {current.content}
        </div>
      )}
    </div>
  );
}
