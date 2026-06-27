/**
 * After `next build` writes dpplans-seo/out/, copy the live map app and its asset
 * dependencies in alongside the static SEO pages. The result is a single `out/` folder
 * that Cloudflare Pages can publish directly to dpplans.com.
 *
 * Files brought in from mapmagician-main:
 *   maps.html, manifest.json, sw.js   — the live app
 *   AssetsGIS/                         — referenced by maps.html (favicon + icons)
 *
 * Also writes out/CNAME so the static host accepts dpplans.com as the custom domain.
 *
 * Cross-platform: uses Node's fs.cpSync (Node 16+) so the same script runs on Windows
 * for local previews and on Cloudflare's Linux build container.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MM_ROOT = path.resolve(ROOT, '..');
const OUT = path.join(ROOT, 'out');

if (!fs.existsSync(OUT)) {
  console.error('postbuild-copy: out/ does not exist — run `next build` first');
  process.exit(1);
}

function copyIfExists(srcRel, destRel) {
  const src = path.join(MM_ROOT, srcRel);
  const dest = path.join(OUT, destRel);
  if (!fs.existsSync(src)) {
    console.warn(`postbuild-copy: skipping ${srcRel} (not found at ${src})`);
    return;
  }
  const parent = path.dirname(dest);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
  console.log(`postbuild-copy: ${srcRel} -> out/${destRel}`);
}

copyIfExists('maps.html', 'maps.html');
copyIfExists('maps-app.js', 'maps-app.js');
copyIfExists('manifest.json', 'manifest.json');
copyIfExists('sw.js', 'sw.js');
copyIfExists('AssetsGIS', 'AssetsGIS');
// Solapur TP-scheme polylines + village/TP labels for the map canvas. maps-app.js:3469
// fetches this with a same-origin relative URL ('data/solapur_overlay.json'); without
// the file on dpplans.com the request 404s silently and the TP-I/II/III/IV polylines
// and ~22 village name labels never appear (works on mapmagician.in only).
copyIfExists('data/solapur_overlay.json', 'data/solapur_overlay.json');

// Splash IS the homepage. The same source file is published at both / (the
// canonical homepage post-promotion) and /index1.html (kept as an alias so
// old links / cache entries / Lighthouse history keep resolving). Canonical
// in the HTML points to / so search engines only index one URL.
copyIfExists('index1.html', 'index.html');
copyIfExists('index1.html', 'index1.html');

// Staging slots: maps1.html, maps2.html, etc. — always test these on dpplans.com before promoting.
// Also pick up their *-app.js companions (maps1-app.js, maps2-app.js, ...).
fs.readdirSync(MM_ROOT)
  .filter(f => /^maps\d+\.html$/.test(f) || /^maps\d+-app\.js$/.test(f))
  .forEach(f => copyIfExists(f, f));

// CNAME tells GitHub Pages / Cloudflare Pages which custom domain to bind. Cloudflare
// Pages also reads this and treats it as authoritative.
fs.writeFileSync(path.join(OUT, 'CNAME'), 'dpplans.com\n');
console.log('postbuild-copy: wrote out/CNAME = dpplans.com');

// Splash promotion: out/index.html IS the homepage now. The previous redirect
// (`/  /maps.html  302`) must not exist or Cloudflare honours it ahead of
// index.html and the splash never renders.
//
// Canonical host: 301 www -> apex. Search Console was showing BOTH
// www.dpplans.com/<page> and dpplans.com/<page> indexed for the same pages,
// which splits ranking signals (clicks/impressions) across two URLs. Per-page
// <link rel="canonical"> already points at the apex, but that is only a hint;
// a 301 is authoritative. Cloudflare Pages reads _redirects, evaluates it
// top-to-bottom (first match wins), and supports a full-URL source with :splat.
// Apex requests never match the www source, so there is no redirect loop.
const redirects =
  'https://www.dpplans.com/* https://dpplans.com/:splat 301\n' +
  '# Splash is the homepage; / serves index.html directly\n';
fs.writeFileSync(path.join(OUT, '_redirects'), redirects);
console.log('postbuild-copy: wrote out/_redirects (www->apex 301; / serves index.html)');

// Slim SEO lookup for index1.html — strips bbox/kml/centroid from regions.json
// (~950 KB) down to a ~10 KB pid/slug/village-slug map. Lets the splash decide
// at click time whether to navigate to /<slug>/ (SEO page) or /maps.html.
try {
  const regionsPath = path.join(ROOT, 'data', 'regions.json');
  const regions = JSON.parse(fs.readFileSync(regionsPath, 'utf8'));
  const slim = {
    generatedAt: regions.generatedAt,
    regions: (regions.regions || []).map(r => ({
      slug: r.slug,
      productPurchaseID: r.productPurchaseID,
      menuKey: r.menuKey,
      displayName: r.displayName,
      villages: (r.villages || [])
        .filter(v => !v.skipPage && v.slug)
        .map(v => ({ name: v.name, slug: v.slug }))
    }))
  };
  const dataDir = path.join(OUT, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'seo-index.json'), JSON.stringify(slim));
  console.log('postbuild-copy: wrote out/data/seo-index.json (' + slim.regions.length + ' regions)');
} catch (err) {
  console.warn('postbuild-copy: skipping seo-index.json —', err.message);
}

// Slim states-only lookup for index1.html FIRST PAINT. Without this the splash
// pulls the full ~167 KB menuGIS.json (~1.2 s on slow links) just to render
// the three state cards above the fold. menu-states.json is ~1 KB and lets
// the panel render the entire first layer instantly; the full menu is only
// fetched when the user actually drills into a state.
//
// We fetch menuGIS once at build time (Cloudflare Pages build env has network)
// and write the slim file. If the fetch fails (offline / RTDB down), the build
// continues without the slim file — index1.html falls back to its original
// full-menu fetch path so the splash still works.
const MENU_URL = 'https://sodium-hour-256110.firebaseio.com/menuGIS.json';
function countVillagesIn(json) {
  if (!json) return 0;
  let c = 0;
  json.split('\n').forEach(l => { if (l.indexOf('=') > -1) c++; });
  return c;
}
fetch(MENU_URL)
  .then(r => r.ok ? r.json() : null)
  .then(menu => {
    if (!menu) throw new Error('menuGIS fetch returned non-OK');
    const byState = {};
    const order = [];
    for (const k in menu) {
      const e = menu[k];
      if (!e || !e.state) continue;
      if (!byState[e.state]) { byState[e.state] = []; order.push(e.state); }
      byState[e.state].push(e);
    }
    const states = order.map(name => {
      const entries = byState[name];
      const districts = entries.filter(e => e.district);
      const out = {
        name,
        icon: (entries[0] && entries[0].iconState) || ''
      };
      if (districts.length > 0) {
        out.districtCount = districts.length;
      } else {
        const v = entries.reduce((c, e) => c + countVillagesIn(e.villagesJSON), 0);
        if (v) out.locationCount = v;
      }
      return out;
    });
    const slim = { generatedAt: new Date().toISOString(), states };
    const dataDir = path.join(OUT, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'menu-states.json'), JSON.stringify(slim));
    console.log('postbuild-copy: wrote out/data/menu-states.json (' + states.length + ' states)');
  })
  .catch(err => console.warn('postbuild-copy: skipping menu-states.json —', err.message));
