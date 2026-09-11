import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment } from 'react';
import { regionBySlug } from '@/lib/regions';
import { SITE } from '@/lib/site';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Faq } from '@/components/Faq';
import { JsonLd } from '@/components/JsonLd';
import { MapEmbed } from '@/components/MapEmbed';

// Hand-authored hub page that owns the head term "mumbai dp 2034" / "dp plan mumbai" /
// "mumbai dp plan 2034". Greater Mumbai is NOT one region in regions.json — the MCGM
// DP 2034 ships as THREE purchasable regions (Island City, Western Suburbs, Eastern
// Suburbs), each with its own tile layer and pass, so until now there was no URL that
// said "Mumbai DP 2034". GSC 2026-09-11 (3 mo): "mumbai dp" 458 impr, "dp plan mumbai"
// 338, "mumbai dp plan 2034 pdf free download" 309, "mumbai dp 2034 map" 143 — all at
// position ~8 with ~2% CTR, landing on a suburb page whose title never said 2034.
// Same pattern as app/kalyan-dombivli-development-plan/page.tsx: static route, no
// generateStaticParams, map + passes deep-link into the three existing regions. Facts are
// the ones already verified for the three section entries in data/region-content.ts
// (MCGM, sanction 8 May 2018 with modifications, in force till 2034, DCPR 2034).

const PAGE_URL = `${SITE.origin}/mumbai-dp-2034/`;

const TITLE = 'Mumbai DP 2034 — MCGM (BMC) Development Plan map online';
const DESCRIPTION =
  'Mumbai DP 2034 map online — the Greater Mumbai Development Plan 2034 sanctioned by the State in May 2018, prepared by MCGM (BMC), over satellite imagery: land-use zone, reservations and DP road lines for any plot from Colaba to Dahisar and Mulund.';

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
    images: [{ url: SITE.ogImage, width: 1200, height: 630, alt: 'Mumbai DP 2034 map' }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [SITE.ogImage] },
  keywords: [
    'mumbai dp 2034',
    'mumbai dp',
    'dp plan mumbai',
    'mumbai dp plan 2034',
    'mumbai dp 2034 map',
    'dp plan mumbai online',
    'mumbai dp plan 2034 pdf free download',
    'mcgm dp 2034',
    'bmc dp 2034',
    'mumbai development plan 2034',
    'dp sheet mumbai',
    'dcpr 2034',
    'मुंबई डीपी 2034',
    'मुंबई विकास आराखडा',
  ],
};

// The three regions that make up the plan. Coords and map links come from the live
// regions.json rows so they never drift if the data is rebuilt.
const PARTS = [
  {
    slug: 'mumbai-internal-island-city-dp-plan',
    name: 'Island City',
    covers: 'Colaba to Mahim and Sion — wards A to G/South (Fort, Marine Drive, Worli, Dadar, Mazgaon)',
  },
  {
    slug: 'mumbai-western-suburbs-dp-plan',
    name: 'Western Suburbs',
    covers: 'Bandra to Dahisar — wards H/W, K/E, K/W, P/N, P/S, R/N, R/C, R/S (Andheri, Goregaon, Malad, Borivali)',
  },
  {
    slug: 'mumbai-eastern-suburbs-dp-plan',
    name: 'Eastern Suburbs',
    covers: 'Sion to Mulund — Kurla, Ghatkopar, Vikhroli, Bhandup along the Eastern Express Highway',
  },
].map(p => ({ ...p, region: regionBySlug(p.slug) }));

// Centre the hub's full-map link between the three sections so the whole city is in view.
const MUMBAI_MAP_URL = `${SITE.fullMap}?lat=19.07&lng=72.87&zoom=11`;

const QUICK_FACTS = [
  { label: 'Planning authority', value: 'Municipal Corporation of Greater Mumbai (MCGM / BMC)' },
  { label: 'Plan', value: 'Development Plan 2034 (DP 2034)' },
  { label: 'Sanctioned', value: '8 May 2018 (with modifications), Government of Maharashtra' },
  { label: 'In force until', value: '2034' },
  { label: 'Regulations', value: 'Development Control and Promotion Regulations (DCPR) 2034' },
  { label: 'Coverage', value: 'All 24 wards of Greater Mumbai' },
  { label: 'On DPPlans', value: 'Three sections — Island City, Western Suburbs, Eastern Suburbs' },
];

