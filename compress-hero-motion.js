// Image builder for the ANIMATED map hero (homepage index2.html staging + every
// dpplans.com region page, 2026-10-09). The same Thane frames are used everywhere —
// the banner is a reference picture, not the region's own map.
//
// The banner cross-fades two pixel-aligned screenshots of the live map so the
// plan overlay appears to fade 70% -> 0% -> 70%, like dragging the opacity
// slider. Cross-fading is exact for this: both frames are the same camera and
// the overlay is alpha-blended, so a blend of "plan at 70%" and "plan at 0%"
// IS the plan at every opacity in between. The frames MUST be captured from
// the same camera in one session or the fade will visibly smear.
//
// Usage:
//   1. Drop the two captures at:
//        AssetsGIS/_source/hero-banner-plan-source.jpg   (overlay at 70%)
//        AssetsGIS/_source/hero-banner-base-source.jpg   (overlay at 0%)
//   2. npm install --no-save sharp   (or run with NODE_PATH pointing at one)
//   3. node compress-hero-motion.js
//
// Outputs (overwrites if present), for f = plan (LCP, static) and base (loaded after onload):
//   AssetsGIS/hero-banner-<f>-{768,1280,1920}.webp   3:1, screens wider than 720px
//   AssetsGIS/hero-banner-<f>-sq{480,640,800}.webp   square centre crop, phones (<=720px)
//   AssetsGIS/hero-banner-<f>-1280.jpg               fallback for browsers without WebP
// A phone banner is ~400x420 CSS px of a cover-cropped 3:1 image, so it only ever
// shows the middle third — the square crop is both lighter (800sq 75 KB vs 1280w
// 128 KB) and sharper than shipping the whole strip. Both keep the "hero-banner-"
// prefix so sw.js serves them cache-first.

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const SRC_DIR = path.join(__dirname, 'AssetsGIS', '_source');
const OUT_DIR = path.join(__dirname, 'AssetsGIS');
const FRAMES = ['plan', 'base'];

// 3:1 strips keep the same width/height ratio as the <img> attrs (1920x640).
const WIDE = [
    { width: 1920, height: 640, q: 70 },
    { width: 1280, height: 427, q: 70 },
    { width: 768,  height: 256, q: 70 }
];
const SQUARE = [800, 640, 480];
const SQUARE_Q = 62;
const JPG_FALLBACK = { width: 1280, height: 427, q: 78 };

const kb = p => (fs.statSync(p).size / 1024).toFixed(0) + ' KB';

async function build() {
    const dims = [];
    for (const f of FRAMES) {
        const src = path.join(SRC_DIR, `hero-banner-${f}-source.jpg`);
        if (!fs.existsSync(src)) {
            console.error('Source not found:', src);
            process.exit(1);
        }
        const meta = await sharp(src).metadata();
        dims.push(meta);
        console.log(`${f}: ${meta.width}x${meta.height} (${kb(src)})`);
    }
    if (dims[0].width !== dims[1].width || dims[0].height !== dims[1].height) {
        console.error('Frames differ in size — they are not from the same capture.');
        process.exit(1);
    }

    const { width: W, height: H } = dims[0];
    const square = { left: Math.round((W - H) / 2), top: 0, width: H, height: H };

    for (const f of FRAMES) {
        const src = path.join(SRC_DIR, `hero-banner-${f}-source.jpg`);
        for (const v of WIDE) {
            const out = path.join(OUT_DIR, `hero-banner-${f}-${v.width}.webp`);
            await sharp(src).resize({ width: v.width, height: v.height, fit: 'cover', position: 'centre' })
                .webp({ quality: v.q, effort: 6 }).toFile(out);
            console.log(`  ${path.basename(out)}  ${kb(out)}`);
        }
        for (const w of SQUARE) {
            const out = path.join(OUT_DIR, `hero-banner-${f}-sq${w}.webp`);
            await sharp(src).extract(square).resize(w, w).webp({ quality: SQUARE_Q, effort: 6 }).toFile(out);
            console.log(`  ${path.basename(out)}  ${kb(out)}`);
        }
        const jpg = path.join(OUT_DIR, `hero-banner-${f}-${JPG_FALLBACK.width}.jpg`);
        await sharp(src).resize({ width: JPG_FALLBACK.width, height: JPG_FALLBACK.height, fit: 'cover', position: 'centre' })
            .jpeg({ quality: JPG_FALLBACK.q, mozjpeg: true, progressive: true }).toFile(jpg);
        console.log(`  ${path.basename(jpg)}  ${kb(jpg)}`);
    }
    console.log('Done.');
}

build().catch(err => { console.error(err); process.exit(1); });
