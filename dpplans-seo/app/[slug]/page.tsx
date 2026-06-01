import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { allRegions, regionBySlug } from '@/lib/regions';
import { regionContentBySlug } from '@/data/region-content';
import { SITE } from '@/lib/site';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Faq } from '@/components/Faq';
import { JsonLd } from '@/components/JsonLd';
import { MapEmbed } from '@/components/MapEmbed';

type Props = { params: { slug: string } };

export function generateStaticParams() {
  return allRegions().map(r => ({ slug: r.slug }));
}

export function generateMetadata({ params }: Props): Metadata {
  const region = regionBySlug(params.slug);
  if (!region) return {};
  const content = regionContentBySlug(params.slug);
  const title = content?.pageTitle ?? `${region.shortName} Development Plan — view DP map online`;
  const description = content?.description ?? `View the ${region.displayName} Development Plan online. Interactive DP overlay over satellite imagery, ${region.villages.length || 'all'} sub-locations indexed${region.state ? `, covering ${region.state}` : ''}.`;
  const url = `${SITE.origin}/${region.slug}/`;
  const og = region.iconUrl
    ? [{ url: region.iconUrl, width: 1200, height: 630, alt: `${region.shortName} DP Plan` }]
    : undefined;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      url,
      title,
      description,
      siteName: SITE.name,
      images: og,
    },
    twitter: { card: 'summary_large_image', title, description, images: og?.map(i => i.url) },
    keywords: content?.keywords ?? [
      `${region.shortName} DP plan`,
      `${region.shortName} Development Plan`,
      `${region.shortName} DP map online`,
      `${region.shortName} zoning map`,
      `${region.state} DP map`,
      'GIS map India',
    ],
  };
}

