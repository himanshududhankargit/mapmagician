import Link from 'next/link';

const ASSET = 'https://www.mapmagician.in';
const APPS = [
  {
    href: `${ASSET}/#development-plan`,
    icon: `${ASSET}/AssetsGIS/image-1.png`,
    label: 'Development Plan GIS',
    active: true,
  },
  {
    href: `${ASSET}/overlayr/`,
    icon: `${ASSET}/AssetOverlayr/image-1.png`,
    label: 'Overlayr - Map Overlay Tool',
  },
  {
    href: `${ASSET}/location-plan-maker/`,
    icon: `${ASSET}/AssetsLocationPlanMaker/icon.png`,
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
          <img src={`${ASSET}/AssetsGIS/mapmagiciansmall.png`} alt="MapMagician" />
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
              <img src={a.icon} alt="" />
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
