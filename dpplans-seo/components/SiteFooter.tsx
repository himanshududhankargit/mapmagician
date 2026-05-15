import Link from 'next/link';
import { SITE } from '@/lib/site';

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="container row">
        <div>
          © {year} {SITE.name}. A {SITE.name} property by Map Magician.
        </div>
        <div>
          <Link href="/home/">All regions</Link>
          {' · '}
          <a href={SITE.fullMap}>Interactive map</a>
          {' · '}
          <a href="https://www.linkedin.com/company/mapmagician" target="_blank" rel="noopener">
            LinkedIn
          </a>
          {' · '}
          <a href="https://www.mapmagician.in/privacy-policy.html">Privacy</a>
        </div>
      </div>
    </footer>
  );
}
