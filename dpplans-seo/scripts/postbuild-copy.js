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

// CNAME tells GitHub Pages / Cloudflare Pages which custom domain to bind. Cloudflare
// Pages also reads this and treats it as authoritative.
fs.writeFileSync(path.join(OUT, 'CNAME'), 'dpplans.com\n');
console.log('postbuild-copy: wrote out/CNAME = dpplans.com');

// Google Search Console — HTML-file verification token. Single line, exact contents
// from the file Google generated. Goes at the site root so the property
// `https://dpplans.com/` can be verified by fetching
// https://dpplans.com/google2e32ac843b23180f.html.
const GOOGLE_VERIFY_FILE = 'google2e32ac843b23180f.html';
fs.writeFileSync(
  path.join(OUT, GOOGLE_VERIFY_FILE),
  'google-site-verification: ' + GOOGLE_VERIFY_FILE + '\n'
);
console.log('postbuild-copy: wrote out/' + GOOGLE_VERIFY_FILE);

// Cloudflare Pages _redirects:
//   1. Send root traffic straight to the live map (302 keeps /home/ as canonical browser).
//   2. The first match wins — so the explicit 200-rewrite for the Google verification
//      file MUST come BEFORE any wildcard or before Cloudflare's automatic .html-stripping
//      kicks in. Status 200 in _redirects = rewrite (serve the resource without
//      changing the URL the browser sees), which prevents the default .html→clean-URL
//      308 that would otherwise break Search Console verification.
const redirects = [
  '/' + GOOGLE_VERIFY_FILE + '  /' + GOOGLE_VERIFY_FILE + '  200',
  '/  /maps.html  302',
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, '_redirects'), redirects);
console.log('postbuild-copy: wrote out/_redirects (' + GOOGLE_VERIFY_FILE + ' rewrite + / redirect)');
