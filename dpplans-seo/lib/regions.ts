import bundle from '@/data/regions.json';
import type { RegionsBundle, Region } from './site';

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