export default function RegionPage({ params }: Props) {
  const region = regionBySlug(params.slug);
  if (!region) notFound();

  const regionContent = regionContentBySlug(params.slug);
  const url = `${SITE.origin}/${region.slug}/`;
  const breadcrumbs = [
    { label: 'Regions', href: '/home/' },
    ...(region.state ? [{ label: region.state }] : []),
    { label: region.shortName },
  ];

  const graph: object[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'Place',
      '@id': url + '#place',
      name: `${region.shortName} Development Plan`,
      url,
      description: `Interactive Development Plan map for ${region.displayName}.`,
      ...(region.state
        ? { containedInPlace: { '@type': 'AdministrativeArea', name: region.state, addressCountry: 'IN' } }
        : {}),
      ...(region.centroid
        ? {
            geo: {
              '@type': 'GeoCoordinates',
              latitude: region.centroid.lat,
              longitude: region.centroid.lng,
              addressCountry: 'IN',
            },
          }
        : {}),
      ...(region.bbox
        ? {
            hasMap: region.fullMapUrl,
            geoWithin: {
              '@type': 'GeoShape',
              box: `${region.bbox[1]} ${region.bbox[0]} ${region.bbox[3]} ${region.bbox[2]}`,
            },
          }
        : { hasMap: region.fullMapUrl }),
      image: region.iconUrl ?? undefined,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      // Visible UI breadcrumb still shows Regions › State › Region, but the structured
      // data drops the intermediate state crumb — there's no /<state>/ landing page to
      // point `item` at, and Google flags intermediate ListItems missing `item` as
      // invalid ("Missing field 'item'").
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Regions', item: SITE.origin + '/home/' },
        { '@type': 'ListItem', position: 2, name: region.shortName, item: url },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: region.faqs.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ];

  const showcaseCaption = `Live preview of the ${region.shortName} Development Plan${region.state ? `, ${region.state}` : ''}`;

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
              <h1>{regionContent?.pageTitle ?? `${region.shortName} Development Plan — view DP map online`}</h1>
              <p className="summary">
                Interactive Development Plan viewer for <strong>{region.displayName}</strong>
                {region.state ? `, ${region.state}` : ''}. The DP overlay aligns with satellite imagery so you
                can identify zones, reservations, and road lines for any plot.
              </p>
            </div>
          </div>
        </div>
      </header>

      <MapEmbed
        title={region.shortName}
        fullMapUrl={region.fullMapUrl}
        caption={showcaseCaption}
      />

      <div className="region-cta-row">
        <div className="container row">
          <div className="meta">
            <b>{region.shortName}</b> · {region.villages.length > 0 ? `${region.villages.length} sub-locations indexed` : 'Development Plan'}
            {region.state ? ` · ${region.state}` : ''}
          </div>
          <a className="btn btn-primary" href={region.fullMapUrl} target="_blank" rel="noopener">
            Open {region.shortName} on full map →
          </a>
        </div>
      </div>

      <div className="container region-body">
        <div>
          <section className="card text-block">
            <h2>About the {region.shortName} Development Plan</h2>
            <p>
              The {region.displayName} Development Plan defines land-use zones, road alignments, reservations and
              proposed amenities across {region.shortName}{region.state ? `, ${region.state}` : ''}. DPPlans renders
              the published plan as an interactive overlay on satellite imagery — pan, zoom, search by survey number
              or village, and measure distances directly on the map.
            </p>
            {region.villages.length > 0 && (
              <p>
                Sub-locations indexed inside {region.shortName} include{' '}
                <strong>
                  {region.villages.slice(0, 8).map(v => v.name).join(', ')}
                  {region.villages.length > 8 ? ` and ${region.villages.length - 8} more` : ''}
                </strong>
                . Each one can be opened directly from the search bar on the full map.
              </p>
            )}
            <p>
              Free up to zoom level 14. High-detail tile layers (zoom 15 and beyond) unlock with a 7-day access pass
              for the {region.shortName} region.
            </p>
          </section>

          {regionContent && (
            <section className="card region-plan-details">
              <h2>{region.shortName} Development Plan — key details</h2>
              {regionContent.paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
              {regionContent.quickFacts.length > 0 && (
                <>
                  <h3>Plan at a glance</h3>
                  <dl className="region-quick-facts">
                    {regionContent.quickFacts.map((f, i) => (
                      <Fragment key={i}>
                        <dt>{f.label}</dt>
                        <dd>{f.value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                </>
              )}
            </section>
          )}

          {region.villages.length > 0 && (
            <section className="card sublocations">
              <h2>Sub-locations in {region.shortName}</h2>
              <p className="aux-text">
                Each location below opens the full {region.shortName} map zoomed straight to that point.
              </p>
              <ul className="sublocation-list">
                {region.villages.map((v, i) => (
                  <li key={i}>
                    {v.slug && !v.skipPage ? (
                      <Link className="name" href={`/${region.slug}/${v.slug}/`}>{v.displayName || v.name}</Link>
                    ) : (
                      <span className="name">{v.displayName || v.name}</span>
                    )}
                    <a
                      className="btn btn-primary btn-sm"
                      href={`${SITE.fullMap}?lat=${v.lat}&lng=${v.lng}&zoom=13`}
                      target="_blank"
                      rel="noopener"
                      aria-label={`Open ${v.name} on the full map`}
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
            </section>
          )}

          <section className="card features">
            <h2>What you get on the {region.shortName} map</h2>
            <ul>
              {region.features.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </section>

          <Faq items={region.faqs} />
        </div>

        <aside>
          <div className="side-card">
            <h3>Open the full app</h3>
            <p className="aux">
              The full {region.shortName} viewer includes measurement tools, search, and an overlay-toggle panel.
              Disclaimer and sign-in run on the app — first visit only.
            </p>
            <a className="btn btn-white btn-block" href={region.fullMapUrl} target="_blank" rel="noopener">
              Launch interactive map →
            </a>
          </div>

          <div className="side-card">
            <h3>Get the apps</h3>
            <div className="pd-mobile-hint">
              <picture>
                <source srcSet="/AssetsGIS/image-1.webp" type="image/webp" />
                <img className="pd-app-icon" src="/AssetsGIS/image-1.png" alt="MapMagician app icon" width={36} height={36} loading="lazy" decoding="async" />
              </picture>
              <div className="pd-mobile-hint-text">
                <strong>Prefer mobile?</strong>Get the Android app for on-the-go access.
              </div>
              <a className="pd-play-btn" href="https://play.google.com/store/apps/details?id=com.himanshu.gis&hl=en_IN" target="_blank" rel="noopener">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="#1B5E20" aria-hidden="true"><path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.2l2.807 1.626a1 1 0 010 1.734l-2.808 1.626L15.206 12l2.492-2.493zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z" /></svg>
                Google Play
              </a>
            </div>
            <div className="pd-mobile-hint">
              <picture>
                <source srcSet="/AssetsGIS/image-1.webp" type="image/webp" />
                <img className="pd-app-icon" src="/AssetsGIS/image-1.png" alt="MapMagician app icon" width={36} height={36} loading="lazy" decoding="async" />
              </picture>
              <div className="pd-mobile-hint-text">
                <strong>Want desktop app?</strong>Get MapMagician from the Microsoft Store.
              </div>
              <a className="pd-play-btn pd-ms-btn" href="https://apps.microsoft.com/detail/9PNZDK3DQPL0?hl=en-us&gl=IN&ocid=pdpshare" target="_blank" rel="noopener">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="#0078D4" aria-hidden="true"><path d="M1 1h10v10H1zm12 0h10v10H13zM1 13h10v10H1zm12 0h10v10H13z" /></svg>
                Microsoft Store
              </a>
            </div>
          </div>

          {region.nearby.length > 0 && (
            <div className="side-card">
              <h3>Nearby regions</h3>
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
