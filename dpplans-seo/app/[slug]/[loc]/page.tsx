import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { allSubLocationPaths, subLocationByPath, nearestSisters } from '@/lib/regions';
import { subLocationContent } from '@/data/sublocation-content';
import { SITE } from '@/lib/site';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Faq } from '@/components/Faq';
import { JsonLd } from '@/components/JsonLd';
import { MapEmbed } from '@/components/MapEmbed';

type Props = { params: { slug: string; loc: string } };

export function generateStaticParams() {
  return allSubLocationPaths().map(p => ({ slug: p.region.slug, loc: p.village.slug! }));
}

export function generateMetadata({ params }: Props): Metadata {
  const hit = subLocationByPath(params.slug, params.loc);
  if (!hit) return {};
  const { region, village } = hit;
  const vname = village.displayName || village.name;
  // Optional hand-curated SEO override for high-value sub-locations (e.g. PCMC).
  const seo = subLocationContent(region.slug, village.slug!);
  const title = seo?.pageTitle
    ?? `${vname} Development Plan map — ${region.shortName} district${region.state ? ', ' + region.state : ''}`;
  const description = seo?.description
    ?? `View the ${vname} section of the ${region.displayName} Development Plan online. Interactive DP overlay over satellite imagery, centred at ${village.lat.toFixed(4)}°N, ${village.lng.toFixed(4)}°E.`;
  const url = `${SITE.origin}/${region.slug}/${village.slug}/`;
  return {
    title,
    description,
    alternates: { canonical: url },
    // Only curated sub-locations carry genuinely unique content, so only they are
    // index-worthy. The thin, near-duplicate long-tail is noindex,follow — still
    // crawlable through to the map, just kept out of the index so it can't drag the
    // domain's quality signal. A town flips to indexable the moment it gets a
    // SUBLOCATION_CONTENT entry. Sitemap inclusion is gated on the same signal.
    robots: seo ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: {
      type: 'article',
      url,
      title,
      description,
      siteName: SITE.name,
      images: region.iconUrl
        ? [{ url: region.iconUrl, width: 1200, height: 630, alt: `${region.shortName} DP Plan` }]
        : undefined,
    },
    twitter: { card: 'summary_large_image', title, description },
    keywords: seo?.keywords ?? [
      `${vname} DP plan`,
      `${vname} development plan`,
      `${vname} ${region.shortName}`,
      `${vname} zoning map`,
      `${region.shortName} DP map`,
      `${region.state} development plan`,
    ],
  };
}

