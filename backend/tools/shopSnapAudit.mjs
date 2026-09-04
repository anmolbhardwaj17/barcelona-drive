/**
 * P-6 · DO REAL SHOPS LAND ON REAL PAVEMENTS?
 *
 * `attachDestinations` snaps a shop to the nearest pavement walk line and drops it if the gap
 * exceeds SHOP_SNAP_M. Unit tests prove the snap arithmetic against synthetic geometry; they cannot
 * prove that Barcelona's surveyed shop points are actually near the pavements the game draws. A
 * destination system that silently matches 4% of shops looks exactly like one that works.
 *
 * Measures, per tile: distance from each shop to the nearest DRIVABLE road centreline, converted to
 * metres, minus the pavement offset — i.e. how far the shop is from the line pedestrians walk.
 *
 * Read-only, against the shipped tiles. Usage: node backend/tools/shopSnapAudit.mjs [tileLimit]
 */
import fs from 'node:fs';
import path from 'node:path';

const R = 6378137;
// ⚠ TWO SPACES IN ONE FILE. Road points are stored as ABSOLUTE MERCATOR; shop, tree and building
// positions are stored as real-metre WORLD (origin-subtracted and unstretched by the bake's
// mercatorToWorld). `tileParserWorker` normalises the first to the second by passing ox/oy to
// readRoads and NOT to readShops. A first version of this audit compared the two raw and reported
// 0% of shops within snapping distance with a median gap of 5,069,611 m — the Mercator northing
// itself. That is the same trap N-25 records for trees, and it is silent: nothing errors, the
// destination list is simply always empty.
const ORIGIN_LAT = 41.350, ORIGIN_LON = 2.115;          // MUST match frontend/src/projection.js
const UNSTRETCH = Math.cos((ORIGIN_LAT * Math.PI) / 180);
const OX = R * (ORIGIN_LON * Math.PI / 180);
const OY = R * Math.log(Math.tan(Math.PI / 4 + (ORIGIN_LAT * Math.PI / 180) / 2));
const mercToWorld = (mx, my) => [(mx - OX) * UNSTRETCH, (my - OY) * UNSTRETCH];

const SHOP_SNAP_M = 12;      // must match pedestrians.js
const PAVEMENT_OFF_M = 6.5;  // typical kerbOffset + SIDEWALK_PAD; the walk line, not the centreline
const WALKABLE = new Set(['residential', 'living_street', 'unclassified', 'pedestrian', 'footway',
  'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link']);

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.bin')) files.push(p);
  }
})('backend/tiles/barcelona');

const limit = Number(process.argv[2] || 0) || files.length;
let shopsTotal = 0, snapped = 0, named = 0, tiles = 0;
const gaps = [];

for (const f of files.slice(0, limit)) {
  const b = fs.readFileSync(f);
  const hl = b.readUInt32LE(0);
  let x = hl; while (x > 0 && b[4 + x - 1] === 0) x--;
  let h; try { h = JSON.parse(b.toString('utf8', 4, 4 + x)); } catch { continue; }
  if (!h.shops?.length || !h.shopPositions) continue;
  const ab = b.buffer.slice(b.byteOffset + 4 + hl, b.byteOffset + b.length);
  const pos = new Float32Array(ab, h.shopPositions.offset, h.shopPositions.count * 2);

  // Road centrelines, walkable types only, as flat mercator point lists.
  const lines = [];
  for (const r of h.roads || []) {
    if (!WALKABLE.has(r.highwayType) || r.tunnel || r.pointCount < 2) continue;
    // Mercator -> world, exactly as readRoads does, so both sides of the comparison are metres.
    const src = new Float32Array(ab, r.pointsOffset, r.pointCount * 3);
    const w = new Float32Array(r.pointCount * 2);
    for (let i = 0; i < r.pointCount; i++) {
      const [wx, wz] = mercToWorld(src[i * 3], src[i * 3 + 2]);
      w[i * 2] = wx; w[i * 2 + 1] = wz;
    }
    lines.push(w);
  }
  if (!lines.length) continue;
  tiles++;

  for (let i = 0; i < h.shopPositions.count; i++) {
    const sx = pos[i * 2], sz = pos[i * 2 + 1];   // already WORLD metres
    let best = Infinity;
    for (const L of lines) {
      for (let j = 0; j + 1 < L.length / 2; j++) {
        const ax = L[j * 2], az = L[j * 2 + 1];
        const bx = L[j * 2 + 2], bz = L[j * 2 + 3];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        let t = ((sx - ax) * dx + (sz - az) * dz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + dx * t, pz = az + dz * t;
        const d2 = (sx - px) ** 2 + (sz - pz) ** 2;
        if (d2 < best) best = d2;
      }
    }
    if (!Number.isFinite(best)) continue;
    shopsTotal++;
    if (h.shops[i]?.name) named++;
    // Distance to the WALK LINE, not the centreline: the pavement sits PAVEMENT_OFF_M out, so a shop
    // on the frontage is closer to it than to the road. Negative means the shop is inboard of it.
    const gap = Math.abs(Math.sqrt(best) - PAVEMENT_OFF_M);
    gaps.push(gap);
    if (gap <= SHOP_SNAP_M) snapped++;
  }
}

gaps.sort((a, b) => a - b);
const pct = (n) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * n))].toFixed(1) : '-';
console.log(`tiles with shops+roads : ${tiles}`);
console.log(`shops measured         : ${shopsTotal}  (${named} named)`);
console.log(`WITHIN SHOP_SNAP_M=${SHOP_SNAP_M}   : ${snapped}  (${(snapped / shopsTotal * 100).toFixed(1)}%)`);
console.log(`gap to the walk line   : p50 ${pct(0.5)} m · p90 ${pct(0.9)} m · p99 ${pct(0.99)} m · max ${gaps.length ? gaps[gaps.length - 1].toFixed(1) : '-'} m`);
