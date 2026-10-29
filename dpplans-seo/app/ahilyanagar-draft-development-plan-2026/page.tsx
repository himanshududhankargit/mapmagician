import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment } from 'react';
import { regionBySlug } from '@/lib/regions';
import { SITE } from '@/lib/site';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Faq } from '@/components/Faq';
import { JsonLd } from '@/components/JsonLd';
import { MapEmbed } from '@/components/MapEmbed';

// Hand-authored page for the Ahilyanagar revised DRAFT Development Plan published under
// Sec 26(1) on 10 Sep 2026 — what the draft proposes, its sheets and where it stands. The
// region page (/ahmednagar-dp-plan/) stays the map page for "ahilyanagar development plan";
// this one answers the draft-specific questions (reservations, sheets, objections, status),
// so the two are written to different intents and link to each other.
// Every figure is from AMC's own documents (amc.gov.in/town-planning, downloaded 2026-10-26):
// notice AMC/TP/891/2026 dated 7 Sep 2026 (Gazette, Nashik Div. suppl. Part One, 10-16 Sep
// 2026, pp. 13-14) and "Report on Draft Development Plan of Ahilyanagar" — Table 17-1
// (proposed land use), §16.2 (reservations: 479 sites, 415.95 ha — press reports print
// 415.15 and one prints 379 sites; the report is right), §15.9 (population horizon), Table
// 15-3 (sectors), §16.2.1 (roads). The "~850 objections" figure is press (Pudhari, 10 Oct).
// The 9 Oct 2026 last date for objections is press too (I Love Nagar 10 Sep, Deshdoot and
// Pudhari 11 Sep): AMC's notice gives "30 days from the Gazette notice" and no calendar date.
// Until 2026-10-29 our "Ahilyanagar 2026" layer was AMC's Existing Land Use map (Sec 25). On
// 2026-10-29 all 18 draft sheets went live (dp-plan-upload run 20261029-125613-Ahilyanagar-…):
// Grid-1..11 as one layer, the gaothan CTS sheets Grid-12..18 above it to zoom 19; the
// Existing Land Use layer was removed.
const DRAFT_LAYER_LIVE = true;

const PAGE_URL = `${SITE.origin}/ahilyanagar-draft-development-plan-2026/`;
const REGION_PATH = '/ahmednagar-dp-plan/';
const AMC_TP_URL = 'https://amc.gov.in/town-planning/';
const NOTICE_URL = 'https://amc.gov.in/wp-content/uploads/%E0%A4%AA%E0%A5%8D%E0%A4%B0%E0%A4%BE%E0%A4%B0%E0%A5%82%E0%A4%AA-%E0%A4%B5%E0%A4%BF%E0%A4%95%E0%A4%BE%E0%A4%B8-%E0%A4%AF%E0%A5%8B%E0%A4%9C%E0%A4%A8%E0%A5%87%E0%A4%9A%E0%A5%87-%E0%A4%AA%E0%A5%8D%E0%A4%B0%E0%A4%B8%E0%A4%BF%E0%A4%A6%E0%A5%8D%E0%A4%A7%E0%A5%80%E0%A4%95%E0%A4%B0%E0%A4%A3.pdf';
const REPORT_URL = 'https://amc.gov.in/wp-content/uploads/Report-PLU-26-us.pdf';

const TITLE = 'Ahilyanagar Draft DP 2026 — map, 479 reservations, objections';
const DESCRIPTION =
  'Ahilyanagar (Ahmednagar) Draft DP 2026: published 10 Sep 2026, objections closed 9 Oct 2026 (about 850 filed). Proposed land use, all 479 reservations and the 18 sheets, now on the map.';

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
    images: [{ url: SITE.ogImage, width: 1200, height: 630, alt: 'Ahilyanagar Draft Development Plan 2026' }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [SITE.ogImage] },
  keywords: [
    'ahilyanagar draft development plan',
    'ahilyanagar draft dp 2026',
    'ahilyanagar new dp plan',
    'ahmednagar draft development plan 2026',
    'ahmednagar new dp plan',
    'ahilyanagar dp reservations',
    'ahilyanagar dp objections',
    'ahilyanagar dp objection last date',
    'ahilyanagar draft dp hearing',
    'ahilyanagar proposed land use map',
    'ahilyanagar draft dp map online',
    'अहिल्यानगर प्रारूप विकास आराखडा',
    'अहिल्यानगर सुधारित विकास आराखडा',
    'अहिल्यानगर विकास आराखडा हरकती',
    'अहिल्यानगर विकास आराखडा नकाशा',
  ],
};

