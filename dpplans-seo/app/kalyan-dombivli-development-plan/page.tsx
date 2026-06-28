import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment } from 'react';
import { regionBySlug } from '@/lib/regions';
import { SITE } from '@/lib/site';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Faq } from '@/components/Faq';
import { JsonLd } from '@/components/JsonLd';
import { MapEmbed } from '@/components/MapEmbed';

// Hand-authored hub page that owns the head term "kalyan dp plan" / "kdmc development
// plan". Kalyan-Dombivli is NOT its own region in regions.json — a full standalone
// region (own purchasable pass + premium tile layer) would need the Android admin /
// menuGIS first. The KDMC area is already covered by the existing Thane (thanedistrict)
// DP tile layer and ships as a sub-location of the Thane region, so without this page the
// only KDMC URL is /thane-dp-plan/kalyan-dombivli/, a child of Thane that competes weakly.
// This static route gives KDMC a clean top-level URL. Static route — output:'export'
// builds it to out/kalyan-dombivli-development-plan/index.html with no generateStaticParams.
// Map + access pass deep-link into the existing Thane tiles. Sources: kdmc.gov.in,
// Wikipedia (KDMC). Prose is kept distinct from the sub-location entry to avoid dupes.

const PAGE_URL = `${SITE.origin}/kalyan-dombivli-development-plan/`;
const SUBPAGE_URL = '/thane-dp-plan/kalyan-dombivli/';

const TITLE = 'Kalyan-Dombivli (KDMC) Development Plan — DP map online';
const DESCRIPTION =
  'View the Kalyan-Dombivli Municipal Corporation (KDMC) Development Plan online. Interactive DP overlay on satellite imagery — read the proposed land-use zone, reservations and road lines for any plot across Kalyan, Dombivli, Titwala, Ambivli, Vithalwadi and Thakurli, Thane district.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    type: 'article',
    url: PAGE_URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: SITE.name,
    images: [{ url: SITE.ogImage, width: 1200, height: 630, alt: 'Kalyan-Dombivli (KDMC) Development Plan map' }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [SITE.ogImage] },
  keywords: [
    'kalyan dp plan',
    'kdmc dp plan',
    'kalyan dombivli development plan',
    'kalyan development plan',
    'dombivli dp plan',
    'kdmc development plan',
    'kalyan dombivli municipal corporation',
    'kalyan taluka map',
    'kalyan dombivli dp map online',
    'kalyan zoning map',
  ],
};

// Centre the full-map link on the KDMC area. Coords are pulled from the live
// kalyan-dombivli sub-location row inside the Thane region so they never drift if the
// data is rebuilt. KDMC tiles ship inside the Thane (thanedistrict) DP layer.
const thaneRegion = regionBySlug('thane-dp-plan');
const kdmc = thaneRegion?.villages.find(v => v.slug === 'kalyan-dombivli');
const KDMC_MAP_URL = kdmc ? `${SITE.fullMap}?lat=${kdmc.lat}&lng=${kdmc.lng}&zoom=12` : SITE.fullMap;

const QUICK_FACTS = [
  { label: 'Planning authority', value: 'Kalyan-Dombivli Municipal Corporation (KDMC)' },
  { label: 'KDMC constituted', value: '1 October 1983' },
  { label: 'District', value: 'Thane, Maharashtra' },
  { label: 'Governing Act', value: 'Maharashtra Regional and Town Planning Act, 1966' },
  { label: 'Twin towns', value: 'Kalyan and Dombivli' },
  { label: 'Other areas', value: 'Titwala, Ambivli, Vithalwadi, Thakurli' },
  { label: 'On dpplans', value: 'Part of the Thane district DP tile layer' },
];

const FAQS = [
  {
    q: 'What is the KDMC Development Plan?',
    a: 'The Kalyan-Dombivli Municipal Corporation (KDMC) is the civic body and planning authority for the twin towns of Kalyan and Dombivli in Thane district, Maharashtra, constituted on 1 October 1983 and operating under the Maharashtra Regional and Town Planning (MRTP) Act, 1966. Its Development Plan is the statutory map that fixes land-use zones, public reservations and the proposed road network across the corporation area. This page renders the KDMC area of the sanctioned Development Plan as an interactive overlay on satellite imagery.',
  },
  {
    q: 'Which areas does the KDMC plan cover?',
    a: 'The plan covers the full KDMC area — the twin towns of Kalyan and Dombivli along with Titwala, Ambivli, Vithalwadi and Thakurli — on the Central Railway suburban corridor north-east of Thane, between the Ulhas river and the Bhiwandi / Ambernath belts.',
  },
  {
    q: 'How is KDMC related to the Thane Development Plan?',
    a: 'KDMC is a separate municipal corporation within Thane district. On DPPlans the KDMC area is served as part of the wider Thane district DP tile layer, so the map and the 7-day access pass for this page are shared with the Thane region. Use the links on this page to open the KDMC area directly, or to browse the full Thane district map.',
  },
  {
    q: 'Is access free?',
    a: 'Browsing the KDMC map is free up to zoom level 14. High-detail tile layers (zoom 15 and beyond) unlock with a 7-day access pass for the Thane district region that covers the KDMC area.',
  },
];

const graph: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'Place',
    '@id': PAGE_URL + '#place',
    name: 'Kalyan-Dombivli (KDMC) Development Plan',
    url: PAGE_URL,
    description: 'Interactive Kalyan-Dombivli Municipal Corporation (KDMC) Development Plan map.',
    containedInPlace: { '@type': 'AdministrativeArea', name: 'Maharashtra', addressCountry: 'IN' },
    ...(kdmc
      ? { geo: { '@type': 'GeoCoordinates', latitude: kdmc.lat, longitude: kdmc.lng, addressCountry: 'IN' } }
      : {}),
    hasMap: KDMC_MAP_URL,
    image: SITE.ogImage,
  },
  {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Regions', item: SITE.origin + '/home/' },
      { '@type': 'ListItem', position: 2, name: 'Kalyan-Dombivli Development Plan', item: PAGE_URL },
    ],
  },
  {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQS.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  },
];

