// Compress the index1.html / splash hero images.
//
// Sources (absolute paths so the user doesn't have to move files):
//   C:\Desktop\Screenshot 2026-05-23 215913.jpg   ->  desktop hero (landscape, Navi Mumbai)
//   D:\Dropbox\1779554478510_temp.jpg              ->  mobile hero  (portrait, Thane/Mumbra)
//
// Usage (one-off):
//   cd mapmagician-main
//   npm init -y && npm install --no-save sharp
//   node compress-splash-hero.js
//   (optional) rm -r node_modules package*.json
//
// Outputs (overwrite if present):
//   AssetsGIS/splash-hero-desktop-{1920,1280,768}.{webp,jpg}
//   AssetsGIS/splash-hero-mobile-{1080,750,390}.{webp,jpg}

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const OUT_DIR = path.join(__dirname, 'AssetsGIS');

const JOBS = [
    {
        src: 'C:\\Desktop\\Screenshot 2026-05-23 215913.jpg',
        prefix: 'splash-hero-desktop',
        variants: [
            { width: 1920, webpQ: 78, jpgQ: 80 },
            { width: 1280, webpQ: 76, jpgQ: 78 },
            { width: 768,  webpQ: 72, jpgQ: 76 }
        ]
    },
    {
        src: 'D:\\Dropbox\\1779554478510_temp.jpg',
        prefix: 'splash-hero-mobile',
        variants: [
            { width: 1080, webpQ: 72, jpgQ: 76 },
            { width: 750,  webpQ: 70, jpgQ: 74 },
            { width: 390,  webpQ: 66, jpgQ: 72 }
        ]
    }
];

async function run() {
    for (const job of JOBS) {
        if (!fs.existsSync(job.src)) {
            console.error('Source not found:', job.src);
            process.exit(1);
        }
        const meta = await sharp(job.src).metadata();
        const srcKB = (fs.statSync(job.src).size / 1024).toFixed(0);
        console.log(`\n${job.prefix}: source ${meta.width}x${meta.height} ${meta.format} (${srcKB} KB)`);

        for (const v of job.variants) {
            // resize by width only -> height auto, preserves aspect ratio (no cropping)
            const base = sharp(job.src).resize({ width: v.width, withoutEnlargement: true });

            const webpPath = path.join(OUT_DIR, `${job.prefix}-${v.width}.webp`);
            await base.clone().webp({ quality: v.webpQ, effort: 6 }).toFile(webpPath);

            const jpgPath = path.join(OUT_DIR, `${job.prefix}-${v.width}.jpg`);
            await base.clone().jpeg({ quality: v.jpgQ, mozjpeg: true, progressive: true }).toFile(jpgPath);

            const webpKB = (fs.statSync(webpPath).size / 1024).toFixed(0);
            const jpgKB  = (fs.statSync(jpgPath).size / 1024).toFixed(0);
            console.log(`  ${v.width}px: webp ${webpKB} KB, jpg ${jpgKB} KB`);
        }
    }
    console.log('\nDone.');
}

run().catch(err => { console.error(err); process.exit(1); });
