import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment } from 'react';
import { regionBySlug } from '@/lib/regions';
import { SITE } from '@/lib/site';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Faq } from '@/components/Faq';
import { JsonLd } from '@/components/JsonLd';
import { MapEmbed } from '@/components/MapEmbed';

// Hand-authored hub page that owns the head term "PCMC development plan" /
// "pimpri chinchwad development plan". PCMC is not its own region in regions.json —
// the DP layer ships as a sub-location of the Pune (PMC) region — so without this page
// the only PCMC URL is /pune-dp-plan/pimpri-chinchwad-municipal-corporation/, a child of
// Pune that competes weakly. This static route gives PCMC a clean top-level URL so PMC
// and PCMC each rank on their own page instead of fighting inside one merged "Pune DP"
// page. Static route — output:'export' builds it to out/pcmc-development-plan/index.html
// with no generateStaticParams. Sources: pcmc.gov.in, menuGIS layer "(Draft 2025)",
// Wikipedia (PCMC). Prose is kept distinct from the sub-location entry to avoid dupes.

const PAGE_URL = `${SITE.origin}/pcmc-development-plan/`;
const SUBPAGE_URL = '/pune-dp-plan/pimpri-chinchwad-municipal-corporation/';

const TITLE = 'PCMC Development Plan 2025 (Draft) — Pimpri Chinchwad DP map online';
const DESCRIPTION =
  'View the PCMC (Pimpri-Chinchwad Municipal Corporation) Draft Development Plan 2025 online. Interactive DP overlay on satellite imagery — read the proposed land-use zone, reservations and road lines for any plot across Pimpri, Chinchwad, Bhosari, Akurdi, Nigdi and Wakad.';

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
    images: [{ url: SITE.ogImage, width: 1200, height: 630, alt: 'PCMC Draft Development Plan 2025 map' }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [SITE.ogImage] },
  keywords: [
    'pcmc development plan',
    'pcmc draft development plan 2025',
    'pimpri chinchwad development plan',
    'pimpri chinchwad dp map online',
    'pcmc dp plan 2025',
    'pcmc zoning map',
    'pcmc dp remark',
    'pimpri chinchwad master plan',
  ],
};

// Centre the full-map link on the PCMC area. Coords are pulled from the live PCMC
// sub-location row inside the Pune region so they never drift if the data is rebuilt.
const puneRegion = regionBySlug('pune-dp-plan');
const pcmc = puneRegion?.villages.find(v => v.slug === 'pimpri-chinchwad-municipal-corporation');
const PCMC_MAP_URL = pcmc ? `${SITE.fullMap}?lat=${pcmc.lat}&lng=${pcmc.lng}&zoom=12` : SITE.fullMap;

const QUICK_FACTS = [
  { label: 'Planning authority', value: 'Pimpri-Chinchwad Municipal Corporation (PCMC)' },
  { label: 'PCMC constituted', value: '1982' },
  { label: 'Plan on this page', value: 'Draft Development Plan 2025' },
  { label: 'Governing Act', value: 'Maharashtra Regional and Town Planning Act, 1966' },
  { label: 'Key industrial belts', value: 'Bhosari MIDC, Chinchwad, Pimpri, Akurdi' },
  { label: 'Major growth nodes', value: 'Nigdi-Pradhikaran, Wakad, Ravet' },
  { label: 'Adjoining city plan', value: 'Pune (PMC) Development Plan' },
];

