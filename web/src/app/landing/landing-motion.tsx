'use client';

import { useEffect } from 'react';
import ui from './landing.module.css';

/**
 * Scroll-triggered entrances for the landing sections.
 *
 * Without JavaScript, or with reduced motion requested, nothing is hidden. Otherwise this adds `motion`
 * to the page wrapper, staggers sibling reveals through --d, and adds `in` to each element when it
 * enters the viewport, then `settled` when its entrance transition ends.
 */
export function LandingMotion() {
  useEffect(() => {
    const page = document.querySelector<HTMLElement>(`.${ui.page}`);
    const { reveal, section, timeline, chips, closing, motion, in: inView, settled } = ui;
    if (!page || !reveal || !motion || !inView || !settled) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;

    const revealed = Array.from(page.querySelectorAll<HTMLElement>(`.${reveal}`));
    const cleanups: (() => void)[] = [];
    for (const el of revealed) {
      const siblings = Array.from(el.parentElement?.children ?? []).filter((c) => c.classList.contains(reveal));
      el.style.setProperty('--d', `${Math.min(siblings.indexOf(el), 6) * 110}ms`);
      const onEnd = (event: TransitionEvent) => {
        if (event.target !== el || event.propertyName !== 'opacity') return;
        el.style.setProperty('--d', '0ms');
        el.classList.add(settled);
        el.removeEventListener('transitionend', onEnd);
      };
      el.addEventListener('transitionend', onEnd);
      cleanups.push(() => el.removeEventListener('transitionend', onEnd));
    }

    const observed = [
      ...revealed,
      ...[section, timeline, chips, closing].flatMap((name) => (name ? Array.from(page.querySelectorAll<HTMLElement>(`.${name}`)) : [])),
    ];

    page.classList.add(motion);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add(inView);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    observed.forEach((el) => observer.observe(el));

    return () => {
      observer.disconnect();
      cleanups.forEach((fn) => fn());
    };
  }, []);

  return null;
}