export default function SubLocationPage({ params }: Props) {
  const hit = subLocationByPath(params.slug, params.loc);
  if (!hit) notFound();
  const { region, village } = hit;
  const vname = village.displayName || village.name;
  const seo = subLocationContent(region.slug, village.slug!);
  const heading = seo?.pageTitle ?? `${vname} Development Plan map — ${region.shortName} district`;
  const url = `${SITE.origin}/${region.slug}/${village.slug}/`;
  const mapUrl = `${SITE.fullMap}?lat=${village.lat}&lng=${village.lng}&zoom=13`;
  const sisters = nearestSisters(region, village);

  const breadcrumbs = [
    { label: 'Regions', href: '/home/' },
    ...(region.state ? [{ label: region.state }] : []),
    { label: region.shortName, href: `/${region.slug}/` },
    { label: vname },
  ];

  const distancePhrase = village.distanceFromHqKm != null && village.bearingFromHq
    ? `about ${village.distanceFromHqKm} km ${village.bearingFromHq} of the ${region.shortName} district centre`
    : null;

  const faqs = [
    {
      q: `Where can I view the ${vname} development plan online?`,
      a: `The ${vname} area falls inside the ${region.displayName} Development Plan. On this page you can preview the section centred at ${vname} and click through to the full interactive map, which shows DP zones, road alignments and reservations overlaid on satellite imagery.`,
    },
    {
      q: `Which district does ${vname} fall under?`,
      a: `${vname} is mapped under the ${region.displayName} Development Plan${region.state ? `, ${region.state}` : ''}${distancePhrase ? ` — ${distancePhrase}` : ''}.`,
    },
    {
      q: `Is the ${vname} map official?`,
      a: region.sourceLink
        ? `The Development Plan referenced here mirrors the published documents from ${region.state ? region.state + ' ' : ''}Town Planning. The official source PDFs are linked at: ${region.sourceLink}`
        : `The Development Plan layer mirrors the latest publication from the local planning authority for ${region.shortName}.`,
    },
    {
      q: `Is access to ${vname} on the map free?`,
      a: `Browsing the ${vname} area is free up to zoom level 14. High-detail tile layers (zoom 15 and beyond) unlock with a 7-day access pass for the ${region.shortName} region.`,
    },
  ];

  const graph: object[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'Place',
      '@id': url + '#place',
      name: `${vname} (${region.shortName} DP)`,
      url,
      description: `Sub-location inside the ${region.displayName} Development Plan area.`,
      geo: {
        '@type': 'GeoCoordinates',
        latitude: village.lat,
        longitude: village.lng,
        addressCountry: 'IN',
      },
      hasMap: mapUrl,
      ...(region.state
        ? {
            containedInPlace: {
              '@type': 'AdministrativeArea',
              name: region.shortName,
              containedInPlace: {
                '@type': 'AdministrativeArea',
                name: region.state,
                addressCountry: 'IN',
              },
            },
          }
        : {}),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Regions', item: SITE.origin + '/home/' },
        { '@type': 'ListItem', position: 2, name: region.shortName, item: `${SITE.origin}/${region.slug}/` },
        { '@type': 'ListItem', position: 3, name: vname, item: url },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ];

  const caption = `Live preview of the ${region.shortName} Development Plan — opens at ${vname}`;

  return (
    <>
      <JsonLd data={graph} />

      <header className="region-header">
        <div className="container">
          <Breadcrumbs items={breadcrumbs} />
          <div className="top-row">
            <div className="icon-large">
              {region.iconUrl ? (
                <img src={region.iconUrl} alt="" width={50} height={50} />
              ) : (
                <span aria-hidden="true">▦</span>
              )}
            </div>
            <div>
              <h1>{heading}</h1>
              <p className="summary">
                {vname} is mapped under the <strong>{region.displayName} Development Plan</strong>
                {region.state ? `, ${region.state}` : ''}
                {distancePhrase ? `, ${distancePhrase}` : ''}. The DP overlay aligns with satellite imagery so
                you can identify zones, reservations and road lines for any plot near {vname}.
              </p>
            </div>
          </div>
        </div>
      </header>

      <MapEmbed title={region.shortName} fullMapUrl={mapUrl} caption={caption} />

      <div className="region-cta-row">
        <div className="container row">
          <div className="meta">
            <b>{vname}</b> · {village.lat.toFixed(4)}°N, {village.lng.toFixed(4)}°E
            {region.state ? ` · ${region.state}` : ''}
          </div>
          <a className="btn btn-primary" href={mapUrl} target="_blank" rel="noopener">
            Open {vname} on full map →
          </a>
        </div>
      </div>

      <div className="container region-body">
        <div>
          <section className="card text-block">
            <h2>About {vname} on the {region.shortName} DP map</h2>
            {seo?.intro && <p>{seo.intro}</p>}
            {seo?.paragraphs?.map((p, i) => (
              <p key={`seo-${i}`}>{p}</p>
            ))}
            <p>
              {vname} sits at coordinates <strong>{village.lat.toFixed(4)}°N, {village.lng.toFixed(4)}°E</strong>
              {distancePhrase ? `, ${distancePhrase}` : ''}. It is indexed inside the {region.displayName}{' '}
              Development Plan area, which is administered by the local planning authority for {region.shortName}
              {region.state ? `, ${region.state}` : ''}.
            </p>
            <p>
              The interactive viewer on this page opens directly at {vname} so you can identify the
              DP zone for any plot in the surrounding area — residential, commercial, industrial, green or
              public-utility — and trace planned road alignments and reservations against the current satellite
              imagery. Use the search bar inside the full map to jump to a specific survey number or landmark
              within {vname}.
            </p>
            <p>
              Browsing {vname} is free up to zoom level 14. The higher-detail DP tile layers
              (zoom 15 and beyond) unlock with a 7-day access pass for the {region.shortName} region.
            </p>
          </section>

          {sisters.length > 0 && (
            <section className="card sublocations">
              <h2>Other sub-locations in {region.shortName}</h2>
              <p className="aux-text">
                Each link opens a dedicated page for that sub-location, with the {region.shortName} DP overlay
                centred there.
              </p>
              <ul className="sublocation-list">
                {sisters.map(v => (
                  <li key={v.slug}>
                    <Link className="name" href={`/${region.slug}/${v.slug}/`}>
                      {v.displayName || v.name}
                    </Link>
                    <a
                      className="btn btn-primary btn-sm"
                      href={`${SITE.fullMap}?lat=${v.lat}&lng=${v.lng}&zoom=13`}
                      target="_blank"
                      rel="noopener"
                      aria-label={`Open ${v.displayName || v.name} on the full map`}
                    >
                      Open map
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </a>
                  </li>
                ))}
              </ul>
              <p className="aux-text" style={{ marginTop: 12 }}>
                Want the full DP for the whole district?{' '}
                <Link href={`/${region.slug}/`}>Open the {region.shortName} Development Plan page →</Link>
              </p>
            </section>
          )}

          <Faq items={faqs} />
        </div>

        <aside>
          <div className="side-card">
            <h3>Open the {region.shortName} viewer</h3>
            <p className="aux">
              The full {region.shortName} viewer includes measurement tools, search and an overlay-toggle
              panel. Centred here at {vname}.
            </p>
            <a className="btn btn-white btn-block" href={mapUrl} target="_blank" rel="noopener">
              Launch interactive map →
            </a>
          </div>

          <div className="side-card">
            <h3>Parent district</h3>
            <p className="aux">
              {vname} is one of {region.villages.filter(v => !v.skipPage).length} indexed sub-locations
              inside {region.shortName}.
            </p>
            <Link className="btn btn-white btn-block" href={`/${region.slug}/`}>
              {region.shortName} Development Plan →
            </Link>
          </div>

          {region.nearby.length > 0 && (
            <div className="side-card">
              <h3>Nearby districts</h3>
              <ul>
                {region.nearby.map(n => (
                  <li key={n.slug}>
                    <Link href={`/${n.slug}/`}>{n.shortName}</Link>
                    <span className="km">{n.distanceKm} km</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
