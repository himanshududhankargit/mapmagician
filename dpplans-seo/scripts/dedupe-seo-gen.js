// Dedupe the curated set so we never index two pages for the same place.
// Within each region, cluster curated towns by geographic proximity (<=1.5 km) or
// identical normalized name; keep ONE canonical page per cluster and drop the rest
// from the generated file (dropped slugs simply stay noindexed/out of sitemap).
const fs = require('fs');
const regs = require('../data/regions.json').regions;

const HAND = new Set([
  'solapur-dp-plan/pandharpur', 'solapur-dp-plan/akkalkot-tal-akkalkot', 'solapur-dp-plan/barshi',
  'solapur-dp-plan/mangalwedha', 'solapur-dp-plan/madha', 'solapur-dp-plan/mohol',
  'solapur-dp-plan/akluj-tal-malshiras', 'solapur-dp-plan/kurduwadi-tal-madha',
  'pune-dp-plan/pimpri-chinchwad-municipal-corporation',
]);

// index village coords/name by key
const meta = {};
for (const r of regs) for (const v of r.villages) if (v.slug) meta[r.slug + '/' + v.slug] = { lat: v.lat, lng: v.lng, name: v.displayName || v.name, region: r.slug, slug: v.slug };

const norm = s => String(s).toLowerCase().replace(/[^a-z]/g, '');
const km = (a, b) => { const R = 6371, tr = x => x * Math.PI / 180; const dLat = tr(b.lat - a.lat), dLng = tr(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a.lat)) * Math.cos(tr(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

// parse generated.ts into ordered [{key, block}]
const src = fs.readFileSync('data/sublocation-content.generated.ts', 'utf8');
const lines = src.split('\n');
const header = lines.slice(0, lines.findIndex(l => l.startsWith('export const'))  + 1).join('\n');
const entries = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^  "([^"]+)": \{$/);
  if (!m) continue;
  let j = i; while (j < lines.length && lines[j] !== '  },') j++;
  entries.push({ key: m[1], block: lines.slice(i, j + 1).join('\n') });
  i = j;
}
const genKeys = entries.map(e => e.key);

// build clusters over HAND ∪ generated, per region
const allKeys = [...HAND, ...genKeys].filter(k => meta[k]);
const byRegion = {};
for (const k of allKeys) (byRegion[meta[k].region] = byRegion[meta[k].region] || []).push(k);

const keepPref = (a, b) => {
  // lower = preferred keeper
  const score = k => (HAND.has(k) ? 0 : 10) + (/-tal-/.test(meta[k].slug) ? 2 : 0) + meta[k].slug.length / 100;
  return score(a) - score(b);
};

const drop = new Set();
const clusters = [];
for (const [region, keys] of Object.entries(byRegion)) {
  const used = new Set();
  for (let i = 0; i < keys.length; i++) {
    if (used.has(keys[i])) continue;
    const group = [keys[i]]; used.add(keys[i]);
    for (let j = i + 1; j < keys.length; j++) {
      if (used.has(keys[j])) continue;
      const close = km(meta[keys[i]], meta[keys[j]]) <= 1.5;
      const sameName = norm(meta[keys[i]].name) === norm(meta[keys[j]].name);
      if (close || sameName) { group.push(keys[j]); used.add(keys[j]); }
    }
    if (group.length > 1) {
      group.sort(keepPref);
      const keeper = group[0];
      group.slice(1).forEach(k => { if (genKeys.includes(k)) drop.add(k); });
      clusters.push({ keeper, dropped: group.slice(1), names: group.map(k => meta[k].name + (HAND.has(k) ? '*' : '')) });
    }
  }
}

const kept = entries.filter(e => !drop.has(e.key));
const out = header + '\n' + kept.map(e => e.block).join('\n') + '\n};\n';
fs.writeFileSync('data/sublocation-content.generated.ts', out);

console.log('duplicate clusters found:', clusters.length);
clusters.forEach(c => console.log('  keep', c.keeper, '| drop:', c.dropped.join(', '), '| names:', c.names.join(' / ')));
console.log('\ngenerated entries:', entries.length, '-> dropped', drop.size, '-> kept', kept.length);
console.log('(* = hand-curated keeper)');
