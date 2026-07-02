/**
 * Stage-1 static verifier (read-only). Cross-path consistency + real-size proof on a baked tile.
 * Run AFTER the Unstretch-X re-bake.
 *
 *  node tools/_stage1_verify.mjs [16_tx_ty]
 *
 * Checks:
 *  1. SPLIT-WORLD: terrain / road / building / tree world-coordinate windows must coincide.
 *     terrain positions are baked-world (bake applied cos); roads/buildings/trees are baked as
 *     absolute Mercator and converted here via the (now cos'd) backend mercatorToWorld — the SAME
 *     value the frontend parse uses. If one class is ~1.33× off, the world is split.
 *  2. SIZES-REAL: a road's baked world length must equal its real ground length (haversine).
 *     Pre-unstretch world length = 1.3321× real; post = real (within bbox latitude variance).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mercatorToWorld, mercatorToLatLon } from '../backend/projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'backend', 'tiles', 'barcelona', '16');

function decode(buf) {
  const hl = buf.readUInt32LE(0);
  let h = buf.toString('utf8', 4, 4 + hl);
  h = h.slice(0, h.lastIndexOf('}') + 1);
  return { header: JSON.parse(h), buf, bin: 4 + hl };
}
const f32 = (d, off, n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = d.buf.readFloatLE(d.bin + off + i * 4); return a; };

// haversine ground metres
function ground(latlon) {
  const R = 6371000, toR = Math.PI / 180;
  let s = 0;
  for (let i = 1; i < latlon.length; i++) {
    const [la1, lo1] = latlon[i - 1], [la2, lo2] = latlon[i];
    const dLa = (la2 - la1) * toR, dLo = (lo2 - lo1) * toR;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * toR) * Math.cos(la2 * toR) * Math.sin(dLo / 2) ** 2;
    s += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return s;
}

function pickTile(arg) {
  if (arg) { const [, x, y] = arg.split('_'); return [x, y]; }
  // auto: find a tile with roads + buildings + trees + bakedTerrain
  for (const tx of fs.readdirSync(DIR).filter(d => /^\d+$/.test(d))) {
    for (const f of fs.readdirSync(path.join(DIR, tx))) {
      const m = f.match(/^(\d+)\.bin$/); if (!m) continue;
      const dec = decode(fs.readFileSync(path.join(DIR, tx, f)));
      const h = dec.header;
      if ((h.roads || []).length > 5 && (h.buildings || []).length > 5 && h.treePositions?.count > 5 && h.bakedTerrain) return [tx, m[1]];
    }
  }
  return null;
}

const tile = pickTile(process.argv[2]);
if (!tile) { console.log('no suitable tile found'); process.exit(1); }
const [tx, ty] = tile;
const dec = decode(fs.readFileSync(path.join(DIR, tx, ty + '.bin')));
const H = dec.header;
console.log(`Tile 16_${tx}_${ty}  roads=${(H.roads||[]).length} buildings=${(H.buildings||[]).length} trees=${H.treePositions?.count||0}\n`);

const range = (xs, zs) => `X[${Math.min(...xs).toFixed(1)}..${Math.max(...xs).toFixed(1)}] Z[${Math.min(...zs).toFixed(1)}..${Math.max(...zs).toFixed(1)}]`;

// 1a. terrain (baked-world)
const bt = H.bakedTerrain;
const tp = f32(dec, bt.positionsOffset, bt.positionsCount);
const txs = [], tzs = []; for (let i = 0; i < tp.length; i += 3) { txs.push(tp[i]); tzs.push(tp[i + 2]); }
console.log('terrain  (baked world)        :', range(txs, tzs));

// 1b. roads (mercator triples → world via cos'd projection)
const rxs = [], rzs = [];
for (const r of H.roads) { const n = r.pointCount, o = r.pointsOffset; const a = f32(dec, o, n * 3);
  for (let i = 0; i < n; i++) { const w = mercatorToWorld(a[i*3], a[i*3+2]); rxs.push(w.x); rzs.push(w.z); } }
console.log('roads    (merc→world via proj):', range(rxs, rzs));

// 1c. buildings (footprints are WORLD-stored, origin pre-subtracted + cos'd at bake → read raw)
const bxs = [], bzs = [];
for (const b of (H.buildings||[])) { if (b.footprintOffset==null) continue; const n=b.footprintCount, a=f32(dec,b.footprintOffset,n*2);
  for (let i=0;i<n;i++){ bxs.push(a[i*2]); bzs.push(a[i*2+1]); } }
if (bxs.length) console.log('buildings(world, raw)         :', range(bxs, bzs));

// 1d. trees (treePositions are WORLD-stored → read raw)
if (H.treePositions?.count) { const n=H.treePositions.count, a=f32(dec,H.treePositions.offset,n*2); const vx=[],vz=[];
  for (let i=0;i<n;i++){ vx.push(a[i*2]); vz.push(a[i*2+1]); }
  console.log('trees    (world, raw)         :', range(vx, vz)); }

// split verdict: all windows should share the same span (same tile, real-metre)
const span = (xs)=>Math.max(...xs)-Math.min(...xs);
const tSpanX=span(txs), rSpanX=span(rxs);
console.log(`\nSPLIT-WORLD CHECK: terrain X-span=${tSpanX.toFixed(1)}m  roads X-span=${rSpanX.toFixed(1)}m  ratio=${(rSpanX/tSpanX).toFixed(3)} (want ~≤1.0; a class ~1.33× = SPLIT)`);

// 2. sizes-real: longest road, world length vs ground length
let best=null;
for (const r of H.roads) { if (r.pointCount<2) continue; const n=r.pointCount,a=f32(dec,r.pointsOffset,n*3);
  const w=[],ll=[]; for(let i=0;i<n;i++){ const wo=mercatorToWorld(a[i*3],a[i*3+2]); w.push(wo); const l=mercatorToLatLon(a[i*3],a[i*3+2]); ll.push([l.lat,l.lon]); }
  let wlen=0; for(let i=1;i<n;i++) wlen+=Math.hypot(w[i].x-w[i-1].x,w[i].z-w[i-1].z);
  const glen=ground(ll);
  if(!best||wlen>best.wlen) best={name:r.name||r.highwayType,wlen,glen,width:r.width}; }
console.log(`\nSIZES-REAL CHECK: longest road "${best.name}"  baked world length=${best.wlen.toFixed(1)}m  real ground length=${best.glen.toFixed(1)}m  ratio=${(best.wlen/best.glen).toFixed(4)} (want ~1.000)`);
console.log(`  its road.width=${best.width}m (applied as world-unit offset → renders that many real metres)`);
