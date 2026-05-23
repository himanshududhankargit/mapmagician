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
  fs.cpSync(src, dest, { recursive: true, force: true });
  console.log(`postbuild-copy: ${srcRel} -> out/${destRel}`);
}

copyIfExists('maps.html', 'maps.html');
copyIfExists('maps-app.js', 'maps-app.js');
copyIfExists('manifest.json', 'manifest.json');
copyIfExists('sw.js', 'sw.js');
copyIfExists('AssetsGIS', 'AssetsGIS');

// Splash staging slot: dpplans.com/index1.html serves the new fast-loading splash
// while the production / -> /maps.html redirect stays untouched. Once approved,
// rename index1.html -> index.html and add copyIfExists('index.html', 'index.html')
// so it overwrites the Next.js redirect stub at the root.
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

// Cloudflare Pages _redirects: send root traffic straight to the live map (302 keeps
// /home/ as the canonical browser landing page).
fs.writeFileSync(path.join(OUT, '_redirects'), '/  /maps.html  302\n');
console.log('postbuild-copy: wrote out/_redirects (/ -> /maps.html)');

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
