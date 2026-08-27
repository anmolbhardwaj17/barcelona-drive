/**
 * P-R1b, second attempt — compare road height against the terrain THAT ACTUALLY RENDERS.
 *
 * The bake-time detector found ZERO conflicts, because it sampled the raw DEM — the very surface the
 * roads were fitted to. But the bake then runs "selective terrain smoothing" (removed-relief RMS
 * 3.31 m, max 5.5 m, touching 65.2% of cells) and ships the SMOOTHED grid. Roads are never re-fitted
 * to it. So the road agrees with a surface that no longer exists, and disagrees with the one under
 * the wheels — which is exactly the 8.8%-of-points figure the runtime ?debug=roadfit probe measured
 * and the "roads look floating" the user reports.
 *
 * This reads baked tiles only. No bake, no PBF, read-only.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', 'tiles', 'barcelona');
const TOL = Number(process.env.TOL_M ?? 0.5);
const R_EARTH = 6378137;
const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'service', 'motorway_link', 'trunk_link', 'primary_link',
  'secondary_link', 'tertiary_link', 'busway']);
const driv = { pts: 0, bad: 0, devs: [] };
// Smoothing happens at DEM LOAD (demLoader.js:187), so demSampler already returns the smoothed
// surface and roads are fitted to it — which is why the median deviation is exactly 0.000. Anything
// that modifies the TILE grid afterwards (trench carve, water sink) lowers it and leaves the road
// hanging. Both lower, and every measured deviation is positive, so attribute per tile.
const tileStats = new Map();
let overWater = 0;

function readTile(f) {
  const b = fs.readFileSync(f);
  const hl = b.readUInt32LE(0);
  let e = hl; while (e > 0 && b[4 + e - 1] === 0) e--;
  const h = JSON.parse(b.toString('utf8', 4, 4 + e));
  const ab = b.buffer.slice(b.byteOffset + 4 + hl, b.byteOffset + b.length);
  return { h, ab };
}

const files = [];
(function walk(d) {
  for (const en of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, en.name);
    if (en.isDirectory()) walk(p); else if (en.name.endsWith('.bin')) files.push(p);
  }
})(ROOT);

let pts = 0, bad = 0, floating = 0, buried = 0;
const devs = [];
const byType = {};
const worst = [];

for (const f of files) {
  let h, ab;
  try { ({ h, ab } = readTile(f)); } catch { continue; }
  const el = h.elevation, roads = h.roads;
  if (!el || el.elevationsOffset === undefined || !roads) continue;
  const grid = new Float32Array(ab, el.elevationsOffset, el.elevationsCount);
  const { south, west, north, east, gridRows, gridCols } = el;

  // bilinear sample of the SHIPPED (smoothed) grid
  const sample = (lat, lon) => {
    const fy = (lat - south) / (north - south) * (gridRows - 1);
    const fx = (lon - west) / (east - west) * (gridCols - 1);
    if (!(fx >= 0 && fx <= gridCols - 1 && fy >= 0 && fy <= gridRows - 1)) return null;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(gridCols - 1, x0 + 1), y1 = Math.min(gridRows - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const g = (r, c) => grid[r * gridCols + c];
    return (g(y0, x0) * (1 - tx) + g(y0, x1) * tx) * (1 - ty)
         + (g(y1, x0) * (1 - tx) + g(y1, x1) * tx) * ty;
  };

  // Point-in-polygon against the tile's CLOSED water bodies. The sink only lowers cells inside
  // those, so if a floating road point sits inside one, the road is crossing water — an untagged
  // bridge (defect class M1_implied_bridge), not a terrain-fitting error.
  const waterPolys = [];
  for (const w of (h.water || [])) {
    if (w.polygonOffset === undefined || !w.polygonCount || w.polygonCount < 3) continue;
    waterPolys.push(new Float32Array(ab, w.polygonOffset, w.polygonCount * 2));
  }
  const inWater = (mx, my) => {
    for (const poly of waterPolys) {
      let inside = false;
      const n = poly.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
        if ((yi > my) !== (yj > my) && mx < ((xj - xi) * (my - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };

  for (const r of roads) {
    if (r.bridge || r.tunnel || (r.layer != null && r.layer !== 0) || r.isRamp) continue;
    if (r.pointsOffset === undefined || !r.pointCount) continue;
    // Road points are Float32 TRIPLES stored as [mercatorX, elevation, mercatorY] — not lat/lon,
    // and not x/y/z. See readFloat32Triples in tileParserWorker.
    const f32 = new Float32Array(ab, r.pointsOffset, r.pointCount * 3);
    for (let i = 0, j = 0; i < r.pointCount; i++, j += 3) {
      const lon = (f32[j] / R_EARTH) * (180 / Math.PI);
      const lat = (2 * Math.atan(Math.exp(f32[j + 2] / R_EARTH)) - Math.PI / 2) * (180 / Math.PI);
      const ev = f32[j + 1];
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(ev)) continue;
      const t = sample(lat, lon);
      if (t == null) continue;
      const dev = ev - t;
      pts++; devs.push(dev);
      const drivable = DRIVABLE.has(r.highwayType);
      if (drivable) driv.pts++;
      if (Math.abs(dev) > TOL) {
        bad++; dev > 0 ? floating++ : buried++;
        byType[r.highwayType || '?'] = (byType[r.highwayType || '?'] || 0) + 1;
        worst.push({ id: r.id, type: r.highwayType, dev: +dev.toFixed(2) });
        // Split out what the DRIVER can actually reach. Pedestrian infrastructure dominates the raw
        // count, and a floating footbridge is a different problem from a floating carriageway.
        if (drivable) { driv.bad++; driv.devs.push(dev); }
        if (inWater(f32[j], f32[j + 2])) overWater++;
        const k = path.relative(ROOT, f);
        const st = tileStats.get(k) || { bad: 0, water: (h.water || []).length };
        st.bad++; tileStats.set(k, st);
      }
    }
  }
}

devs.sort((a, b) => a - b);
const q = (x) => (devs.length ? devs[Math.floor(devs.length * x)].toFixed(3) : 'n/a');
console.log(`road points sampled : ${pts.toLocaleString()}`);
console.log(`beyond ${TOL} m        : ${bad.toLocaleString()} (${(100 * bad / Math.max(pts, 1)).toFixed(1)}%)`);
console.log(`   floating / buried: ${floating.toLocaleString()} / ${buried.toLocaleString()}`);
console.log(`deviation p01 ${q(0.01)}  p50 ${q(0.5)}  p99 ${q(0.99)}  min ${devs[0]?.toFixed(2)}  max ${devs[devs.length - 1]?.toFixed(2)}`);
console.log('by type:', Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 8)));
driv.devs.sort((a, b) => Math.abs(b) - Math.abs(a));
console.log(`\nDRIVABLE roads only : ${driv.pts.toLocaleString()} points, ` +
            `${driv.bad.toLocaleString()} beyond ${TOL} m (${(100 * driv.bad / Math.max(driv.pts, 1)).toFixed(1)}%)` +
            (driv.devs.length ? `  worst ${driv.devs[0].toFixed(2)} m  median-bad ${driv.devs[Math.floor(driv.devs.length / 2)].toFixed(2)} m` : ''));
worst.sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev));
const tiles = [...tileStats.entries()].sort((a, b) => b[1].bad - a[1].bad);
const withWater = tiles.filter(([, v]) => v.water > 0);
const badInWaterTiles = withWater.reduce((a, [, v]) => a + v.bad, 0);
const badTotal = tiles.reduce((a, [, v]) => a + v.bad, 0);
console.log(`\nfloating points INSIDE a water polygon: ${overWater.toLocaleString()} / ${bad.toLocaleString()} ` +
            `(${(100 * overWater / Math.max(bad, 1)).toFixed(0)}%) -> untagged bridges (M1), not fitting errors`);
console.log(`\ntiles with floating points : ${tiles.length}  of which have water: ${withWater.length}`);
console.log(`floating points in water-bearing tiles: ${badInWaterTiles} / ${badTotal} ` +
            `(${(100 * badInWaterTiles / Math.max(badTotal, 1)).toFixed(0)}%)`);
console.log('worst tiles:'); for (const [k, v] of tiles.slice(0, 6)) console.log(`   ${k}  ${v.bad} bad pts  water polys ${v.water}`);
// Is the deviation QUANTISED to LAYER_STEP? p99 landing on 6.37 could be coincidence or the whole
// answer. A histogram settles it: a fitting error is smooth, a misapplied layer clusters on 6/12/18.
const badDevs = worst.map((w) => w.dev);
const hist = new Map();
for (const d of badDevs) { const b = Math.round(d); hist.set(b, (hist.get(b) || 0) + 1); }
const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('\ndeviation histogram (rounded m -> count), most common first:');
for (const [m, n] of top) {
  const mult = m !== 0 && Math.abs(m % 6) === 0 ? '  <- multiple of LAYER_STEP' : '';
  console.log(`   ${String(m).padStart(4)} m : ${String(n).padStart(5)}${mult}`);
}
const onStep = badDevs.filter((d) => Math.abs(Math.abs(d) % 6) < 0.35 || Math.abs(Math.abs(d) % 6 - 6) < 0.35).length;
console.log(`within 0.35 m of a LAYER_STEP multiple: ${onStep} / ${badDevs.length} (${(100 * onStep / badDevs.length).toFixed(0)}%)`);
console.log('worst points:'); for (const w of worst.slice(0, 8)) console.log(`   id ${String(w.id).padStart(11)} ${String(w.type).padEnd(13)} ${w.dev > 0 ? '+' : ''}${w.dev} m`);
