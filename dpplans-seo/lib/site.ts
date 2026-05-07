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
    'View Development Plan, Layout, and Village maps online for 39+ Indian regions including Pune, Mumbai, Hyderabad, Bengaluru, Solapur, Nashik, Nagpur and more. Interactive GIS over satellite imagery, free to browse.',
  twitter: '@mapmagicianin',
  // The interactive map app file. Explicit `.html` so local static servers resolve it;
  // Cloudflare Pages serves /maps.html identically with or without the extension.
  fullMap: 'https://dpplans.com/maps.html',
};

export type RegionCentroid = { lat: number; lng: number; minZoom: number | null; maxZoom: number | null };

export type RegionFocal = { lat: number; lng: number; source: string; zoom: number };

export type RegionVillage = { name: string; lat: number; lng: number };

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
