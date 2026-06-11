import type { Metadata } from 'next';
import Link from 'next/link';
import { regionBySlug } from '@/lib/regions';
import { SITE } from '@/lib/site';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Faq } from '@/components/Faq';
import { JsonLd } from '@/components/JsonLd';

// Hand-authored hub page that consolidates the head term "MSRDC development plan".
// The three corridor region pages each rank weakly on their own (the term is diluted by
// the city name + "Corridor"); this page owns the term and funnels link equity to all
// three via internal links. Static route — output:'export' builds it to
// out/msrdc-development-plan/index.html with no generateStaticParams.

const PAGE_URL = `${SITE.origin}/msrdc-development-plan/`;

const TITLE = 'MSRDC Development Plan map online — Mumbai–Pune Expressway, Mahabaleshwar & Karjat corridors';
const DESCRIPTION =
  'View the MSRDC (Maharashtra State Road Development Corporation) corridor Development Plans online — the Mumbai–Pune Expressway, New Mahabaleshwar and Karjat corridors as interactive DP overlays on satellite imagery: land-use zones, reservations and road lines for any plot.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    type: 'website',
    url: PAGE_URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: SITE.name,
    images: [{ url: SITE.ogImage, width: 1200, height: 630, alt: 'MSRDC Development Plan corridors' }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [SITE.ogImage] },
  keywords: [
    'msrdc development plan',
    'msrdc corridor development plan',
    'msrdc plan',
    'maharashtra state road development corporation development plan',
    'mumbai pune expressway development plan',
    'new mahabaleshwar development plan',
    'karjat development plan',
    'msrdc dp map',
  ],
};

// Display order + curated one-line context for each corridor. The numeric facts
// (villages, map URL) are pulled live from regions.json so they never drift.
const CORRIDORS: { slug: string; label: string; blurb: string }[] = [
  {
    slug: 'pune-mumbai-msrdc-corridor',
    label: 'Pune–Mumbai Expressway Corridor',
    blurb:
      'The MSRDC Special Planning Authority corridor — an ~2 km-wide notified stretch flanking the ~94 km Mumbai–Pune Expressway (Yashwantrao Chavan Expressway, India’s first access-controlled toll expressway, opened 2002) through the Khalapur–Lonavala–Khandala ghat belt between Mumbai and Pune.',
  },
  {
    slug: 'mahabaleshwar-msrdc-corridor',
    label: 'New Mahabaleshwar Corridor',
    blurb:
      'The New Mahabaleshwar Hill Station project in Satara district, for which MSRDC was appointed Special Planning Authority in 2019 — a Western Ghats belt across the Jaoli, Mahabaleshwar, Satara and Patan talukas, later expanded to 529 villages (~2,097 km²) around the existing Mahabaleshwar–Panchgani hill stations.',
  },
  {
    slug: 'karjat-msrdc-corridor',
    label: 'Karjat Corridor',
    blurb:
      'The MSRDC Special Planning Authority corridor flanking the Mumbai–Pune Expressway through the Panvel and Khalapur talukas of Raigad district — 71 villages over ~187 km², a fast-growing logistics, warehousing and second-home belt (previously part of NAINA under CIDCO).',
  },
];

const corridorData = CORRIDORS.map(c => {
  const region = regionBySlug(c.slug);
  return region ? { ...c, region } : null;
}).filter((x): x is { slug: string; label: string; blurb: string; region: NonNullable<ReturnType<typeof regionBySlug>> } => x !== null);

