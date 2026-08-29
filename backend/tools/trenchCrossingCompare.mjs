/**
 * N-42 · Did pavements over daylighted trenches actually get recognised as crossings?
 *
 * The prediction is specific and falsifiable: 1,135 surface ways of the excluded classes (footway,
 * cycleway, pedestrian, service, steps, path) float more than 2 m over their own terrain and NONE
 * of them carries `crossesTrench`. If the fix landed, that flag appears on the path family and the
 * drivable count is untouched — a drivable number that MOVES would mean the carve set was widened
 * by mistake, which would gouge streets for pedestrian subways.
 *
 * Usage: node backend/tools/trenchCrossingCompare.mjs <beforeTilesDir> <afterTilesDir>
 */
import fs from 'node:fs'; import path from 'node:path';
const DRIVABLE = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
  'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street']);

function scan(root) {
  const flagged = new Map();          // highwayType -> count of ways with crossesTrench
  const seen = new Set();
  const files = [];
  (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.name.endsWith('.bin')) files.push(p);
  } })(root);
  for (const f of files) {
    const b = fs.readFileSync(f); const hl = b.readUInt32LE(0);
    let x = hl; while (x > 0 && b[4 + x - 1] === 0) x--;
    let h; try { h = JSON.parse(b.toString('utf8', 4, 4 + x)); } catch { continue; }
    for (const r of h.roads || []) {
      if (!r.crossesTrench || seen.has(r.id)) continue;
      seen.add(r.id);
      flagged.set(r.highwayType, (flagged.get(r.highwayType) || 0) + 1);
    }
  }
  return flagged;
}

const [before, after] = [scan(process.argv[2]), scan(process.argv[3])];
const types = [...new Set([...before.keys(), ...after.keys()])].sort();
const sum = (m, pred) => [...m].filter(([k]) => pred(k)).reduce((a, [, v]) => a + v, 0);
console.log('ways carrying crossesTrench, by type\n');
console.log('  type              before   after   delta');
for (const t of types) {
  const b = before.get(t) || 0, a = after.get(t) || 0;
  console.log(`  ${t.padEnd(16)} ${String(b).padStart(6)}  ${String(a).padStart(6)}  ${(a - b >= 0 ? '+' : '') + (a - b)}`);
}
const bd = sum(before, (t) => DRIVABLE.has(t)), ad = sum(after, (t) => DRIVABLE.has(t));
const bp = sum(before, (t) => !DRIVABLE.has(t)), ap = sum(after, (t) => !DRIVABLE.has(t));
console.log(`\n  DRIVABLE classes : ${bd} -> ${ad}   (should barely move; a big jump means the CARVE set was widened)`);
console.log(`  path family etc. : ${bp} -> ${ap}   (this is the fix)`);
