/**
 * N-25 · WHICH SPACE IS EACH BAKED TREE IN?
 *
 * `vegetationBaker.collectAllPositions` pushes two producers into ONE array:
 *   • getRoadsideTreePositions()          reads road.points        → ABSOLUTE MERCATOR
 *   • getBuildingPerimeterTreePositions() reads building.footprint → real-metre WORLD
 * and `convertToBinary` writes whatever it is handed. The frontend's `readBakedVegetation` then
 * converts EVERY entry as if it were Mercator: (v - origin) * cos(lat).
 *
 * So one of the two producers is wrong, in the file, today — and nothing errors, because a tree at
 * the wrong scale is simply somewhere else.
 *
 * Read-only, against the shipped tiles. Usage: node backend/tools/vegSpaceAudit.mjs [tileLimit]
 */
import fs from 'node:fs';
import path from 'node:path';

const R = 6378137;
const ORIGIN_LAT = 41.350, ORIGIN_LON = 2.115;
const UNSTRETCH = Math.cos((ORIGIN_LAT * Math.PI) / 180);
const OX = R * (ORIGIN_LON * Math.PI / 180);
const OY = R * Math.log(Math.tan(Math.PI / 4 + (ORIGIN_LAT * Math.PI / 180) / 2));

// Barcelona world coords run 0–12 km; Mercator eastings are ~235–250 k. Nothing legitimate is in
// between, so the split is unambiguous rather than a threshold anyone has to defend.
const isMercator = (x) => x > 100000;

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.bin')) files.push(p);
  }
})('backend/tiles/barcelona');

const limit = Number(process.argv[2] || 0) || files.length;
let merc = 0, world = 0, tilesMixed = 0, tiles = 0, offTile = 0;

for (const f of files.slice(0, limit)) {
  const b = fs.readFileSync(f);
  const hl = b.readUInt32LE(0);
  let x = hl; while (x > 0 && b[4 + x - 1] === 0) x--;
  let h; try { h = JSON.parse(b.toString('utf8', 4, 4 + x)); } catch { continue; }
  const bv = h.bakedVegetation;
  if (!bv || bv.treePositionsOffset === undefined || !bv.treePositionsCount) continue;
  const ab = b.buffer.slice(b.byteOffset + 4 + hl, b.byteOffset + b.length);
  const tp = new Float32Array(ab, bv.treePositionsOffset, bv.treePositionsCount);
  tiles++;
  let m = 0, w = 0;
  for (let i = 0; i < tp.length; i += 2) {
    if (isMercator(tp[i])) m++; else w++;
    // Where does the frontend actually PUT it? It converts every entry as Mercator.
    const wx = (tp[i] - OX) * UNSTRETCH, wz = (tp[i + 1] - OY) * UNSTRETCH;
    if (!(wx > -1000 && wx < 20000 && wz > -1000 && wz < 20000)) offTile++;
  }
  merc += m; world += w;
  if (m && w) tilesMixed++;
}

const total = merc + world;
console.log(`tiles with baked vegetation : ${tiles}`);
console.log(`baked tree positions        : ${total}`);
console.log(`  looks like MERCATOR       : ${merc}  (${(merc / total * 100).toFixed(1)}%)  <- roadside producer`);
console.log(`  looks like WORLD          : ${world}  (${(world / total * 100).toFixed(1)}%)  <- building-perimeter producer`);
console.log(`tiles holding BOTH spaces   : ${tilesMixed} of ${tiles}`);
console.log(`\nafter readBakedVegetation's Mercator conversion, positions landing OUTSIDE`);
console.log(`the 0-20 km Barcelona world box : ${offTile}  (${(offTile / total * 100).toFixed(1)}%)`);