const region = regionBySlug('ahmednagar-dp-plan');
const city = region?.villages.find(v => v.slug === 'ahmednagar-city');
const MAP_URL = city ? `${SITE.fullMap}?lat=${city.lat}&lng=${city.lng}&zoom=13` : region?.fullMapUrl ?? SITE.fullMap;

const QUICK_FACTS = [
  { label: 'Planning authority', value: 'Ahilyanagar Municipal Corporation (AMC)' },
  { label: 'Plan', value: 'Draft Development Plan — old municipal limit 3rd revision + additional area 1st revision' },
  { label: 'Published under', value: 'Section 26(1), Maharashtra Regional and Town Planning Act, 1966' },
  { label: 'Notice', value: 'AMC/TP/891/2026, dated 7 September 2026, Commissioner Yashwant Dange' },
  { label: 'Gazette', value: 'Maharashtra Government Gazette, Nashik Division supplement, Part One, 10–16 September 2026' },
  { label: 'Objections', value: 'Closed 9 October 2026 (30 days from the Gazette notice); about 850 filed' },
  { label: 'Stage now', value: 'Objections being sorted for the planning committee hearings (Section 28)' },
  { label: 'On the DPPlans map', value: 'All 18 sheets since 29 October 2026; gaothan CTS sheets to street level' },
  { label: 'Planning area', value: '6,809.07 ha (developable 6,082.15 ha, non-developable 726.92 ha)' },
  { label: 'Reservations', value: '479 sites, 415.95 ha' },
  { label: 'Population planned for', value: '6,48,000 by 2039 (reservations); 8,10,000 by 2049 (zoning)' },
  { label: 'Map sheets', value: '18 at 1:4000 — Grid-1 to 11 for the city, Grid-12 to 18 for the gaothans (CTS)' },
];

const TIMELINE = [
  ['7 Mar 2024', 'General Body Resolution No. 31 declares the intention to revise the Development Plan (Section 23(1) read with Section 38); notified in the Gazette on 14–20 March 2024.'],
  ['6 May 2024', 'Order No. 12 appoints the Deputy Director, Town Planning, Development Plan Special Unit, as Town Planning Officer (Section 24).'],
  ['2024–2026', 'Existing Land Use map prepared under Section 25, followed by the draft plan.'],
  ['18 May 2026', 'The Town Planning Officer hands the draft to the Corporation.'],
  ['30 Jul 2026', 'General Body Resolution No. 23 approves publication, subject to modifications.'],
  ['7 Sep 2026', 'The modified draft, maps and report are submitted; the Commissioner signs the notice.'],
  ['10–16 Sep 2026', 'Published in the Gazette; suggestions and objections invited for 30 days.'],
  ['9 Oct 2026', 'Last date for suggestions and objections, as reported in the local press.'],
  ['10 Oct 2026', 'About 850 objections reported at the Commissioner’s office, with more at the Town Planning office — on schools, playgrounds, roads and zoning, many from Kedgaon and Nalegaon and from private landowners.'],
  ['29 Oct 2026', 'All 18 draft sheets on the DPPlans map, the gaothan CTS sheets readable to street level.'],
  ['Next', 'The General Body has recommended three corporators for the planning committee, awaiting State approval. Objectors are then sent notices and heard (Section 28), and the plan goes to the State Government for sanction (Sections 30–31).'],
];

