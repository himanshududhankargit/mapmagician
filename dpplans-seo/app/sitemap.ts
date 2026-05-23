import type { MetadataRoute } from 'next';
import { allRegions, allSubLocationPaths, generatedAt } from '@/lib/regions';
import { SITE } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date(generatedAt());
  // /home/ is the regions browser. Root `/` is excluded — it's just a redirect to /maps
  // and shouldn't dilute crawl budget.
  const home = {
    url: SITE.origin + '/home/',
    lastModified,
    changeFrequency: 'weekly' as const,
    priority: 1.0,
  };
  const regionPages = allRegions().map(r => ({
    url: `${SITE.origin}/${r.slug}/`,
    lastModified,
    changeFrequency: 'weekly' as const,
    priority: 0.8,
  }));
  const subLocationPages = allSubLocationPaths().map(({ region, village }) => ({
    url: `${SITE.origin}/${region.slug}/${village.slug}/`,
    lastModified,
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }));
  return [home, ...regionPages, ...subLocationPages];
}
