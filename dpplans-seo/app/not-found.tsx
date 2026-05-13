import type { Metadata } from 'next';
import Link from 'next/link';

// 404 page must not be indexed — any broken region link or removed slug should
// not pollute search results with a thin "Region not found" page.
export const metadata: Metadata = {
  title: 'Region not found',
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <div className="container" style={{ padding: '60px 16px' }}>
      <h1 style={{ fontSize: 28, marginTop: 0 }}>Region not found</h1>
      <p>That URL doesn’t match any indexed Development Plan region.</p>
      <p>
        <Link href="/">← See all regions</Link>
      </p>
    </div>
  );
}
