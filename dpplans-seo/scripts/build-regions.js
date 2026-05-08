/**
 * Build dpplans-seo/data/regions.json from:
 *   - Firebase RTDB `menuGIS` (fetched live at build time — public read; no auth needed)
 *   - ../data/database/d1.bin (Maharashtra DP tile metadata, JSON — sibling in mapmagician-main)
 *   - ../data/database/d3.bin (legacy DP tile metadata, JSON)
 *
 * Output: data/regions.json — the single source of truth for static-site generation.
 * Run with `npm run build:regions`. Build fails loudly if RTDB is unreachable —
 * Cloudflare Pages keeps the previous successful deploy live, so dpplans.com stays up.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// dpplans-seo lives inside mapmagician-main, so d1/d3 are one level up.
const MM_ROOT = path.resolve(ROOT, '..');
const MENU_GIS_URL = 'https://sodium-hour-256110.firebaseio.com/menuGIS.json';
const D1_PATH = path.join(MM_ROOT, 'data', 'database', 'd1.bin');
const D3_PATH = path.join(MM_ROOT, 'data', 'database', 'd3.bin');
const OUT_PATH = path.join(ROOT, 'data', 'regions.json');

const ICON_BASE = 'https://tiles.mapmagician.in/dpplans/0imagesGIS/';
// Brand-consistent canonical: keep users on dpplans.com. We use the explicit `.html`
// suffix so local static servers (python -m http.server) resolve the file correctly.
// Cloudflare Pages serves /maps.html identically whether requested with or without the
// extension, so production behavior is unchanged.
const MAPS_CANONICAL = 'https://dpplans.com/maps.html';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function fetchMenuGIS() {
  const r = await fetch(MENU_GIS_URL);
  if (!r.ok) throw new Error(`menuGIS fetch failed: ${r.status} ${r.statusText}`);
  const data = await r.json();
  if (!data || typeof data !== 'object') throw new Error('menuGIS fetch returned non-object');
  return data;
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Strip parentheticals and dates from menu names.
// "Pune (Updated 16/10/2025)" -> "Pune"
// "Ahmednagar / Ahilyanagar (Part) (new maps)" -> "Ahmednagar / Ahilyanagar"
// "Solapur (Update 31-01-2026)" -> "Solapur"
function cleanDisplayName(raw) {
  return String(raw || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pick a single short city name suitable for slug + H1 short form.
// "Ahmednagar / Ahilyanagar" -> "Ahmednagar"
// "Pune–Mumbai – MSRDC Corridor" -> "Pune-Mumbai MSRDC"
function shortCityName(cleaned) {
  let s = cleaned.split(/[/]/)[0].trim();
  s = s.replace(/–|—/g, '-');
  return s;
}

// Slug pattern: <short>-dp-plan unless name already mentions "MSRDC", "NAINA",
// "PMRDA" (corridors / regional plans get -plan or -region suffix).
function buildSlug(cleaned) {
  const lower = cleaned.toLowerCase();
  const base = slugify(shortCityName(cleaned));
  if (!base) return '';
  if (lower.includes('msrdc') || lower.includes('corridor')) {
    const trimmed = base.replace(/-?(msrdc|corridor)/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return `${trimmed || base}-msrdc-corridor`;
  }
  if (lower.includes('naina')) return 'naina-development-plan';
  if (lower.includes('pmrda')) return 'pmrda-development-plan';
  if (lower.includes('regional plan')) return `${base}-regional-plan`;
  return `${base}-dp-plan`;
}

// Parse "Name = lat, lng" lines from villagesJSON.
function parseVillages(blob) {
  if (!blob) return [];
  const out = [];
  for (const raw of String(blob).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes('=')) continue;
    const [namePart, coordPart] = line.split('=');
    if (!coordPart) continue;
    const m = coordPart.trim().match(/(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/);
    if (!m) continue;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[3]);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    out.push({ name: namePart.trim(), lat, lng });
  }
  return out;
}

// KML in d1/d3 entries is a single string of "lng,lat,alt lng,lat,alt ..." pairs.
// Compute centroid (mean lat/lng) and bbox from all polygons sharing a productPurchaseID.
function aggregateKml(rawTiles) {
  const byPid = new Map(); // pid -> { sumLat, sumLng, count, west, east, south, north, minZ, maxZ }
  for (const key of Object.keys(rawTiles)) {
    const t = rawTiles[key];
    const pid = (t.productPurchaseID || '').toLowerCase();
    if (!pid) continue;
    if (!t.kml) continue;
    let bucket = byPid.get(pid);
    if (!bucket) {
      bucket = { sumLat: 0, sumLng: 0, count: 0, west: 180, east: -180, south: 90, north: -90, minZ: 99, maxZ: 0 };
      byPid.set(pid, bucket);
    }
    const minZ = parseInt(t.MinZoom, 10);
    const maxZ = parseInt(t.MaxZoom, 10);
    if (isFinite(minZ)) bucket.minZ = Math.min(bucket.minZ, minZ);
    if (isFinite(maxZ)) bucket.maxZ = Math.max(bucket.maxZ, maxZ);
    for (const triplet of t.kml.split(/\s+/)) {
      const parts = triplet.split(',');
      if (parts.length < 2) continue;
      const lng = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      bucket.sumLat += lat;
      bucket.sumLng += lng;
      bucket.count++;
      if (lng < bucket.west) bucket.west = lng;
      if (lng > bucket.east) bucket.east = lng;
      if (lat < bucket.south) bucket.south = lat;
      if (lat > bucket.north) bucket.north = lat;
    }
  }
  const result = {};
  for (const [pid, b] of byPid) {
    if (!b.count) continue;
    result[pid] = {
      lat: +(b.sumLat / b.count).toFixed(6),
      lng: +(b.sumLng / b.count).toFixed(6),
      bbox: [b.west, b.south, b.east, b.north].map(v => +v.toFixed(6)),
      // Initial sentinel values (99 / 0) mean the source rows had blank zoom fields.
      minZoom: b.minZ < 99 ? b.minZ : null,
      maxZoom: b.maxZ > 0 ? b.maxZ : null,
    };
  }
  return result;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function pickZoom(maxZoom) {
  if (!maxZoom) return 12;
  if (maxZoom >= 18) return 13;
  if (maxZoom >= 16) return 12;
  return 11;
}

// Always open the map at the FIRST sub-location at zoom 13 — that's almost always the
// region's city core (e.g. "Ahmednagar City (part)" for Ahmednagar, "Pune" for Pune).
// maps.html line 3257 sets MAX_FREE_ZOOM=14 and the paywall fires at `z >= MAX_FREE_ZOOM`,
// so zoom 13 stays strictly below the threshold — a click never triggers the paywall.
// Fall back to the polygon centroid only when the region has no sub-locations indexed.
function pickFocalPoint(shortName, villages, centroid) {
  if (villages && villages.length > 0) {
    const v = villages[0];
    return { lat: v.lat, lng: v.lng, source: 'village:' + v.name, zoom: 13 };
  }
  if (centroid) {
    return { lat: centroid.lat, lng: centroid.lng, source: 'centroid', zoom: 13 };
  }
  return null;
}

function buildFullMapUrl(focal) {
  if (!focal) return MAPS_CANONICAL;
  return `${MAPS_CANONICAL}?lat=${focal.lat}&lng=${focal.lng}&zoom=${focal.zoom}`;
}

// `embed=1` strips chrome (search, toolbar, FABs, disclaimer, sign-in) — see maps.html
// lines 829-839 (`body.embed-mode` rules) and 1764-1765 (disclaimer skip).
function buildEmbedUrl(focal) {
  if (!focal) return `${MAPS_CANONICAL}?embed=1`;
  return `${MAPS_CANONICAL}?lat=${focal.lat}&lng=${focal.lng}&zoom=${focal.zoom}&embed=1`;
}

function buildFaqs(region) {
  const city = region.shortName;
  const stateName = region.state;
  const isDraft = /draft/i.test(region.rawDistrictName);
  const villagesCount = region.villages.length;
  const items = [
    {
      q: `Where can I view the ${city} Development Plan online?`,
      a: `You can view the ${region.displayName} DP map on Map Magician’s interactive viewer. The plan is overlaid on satellite imagery so you can identify zones, reservations and road lines for any plot in ${city}${stateName ? `, ${stateName}` : ''}.`,
    },
    {
      q: `Is the ${city} DP map official?`,
      a: region.sourceLink
        ? `The published Development Plan referenced here mirrors the source documents from ${stateName ? stateName + ' ' : ''}Town Planning. The official PDFs are linked from the source: ${region.sourceLink}`
        : `The Development Plan referenced here mirrors the latest publication from the local planning authority for ${city}.`,
    },
    {
      q: `Can I see specific villages or sectors inside ${city}?`,
      a: villagesCount > 0
        ? `Yes — ${villagesCount} sub-locations are indexed inside ${city}, including ${region.villages.slice(0, 4).map(v => v.name).join(', ')} and more. Each can be opened directly from the search bar on the map.`
        : `Yes — zoom into the ${city} region on the map to inspect any locality, sector or survey number covered by the Development Plan.`,
    },
    {
      q: `Is access free?`,
      a: `Browsing the ${city} region is free up to zoom level 14. High-detail (zoom 15–${region.centroid && region.centroid.maxZoom ? region.centroid.maxZoom : 18}) imagery is unlocked with a 7-day access pass. ${isDraft ? 'Note: this plan is currently a draft publication.' : ''}`.trim(),
    },
    {
      q: `What devices does the ${city} DP viewer work on?`,
      a: `The viewer runs in any modern browser — desktop, tablet, or mobile. There is also a native Android app for offline access.`,
    },
  ];
  return items;
}

function buildFeatures(region) {
  const city = region.shortName;
  return [
    `Interactive zoom and pan over the entire ${city} Development Plan area`,
    `Satellite + DP overlay so plot boundaries align with on-ground features`,
    `Search by survey number, village or landmark inside ${city}`,
    `Measure distances and areas directly on the ${city} map`,
    `Mobile-friendly — view ${city} DP zones on the go`,
    region.villages.length > 0
      ? `${region.villages.length} indexed sub-locations inside ${city}`
      : `Latest published ${city} DP boundaries`,
  ];
}

async function main() {
  const menu = await fetchMenuGIS();
  console.log(`fetched menuGIS from RTDB: ${Object.keys(menu).length} entries`);
  const d1 = readJson(D1_PATH);
  const d3 = readJson(D3_PATH);
  const centroids = { ...aggregateKml(d1), ...aggregateKml(d3) };

  const regions = [];
  for (const key of Object.keys(menu)) {
    const row = menu[key];
    if (!row || !row.productPurchaseID) continue;

    const cleaned = cleanDisplayName(row.district || row.state);
    if (!cleaned) continue;
    const shortName = shortCityName(cleaned);
    const slug = buildSlug(cleaned);
    if (!slug) continue;

    const pid = String(row.productPurchaseID).toLowerCase();
    const centroid = centroids[pid] || centroids[pid.replace(/gst$/, '')] || null;

    regions.push({
      slug,
      productPurchaseID: row.productPurchaseID,
      menuKey: key,
      displayName: cleaned,
      rawDistrictName: row.district || '',
      shortName,
      state: row.state || '',
      iconUrl: row.iconVillage ? `${ICON_BASE}${row.iconVillage}.png` : (row.iconState ? `${ICON_BASE}${row.iconState}.png` : null),
      stateIconUrl: row.iconState ? `${ICON_BASE}${row.iconState}.png` : null,
      centroid: centroid ? { lat: centroid.lat, lng: centroid.lng, minZoom: centroid.minZoom, maxZoom: centroid.maxZoom } : null,
      bbox: centroid ? centroid.bbox : null,
      villages: parseVillages(row.villagesJSON),
      sourceLink: row.links || '',
      price: row.price || '',
      // focal: the actual point we open the map at — prefer the village named after the
      // region (e.g. "Ahmednagar City (part)" for Ahmednagar) over the polygon centroid.
      focal: null,
      fullMapUrl: '',
      embedUrl: '',
    });
  }

  // Compute nearby regions (up to 5) within the same state.
  for (const r of regions) {
    if (!r.centroid) { r.nearby = []; continue; }
    const ranked = regions
      .filter(x => x.slug !== r.slug && x.state === r.state && x.centroid)
      .map(x => ({ slug: x.slug, displayName: x.displayName, shortName: x.shortName, distanceKm: +haversineKm(r.centroid, x.centroid).toFixed(1) }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 5);
    r.nearby = ranked;
  }

  // Resolve the focal point per region (village named after region > polygon centroid)
  // and rebuild the embed/full URLs from it.
  for (const r of regions) {
    r.focal = pickFocalPoint(r.shortName, r.villages, r.centroid);
    r.fullMapUrl = buildFullMapUrl(r.focal);
    r.embedUrl = buildEmbedUrl(r.focal);
  }

  // Attach prebuilt content blocks last, so they can reference final fields.
  for (const r of regions) {
    r.faqs = buildFaqs(r);
    r.features = buildFeatures(r);
  }

  // Stable sort: state, then displayName.
  regions.sort((a, b) => (a.state || '').localeCompare(b.state || '') || a.displayName.localeCompare(b.displayName));

  // Detect duplicate slugs, fail loudly so we never ship two pages on the same URL.
  const seen = new Map();
  for (const r of regions) {
    if (seen.has(r.slug)) {
      throw new Error(`Duplicate slug "${r.slug}": ${seen.get(r.slug)} vs ${r.menuKey}`);
    }
    seen.set(r.slug, r.menuKey);
  }

  // Compare against the committed regions.json (ignoring generatedAt) so unchanged data
  // doesn't cause a no-op file rewrite — keeps Cloudflare deploys idempotent and makes
  // a true content change easy to spot in logs.
  const newPayload = { count: regions.length, regions };
  const newCanonical = JSON.stringify(newPayload);
  let unchanged = false;
  if (fs.existsSync(OUT_PATH)) {
    try {
      const prev = readJson(OUT_PATH);
      const prevCanonical = JSON.stringify({ count: prev.count, regions: prev.regions });
      unchanged = prevCanonical === newCanonical;
    } catch (e) {
      console.warn('could not read existing regions.json, will rewrite:', e.message);
    }
  }

  if (unchanged) {
    console.log(`regions unchanged (${regions.length} entries) — skipping write to ${path.relative(ROOT, OUT_PATH)}`);
    return;
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), ...newPayload }, null, 2));
  console.log(`wrote ${regions.length} regions to ${path.relative(ROOT, OUT_PATH)}`);
  console.log('sample slugs:', regions.slice(0, 8).map(r => r.slug).join(', '));
}

main().catch(err => {
  console.error('build-regions failed:', err);
  process.exit(1);
});