const FAQS = [
  {
    q: 'What is the MSRDC Development Plan?',
    a: 'MSRDC — the Maharashtra State Road Development Corporation — is a Government of Maharashtra undertaking set up in 1996 to build and operate major road infrastructure such as the Mumbai–Pune Expressway. For certain corridors and areas along its projects, MSRDC is appointed as a Special / Planning Authority under the Maharashtra Regional and Town Planning (MRTP) Act, 1966, and prepares a Development Plan that fixes land-use zones, reservations and road lines. These pages render those plans as interactive overlays on satellite imagery.',
  },
  {
    q: 'Which corridors does MSRDC plan on this site?',
    a: 'Three MSRDC corridor plans are indexed here: the Pune–Mumbai (Mumbai–Pune Expressway) corridor, the New Mahabaleshwar corridor in Satara district, and the Karjat corridor in Raigad district. Each links to its own interactive DP map.',
  },
  {
    q: 'Is MSRDC the planning authority for New Mahabaleshwar?',
    a: 'Yes. The Government of Maharashtra appointed MSRDC as the Special Planning Authority for the New Mahabaleshwar Hill Station project in 2019, across the Jaoli, Mahabaleshwar, Satara and Patan talukas of Satara district — a project later expanded to 529 villages over roughly 2,097 sq km.',
  },
  {
    q: 'Is the MSRDC corridor map official?',
    a: 'The overlays mirror the published or draft Development Plan documents for each corridor. Planning notifications and sanctioned plans can change — always confirm the final sanctioned plan with MSRDC or the Urban Development Department before relying on a zone for any legal or financial decision.',
  },
  {
    q: 'Is access free?',
    a: 'Browsing each corridor is free up to zoom level 14. High-detail tile layers (zoom 15 and beyond) unlock with a 7-day access pass for that corridor.',
  },
];

