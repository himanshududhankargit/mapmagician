import Link from 'next/link';
import { Fragment } from 'react';

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {items.map((c, i) => (
        <Fragment key={i}>
          {c.href ? <Link href={c.href}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
          {i < items.length - 1 && <span aria-hidden="true"> › </span>}
        </Fragment>
      ))}
    </nav>
  );
}