export default function KdmcHubPage() {
  return (
    <>
      <JsonLd data={graph} />

      <header className="region-header">
        <div className="container">
          <Breadcrumbs items={[{ label: 'Regions', href: '/home/' }, { label: 'Kalyan-Dombivli Development Plan' }]} />
          <div className="top-row">
            <div className="icon-large"><span aria-hidden="true">▦</span></div>
            <div>
              <h1>Kalyan-Dombivli (KDMC) Development Plan — DP map online</h1>
              <p className="summary">
                Interactive Development Plan viewer for the <strong>Kalyan-Dombivli Municipal Corporation
                (KDMC)</strong>, Thane district. The DP overlay aligns with satellite imagery so you can read the
                proposed zone, reservations and road lines for any plot across the twin towns.
              </p>
            </div>
          </div>
        </div>
      </header>

      <MapEmbed
        title="Kalyan-Dombivli"
        fullMapUrl={KDMC_MAP_URL}
        caption="Live preview of the Kalyan-Dombivli (KDMC) Development Plan, Thane district"
      />

      <div className="region-cta-row">
        <div className="container row">
          <div className="meta">
            <b>KDMC</b> · Kalyan-Dombivli Development Plan · Maharashtra
          </div>
          <a className="btn btn-primary" href={KDMC_MAP_URL} target="_blank" rel="noopener">
            Open Kalyan-Dombivli on full map →
          </a>
        </div>
      </div>

      <div className="container region-body">
        <div>
          <section className="card text-block">
            <h2>About the KDMC Development Plan</h2>
            <p>
              The <strong>Kalyan-Dombivli Municipal Corporation (KDMC)</strong> is the planning authority for the
              twin towns of Kalyan and Dombivli in Thane district, constituted on 1 October 1983 and operating under
              the Maharashtra Regional and Town Planning (MRTP) Act, 1966. Its <strong>Development Plan</strong> is the
              statutory map that fixes the land-use zones (residential, commercial, industrial, public / semi-public,
              green and no-development), public reservations and the proposed road network across the corporation
              limits. This page renders the KDMC area as an interactive overlay on live satellite imagery.
            </p>
            <p>
              To read the DP remark for a plot, search a survey number, locality or landmark on the full map, then
              toggle the overlay to confirm the proposed zone and any reservation or road line crossing it. Always
              verify the final sanctioned plan with KDMC or the Urban Development Department before relying on a zone
              for any legal or financial decision.
            </p>
          </section>

          <section className="card region-plan-details">
            <h2>Kalyan-Dombivli Development Plan — key details</h2>
            <p>
              KDMC covers the twin towns of <strong>Kalyan and Dombivli</strong> along with Titwala, Ambivli,
              Vithalwadi and Thakurli, on the Central Railway suburban corridor north-east of Thane. The corporation
              area sits between the Ulhas river and the Bhiwandi, Ulhasnagar and Ambernath belts, with Kalyan Junction
              acting as one of the busiest railway interchanges in the Mumbai Metropolitan Region.
            </p>
            <p>
              On DPPlans the KDMC area is served as part of the wider <strong>Thane district</strong> Development Plan
              tile layer, so the map view and the 7-day access pass for this page are shared with the Thane region.
              Use the links below to open the KDMC area directly or to browse the full Thane district map.
            </p>
            <h3>Plan at a glance</h3>
            <dl className="region-quick-facts">
              {QUICK_FACTS.map((f, i) => (
                <Fragment key={i}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </Fragment>
              ))}
            </dl>
          </section>

          <section className="card features">
            <h2>What you can do on the Kalyan-Dombivli map</h2>
            <ul>
              <li>Overlay the KDMC Development Plan on live satellite imagery and pan / zoom freely</li>
              <li>Read the proposed land-use zone, reservations and road lines for any plot</li>
              <li>Search by locality, survey number or landmark and jump straight to it</li>
              <li>Measure distances and areas directly on the map</li>
              <li>Open Kalyan-Dombivli in the full interactive app on desktop, tablet or Android</li>
            </ul>
          </section>

          <Faq items={FAQS} />
        </div>

        <aside>
          <div className="side-card">
            <h3>Open the full app</h3>
            <p className="aux">
              The full viewer includes measurement tools, search and an overlay-toggle panel. Free up to zoom 14;
              high-detail layers unlock with a 7-day access pass.
            </p>
            <a className="btn btn-white btn-block" href={KDMC_MAP_URL} target="_blank" rel="noopener">
              Launch interactive map →
            </a>
          </div>

          <div className="side-card">
            <h3>Nearby plans</h3>
            <p className="aux">
              Kalyan-Dombivli sits within Thane district, next to the Mumbai suburbs.
            </p>
            <ul>
              <li><Link href="/thane-dp-plan/">Thane district Development Plan</Link></li>
              <li><Link href={SUBPAGE_URL}>KDMC area within the Thane district map</Link></li>
              <li><Link href="/mumbai-western-suburbs-dp-plan/">Mumbai Western Suburbs DP</Link></li>
            </ul>
          </div>

          <div className="side-card">
            <h3>Browse all regions</h3>
            <p className="aux">
              Kalyan-Dombivli is part of DPPlans' wider index of Development &amp; Master Plan maps across India.
            </p>
            <Link className="btn btn-white btn-block" href="/home/">All Development Plan regions →</Link>
          </div>
        </aside>
      </div>
    </>
  );
}
