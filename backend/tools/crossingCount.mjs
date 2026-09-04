#!/usr/bin/env node
/**
 * crossingCount.mjs — how many marked crossings are actually IN the baked tiles?
 *
 * P-2's first step is "add `crossing` to the segment whitelist and PROVE it arrives". This is the
 * offline half of that proof: before wiring behaviour to a flag, know the flag's population. D-23 —
 * a counter at the point of decision does not prove the decision reached the output, so the number
 * the runtime probe reports has to be checked against a number measured from the data.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tiles', 'barcelona');
function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else if (e.name.endsWith('.bin') && e.name !== 'citymap.bin') out.push(f);
  }
  return out;
}
let tiles = 0, roads = 0, crossings = 0, tilesWith = 0;
const lens = [];
const byType = new Map();
for (const f of walk(TILE_DIR)) {
  const b = fs.readFileSync(f);
  const hl = b.readUInt32LE(0);
  let end = 4 + hl;
  while (end > 4 && b[end - 1] === 0) end--;
  let h; try { h = JSON.parse(b.slice(4, end).toString('utf8')); } catch { continue; }
  tiles++;
  let inTile = 0;
  for (const r of h.roads || []) {
    roads++;
    if (!r.crossing) continue;
    crossings++; inTile++;
    byType.set(r.highwayType, (byType.get(r.highwayType) || 0) + 1);
    if (r.pointCount >= 2) {
      const a = new Float32Array(b.buffer, b.byteOffset + 4 + hl + r.pointsOffset, r.pointCount * 3);
      let L = 0;
      for (let i = 1; i < r.pointCount; i++) L += Math.hypot(a[i * 3] - a[i * 3 - 3], a[i * 3 + 2] - a[i * 3 - 1]);
      lens.push(L);
    }
  }
  if (inTile) tilesWith++;
}
lens.sort((a, b) => a - b);
const pct = (p) => (lens.length ? lens[Math.floor(lens.length * p)] : 0);
console.log(`tiles ${tiles} (${tilesWith} with crossings) · roads ${roads} · crossings ${crossings} `
  + `(${(crossings / roads * 100).toFixed(2)}%)`);
console.log(`crossing length m: min ${pct(0).toFixed(1)} · p50 ${pct(0.5).toFixed(1)} `
  + `· p90 ${pct(0.9).toFixed(1)} · max ${pct(0.999).toFixed(1)}`);
console.log('by highwayType:', [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '));