// Press coverage of the draft — the dated record behind the objection deadline and count.
const NEWS: Array<{ date: string; outlet: string; title: string; url: string; summary: string }> = [
  {
    date: '10 Sep 2026',
    outlet: 'I Love Nagar',
    title: 'अहिल्यानगर महापालिकेचा विकास आराखडा प्रसिद्ध; ९ ऑक्टोबरपर्यंत घेता येणार हरकती',
    url: 'https://ilovenagar.com/ahilyanagar-municipal-corporation-development-plan/',
    summary: 'The draft is published at the head office and on the AMC website; objections until 9 October.',
  },
  {
    date: '11 Sep 2026',
    outlet: 'Deshdoot',
    title: 'AMC : अहिल्यानगरच्या विकासाचा नवा आराखडा',
    url: 'https://deshdoot.com/amc-development-plan-ahilyanagar/',
    summary: '479 reservations across 415 hectares, and where to file suggestions and objections.',
  },
  {
    date: '11 Sep 2026',
    outlet: 'Pudhari',
    title: 'अहिल्‍यानगरात ९० नवे प्‍लेग्राऊंड; महापालिकेचा प्रारूप विकास आराखडा प्रसिद्ध',
    url: 'https://pudhari.news/maharashtra/north-maharashtra/ahilyanagar/ahilyanagar-revised-development-plan-479-reservations-objections-october-9-sb97',
    summary: '90 new playgrounds among the reservations; objections until 9 October.',
  },
  {
    date: '10 Oct 2026',
    outlet: 'Pudhari',
    title: 'नगरच्या प्रारूप विकास आराखड्यावर साडेआठशे हरकती!',
    url: 'https://pudhari.news/maharashtra/north-maharashtra/ahilyanagar/ahilyanagar-draft-development-plan-objections-sk04',
    summary: 'About 850 objections filed; the hearing committee and the route to State sanction.',
  },
];

const LAND_USE: Array<[string, string, string]> = [
  ['Residential', '3,946.07', '57.95%'],
  ['Transportation & communication', '1,278.29', '18.77%'],
  ['Public & semi-public', '326.56', '4.80%'],
  ['Recreational', '289.50', '4.25%'],
  ['Public utilities', '107.07', '1.57%'],
  ['Industrial', '80.67', '1.18%'],
  ['Commercial', '53.99', '0.79%'],
  ['Agriculture (non-developable)', '478.78', '7.03%'],
  ['Water bodies (non-developable)', '183.96', '2.70%'],
  ['Defence (non-developable)', '64.18', '0.94%'],
];

const RESERVATIONS: Array<[string, number, string]> = [
  ['Playground', 90, '103.53'],
  ['Garden / park', 86, '82.44'],
  ['Other public purposes', 41, '78.96'],
  ['Vegetable market / shopping centre / market', 60, '31.07'],
  ['Educational facility', 40, '26.22'],
  ['Public parking', 32, '15.82'],
  ['Solid waste management site', 6, '13.04'],
  ['Municipal purpose', 38, '11.43'],
  ['Sewage treatment plant', 4, '10.95'],
  ['Health facility', 28, '10.64'],
  ['Cremation ground', 10, '8.46'],
  ['Burial ground', 7, '7.00'],
  ['Community / multipurpose hall', 10, '5.83'],
  ['Town hall', 4, '5.53'],
  ['AMT bus stand', 7, '2.72'],
  ['Fire station', 3, '1.23'],
  ['Library', 11, '0.85'],
  ['Water pumping station', 2, '0.22'],
];

const SECTORS: Array<[string, string, string]> = [
  ['I', 'Kedgaon, Bhingar', '2,032.78'],
  ['II', 'Nalegaon, Morchudnagar, Maliwada', '1,154.68'],
  ['III', 'Nagapur, Bolhegaon, part of Nalegaon', '1,494.25'],
  ['IV', 'Bhistbag, part of Savedi', '821.64'],
  ['V', 'Bhistbag, part of Savedi', '487.69'],
  ['VI', 'Savedi, part of Bhingar (Mukundnagar)', '412.04'],
  ['VII', 'GLR, part of Maliwada', '283.77'],
  ['VIII', 'Ahilyanagar gaothan (old city)', '122.24'],
];

const SHEETS = [
  'Grid-1 — Nagapur, Bolhegaon',
  'Grid-2 — Savedi, Bhistbag',
  'Grid-3 — Savedi, Bhingar',
  'Grid-4 — Nalegaon, Morchudnagar, Bolhegaon',
  'Grid-5 — Nalegaon, Morchudnagar, Savedi, Chahurana',
  'Grid-6 — Savedi, Bhingar, Ahilyanagar gaothan',
  'Grid-7 — Kedgaon, Nalegaon, Morchudnagar',
  'Grid-8 — Nalegaon, Morchudnagar, Kedgaon, Bhingar gaothan',
  'Grid-9 — Maliwada, Chahurana, Bhingar gaothan',
  'Grid-10 and Grid-11 — Kedgaon',
  'Grid-12 to Grid-16 — CTS sheets, Ahilyanagar gaothan',
  'Grid-17 — CTS sheet, Kedgaon gaothan',
  'Grid-18 — CTS sheet, Nagapur gaothan',
];

