import Link from 'next/link';

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
