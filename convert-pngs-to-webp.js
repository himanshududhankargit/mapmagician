// One-off PNG -> WebP converter for icons + app-screenshot carousels.
//
// Usage (from this folder):
//   npm init -y
//   npm install --save-dev sharp
//   node convert-pngs-to-webp.js
//
// Writes "<name>.webp" next to each listed "<name>.png". Skips re-encoding
// if the .webp is newer than the .png. Use --force to override.

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const FORCE = process.argv.includes('--force');

// All PNGs that appear inside <img> tags on the marketing pages.
// Grouped by quality preset because logos compress differently to photos.
// AssetsGIS/getitonplaystore.png excluded — encodes ~15% larger as WebP.
const ICONS = [
    'AssetsGIS/mapmagiciansmall.png',
    'AssetsGIS/image-1.png',
    'AssetsLocationPlanMaker/icon.png'
];

// Excluded (re-encoding produced LARGER files than the PNG, so we keep PNG only):
//   AssetsGIS/image-8.png, AssetsGIS/image-9.png,
//   AssetOverlayr/image-4.png, AssetOverlayr/image-6.png,
//   AssetsGIS/getitonplaystore.png
const SCREENSHOTS = [
    'AssetsGIS/image-2.png',
    'AssetsGIS/image-3.png',
    'AssetsGIS/image-4.png',
    'AssetsGIS/image-5.png',
    'AssetsGIS/image-6.png',
    'AssetsGIS/image-7.png',
    'AssetsLocationPlanMaker/screenshot-1.png',
    'AssetsLocationPlanMaker/screenshot-2.png',
    'AssetsLocationPlanMaker/screenshot-3.png',
    'AssetsLocationPlanMaker/screenshot-4.png',
    'AssetsLocationPlanMaker/screenshot-5.png',
    'AssetsLocationPlanMaker/screenshot-6.png',
    'AssetsLocationPlanMaker/sample-output.png',
    'AssetOverlayr/image-2.png',
    'AssetOverlayr/image-3.png',
    'AssetOverlayr/image-5.png'
];

async function convert(relPath, quality) {
    const src = path.join(__dirname, relPath);
    const dst = src.replace(/\.png$/i, '.webp');

    if (!fs.existsSync(src)) {
        console.warn(`  skip (missing): ${relPath}`);
        return;
    }

    if (!FORCE && fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) {
        console.log(`  skip (up-to-date): ${relPath}`);
        return;
    }

    await sharp(src).webp({ quality, effort: 6 }).toFile(dst);

    const srcKB = (fs.statSync(src).size / 1024).toFixed(0);
    const dstKB = (fs.statSync(dst).size / 1024).toFixed(0);
    const saved = (100 - (fs.statSync(dst).size * 100 / fs.statSync(src).size)).toFixed(0);
    console.log(`  ${relPath}: png ${srcKB} KB -> webp ${dstKB} KB  (-${saved}%)`);
}

async function main() {
    console.log('Icons (q=85):');
    for (const f of ICONS) await convert(f, 85);
    console.log('Screenshots (q=80):');
    for (const f of SCREENSHOTS) await convert(f, 80);
    console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
