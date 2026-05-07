import Link from 'next/link';
import type { Region } from '@/lib/site';

export function RegionCard({ region }: { region: Region }) {
  const villages = region.villages.length;
  const subtitle = villages > 0 ? `${villages} sub-locations` : 'Development Plan';
  return (
    <Link
      href={`/${region.slug}/`}
      className="region-card"
      data-search={`${region.shortName} ${region.displayName} ${region.state}`.toLowerCase()}
    >
      <div className="icon">
        {region.iconUrl ? (
          <img src={region.iconUrl} alt="" loading="lazy" width={36} height={36} />
        ) : (
          <span aria-hidden="true">▦</span>
        )}
      </div>
      <div className="meta">
        <b>{region.shortName}</b>
        <span>{subtitle} · {region.state}</span>
      </div>
    </Link>
  );
}
