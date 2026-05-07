'use client';

/**
 * Map showcase block — same pattern as mapmagician-main/index.html .map-showcase:
 *   - dark container behind a fully-loaded iframe of maps.html?…&embed=1
 *   - bottom-gradient overlay carrying the LIVE badge, caption, and "Open Interactive Map" CTA
 *   - tapping anywhere on the overlay opens the full map in a new tab so the disclaimer
 *     and sign-in flow run in their normal context
 *
 * `embed=1` is honored by maps.html (lines 829-839 hide chrome, line 1764 skips the
 * disclaimer, line 2185 skips auth). So the iframe shows a clean preview while the
 * click target loads the full app.
 */
type Props = {
  embedUrl: string;
  fullMapUrl: string;
  title: string;
  caption: string;
};

export function MapEmbed({ embedUrl, fullMapUrl, title, caption }: Props) {
  return (
    <section className="map-showcase" aria-label={`${title} live map preview`}>
      <div className="skeleton" aria-hidden="true">
        <div className="loader" />
        <div style={{ fontSize: 14 }}>Loading {title} map preview…</div>
      </div>
      <iframe
        src={embedUrl}
        title={`${title} Development Plan — live preview`}
        loading="eager"
        referrerPolicy="no-referrer-when-downgrade"
        allow="accelerometer; autoplay; encrypted-media; gyroscope"
      />
      <a
        className="overlay"
        href={fullMapUrl}
        target="_blank"
        rel="noopener"
        aria-label={`Open the full ${title} interactive map`}
      >
        <span className="live-badge">
          <span className="pulse-dot" />
          LIVE
        </span>
        <span className="caption">{caption}</span>
        <span className="open-cta">
          Open Interactive Map
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </span>
      </a>
    </section>
  );
}
