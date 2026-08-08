/**
 * Site-wide constants. Centralized so the canonical URL and CTA target only
 * need to change in one place if the brand or hosting changes.
 */
export const SITE = {
  name: 'DPPlans',
  domain: 'dpplans.com',
  origin: 'https://dpplans.com',
  tagline: 'Development Plan maps for India — online viewer',
  description:
    'View Development Plan and Master Plan maps online for 40+ Indian regions including Pune, Mumbai, Hyderabad (HMDA), Bengaluru, Solapur, Nashik, Nagpur and more. Interactive GIS over satellite imagery, free to browse.',
  twitter: '@mapmagicianin',
  // The interactive map app file. Explicit `.html` so local static servers resolve it;
  // Cloudflare Pages serves /maps.html identically with or without the extension.
  fullMap: 'https://dpplans.com/maps.html',
  // 1200×630 social-share banner (mapmagician-main/AssetsGIS/, copied to out/ by
  // postbuild-copy.js). Site-wide OpenGraph/Twitter fallback for pages without their own.
  ogImage: 'https://dpplans.com/AssetsGIS/mapmagicianlogo-banner.png',
};

/**
 * "Download Map" — the print-ready sheet the map app generates (maps-app.js, the
 * `dlmap` module). Centralized because the same facts are repeated on the hub page,
 * every region page and every sub-location page, and a wrong price or format there is
 * a customer-facing lie. Keep in sync with the app:
 *   - sheet geometry: DLMAP_TEMPLATE_W/H = 3557×2515 (A4 landscape at ~300 dpi)
 *   - format:         JPEG. NOT a PDF — say so plainly, the search demand is all
 *                     "pdf download" and a bait-and-switch costs more than the click.
 *
 * 🛑 NEVER print the price on these pages (owner instruction, 2026-08-08). It lives in
 * `appConfig/pricing/download_map` in RTDB, is read server-side by createDownloadOrder,
 * and can be changed from the Android admin panel at any time — a number baked into
 * ~2,600 statically-exported pages would go stale silently and quote customers a price
 * we no longer charge. Say "the price is shown before you confirm" instead; the app
 * shows it on the dialog, next to a preview, before any payment is taken.
 */
export const DOWNLOAD = {
  widthPx: 3557,
  heightPx: 2515,
  format: 'JPEG',
  paperNote: 'A4 landscape at roughly 300 dpi',
  /** Route of the hub page that explains the feature end to end. */
  hubPath: '/download-development-plan-map/',
  get hubUrl() {
    return SITE.origin + this.hubPath;
  },
  /** 1980×1400 crop of a real generated sheet, shipped in AssetsGIS/. */
  sampleImage: '/AssetsGIS/dlmap-sample.jpg',
  sampleWidth: 1980,
  sampleHeight: 1400,
};

export type RegionCentroid = { lat: number; lng: number; minZoom: number | null; maxZoom: number | null };

export type RegionFocal = { lat: number; lng: number; source: string; zoom: number };

export type RegionVillage = {
  name: string;
  lat: number;
  lng: number;
  // Added by build-regions.js for the nested /<region>/<loc>/ pages.
  // `skipPage=true` means we do NOT generate a sub-location page (e.g. when
  // village name matches the parent district's shortName — would just duplicate it).
  // `displayName` is the user-facing form (parens / tehsil / "/A" suffixes stripped).
  slug?: string;
  skipPage?: boolean;
  displayName?: string;
  distanceFromHqKm?: number;
  bearingFromHq?: string;
};

export type NearbyRegion = { slug: string; displayName: string; shortName: string; distanceKm: number };

export type RegionFaq = { q: string; a: string };

export type Region = {
  slug: string;
  productPurchaseID: string;
  menuKey: string;
  displayName: string;
  rawDistrictName: string;
  shortName: string;
  state: string;
  iconUrl: string | null;
  stateIconUrl: string | null;
  centroid: RegionCentroid | null;
  bbox: [number, number, number, number] | null;
  villages: RegionVillage[];
  sourceLink: string;
  price: string;
  focal: RegionFocal | null;
  fullMapUrl: string;
  embedUrl: string;
  nearby: NearbyRegion[];
  faqs: RegionFaq[];
  features: string[];
};

export type RegionsBundle = {
  generatedAt: string;
  count: number;
  regions: Region[];
};
