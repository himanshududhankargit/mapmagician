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
copyIfExists('manifest.json', 'manifest.json');
copyIfExists('sw.js', 'sw.js');
copyIfExists('AssetsGIS', 'AssetsGIS');

// Staging slots: maps1.html, maps2.html, etc. — always test these on dpplans.com before promoting.
fs.readdirSync(MM_ROOT)
  .filter(f => /^maps\d+\.html$/.test(f))
  .forEach(f => copyIfExists(f, f));

// CNAME tells GitHub Pages / Cloudflare Pages which custom domain to bind. Cloudflare
// Pages also reads this and treats it as authoritative.
fs.writeFileSync(path.join(OUT, 'CNAME'), 'dpplans.com\n');
console.log('postbuild-copy: wrote out/CNAME = dpplans.com');

// Cloudflare Pages _redirects: send root traffic straight to the live map (302 keeps
// /home/ as the canonical browser landing page).
fs.writeFileSync(path.join(OUT, '_redirects'), '/  /maps.html  302\n');
console.log('postbuild-copy: wrote out/_redirects (/ -> /maps.html)');