const FAQS = [
  {
    q: 'What is the PCMC Development Plan?',
    a: 'The Pimpri-Chinchwad Municipal Corporation (PCMC) is the civic body and planning authority for the twin industrial city of Pimpri-Chinchwad in Pune district, Maharashtra, constituted in 1982 and operating under the Maharashtra Regional and Town Planning (MRTP) Act, 1966. Its Development Plan is the statutory map that fixes land-use zones, public reservations and the proposed road network across the corporation area. This page renders the PCMC Draft Development Plan (2025) as an interactive overlay on satellite imagery.',
  },
  {
    q: 'Is the PCMC Draft Development Plan 2025 final or sanctioned?',
    a: 'The layer shown here is the DRAFT Development Plan (2025). A draft DP is published for public objections and suggestions and may change before it is sanctioned and gazetted by the Government of Maharashtra. Treat the map as a fast reference and confirm the final sanctioned plan with PCMC or the Urban Development Department before relying on a zone for any legal or financial decision.',
  },
  {
    q: 'Which areas does the PCMC plan cover?',
    a: 'The plan covers the full PCMC area — including Pimpri, Chinchwad, Bhosari, Akurdi, Nigdi-Pradhikaran, Sangvi, Wakad and Ravet — anchored by the Bhosari (MIDC), Chinchwad, Pimpri and Akurdi industrial belts and the residential / commercial growth along the Mumbai-Pune Expressway and old NH-48 corridor.',
  },
  {
    q: 'How is PCMC different from the Pune (PMC) Development Plan?',
    a: 'PCMC and PMC (Pune Municipal Corporation) are two separate municipal corporations with two separate Development Plans. PCMC plans the twin city of Pimpri-Chinchwad; PMC plans Pune city. The wider metropolitan periphery outside both corporations is planned by PMRDA. Each has its own page and map on DPPlans.',
  },
  {
    q: 'Is access free?',
    a: 'Browsing the PCMC map is free up to zoom level 14. High-detail tile layers (zoom 15 and beyond) unlock with a 7-day access pass for the region.',
  },
];

