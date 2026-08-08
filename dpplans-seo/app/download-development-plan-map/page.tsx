import type { Metadata } from 'next';
import Link from 'next/link';
import { allRegions, regionBySlug } from '@/lib/regions';
import { DOWNLOAD, SITE, type RegionFaq } from '@/lib/site';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Faq } from '@/components/Faq';
import { JsonLd } from '@/components/JsonLd';

// Hand-authored hub that owns the download head terms. Google autocomplete (gl=IN,
// checked 2026-08-08) shows the demand around this feature is almost entirely
// download-shaped and almost entirely city-qualified:
//
//   "<city> development plan map pdf download"  — aurangabad, pune, kdmc, panvel,
//                                                 baramati, bhiwandi, nagpur, igatpuri
//   "dp plan download pdf maharashtra" / "dp plan download" / "dp map download"
//   "<locality> dp plan pdf free download"      — lohegaon, wagholi, thane, moshi,
//                                                 alandi, ambernath, pcmc, nashik
//   "town plan map pdf download", "master plan download pdf",
//   "how to print google map in high resolution", "high resolution map download"
//
// The city-qualified long tail is answered on the region / sub-location pages (they
// already rank for the city term — see components/DownloadSheet.tsx). This page exists
// for the unqualified head terms and for the "how do I actually do it" queries, and it
// is the internal-link hub every region page points at.
//
// Honesty: we output a JPEG sheet, not a PDF, and it is not the authority's sanctioned
// plan document. Both are stated above the fold. Ranking for "pdf download" and
// delivering something else without saying so would be a bait-and-switch.

const PAGE_URL = DOWNLOAD.hubUrl;

const TITLE = 'Download Development Plan map — print-ready DP map sheets (India)';
const DESCRIPTION =
  'Download a Development Plan map for the exact area you need — pick a plot, village or road on the interactive DP map and get a print-ready A4 sheet with the DP overlay on satellite imagery, a scale bar and a north arrow. Covers Pune, PCMC, Thane, Nashik, Nagpur, Aurangabad, Navi Mumbai, Hyderabad HMDA and more.';

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
    images: [{ url: SITE.origin + DOWNLOAD.sampleImage, width: DOWNLOAD.sampleWidth, height: DOWNLOAD.sampleHeight, alt: 'Sample downloaded Development Plan map sheet' }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [SITE.origin + DOWNLOAD.sampleImage] },
  keywords: [
    'development plan map pdf download',
    'dp plan download',
    'dp plan download pdf maharashtra',
    'dp map download',
    'download development plan map',
    'how to download development plan map',
    'dp plan pdf download',
    'town plan map pdf download',
    'master plan map download',
    'development plan map high resolution',
    'print development plan map',
    'zoning map download india',
  ],
};

// Regions people most often qualify the download query with, in autocomplete order of
// how often the city shows up. Slugs are resolved against regions.json so a rename in
// the data can only drop an entry, never render a dead link.
const FEATURED_SLUGS = [
  'pune-dp-plan',
  'pmrda-development-plan',
  'thane-dp-plan',
  'nashik-dp-plan',
  'nagpur-metropolitan-region-dp-plan',
  'aurangabad-dp-plan',
  'navi-mumbai-municipal-corporation-dp-plan',
  'naina-development-plan',
  'mumbai-western-suburbs-dp-plan',
  'kolhapur-dp-plan',
  'solapur-dp-plan',
  'hyderabad-hmda-periphery-dp-plan',
  'bengaluru-dp-plan',
];

const FEATURED = FEATURED_SLUGS.map(regionBySlug).filter((r): r is NonNullable<typeof r> => !!r);

