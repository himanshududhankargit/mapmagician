import type { MetadataRoute } from 'next';
import { allRegions, allSubLocationPaths, generatedAt } from '@/lib/regions';
import { isCuratedSubLocation } from '@/data/sublocation-content';
import { SITE } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date(generatedAt());
  // / is the splash (states browser). After promotion in postbuild-copy.js,
  // out/index.html serves the fast-loading splash directly — no more /maps
  // redirect. /home/ stays in the sitemap at lower priority as a secondary
  // entry point (Next.js-rendered region browser with richer SEO content).
  const home = {
    url: SITE.origin + '/',
    lastModified,
    changeFrequency: 'weekly' as const,
    priority: 1.0,
  };
  const regionsBrowser = {
    url: SITE.origin + '/home/',
    lastModified,
    changeFrequency: 'weekly' as const,
    priority: 0.9,
  };
  // Hand-authored hub pages (not driven by regions.json) — must be listed explicitly.
  const msrdcHub = {
    url: SITE.origin + '/msrdc-development-plan/',
    lastModified,
    changeFrequency: 'weekly' as const,
    priority: 0.8,
  };
  const pcmcHub = {
    url: SITE.origin + '/pcmc-development-plan/',
    lastModified,
    changeFrequency: 'weekly' as const,
    priority: 0.8,
  };
  const regionPages = allRegions().map(r => ({
    url: `${SITE.origin}/${r.slug}/`,
    lastModified,
    changeFrequency: 'weekly' as const,
    priority: 0.8,
  }));
  // Only curated sub-locations are indexable (see app/[slug]/[loc]/page.tsx robots
  // gating). A noindex URL must not be advertised in the sitemap — mixed signal — so
  // the thin long-tail is excluded here and re-enters automatically once curated.
  const subLocationPages = allSubLocationPaths()
    .filter(({ region, village }) => isCuratedSubLocation(region.slug, village.slug!))
    .map(({ region, village }) => ({
      url: `${SITE.origin}/${region.slug}/${village.slug}/`,
      lastModified,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    }));
  return [home, regionsBrowser, msrdcHub, pcmcHub, ...regionPages, ...subLocationPages];
}
