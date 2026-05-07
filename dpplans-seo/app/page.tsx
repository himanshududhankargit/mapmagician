import type { Metadata } from 'next';
import { SITE } from '@/lib/site';

/**
 * The root URL `dpplans.com/` exists to land direct visitors on the live map immediately
 * (the SEO landing for browsing all regions lives at `/home/`).
 *
 * Cloudflare Pages handles the redirect at edge-time via `out/_redirects`
 * (`/  /maps.html  302`), so most users never hit this HTML. This file is a fallback for
 * - hosts that don't honor `_redirects` (GitHub Pages, plain S3, etc.)
 * - search-engine bots that ignore _redirects but parse meta-refresh
 *
 * `noindex` keeps Google from treating this stub as the canonical homepage; the regions
 * browser at `/home/` is what should rank.
 */
export const metadata: Metadata = {
  title: 'Open the Development Plan map',
  description: 'Loading the interactive DP map…',
  robots: { index: false, follow: true },
  alternates: { canonical: `${SITE.origin}/maps.html` },
  // Belt and suspenders: declare the refresh as <meta http-equiv> too.
  other: { refresh: '0; url=/maps.html' },
};

export default function RootRedirect() {
  return (
    <div style={{ padding: 24, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <p>Loading the map…</p>
      <p>
        If you are not redirected automatically, <a href="/maps.html">tap here to open the Development Plan map</a>.
      </p>
      <noscript>
        <a href="/maps.html">Open Development Plan map</a>
      </noscript>
      {/* Fallback JS redirect — runs faster than meta-refresh on most browsers. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){try{location.replace('/maps.html'+location.search+location.hash);}catch(e){location.href='/maps.html';}})();`,
        }}
      />
    </div>
  );
}
