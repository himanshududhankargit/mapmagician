import type { MetadataRoute } from 'next';
import { allRegions, generatedAt } from '@/lib/regions';
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
  const pages = allRegions().map(r => ({
    url: `${SITE.origin}/${r.slug}/`,
    lastModified,
    changeFrequency: 'weekly' as const,
    priority: 0.8,
  }));
  return [home, ...pages];
}
