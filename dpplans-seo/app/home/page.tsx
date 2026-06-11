import type { Metadata } from 'next';
import Link from 'next/link';
import { regionsByState, allRegions } from '@/lib/regions';
import { SITE } from '@/lib/site';
import { JsonLd } from '@/components/JsonLd';
import { RegionCard } from '@/components/RegionCard';
import { RegionSearch } from '@/components/RegionSearch';

const HOME_URL = `${SITE.origin}/home/`;

// 1200×630 banner image lives in mapmagician-main/AssetsGIS/ and is copied into
// dpplans-seo/out/AssetsGIS/ by scripts/postbuild-copy.js. Used for social-share
// previews (LinkedIn / Twitter / WhatsApp / Google Discover).
const OG_BANNER = `${SITE.origin}/AssetsGIS/mapmagicianlogo-banner.png`;

export const metadata: Metadata = {
  title: 'Development Plan maps online — India DP, Layout & Village maps',
  description: SITE.description,
  alternates: { canonical: HOME_URL },
  openGraph: {
    type: 'website',
    url: HOME_URL,
    title: 'Development Plan maps online — India DP, Layout & Village maps',
    description: SITE.description,
    siteName: SITE.name,
    images: [{ url: OG_BANNER, width: 1200, height: 630, alt: 'DPPlans — Development Plan maps for India' }],
  },
  twitter: { card: 'summary_large_image', title: 'Development Plan maps online — India DP, Layout & Village maps', description: SITE.description, images: [OG_BANNER] },
};

export default function HomePage() {
  const grouped = regionsByState();
  const totalRegions = allRegions().length;
  const totalVillages = allRegions().reduce((s, r) => s + r.villages.length, 0);

  const websiteSchema = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE.name,
    url: HOME_URL,
    description: SITE.description,
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${HOME_URL}?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };

  const orgSchema = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Map Magician',
    url: 'https://www.mapmagician.in',
    sameAs: [SITE.origin, 'https://www.linkedin.com/company/mapmagician'],
    logo: 'https://www.mapmagician.in/AssetsGIS/mapmagiciansmall.png',
  };

  return (
    <>
      <JsonLd data={[websiteSchema, orgSchema]} />

      <section className="home-hero">
        <div className="container">
          <h1>Development Plan maps online — {totalRegions}+ regions across India</h1>
          <p className="lead">
            Browse Development Plan, Layout and Village maps over satellite imagery. Pune, Mumbai, Hyderabad,
            Bengaluru, Solapur, Nashik, Nagpur and more — pan, zoom, search by survey number, and measure on the map.
            Free to view up to zoom 14.
          </p>
          <RegionSearch />
          <div className="stats" aria-label="Coverage">
            <span><b>{totalRegions}</b>regions</span>
            <span><b>{totalVillages}+</b>sub-locations indexed</span>
            <span><b>3</b>states · expanding</span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          {grouped.map(group => (
            <div className="state-block" key={group.state}>
              <h2>{group.state}</h2>
              <div className="region-grid">
                {group.regions.map(r => (
                  <RegionCard key={r.slug} region={r} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="container text-block">
          <h2>Featured collection: MSRDC corridors</h2>
          <p>
            The Maharashtra State Road Development Corporation (MSRDC) prepares Development Plans for several expressway
            and hill-station corridors rather than a single city. See the Mumbai–Pune Expressway, New Mahabaleshwar and
            Karjat corridors together — and how MSRDC plans them — on the{' '}
            <Link href="/msrdc-development-plan/">MSRDC Development Plans</Link> page.
          </p>
        </div>
      </section>

      <section className="section alt">
        <div className="container text-block">
          <h2>About DPPlans</h2>
          <p>
            DPPlans is the public index of every Indian Development Plan map covered by Map Magician’s interactive
            GIS viewer. Each region page links directly into the full map at the right location and zoom — no login
            required to view free zoom levels. Coverage currently spans Maharashtra, Telangana (Hyderabad HMDA
            periphery) and Karnataka (Bengaluru draft), and is expanding.
          </p>
          <p>
            The maps are intended for landowners, real-estate buyers, architects, town-planners and surveyors who
            need to verify the Development Plan zone for a specific plot. The DP overlay aligns with satellite
            imagery so plot boundaries, reservations and proposed road lines can be inspected in context.
          </p>
        </div>
      </section>
    </>
  );
}