// The two corporations that carry their own hand-authored hub instead of a regions.json
// entry — both are heavy download-query cities (KDMC and PCMC both appear verbatim in
// autocomplete), so they belong in the grid.
const FEATURED_HUBS = [
  { href: '/pcmc-development-plan/', name: 'PCMC (Pimpri-Chinchwad)', state: 'Maharashtra' },
  { href: '/kalyan-dombivli-development-plan/', name: 'Kalyan-Dombivli (KDMC)', state: 'Maharashtra' },
];

const STEPS = [
  {
    name: 'Open the Development Plan for your area',
    text: 'Pick your city or district from the region list and open it on the interactive map. Search a survey number, village or landmark to get to the exact plot.',
  },
  {
    name: 'Tap Download Map',
    text: 'A capture box appears over the map in the proportions of the printed sheet. Pan and zoom the map until the box covers the area you want on paper, then press Proceed.',
  },
  {
    name: 'Check the preview and add a caption',
    text: 'A preview of the sheet is generated so you can confirm the framing before paying. Type the caption that should print on the sheet — it defaults to "Part Development Plan" — and leave the scale bar switched on.',
  },
  {
    name: 'Confirm and save',
    text: 'Confirm the payment — the price is shown on the dialog, next to the preview — and the full-resolution sheet renders and saves to your Downloads folder, ready to print on A4 or attach to a report.',
  },
];

const FAQS: RegionFaq[] = [
  {
    q: 'How do I download a Development Plan map?',
    a: `Open the Development Plan for your city on the ${SITE.name} map, zoom to the area you care about, and tap Download Map. A capture box appears in the shape of the printed sheet — pan the map until it covers your area, press Proceed, check the preview, type a caption, and confirm. The sheet renders at ${DOWNLOAD.widthPx}×${DOWNLOAD.heightPx} pixels (${DOWNLOAD.paperNote}) and saves to your Downloads folder.`,
  },
  {
    q: 'Is the downloaded DP map a PDF?',
    a: `No — it is a high-resolution ${DOWNLOAD.format} image. It is sized so it prints on A4 without scaling, and it drops straight into a Word document, a valuation report or a PDF you assemble yourself. If you specifically need the planning authority's sanctioned-plan PDF, that has to come from the authority; those files are city-wide documents in which a single plot is hard to locate, which is usually why people end up looking for a map of just their area instead.`,
  },
  // No price figure anywhere on these pages — it is set in RTDB and changeable from the
  // admin panel, so a number in a static export would eventually quote a price we do not
  // charge. See the note on DOWNLOAD in lib/site.ts.
  {
    q: 'Is downloading a map sheet free?',
    a: `Viewing any Development Plan on ${SITE.name} is free up to zoom level 14. Downloading a sheet is a paid one-off — the price is shown on the download dialog, alongside a preview of the sheet, before you confirm anything. Separately, the high-detail DP layers (zoom 15 and beyond) need a 7-day access pass for that region, and while a pass is active you can re-download any sheet you have already generated at no extra cost.`,
  },
  {
    q: 'Can I download the DP map without buying a region pass?',
    a: 'You can, but the sheet will only carry the detail your account can actually see. Without an active pass for that region the plan is rendered at the free zoom level, which is fine for a locality overview and not enough for plot-level work. With a pass, the sheet is rendered from the full-detail DP tiles.',
  },
  {
    q: 'What is printed on the sheet?',
    a: 'The Development Plan overlay — land-use zones, reservations and road / road-widening lines — drawn over satellite imagery for the area you framed, inside a titled border with a geodetic scale bar, a north arrow and the caption you typed. The scale bar is drawn from real ground distances, so it stays correct even if you print the sheet at a different size.',
  },
  {
    q: 'Can I download a village map or a plot-level map?',
    a: `Yes. The capture box is dragged by you, so the sheet can be a whole taluka or a single survey number — zoom in first and the box covers less ground at higher detail. Village-boundary and village-plan layers, where published for that region, render on the sheet the same way they render on screen.`,
  },
  {
    q: 'Is this an official or certified copy of the Development Plan?',
    a: `No. ${SITE.name} renders the published Development Plan as an interactive map so it is quick to read, and the downloaded sheet is a map of the area you selected — not a certified extract, and not a DP remark. For anything legal or financial, confirm the zone with the planning authority and obtain the official document from them.`,
  },
  {
    q: 'Which cities can I download Development Plan maps for?',
    a: `Every region indexed on ${SITE.name} — ${allRegions().length} Development Plan areas at present, including Pune, PMRDA, PCMC, Kalyan-Dombivli, Thane, Navi Mumbai, NAINA, Nashik, Nagpur, Aurangabad, Kolhapur, Solapur, the three Mumbai plans, Hyderabad (HMDA periphery) and Bengaluru. The download works the same way on all of them.`,
  },
];

