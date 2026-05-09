// One-off image compressor for the index.html hero banner.
//
// Usage:
//   1. Drop the source screenshot at: AssetsGIS/_source/hero-banner-source.jpg
//   2. From this folder run:
//        npm init -y          (only the first time, if no package.json exists)
//        npm install --save-dev sharp
//        node compress-hero-banner.js
//   3. Optionally remove node_modules + package*.json afterwards — the script
//      stays in the repo for future re-runs.
//
// Outputs (overwrites if present):
//   AssetsGIS/hero-banner-{1920,1280,768}.webp
//   AssetsGIS/hero-banner-{1920,1280,768}.jpg

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const SRC = path.join(__dirname, 'AssetsGIS', '_source', 'hero-banner-source.jpg');
const OUT_DIR = path.join(__dirname, 'AssetsGIS');

// Locked to exact 3:1 ratio so the <img> width/height attrs match
// every variant precisely (no Lighthouse "incorrect aspect ratio" warning).
const VARIANTS = [
    { width: 1920, height: 640, webpQ: 78, jpgQ: 80 },
    { width: 1280, height: 427, webpQ: 78, jpgQ: 80 },
    { width: 768,  height: 256, webpQ: 75, jpgQ: 78 }
];

async function build() {
    if (!fs.existsSync(SRC)) {
        console.error('Source not found:', SRC);
        console.error('Save the screenshot at that path and re-run.');
        process.exit(1);
    }

    const meta = await sharp(SRC).metadata();
    console.log(`Source: ${meta.width}x${meta.height} ${meta.format} (${(fs.statSync(SRC).size / 1024).toFixed(0)} KB)`);

    for (const v of VARIANTS) {
        const base = sharp(SRC).resize({
            width: v.width,
            height: v.height,
            fit: 'cover',
            position: 'centre'
        });

        const webpPath = path.join(OUT_DIR, `hero-banner-${v.width}.webp`);
        await base.clone().webp({ quality: v.webpQ, effort: 6 }).toFile(webpPath);

        const jpgPath = path.join(OUT_DIR, `hero-banner-${v.width}.jpg`);
        await base.clone().jpeg({ quality: v.jpgQ, mozjpeg: true, progressive: true }).toFile(jpgPath);

        const webpKB = (fs.statSync(webpPath).size / 1024).toFixed(0);
        const jpgKB  = (fs.statSync(jpgPath).size / 1024).toFixed(0);
        console.log(`  ${v.width}px: webp ${webpKB} KB, jpg ${jpgKB} KB`);
    }

    console.log('Done.');
}

build().catch(err => { console.error(err); process.exit(1); });
