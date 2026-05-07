'use client';

import { useEffect, useRef } from 'react';

/**
 * Tiny client-side filter for the region grid. Reads the data-search attribute the server
 * already wrote into each card and toggles `hidden`. No virtual list, no fuzzy search —
 * 39 regions fit in DOM cheaply.
 */
export function RegionSearch() {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const handler = () => {
      const q = input.value.trim().toLowerCase();
      const cards = document.querySelectorAll<HTMLElement>('.region-card[data-search]');
      cards.forEach(c => {
        const haystack = c.dataset.search || '';
        c.hidden = !!q && !haystack.includes(q);
      });
      // Hide state blocks that have no visible cards left.
      document.querySelectorAll<HTMLElement>('.state-block').forEach(b => {
        const visible = b.querySelectorAll<HTMLElement>('.region-card:not([hidden])').length;
        b.hidden = visible === 0;
      });
    };
    input.addEventListener('input', handler);
    return () => input.removeEventListener('input', handler);
  }, []);

  return (
    <div className="search-row">
      <input
        ref={ref}
        type="search"
        aria-label="Filter regions"
        placeholder="Filter regions — Pune, Mumbai, Solapur…"
        autoComplete="off"
      />
    </div>
  );
}