const ON_OUR_MAP = DRAFT_LAYER_LIVE
  ? 'Since 29 October 2026 all 18 sheets of this draft are on the DPPlans map over satellite imagery: the 11 city sheets (Grid-1 to 11) as one layer, and the gaothan CTS sheets — Ahilyanagar (Grid-12 to 16), Kedgaon (Grid-17) and Nagapur (Grid-18) — drawn above it and readable down to individual plots. Search a survey number or landmark to read its proposed zone and any reservation, then switch to the older plan layer to see how the earlier Ahmednagar Development Plan treated the same ground.'
  : 'The Ahilyanagar 2026 layer now on the DPPlans map is the Existing Land Use map that AMC prepared for this revision (Section 25): it shows how land is used today, not the zones and reservations proposed in the draft. The 18 proposed land-use sheets are being georeferenced and will be added as their own layer. Until then, use the official sheets on the AMC website for the draft proposals.';

const FAQS = [
  {
    q: 'What is the Ahilyanagar Draft Development Plan 2026?',
    a: 'It is the revised Development Plan that the Ahilyanagar Municipal Corporation published in draft on 10 September 2026 under Section 26(1) of the Maharashtra Regional and Town Planning Act, 1966 — the third revision for the old municipal limit and the first for the area added to the Corporation later. It covers 6,809.07 hectares, proposes the land use for every plot, and reserves 479 sites (415.95 ha) for public purposes, planned for a population of 6,48,000 by 2039.',
  },
  {
    q: 'What was the last date for objections to the Ahilyanagar draft DP?',
    a: '9 October 2026. The notice invited written suggestions and objections, with reasons, to the Commissioner within 30 days of its publication in the Maharashtra Government Gazette (10–16 September 2026), and local newspapers reported the last date as 9 October. They were taken at the Commissioner’s office at the Corporation headquarters and at the Development Plan unit of the Deputy Director of Town Planning at TV Centre.',
  },
  {
    q: 'Can I still file an objection to the Ahilyanagar draft DP?',
    a: 'Not under the published notice: it said only suggestions and objections received within the 30-day period would be considered, and that period ended on 9 October 2026. About 850 objections were filed. For a hearing date or the status of an objection already filed, contact the AMC Town Planning department (Development Plan Special Unit).',
  },
  {
    q: 'What happens to the objections now?',
    a: 'The Corporation is sorting them by subject. The General Body has recommended three corporators for the planning committee, which awaits State approval; each objector is then sent a notice and heard (Section 28 of the MRTP Act). After the hearings the plan, with the committee’s changes, goes to the State Government for sanction (Sections 30–31).',
  },
  {
    q: 'अहिल्यानगर प्रारूप विकास आराखड्यावर हरकती घेण्याची अंतिम तारीख कोणती होती?',
    a: '९ ऑक्टोबर २०२६. अहिल्यानगर महानगरपालिकेचा सुधारित प्रारूप विकास आराखडा १० सप्टेंबर २०२६ रोजी महाराष्ट्र प्रादेशिक नियोजन व नगररचना अधिनियम, १९६६ च्या कलम २६(१) अन्वये प्रसिद्ध झाला आणि राजपत्रातील सूचनेपासून ३० दिवस हरकती व सूचना स्वीकारल्या गेल्या. सुमारे ८५० हरकती दाखल झाल्या असून त्यांची सुनावणी नियोजन समितीसमोर होईल. आराखड्यात ४७९ आरक्षणे असून सर्व १८ नकाशे DPPlans नकाशावर पाहता येतात.',
  },
  {
    q: 'How many reservations does the draft propose?',
    a: '479 reservation sites covering 415.95 hectares. The largest groups are 90 playgrounds (103.53 ha), 86 gardens and parks (82.44 ha), 60 vegetable markets and shopping centres (31.07 ha), 40 educational sites (26.22 ha), 38 municipal-purpose sites and 32 public parking sites, plus 41 sites for other public purposes (78.96 ha).',
  },
  {
    q: 'Is the draft plan final?',
    a: 'No. A draft Development Plan can change at the hearing stage and when the State Government sanctions it, so a zone or reservation on the draft is a proposal, not a final designation. Until the plan is sanctioned, confirm the current position of a plot with the Ahilyanagar Municipal Corporation before buying, selling or building.',
  },
  {
    q: 'Where are the official draft DP maps?',
    a: 'The AMC town-planning page links the 18 detailed sheets (Grid-1 to Grid-18, scale 1:4000), a combined map, the Marathi and English reports and the publication notice. Copies of the plan can also be bought at the Commissioner’s office.',
  },
  {
    q: 'Can I check my plot against the draft on DPPlans?',
    a: DRAFT_LAYER_LIVE ? 'Yes. ' + ON_OUR_MAP : ON_OUR_MAP,
  },
  {
    q: 'Is this the Ahmednagar Development Plan?',
    a: 'Yes. Ahmednagar was renamed Ahilyanagar, and the Ahmednagar Municipal Corporation is now the Ahilyanagar Municipal Corporation. This draft revises the same city’s Development Plan.',
  },
];

