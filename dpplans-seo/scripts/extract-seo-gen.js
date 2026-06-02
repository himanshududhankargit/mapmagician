const fs = require('fs');
const p = 'C:/Users/himan/AppData/Local/Temp/claude/C--MyData-GIS-web/191aa11c-bcb6-45fc-b6b6-421b9f4751f2/tasks/whfb5eogf.output';
const raw = fs.readFileSync(p, 'utf8');
const obj = JSON.parse(raw).result;
let ts = obj.tsFile;
console.log('count=', obj.count, 'regions=', obj.regions, 'chunks=', obj.chunks);
const escaped = ts.includes('Record&lt;') || ts.includes('&amp;') || ts.includes('&lt;');
console.log('html-escaped?', escaped);
if (escaped) {
  ts = ts.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
console.log('has import?', ts.includes("import type { SubLocationContent } from './sublocation-content'"));
console.log('has export?', ts.includes('export const GENERATED_SUBLOCATION_CONTENT'));
console.log('Record< present?', ts.includes('Record<string, SubLocationContent>'));
console.log('leftover entity?', /&(amp|lt|gt|quot|#39);/.test(ts));
const keys = (ts.match(/^  "([^"]+)":/gm) || []).map(s => s.replace(/^  "/, '').replace(/":$/, ''));
console.log('entries in file:', keys.length);
fs.writeFileSync('data/sublocation-content.generated.ts', ts);
console.log('wrote data/sublocation-content.generated.ts bytes=', ts.length);
const byReg = {};
keys.forEach(k => { const r = k.split('/')[0]; (byReg[r] = byReg[r] || []).push(k.split('/').slice(1).join('/')); });
console.log('\nby region:');
Object.entries(byReg).sort((a, b) => b[1].length - a[1].length).forEach(([r, v]) => console.log('  ' + r.padEnd(42), v.length, '|', v.join(', ')));
