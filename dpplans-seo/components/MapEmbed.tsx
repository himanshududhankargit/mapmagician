/**
 * Map showcase block — same pattern as mapmagician-main/index.html .map-banner:
 *   - dark container behind a static responsive hero JPG (no iframe)
 *   - bottom-gradient overlay carrying the LIVE badge, caption, and "Open Interactive Map" CTA
 *   - tapping anywhere on the overlay opens the full map in a new tab
 *
 * Replaced the previous iframe-of-maps.html approach because the iframe was
 * cold-loading the entire app shell (including Firebase SDK, Google Maps API,
 * tile workers) before the user could interact, costing 3-5s on slow connections.
 * Static JPG with srcset loads in <500ms and the click target still launches the
 * full app in its normal context.
 */
type Props = {
  fullMapUrl: string;
  title: string;
  caption: string;
};

export function MapEmbed({ fullMapUrl, title, caption }: Props) {
  return (
    <section className="map-showcase" aria-label={`${title} live map preview`}>
      <a
        className="overlay banner-link"
        href={fullMapUrl}
        target="_blank"
        rel="noopener"
        aria-label={`Open the full ${title} interactive map`}
      >
        <picture>
          <source
            type="image/webp"
            srcSet="/AssetsGIS/hero-banner-768.webp 768w, /AssetsGIS/hero-banner-1280.webp 1280w, /AssetsGIS/hero-banner-1920.webp 1920w"
            sizes="100vw"
          />
          <img
            src="/AssetsGIS/hero-banner-1280.jpg"
            srcSet="/AssetsGIS/hero-banner-768.jpg 768w, /AssetsGIS/hero-banner-1280.jpg 1280w, /AssetsGIS/hero-banner-1920.jpg 1920w"
            sizes="100vw"
            width={1920}
            height={640}
            alt={`${title} Development Plan — interactive DP overlay on Google Maps`}
            fetchPriority="high"
            decoding="async"
            className="banner-img"
          />
        </picture>
        <div className="banner-overlay-content">
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
        </div>
      </a>
    </section>
  );
}