const FAQS = [
  {
    q: 'What is the Mumbai DP 2034?',
    a: 'The Development Plan 2034 is the statutory land-use plan for Greater Mumbai, prepared by the Municipal Corporation of Greater Mumbai (MCGM, also called BMC) under the Maharashtra Regional and Town Planning Act, 1966. The State Government sanctioned it with modifications on 8 May 2018 and it remains in force until 2034, alongside the Development Control and Promotion Regulations (DCPR) 2034. It fixes the land-use zone, public reservations and the proposed road network for every plot across the 24 wards of the city.',
  },
  {
    q: 'How do I check the DP 2034 zone for a plot in Mumbai?',
    a: 'Open the section your plot falls in — Island City (south of Mahim and Sion), Western Suburbs (Bandra to Dahisar) or Eastern Suburbs (Sion to Mulund) — then search the locality, landmark or CTS number on the full map and toggle the DP overlay. The zone, any reservation and any DP road line crossing the plot are drawn over current satellite imagery, so you can see exactly where a proposed road or reservation falls on the ground.',
  },
  {
    q: 'Is this the official DP 2034 PDF?',
    a: 'No. This is an online map viewer of the sanctioned plan — the DP 2034 overlay georeferenced over satellite imagery — not the authority’s sheet-wise PDF. MCGM publishes the official DP 2034 sheets and DCPR 2034; treat this map as a fast reference and confirm the final sanctioned position with MCGM before relying on a zone for any legal or financial decision.',
  },
  {
    q: 'Is access free?',
    a: 'Browsing every section of the Mumbai DP 2034 is free up to zoom level 14. The high-detail tile layers (zoom 15 and beyond) unlock with a 7-day access pass, which is issued per section — Island City, Western Suburbs and Eastern Suburbs are separate passes, so you only pay for the part of the city you need.',
  },
  {
    q: 'Does DP 2034 cover Navi Mumbai, Thane or Mira-Bhayandar?',
    a: 'No — DP 2034 stops at the Greater Mumbai municipal limit. Navi Mumbai (NMMC), Thane (TMC), Mira-Bhayandar (MBMC) and Kalyan-Dombivli (KDMC) each have their own Development Plan prepared by their own corporation; DPPlans has a separate page for each of them.',
  },
];