const graph: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'Place',
    '@id': PAGE_URL + '#place',
    name: 'PCMC Development Plan — Pimpri-Chinchwad',
    url: PAGE_URL,
    description: 'Interactive PCMC (Pimpri-Chinchwad Municipal Corporation) Draft Development Plan 2025 map.',
    containedInPlace: { '@type': 'AdministrativeArea', name: 'Maharashtra', addressCountry: 'IN' },
    ...(pcmc
      ? { geo: { '@type': 'GeoCoordinates', latitude: pcmc.lat, longitude: pcmc.lng, addressCountry: 'IN' } }
      : {}),
    hasMap: PCMC_MAP_URL,
    image: SITE.ogImage,
  },
  {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Regions', item: SITE.origin + '/home/' },
      { '@type': 'ListItem', position: 2, name: 'PCMC Development Plan', item: PAGE_URL },
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

export default function PcmcHubPage() {
  return (
    <>
      <JsonLd data={graph} />

      <header className="region-header">
        <div className="container">
          <Breadcrumbs items={[{ label: 'Regions', href: '/home/' }, { label: 'PCMC Development Plan' }]} />
          <div className="top-row">
            <div className="icon-large"><span aria-hidden="true">▦</span></div>
            <div>
              <h1>PCMC Draft Development Plan 2025 — Pimpri Chinchwad DP map online</h1>
              <p className="summary">
                Interactive Development Plan viewer for the <strong>Pimpri-Chinchwad Municipal Corporation
                (PCMC)</strong>, Pune district. The DP overlay aligns with satellite imagery so you can read the
                proposed zone, reservations and road lines for any plot across the twin city.
              </p>
            </div>
          </div>
        </div>
      </header>

      <MapEmbed
        title="PCMC"
        fullMapUrl={PCMC_MAP_URL}
        caption="Live preview of the PCMC Draft Development Plan 2025, Pimpri-Chinchwad"
      />

      <div className="region-cta-row">
        <div className="container row">
          <div className="meta">
            <b>PCMC</b> · Draft Development Plan 2025 · Maharashtra
          </div>
          <a className="btn btn-primary" href={PCMC_MAP_URL} target="_blank" rel="noopener">
            Open PCMC on full map →
          </a>
        </div>
      </div>

      <div className="container region-body">
        <div>
          <section className="card text-block">
            <h2>About the PCMC Development Plan</h2>
            <p>
              The <strong>Pimpri-Chinchwad Municipal Corporation (PCMC)</strong> is the planning authority for the
              twin industrial city of Pimpri-Chinchwad in Pune district, constituted in 1982 and operating under the
              Maharashtra Regional and Town Planning (MRTP) Act, 1966. Its <strong>Development Plan</strong> is the
              statutory map that fixes the land-use zones (residential, commercial, industrial, public / semi-public,
              green and no-development), public reservations and the proposed road network across the corporation
              limits. This page renders the <strong>PCMC Draft Development Plan (2025)</strong> as an interactive
              overlay on live satellite imagery.
            </p>
            <p>
              To read the DP remark for a plot, search a survey number, locality or landmark on the full map, then
              toggle the PCMC overlay to confirm the proposed zone and any reservation or road line crossing it. Note
              this is the <em>draft</em> plan — published for public objections — so always verify the final sanctioned
              plan with PCMC before relying on a zone for any legal or financial decision.
            </p>
          </section>

          <section className="card region-plan-details">
            <h2>PCMC Development Plan — key details</h2>
            <p>
              PCMC's land-use is anchored by its industrial estates — the Bhosari (MIDC) estate, along with the
              Chinchwad, Pimpri and Akurdi industrial belts — which gave the twin city its identity as one of
              Maharashtra's largest manufacturing and automobile-component hubs. Around this industrial core, the draft
              plan accommodates dense residential and commercial growth at Nigdi-Pradhikaran, Sangvi, Wakad and Ravet,
              and along the Mumbai-Pune Expressway / old NH-48 corridor that runs through the city.
            </p>
            <p>
              Pimpri-Chinchwad adjoins Pune city, but the two are planned by separate corporations: PCMC prepares this
              plan for the twin city, while the Pune Municipal Corporation (PMC) prepares the Pune Development Plan for
              Pune city, and the Pune Metropolitan Region Development Authority (PMRDA) plans the wider periphery
              outside both. Use the links below to switch between the PMC and PCMC maps.
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
            <h2>What you can do on the PCMC map</h2>
            <ul>
              <li>Overlay the PCMC Draft Development Plan 2025 on live satellite imagery and pan / zoom freely</li>
              <li>Read the proposed land-use zone, reservations and road lines for any plot</li>
              <li>Search by locality, survey number or landmark and jump straight to it</li>
              <li>Measure distances and areas directly on the map</li>
              <li>Open PCMC in the full interactive app on desktop, tablet or Android</li>
            </ul>
          </section>

          <Faq items={FAQS} />
        </div>

        <aside>
          <div className="side-card">
            <h3>Open the full app</h3>
            <p className="aux">
              The full PCMC viewer includes measurement tools, search and an overlay-toggle panel. Free up to zoom 14;
              high-detail layers unlock with a 7-day access pass.
            </p>
            <a className="btn btn-white btn-block" href={PCMC_MAP_URL} target="_blank" rel="noopener">
              Launch interactive map →
            </a>
          </div>

          <div className="side-card">
            <h3>Pune-area plans</h3>
            <p className="aux">
              Pimpri-Chinchwad, Pune city and the metropolitan periphery are each planned by a different authority.
            </p>
            <ul>
              <li><Link href="/pune-dp-plan/">Pune (PMC) Development Plan</Link></li>
              <li><Link href={SUBPAGE_URL}>PCMC area within the Pune district map</Link></li>
              <li><Link href="/pmrda-development-plan/">PMRDA Development Plan</Link></li>
            </ul>
          </div>

          <div className="side-card">
            <h3>Browse all regions</h3>
            <p className="aux">
              PCMC is part of DPPlans' wider index of Development &amp; Master Plan maps across India.
            </p>
            <Link className="btn btn-white btn-block" href="/home/">All Development Plan regions →</Link>
          </div>
        </aside>
      </div>
    </>
  );
}
