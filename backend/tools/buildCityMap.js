#!/usr/bin/env node
/**
 * buildCityMap — pre-generate ONE compact citymap file from the already-baked tiles, so the custom minimap
 * loads the whole city's 2D vector map in a single small download instead of streaming all ~426 full tiles
 * (~525 MB → ~0.5 MB gzipped). No re-bake needed: reads the existing tiles and re-packs roads/water/parks.
 *
 * Grouped BY SOURCE TILE (tx,ty) so the client ingests each under the same `${tx}_${ty}` key the near-car
 * streamer uses → a full tile (with buildings) cleanly upgrades the lite citymap entry, no duplication.
 *
 * Output: backend/tiles/<region>/citymap.bin  (JSON header + little-endian binary body)
 *   header = { v, region, quant, baseX, baseY, roadTypes:[str], roadNames:[str], tileCount }
 *   body, per tile (sequential, DataView-read, little-endian):
 *     u32 tx, u32 ty, u16 roadCount, u16 waterCount, u16 greenCount
 *     roads:  per road → u16 typeIdx, u32 nameIdx, f32 width, u16 ptCount, ptCount×(u16 qx, u16 qy)
 *     water:  per poly → u16 ptCount, ptCount×(u16 qx, u16 qy)
 *     greens: per poly → u16 ptCount, ptCount×(u16 qx, u16 qy)
 *   coords are WORLD metres quantized: world = base + q * quant.
 *
 * Usage: node backend/tools/buildCityMap.js [region=barcelona] [zoom=16]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MUST match frontend/src/projection.js (ORIGIN_LAT/LON, R, unstretch).
const R = 6378137;
const ORIGIN_LAT = 41.350, ORIGIN_LON = 2.115;
const UNSTRETCH = Math.cos((ORIGIN_LAT * Math.PI) / 180);
const ORIGIN = { x: R * (ORIGIN_LON * Math.PI / 180), y: R * Math.log(Math.tan(Math.PI / 4 + (ORIGIN_LAT * Math.PI / 180) / 2)) };

// A minimap needs no fine detail → simplify polylines (Douglas–Peucker) + drop tiny fragments.
const ROAD_TOL = 2.5, AREA_TOL = 6.0, MIN_AREA_SPAN = 12;  // metres
function simplify(pts, tol) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    let far = -1, fd = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2], py = pts[i * 2 + 1];
      const t = ((px - ax) * dx + (py - ay) * dy) / len2;
      const cx = ax + Math.max(0, Math.min(1, t)) * dx, cy = ay + Math.max(0, Math.min(1, t)) * dy;
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (d > fd) { fd = d; far = i; }
    }
    if (far !== -1) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}
function bboxSpan(pts) {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { const x = pts[i], y = pts[i + 1]; if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; }
  return Math.hypot(mxx - mnx, mxy - mny);
}

const region = process.argv[2] || 'barcelona';
const zoom = process.argv[3] || '16';
const tilesDir = path.join(__dirname, '..', 'tiles', region, zoom);
const outPath = path.join(__dirname, '..', 'tiles', region, 'citymap.bin');

function readTileHeader(buf) {
  const hlen = buf.readUInt32LE(0);
  const bytes = buf.subarray(4, 4 + hlen);
  let je = hlen; while (je > 0 && bytes[je - 1] === 0) je--;
  return { header: JSON.parse(bytes.subarray(0, je).toString('utf8')), binOffset: 4 + hlen };
}
// Roads store ABSOLUTE mercator as float32 triples (x, elev, y) → convert to WORLD.
function readRoadPts(buf, base, count) {
  const p = new Array(count * 2);
  for (let i = 0; i < count; i++) { p[i * 2] = (buf.readFloatLE(base + i * 12) - ORIGIN.x) * UNSTRETCH; p[i * 2 + 1] = (buf.readFloatLE(base + i * 12 + 8) - ORIGIN.y) * UNSTRETCH; }
  return p;
}
// Pairs. mercator=true → convert (water); false → already WORLD (greens).
function readPairPts(buf, base, count, mercator) {
  const p = new Array(count * 2);
  for (let i = 0; i < count; i++) { const a = buf.readFloatLE(base + i * 8), b = buf.readFloatLE(base + i * 8 + 4); if (mercator) { p[i * 2] = (a - ORIGIN.x) * UNSTRETCH; p[i * 2 + 1] = (b - ORIGIN.y) * UNSTRETCH; } else { p[i * 2] = a; p[i * 2 + 1] = b; } }
  return p;
}

const typeTable = [], typeIdx = new Map();
const nameTable = [''], nameIdx = new Map([['', 0]]);
const internType = (t) => { if (!typeIdx.has(t)) { typeIdx.set(t, typeTable.length); typeTable.push(t); } return typeIdx.get(t); };
const internName = (n) => { if (!n) return 0; if (!nameIdx.has(n)) { nameIdx.set(n, nameTable.length); nameTable.push(n); } return nameIdx.get(n); };

const tiles = [];   // { tx, ty, roads:[{typeIdx,nameIdx,width,pts}], water:[{pts}], greens:[{pts}] }
let baseX = Infinity, baseY = Infinity;
const trackMin = (pts) => { for (let i = 0; i < pts.length; i += 2) { if (pts[i] < baseX) baseX = pts[i]; if (pts[i + 1] < baseY) baseY = pts[i + 1]; } };

for (const xd of fs.readdirSync(tilesDir)) {
  const xp = path.join(tilesDir, xd);
  let st; try { st = fs.statSync(xp); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const yf of fs.readdirSync(xp)) {
    const m = yf.match(/^(\d+)\.bin$/); if (!m) continue;
    const buf = fs.readFileSync(path.join(xp, yf));
    let parsed; try { parsed = readTileHeader(buf); } catch { continue; }
    const { header: h, binOffset } = parsed;
    const tile = { tx: +xd, ty: +m[1], roads: [], water: [], greens: [], beaches: [] };
    for (const r of h.roads || []) {
      if (!(r.pointCount >= 2)) continue;
      const pts = simplify(readRoadPts(buf, binOffset + r.pointsOffset, r.pointCount), ROAD_TOL);
      if (pts.length < 4) continue;
      tile.roads.push({ typeIdx: internType(r.highwayType || ''), nameIdx: internName(r.name || ''), width: (Number.isFinite(r.width) && r.width > 0) ? r.width : -1, pts });
      trackMin(pts);
    }
    for (const w of h.water || []) {
      if (!(w.polygonCount >= 3)) continue;
      const raw = readPairPts(buf, binOffset + w.polygonOffset, w.polygonCount, true);
      if (bboxSpan(raw) < MIN_AREA_SPAN) continue;
      const pts = simplify(raw, AREA_TOL);
      if (pts.length >= 6) { tile.water.push({ pts }); trackMin(pts); }
    }
    for (const g of h.greens || []) {
      if (!(g.polygonCount >= 3)) continue;
      const raw = readPairPts(buf, binOffset + g.polygonOffset, g.polygonCount, false);
      if (bboxSpan(raw) < MIN_AREA_SPAN) continue;
      const pts = simplify(raw, AREA_TOL);
      if (pts.length >= 6) { tile.greens.push({ pts }); trackMin(pts); }
    }
    // v2: beaches (area features — already WORLD pairs, like greens). isLine entries are shoreline
    // ways, not fillable areas.
    for (const b of h.beaches || []) {
      if (b.isLine || !(b.polygonCount >= 3)) continue;
      const raw = readPairPts(buf, binOffset + b.polygonOffset, b.polygonCount, false);
      if (bboxSpan(raw) < MIN_AREA_SPAN) continue;
      const pts = simplify(raw, AREA_TOL);
      if (pts.length >= 6) { tile.beaches.push({ pts }); trackMin(pts); }
    }
    if (tile.roads.length || tile.water.length || tile.greens.length || tile.beaches.length) tiles.push(tile);
  }
}

// ── Encode ────────────────────────────────────────────────────────────────────
const QUANT = 0.5;
baseX = Math.floor(baseX); baseY = Math.floor(baseY);
const qx = (x) => Math.max(0, Math.min(65535, Math.round((x - baseX) / QUANT)));
const qy = (y) => Math.max(0, Math.min(65535, Math.round((y - baseY) / QUANT)));

const header = { v: 2, region, quant: QUANT, baseX, baseY, roadTypes: typeTable, roadNames: nameTable, tileCount: tiles.length };
// v2: + beaches channel (u16 beachCount in the tile record, polys after greens). The client reads
// beachCount only when header.v >= 2, so a v1 file still parses.
// No padding: the client reads the body via DataView (alignment-safe), and padding nulls would break the
// header's JSON.parse. headerLen = exact JSON byte length.
const hjson = Buffer.from(JSON.stringify(header), 'utf8');

let bodyBytes = 0;
let nRoads = 0, nWater = 0, nGreens = 0, nBeaches = 0;
for (const t of tiles) {
  bodyBytes += 4 + 4 + 2 + 2 + 2 + 2;                              // tx,ty,counts (v2: +beachCount)
  for (const r of t.roads)   { bodyBytes += 2 + 4 + 4 + 2 + (r.pts.length / 2) * 4; nRoads++; }
  for (const w of t.water)   { bodyBytes += 2 + (w.pts.length / 2) * 4; nWater++; }
  for (const g of t.greens)  { bodyBytes += 2 + (g.pts.length / 2) * 4; nGreens++; }
  for (const b of t.beaches) { bodyBytes += 2 + (b.pts.length / 2) * 4; nBeaches++; }
}

const out = Buffer.alloc(4 + hjson.length + bodyBytes);
let o = 0;
out.writeUInt32LE(hjson.length, o); o += 4;
hjson.copy(out, o); o += hjson.length;
const wPts = (pts) => { for (let i = 0; i < pts.length; i += 2) { out.writeUInt16LE(qx(pts[i]), o); o += 2; out.writeUInt16LE(qy(pts[i + 1]), o); o += 2; } };
for (const t of tiles) {
  out.writeUInt32LE(t.tx, o); o += 4;
  out.writeUInt32LE(t.ty, o); o += 4;
  out.writeUInt16LE(t.roads.length, o); o += 2;
  out.writeUInt16LE(t.water.length, o); o += 2;
  out.writeUInt16LE(t.greens.length, o); o += 2;
  out.writeUInt16LE(t.beaches.length, o); o += 2;
  for (const r of t.roads) {
    out.writeUInt16LE(r.typeIdx, o); o += 2;
    out.writeUInt32LE(r.nameIdx, o); o += 4;
    out.writeFloatLE(r.width, o); o += 4;
    out.writeUInt16LE(r.pts.length / 2, o); o += 2;
    wPts(r.pts);
  }
  for (const w of t.water)   { out.writeUInt16LE(w.pts.length / 2, o); o += 2; wPts(w.pts); }
  for (const g of t.greens)  { out.writeUInt16LE(g.pts.length / 2, o); o += 2; wPts(g.pts); }
  for (const b of t.beaches) { out.writeUInt16LE(b.pts.length / 2, o); o += 2; wPts(b.pts); }
}

fs.writeFileSync(outPath, out);
console.log(`[citymap] ${tiles.length} tiles → roads ${nRoads}, water ${nWater}, greens ${nGreens}, beaches ${nBeaches}`);
console.log(`[citymap] wrote ${outPath} (${(out.length / 1048576).toFixed(2)} MB, ${nameTable.length} names, ${typeTable.length} road types)`);