const graph: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'Place',
    '@id': PAGE_URL + '#place',
    name: 'Mumbai DP 2034 (Greater Mumbai Development Plan)',
    url: PAGE_URL,
    description: 'Interactive map of the Greater Mumbai Development Plan 2034 (MCGM / BMC).',
    containedInPlace: { '@type': 'AdministrativeArea', name: 'Maharashtra', addressCountry: 'IN' },
    geo: { '@type': 'GeoCoordinates', latitude: 19.07, longitude: 72.87, addressCountry: 'IN' },
    hasMap: MUMBAI_MAP_URL,
    image: SITE.ogImage,
  },
  {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Regions', item: SITE.origin + '/home/' },
      { '@type': 'ListItem', position: 2, name: 'Mumbai DP 2034', item: PAGE_URL },
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

export default function MumbaiDp2034HubPage() {
  return (
    <>
      <JsonLd data={graph} />

      <header className="region-header">
        <div className="container">
          <Breadcrumbs items={[{ label: 'Regions', href: '/home/' }, { label: 'Mumbai DP 2034' }]} />
          <div className="top-row">
            <div className="icon-large"><span aria-hidden="true">▦</span></div>
            <div>
              <h1>{TITLE}</h1>
              <p className="summary">
                Interactive viewer for the <strong>Greater Mumbai Development Plan 2034</strong>, prepared by the
                Municipal Corporation of Greater Mumbai (MCGM / BMC) and sanctioned by the State in 2018. The DP
                overlay aligns with satellite imagery so you can read the zone, reservations and DP road lines for
                any plot in the city.
              </p>
            </div>
          </div>
        </div>
      </header>

      <MapEmbed
        title="Mumbai DP 2034"
        fullMapUrl={MUMBAI_MAP_URL}
        caption="Live preview of the Mumbai DP 2034 — Island City, Western and Eastern Suburbs"
      />

      <div className="region-cta-row">
        <div className="container row">
          <div className="meta">
            <b>MCGM / BMC</b> · Development Plan 2034 · Maharashtra
          </div>
          <a className="btn btn-primary" href={MUMBAI_MAP_URL} target="_blank" rel="noopener">
            Open Mumbai on full map →
          </a>
        </div>
      </div>

      <div className="container region-body">
        <div>
          <section className="card text-block">
            <h2>About the Mumbai DP 2034</h2>
            <p>
              The <strong>Development Plan 2034</strong> is the statutory land-use plan for all 24 wards of Greater
              Mumbai, prepared by the <strong>Municipal Corporation of Greater Mumbai (MCGM)</strong> under the
              Maharashtra Regional and Town Planning Act, 1966. The Government of Maharashtra accorded sanction to the
              plan, with modifications, by notification dated <strong>8 May 2018</strong>; it remains in force until
              2034 and is implemented together with the Development Control and Promotion Regulations (DCPR) 2034.
            </p>
            <p>
              The plan fixes the land-use zone for every plot — residential, commercial, industrial, public /
              semi-public, green and no-development — along with public reservations and the proposed road network,
              including the arterials, link roads and metro corridors that shape the city&apos;s growth. DPPlans renders
              the sanctioned DP as an interactive overlay on current satellite imagery, so a proposed road or
              reservation can be read exactly where it falls on the ground rather than off a paper sheet.
            </p>
            <p>
              To check a plot: open the section it falls in below, search the locality, landmark or CTS number on the
              full map, then toggle the overlay to read the zone and any reservation or DP road line crossing it.
              Always confirm the final sanctioned position with MCGM before relying on a zone for a legal or
              financial decision.
            </p>
          </section>

          <section className="card sublocations notable-areas">
            <h2>The three sections of the Mumbai DP 2034</h2>
            <p className="aux-text">
              Greater Mumbai is served as three map sections, each with its own detailed page, tile layer and
              7-day access pass.
            </p>
            <ul className="sublocation-list">
              {PARTS.map(p => (
                <li key={p.slug}>
                  <div>
                    <Link className="name" href={`/${p.slug}/`}>Mumbai {p.name} DP 2034</Link>
                    <div className="aux-text" style={{ marginBottom: 0, marginTop: 4 }}>{p.covers}</div>
                  </div>
                  <a
                    className="btn btn-primary btn-sm"
                    href={p.region?.fullMapUrl ?? MUMBAI_MAP_URL}
                    target="_blank"
                    rel="noopener"
                    aria-label={`Open the Mumbai ${p.name} on the full map`}
                  >
                    Open map
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <section className="card region-plan-details">
            <h2>Mumbai DP 2034 — key details</h2>
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
            <h2>What you can do on the Mumbai DP 2034 map</h2>
            <ul>
              <li>Overlay the sanctioned DP 2034 on live satellite imagery and pan / zoom freely</li>
              <li>Read the land-use zone, reservations and DP road lines for any plot in the city</li>
              <li>Search by locality, landmark or CTS number and jump straight to it</li>
              <li>Measure distances and areas directly on the map</li>
              <li>Save any area as a print-ready map sheet, or open it in the Android / desktop app</li>
            </ul>
          </section>

          <Faq items={FAQS} />
        </div>

        <aside>
          <div className="side-card">
            <h3>Open the full app</h3>
            <p className="aux">
              The full viewer includes measurement tools, search and an overlay-toggle panel. Free up to zoom 14;
              high-detail layers unlock with a 7-day pass per section.
            </p>
            <a className="btn btn-white btn-block" href={MUMBAI_MAP_URL} target="_blank" rel="noopener">
              Launch interactive map →
            </a>
          </div>

          <div className="side-card">
            <h3>Neighbouring plans</h3>
            <p className="aux">
              DP 2034 ends at the Greater Mumbai limit. The corporations around it plan separately.
            </p>
            <ul>
              <li><Link href="/navi-mumbai-municipal-corporation-dp-plan/">Navi Mumbai (NMMC) Development Plan</Link></li>
              <li><Link href="/thane-dp-plan/">Thane (TMC) Development Plan</Link></li>
              <li><Link href="/mira-bhayandar-dp-plan/">Mira-Bhayandar (MBMC) Development Plan</Link></li>
              <li><Link href="/kalyan-dombivli-development-plan/">Kalyan DP Plan (KDMC)</Link></li>
            </ul>
          </div>

          <div className="side-card">
            <h3>Browse all regions</h3>
            <p className="aux">
              Mumbai DP 2034 is part of DPPlans&apos; wider index of Development &amp; Master Plan maps across India.
            </p>
            <Link className="btn btn-white btn-block" href="/home/">All Development Plan regions →</Link>
          </div>
        </aside>
      </div>
    </>
  );
}
