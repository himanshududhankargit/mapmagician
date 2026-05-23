import bundle from '@/data/regions.json';
import type { RegionsBundle, Region, RegionVillage } from './site';

const data = bundle as RegionsBundle;

export function allRegions(): Region[] {
  return data.regions;
}

export function regionBySlug(slug: string): Region | undefined {
  return data.regions.find(r => r.slug === slug);
}

export function regionsByState(): Array<{ state: string; regions: Region[] }> {
  const map = new Map<string, Region[]>();
  for (const r of data.regions) {
    const arr = map.get(r.state) ?? [];
    arr.push(r);
    map.set(r.state, arr);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([state, regions]) => ({ state, regions }));
}

export function generatedAt(): string {
  return data.generatedAt;
}

// Sub-location helpers -- power the nested /<region>/<loc>/ static pages.

export type SubLocationPath = { region: Region; village: RegionVillage };

export function allSubLocationPaths(): SubLocationPath[] {
  const out: SubLocationPath[] = [];
  for (const r of data.regions) {
    for (const v of r.villages) {
      if (v.skipPage || !v.slug) continue;
      out.push({ region: r, village: v });
    }
  }
  return out;
}

export function subLocationByPath(regionSlug: string, locSlug: string): SubLocationPath | undefined {
  const region = regionBySlug(regionSlug);
  if (!region) return undefined;
  const village = region.villages.find(v => !v.skipPage && v.slug === locSlug);
  if (!village) return undefined;
  return { region, village };
}

// 6 closest sister sub-locations within the same region, by haversine. Cleaner UX
// signal for users + builds the internal-link graph crawlers need to discover and
// weight thousands of new URLs.
export function nearestSisters(region: Region, here: RegionVillage, limit = 6): RegionVillage[] {
  const R = 6371;
  const toRad = (x: number) => x * Math.PI / 180;
  const d = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  return region.villages
    .filter(v => !v.skipPage && v.slug && v.slug !== here.slug)
    .map(v => ({ v, km: d(here, v) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, limit)
    .map(x => x.v);
}