const graph: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    '@id': PAGE_URL + '#howto',
    name: 'How to download a Development Plan map',
    description:
      'Download the part of an Indian Development Plan you need as a print-ready A4 map sheet with the DP overlay on satellite imagery.',
    totalTime: 'PT2M',
    // No estimatedCost — structured data outlives an edit to the price in RTDB, and a
    // wrong MonetaryAmount is worse than none.
    image: SITE.origin + DOWNLOAD.sampleImage,
    step: STEPS.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: s.name,
      text: s.text,
      url: `${PAGE_URL}#step-${i + 1}`,
    })),
  },
  {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Regions', item: SITE.origin + '/home/' },
      { '@type': 'ListItem', position: 2, name: 'Download Development Plan map', item: PAGE_URL },
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

export default function DownloadHubPage() {
  return (
    <>
      <JsonLd data={graph} />

      <header className="region-header">
        <div className="container">
          <Breadcrumbs items={[{ label: 'Regions', href: '/home/' }, { label: 'Download DP maps' }]} />
          <div className="top-row">
            <div className="icon-large"><span aria-hidden="true">▦</span></div>
            <div>
              <h1>Download a Development Plan map — print-ready DP sheets for any area</h1>
              <p className="summary">
                Pick the plot, village or road you actually care about on the interactive Development Plan
                map and download <strong>just that area</strong> as a print-ready sheet — the DP overlay on
                satellite imagery, inside a bordered {DOWNLOAD.paperNote} layout with a scale bar, a north
                arrow and your own caption.
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="container region-body">
        <div>
          <section className="card text-block">
            <h2>What you get</h2>
            <figure className="dl-sample">
              <img
                src={DOWNLOAD.sampleImage}
                width={DOWNLOAD.sampleWidth}
                height={DOWNLOAD.sampleHeight}
                alt="Sample Development Plan map sheet downloaded from DPPlans — DP overlay on satellite imagery with border, scale bar and caption"
                fetchPriority="high"
                decoding="async"
              />
              <figcaption>An actual generated sheet, reduced. Output is {DOWNLOAD.widthPx}&nbsp;×&nbsp;{DOWNLOAD.heightPx}&nbsp;px.</figcaption>
            </figure>
            <p>
              Most people searching for a <em>&ldquo;development plan map pdf download&rdquo;</em> do not want a
              300-page city-wide document — they want a clean map of one plot, one village or one road, at a size
              they can print, mark up and hand to somebody. That is what this produces.
            </p>
            <ul className="dl-list">
              <li>
                <strong>The DP overlay</strong> — land-use zones, reservations, road and road-widening lines — drawn
                over satellite imagery, so plot boundaries line up with what is on the ground
              </li>
              <li>
                <strong>{DOWNLOAD.widthPx} × {DOWNLOAD.heightPx} pixels</strong>, i.e. {DOWNLOAD.paperNote} — it prints
                on A4 with no scaling and stays sharp
              </li>
              <li><strong>A geodetic scale bar</strong>, drawn from real ground distances so it stays true at any print size</li>
              <li><strong>North arrow, sheet border and your own caption</strong> (default: &ldquo;Part Development Plan&rdquo;)</li>
              <li><strong>Full-resolution map tiles</strong>, not a screenshot — this is the difference people notice</li>
            </ul>
            <p className="dl-price">
              <strong>A preview first, then a one-off payment.</strong> The sheet is previewed and the price shown
              before you confirm anything, and re-downloading that same sheet is free while your region pass is
              active. Works in the browser on desktop and mobile, and in the Android app.
            </p>
            <p className="dl-note">
              The file is a high-resolution <strong>{DOWNLOAD.format} image</strong>, not a PDF, and it is not the
              planning authority&rsquo;s sanctioned-plan document or a DP remark. It is a map sheet generated from the
              published DP overlay for the area you framed. For a certified extract, apply to the planning authority.
            </p>
          </section>

          <section className="card region-plan-details">
            <h2>How to download a Development Plan map</h2>
            <ol className="dl-steps">
              {STEPS.map((s, i) => (
                <li key={i} id={`step-${i + 1}`}>
                  <strong>{s.name}.</strong> {s.text}
                </li>
              ))}
            </ol>
            <p>
              The capture box is the whole trick: you decide what lands on the page before anything is rendered or
              paid for, so a sheet can be an entire taluka or a single survey number. Zoom in first and the same box
              covers less ground at more detail.
            </p>
          </section>

          <section className="card">
            <h2>Download the DP map for your city</h2>
            <p className="aux-text">
              Open a region, then use <strong>Download Map</strong> from inside it. Every region below supports it.
            </p>
            <ul className="dl-region-grid">
              {FEATURED.map(r => (
                <li key={r.slug}>
                  <Link href={`/${r.slug}/`}>
                    {r.shortName} DP map
                    <span className="st">{r.state}</span>
                  </Link>
                </li>
              ))}
              {FEATURED_HUBS.map(h => (
                <li key={h.href}>
                  <Link href={h.href}>
                    {h.name} DP map
                    <span className="st">{h.state}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="aux-text" style={{ marginTop: '14px' }}>
              <Link href="/home/">See all {allRegions().length} Development Plan regions →</Link>
            </p>
          </section>

          <section className="card features">
            <h2>Why not just take a screenshot?</h2>
            <ul>
              <li>A screenshot is capped at your screen resolution — it turns to mush the moment it is printed</li>
              <li>A screenshot has no scale bar, so nobody can measure anything on the printout</li>
              <li>A screenshot has no north arrow, border or title — it does not read as a drawing</li>
              <li>The sheet renders the DP tiles at full resolution for the framed area, well beyond what fits on screen</li>
              <li>The framing is chosen deliberately with the capture box instead of being whatever the window happened to show</li>
            </ul>
          </section>

          <Faq items={FAQS} />
        </div>

        <aside>
          <div className="side-card">
            <h3>Open the map</h3>
            <p className="aux">
              Browse any Development Plan free up to zoom 14, then use Download Map for a print-ready sheet of the
              area you frame.
            </p>
            <a className="btn btn-white btn-block" href={SITE.fullMap} target="_blank" rel="noopener">
              Launch interactive map →
            </a>
          </div>

          <div className="side-card">
            <h3>Browse all regions</h3>
            <p className="aux">
              {allRegions().length} Development Plan and Master Plan areas across Maharashtra, Telangana and
              Karnataka.
            </p>
            <Link className="btn btn-white btn-block" href="/home/">All DP regions →</Link>
          </div>

          <div className="side-card">
            <h3>On Android</h3>
            <p className="aux">
              The same print-ready sheet generates in the MapMagician Android app, with your saved regions.
            </p>
            <a
              className="btn btn-white btn-block"
              href="https://play.google.com/store/apps/details?id=com.himanshu.gis&hl=en_IN"
              target="_blank"
              rel="noopener"
            >
              Get it on Google Play →
            </a>
          </div>
        </aside>
      </div>
    </>
  );
}
