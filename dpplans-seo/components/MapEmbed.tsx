import { MapFadeFrame } from './MapFadeFrame';

/**
 * Map showcase block — same pattern as mapmagician-main/index.html .map-banner:
 *   - dark container behind a static responsive hero image (no iframe)
 *   - bottom-gradient overlay carrying the LIVE badge, caption, and "Open Interactive Map" CTA
 *   - the whole banner is one link, so a tap anywhere opens the full map in a new tab
 *
 * Replaced the previous iframe-of-maps.html approach because the iframe was
 * cold-loading the entire app shell (including Firebase SDK, Google Maps API,
 * tile workers) before the user could interact, costing 3-5s on slow connections.
 * Static image with srcset loads in <500ms and the click target still launches the
 * full app in its normal context.
 *
 * Animated plan fade (2026-10-09): the hero is two pixel-aligned captures of the
 * live map over Thane — the same reference picture on every page — "plan" (overlay
 * at 70%, the static LCP image) and "base" (overlay at 0%, MapFadeFrame, loaded only
 * after window load). Fading base in and out over plan IS the plan at every opacity
 * 70% -> 0% -> 70%, and the chip beside LIVE mocks the map's opacity slider in step.
 * Images are built by mapmagician-main/compress-hero-motion.js.
 *
 * Phones (<=720px) get a square centre crop: a ~400px-wide cover-cropped banner only
 * shows the middle third of the 3:1 strip, so the crop is lighter (75 KB vs 128 KB)
 * and sharper.
 */
type Props = {
  fullMapUrl: string;
  title: string;
  caption: string;
};

const MOBILE = '(max-width: 720px)';
const PLAN_SQ = '/AssetsGIS/hero-banner-plan-sq480.webp 480w, /AssetsGIS/hero-banner-plan-sq640.webp 640w, /AssetsGIS/hero-banner-plan-sq800.webp 800w';
const PLAN_WIDE = '/AssetsGIS/hero-banner-plan-768.webp 768w, /AssetsGIS/hero-banner-plan-1280.webp 1280w, /AssetsGIS/hero-banner-plan-1920.webp 1920w';

export function MapEmbed({ fullMapUrl, title, caption }: Props) {
  // No <link rel="preload"> for the hero, on purpose (measured 2026-10-09):
  // ReactDOM.preload() silently DROPS `media` for images, so both art-direction
  // branches would download on every device; and a <link> written as JSX keeps
  // `media` but is NOT hoisted to <head> — it lands in <body> beside this <picture>,
  // gaining nothing. The <picture> sits ~11 KB into the HTML, inside the first
  // network round trip, so the preload scanner finds it as early as a preload would.
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
          <source type="image/webp" media={MOBILE} srcSet={PLAN_SQ} sizes="100vw" />
          <source type="image/webp" srcSet={PLAN_WIDE} sizes="100vw" />
          <img
            src="/AssetsGIS/hero-banner-plan-1280.jpg"
            width={1920}
            height={640}
            alt={`${title} Development Plan — interactive DP overlay on Google Maps`}
            fetchPriority="high"
            decoding="async"
            className="banner-img"
          />
        </picture>
        <MapFadeFrame />
        <div className="banner-overlay-content">
          <span className="badge-row">
            <span className="live-badge">
              <span className="pulse-dot" />
              LIVE
            </span>
            <span className="opacity-chip" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
              <span>Plan opacity</span>
              <span className="opacity-track"><span className="opacity-fill" /><span className="opacity-thumb" /></span>
              <span className="opacity-pct" />
            </span>
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
