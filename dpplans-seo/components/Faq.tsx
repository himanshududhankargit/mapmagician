import type { RegionFaq } from '@/lib/site';

export function Faq({ items }: { items: RegionFaq[] }) {
  return (
    <section className="faq" aria-label="Frequently asked questions">
      <h2 className="section-title" style={{ padding: '14px 4px 4px' }}>Frequently asked questions</h2>
      {items.map((item, i) => (
        <details key={i} {...(i === 0 ? { open: true } : {})}>
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      ))}
    </section>
  );
}
