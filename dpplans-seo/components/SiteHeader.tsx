import Link from 'next/link';

const ASSET = 'https://www.mapmagician.in';
// Icons are tiny same-origin WebPs (AssetsGIS/nav-icons/, 2-3 KB each, copied in by
// postbuild-copy's AssetsGIS/ copy). They used to be the 512px PNGs off
// www.mapmagician.in — 402 KB that React preloads in <head> on EVERY page, ahead of
// the hero (LCP) image, for icons drawn at 28-40px. Re-export from the PNGs if those
// ever change.
const APPS = [
  {
    href: `${ASSET}/#development-plan`,
    icon: '/AssetsGIS/nav-icons/gis-64.webp',
    label: 'Development Plan GIS',
    active: true,
  },
  {
    href: `${ASSET}/overlayr/`,
    icon: '/AssetsGIS/nav-icons/overlayr-64.webp',
    label: 'Overlayr - Map Overlay Tool',
  },
  {
    href: `${ASSET}/location-plan-maker/`,
    icon: '/AssetsGIS/nav-icons/lpm-64.webp',
    label: 'Location Plan Maker Pro',
  },
];

export function SiteHeader() {
  return (
    <nav className="mm-nav">
      <div className="nav-container">
        {/* Brand goes to /home/ — the regions browser. Root `/` redirects to /maps so direct
            visitors land on the live app; /home/ is the navigation hub. */}
        <Link href="/home/" className="logo" aria-label="DPPlans home — browse regions">
          <img src="/AssetsGIS/nav-icons/logo-96.webp" alt="MapMagician" width={40} height={40} />
          <span>MapMagician</span>
        </Link>

        <div className="app-switcher" aria-label="MapMagician apps">
          {APPS.map(a => (
            <a
              key={a.label}
              href={a.href}
              className={`app-switch-btn${a.active ? ' active' : ''}`}
              target={a.active ? undefined : '_blank'}
              rel={a.active ? undefined : 'noopener'}
            >
              <img src={a.icon} alt="" width={28} height={28} />
              <span>{a.label}</span>
            </a>
          ))}
        </div>

        <div className="nav-links">
          <a href={`${ASSET}/#gis-info`} target="_blank" rel="noopener">About GIS</a>
        </div>
      </div>
    </nav>
  );
}