const graph: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'Article',
    '@id': PAGE_URL + '#article',
    headline: TITLE,
    description: DESCRIPTION,
    url: PAGE_URL,
    datePublished: '2026-10-26',
    dateModified: '2026-10-29',
    about: {
      '@type': 'Place',
      name: 'Ahilyanagar (Ahmednagar), Maharashtra',
      ...(city ? { geo: { '@type': 'GeoCoordinates', latitude: city.lat, longitude: city.lng, addressCountry: 'IN' } } : {}),
    },
    image: SITE.ogImage,
    publisher: { '@type': 'Organization', name: SITE.name, url: SITE.origin },
  },
  {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Regions', item: SITE.origin + '/home/' },
      { '@type': 'ListItem', position: 2, name: 'Ahilyanagar Development Plan', item: SITE.origin + REGION_PATH },
      { '@type': 'ListItem', position: 3, name: 'Draft DP 2026', item: PAGE_URL },
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

export default function AhilyanagarDraftDp2026Page() {
  return (
    <>
      <JsonLd data={graph} />

      <header className="region-header">
        <div className="container">
          <Breadcrumbs
            items={[
              { label: 'Regions', href: '/home/' },
              { label: 'Ahilyanagar Development Plan', href: REGION_PATH },
              { label: 'Draft DP 2026' },
            ]}
          />
          <div className="top-row">
            <div className="icon-large"><span aria-hidden="true">▦</span></div>
            <div>
              <h1>Ahilyanagar Draft Development Plan 2026</h1>
              <p className="summary">
                The <strong>Ahilyanagar Municipal Corporation</strong> published its revised draft Development Plan
                on <strong>10 September 2026</strong> under Section 26(1) of the MRTP Act: 6,809 hectares, 479
                reservations and 18 map sheets. Objections closed on <strong>9 October 2026</strong>, with about 850
                filed, and all 18 sheets are now on the DPPlans map. Here is what it proposes and where it stands.
              </p>
            </div>
          </div>
        </div>
      </header>

      <MapEmbed
        title="Ahilyanagar Development Plan"
        fullMapUrl={MAP_URL}
        caption="Open Ahilyanagar on the DPPlans map"
      />

      <div className="region-cta-row">
        <div className="container row">
          <div className="meta">
            <b>Ahilyanagar Municipal Corporation</b> · Draft DP · published 10 Sep 2026 · objections closed 9 Oct 2026
          </div>
          <a className="btn btn-primary" href={MAP_URL} target="_blank" rel="noopener">
            Open Ahilyanagar on full map →
          </a>
        </div>
      </div>

      <div className="container region-body">
        <div>
          <section className="card text-block">
            <h2>About the draft</h2>
            <p>
              The draft revises the Development Plan of the <strong>Ahilyanagar (Ahmednagar) Municipal
              Corporation</strong> in two parts at once: the third revision for the old municipal limit and the first
              for the area added to the Corporation later. It was prepared by the Corporation&apos;s Development Plan
              Special Unit, approved for publication by the General Body on 30 July 2026 with modifications, and
              published in the Maharashtra Government Gazette for 10–16 September 2026.
            </p>
            <p>
              It plans the city for <strong>6,48,000 people by 2039</strong> — the horizon used for reservations —
              and 8,10,000 by 2049 for zoning, both projected by the geometric-increase method. Of the 6,809.07
              hectare planning area, 89.32% is developable; residential use takes 3,946 hectares, and roads and
              transport 1,278 hectares. The city is divided into eight planning sectors, from Kedgaon and Bhingar
              (Sector I) to the old Ahilyanagar gaothan (Sector VIII).
            </p>
            <p>
              Most of the earlier road network is kept. The report lists three changes: the proposed road in the
              Nalegaon–Bolhegaon area is narrowed from 54 m to 30 m; a new grid of 12, 15, 18 and 24 m roads serves
              about 600 hectares of new residential area around Nalegaon and Bolhegaon; and, under the General
              Body&apos;s resolution, the proposed 30 m road connecting to the Nagar–Manmad Road is cut to 24 m.
            </p>
            <p>{ON_OUR_MAP}</p>
          </section>

          <section className="card region-plan-details">
            <h2>Ahilyanagar draft DP — key details</h2>
            <dl className="region-quick-facts">
              {QUICK_FACTS.map((f, i) => (
                <Fragment key={i}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </Fragment>
              ))}
            </dl>

            <h3>How the plan got here</h3>
            <dl className="region-quick-facts">
              {TIMELINE.map(([when, what]) => (
                <Fragment key={when}>
                  <dt>{when}</dt>
                  <dd>{what}</dd>
                </Fragment>
              ))}
            </dl>
          </section>

          <section className="card region-plan-details">
            <h2>Proposed land use</h2>
            <p className="aux-text">Area in hectares and share of the 6,809.07 ha planning area (report, Table 17-1).</p>
            <dl className="region-quick-facts">
              {LAND_USE.map(([use, ha, pct]) => (
                <Fragment key={use}>
                  <dt>{use}</dt>
                  <dd>{ha} ha · {pct}</dd>
                </Fragment>
              ))}
            </dl>
          </section>

          <section className="card region-plan-details">
            <h2>All 479 reservations by type</h2>
            <p className="aux-text">Number of sites and area in hectares (report, section 16.2). Total 415.95 ha.</p>
            <dl className="region-quick-facts">
              {RESERVATIONS.map(([type, sites, ha]) => (
                <Fragment key={type}>
                  <dt>{type}</dt>
                  <dd>{sites} sites · {ha} ha</dd>
                </Fragment>
              ))}
            </dl>
          </section>

          <section className="card region-plan-details">
            <h2>Planning sectors</h2>
            <dl className="region-quick-facts">
              {SECTORS.map(([no, villages, ha]) => (
                <Fragment key={no}>
                  <dt>Sector {no}</dt>
                  <dd>{villages} · {ha} ha</dd>
                </Fragment>
              ))}
            </dl>
          </section>

          <section className="card features">
            <h2>The 18 draft DP map sheets</h2>
            <ul>
              {SHEETS.map(s => <li key={s}>{s}</li>)}
            </ul>
            <p className="aux-text">
              Official sheets, combined map and reports: <a href={AMC_TP_URL} target="_blank" rel="noopener">AMC town
              planning</a> · <a href={NOTICE_URL} target="_blank" rel="noopener">publication notice</a> ·{' '}
              <a href={REPORT_URL} target="_blank" rel="noopener">report (English)</a>
            </p>
          </section>

          <section className="card features">
            <h2>Ahilyanagar draft DP in the news</h2>
            <ul>
              {NEWS.map(n => (
                <li key={n.url}>
                  <strong>{n.date}, {n.outlet}</strong> —{' '}
                  <a href={n.url} target="_blank" rel="noopener">{n.title}</a>. {n.summary}
                </li>
              ))}
            </ul>
          </section>

          <Faq items={FAQS} />
        </div>

        <aside>
          <div className="side-card">
            <h3>Ahilyanagar DP map</h3>
            <p className="aux">
              The map page for Ahilyanagar: the Corporation area, the Gaothan CTS sheets and the earlier Ahmednagar
              Development Plan, plus Jamkhed, Shirdi, Sangamner and Pathardi.
            </p>
            <Link className="btn btn-white btn-block" href={REGION_PATH}>Ahilyanagar Development Plan →</Link>
          </div>

          <div className="side-card">
            <h3>Official documents</h3>
            <p className="aux">
              AMC publishes the draft sheets, the combined map, the reports in Marathi and English, and the Section
              26(1) notice on its town-planning page.
            </p>
            <a className="btn btn-white btn-block" href={AMC_TP_URL} target="_blank" rel="noopener">
              AMC town planning →
            </a>
          </div>

          <div className="side-card">
            <h3>Browse all regions</h3>
            <p className="aux">
              Development and Master Plan maps across Maharashtra, Karnataka and Telangana.
            </p>
            <Link className="btn btn-white btn-block" href="/home/">All Development Plan regions →</Link>
          </div>
        </aside>
      </div>
    </>
  );
}