const graph: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': PAGE_URL + '#collection',
    url: PAGE_URL,
    name: 'MSRDC Development Plans',
    description: DESCRIPTION,
    isPartOf: { '@type': 'WebSite', name: SITE.name, url: SITE.origin },
    hasPart: corridorData.map(c => ({
      '@type': 'Place',
      name: `${c.label} — MSRDC Development Plan`,
      url: `${SITE.origin}/${c.slug}/`,
    })),
  },
  {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Regions', item: SITE.origin + '/home/' },
      { '@type': 'ListItem', position: 2, name: 'MSRDC Development Plans', item: PAGE_URL },
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

export default function MsrdcHubPage() {
  return (
    <>
      <JsonLd data={graph} />

      <header className="region-header">
        <div className="container">
          <Breadcrumbs items={[{ label: 'Regions', href: '/home/' }, { label: 'MSRDC Development Plans' }]} />
          <div className="top-row">
            <div className="icon-large"><span aria-hidden="true">▦</span></div>
            <div>
              <h1>MSRDC Development Plans — corridor DP maps online</h1>
              <p className="summary">
                Interactive Development Plan maps for the <strong>Maharashtra State Road Development Corporation
                (MSRDC)</strong> corridors — the Mumbai–Pune Expressway, New Mahabaleshwar and Karjat. Each DP overlay
                aligns with satellite imagery so you can read the zones, reservations and road lines for any plot.
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="container region-body">
        <div>
          <section className="card text-block">
            <h2>What is the MSRDC Development Plan?</h2>
            <p>
              The <strong>Maharashtra State Road Development Corporation (MSRDC)</strong> is a Government of Maharashtra
              undertaking, incorporated in 1996, best known for building and operating the Mumbai–Pune Expressway. Beyond
              roads, MSRDC is appointed as a <strong>Special / Planning Authority</strong> under the Maharashtra Regional
              and Town Planning (MRTP) Act, 1966 for specific corridors and influence areas along its projects. In that
              role it prepares a <strong>Development Plan (DP)</strong> — the statutory map that fixes land-use zones
              (residential, commercial, industrial, agricultural / no-development, green), public reservations and the
              proposed road network across the notified area.
            </p>
            <p>
              Because these plans sit along expressways, ghats and hill-station belts rather than inside a single city,
              they are usually searched as the <em>“MSRDC corridor”</em> plan rather than by a town name. This page brings
              all of MSRDC’s indexed corridors together and links straight into each interactive map.
            </p>
          </section>

          <section className="card">
            <h2>MSRDC corridors covered</h2>
            <p className="aux-text">
              {corridorData.length} corridor Development Plans are indexed. Open any one to view its DP overlay on
              satellite imagery, or jump straight onto the full map.
            </p>
            <ul className="sublocation-list">
              {corridorData.map(c => (
                <li key={c.slug} style={{ display: 'block' }}>
                  <Link className="name" href={`/${c.slug}/`}>{c.label}</Link>
                  <p className="aux" style={{ margin: '4px 0 8px' }}>
                    {c.blurb} {c.region.villages.length > 0 ? `${c.region.villages.length} sub-locations indexed.` : ''}
                  </p>
                  <span style={{ display: 'inline-flex', gap: 10 }}>
                    <Link className="btn btn-primary btn-sm" href={`/${c.slug}/`}>View the {c.label} plan →</Link>
                    <a className="btn btn-white btn-sm" href={c.region.fullMapUrl} target="_blank" rel="noopener">
                      Open on full map
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card text-block">
            <h2>How MSRDC corridor planning works</h2>
            <p>
              When the State Government notifies a corridor or hill-station area as a special planning area, MSRDC first
              publishes an <strong>existing-land-use survey</strong> and then a <strong>draft Development Plan</strong>,
              invites public objections and suggestions, and — after the planning committee and Government approval — a
              <strong> sanctioned Development Plan</strong> is gazetted. The sanctioned DP, read together with the
              Development Control &amp; Promotion Regulations (DCPR), governs what can be built on each plot and where
              roads, reservations and amenity spaces fall.
            </p>
            <p>
              For the <strong>New Mahabaleshwar Hill Station project</strong>, MSRDC was appointed Special Planning
              Authority in 2019 across the Jaoli, Mahabaleshwar, Satara and Patan talukas of Satara district — an
              ecologically sensitive Western Ghats project (later expanded to 529 villages, ~2,097 km²) where the plan
              balances tourism and second-home growth against forest, slope and catchment protection. Along the{' '}
              <strong>Mumbai–Pune Expressway</strong>, the corridor plan covers an ~2 km-wide notified stretch flanking
              the expressway between Mumbai and Pune. In the <strong>Karjat</strong> corridor of Raigad — 71 villages
              across the Panvel and Khalapur talukas, previously part of NAINA under CIDCO — the plan covers a fast-growing
              logistics and second-home belt in the Sahyadri foothills.
            </p>
            <p>
              To use any corridor map, search a survey number, village or landmark, then toggle the DP overlay to confirm
              the designated zone and any reservation or road line crossing the plot before relying on it. Planning
              notifications evolve — treat these maps as a fast reference and verify the final sanctioned plan with MSRDC
              or the Urban Development Department for legal or financial decisions.
            </p>
          </section>

          <section className="card features">
            <h2>What you can do on the MSRDC corridor maps</h2>
            <ul>
              <li>Overlay the corridor Development Plan on live satellite imagery and pan / zoom freely</li>
              <li>Read the land-use zone, reservations and proposed road lines for any plot</li>
              <li>Search by village, survey number or landmark and jump straight to it</li>
              <li>Measure distances and areas directly on the map</li>
              <li>Open each corridor in the full interactive app on desktop, tablet or Android</li>
            </ul>
          </section>

          <Faq items={FAQS} />
        </div>

        <aside>
          <div className="side-card">
            <h3>Browse all regions</h3>
            <p className="aux">
              MSRDC corridors are part of DPPlans’ wider index of Development &amp; Master Plan maps across Maharashtra,
              Telangana and Karnataka.
            </p>
            <Link className="btn btn-white btn-block" href="/home/">All Development Plan regions →</Link>
          </div>

          <div className="side-card">
            <h3>The corridors</h3>
            <ul>
              {corridorData.map(c => (
                <li key={c.slug}>
                  <Link href={`/${c.slug}/`}>{c.label}</Link>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}
