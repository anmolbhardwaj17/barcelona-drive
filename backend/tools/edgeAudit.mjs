/**
 * EDGE AUDIT — where does the carriageway have a drop beside it that nothing protects?
 *
 * The premise the road system has been built on is wrong. It asks OSM "is this a bridge?", gets 63
 * yes-answers across the whole of Barcelona, and protects those. But a drop beside a road does not
 * come only from bridges: it comes from ramps, from cuttings, from the daylighted tunnel trenches
 * (Option L carves the terrain away and the road beside the cut is left at the lip), and from any
 * embankment. OSM does not tag any of that, and never will.
 *
 * So this measures the thing that actually matters, from the shipped tiles: sample the terrain a
 * little way off each side of every carriageway, and ask HOW FAR DOWN IT IS. A metre of drop beside
 * a lane is a fall. It does not care what OSM called the road.
 *
 * Also measures curvature, because a sharp bend wants a barrier whether or not there is a drop —
 * that is what a crash barrier is for, and no tag will ever supply it.
 *
 * Read-only over baked tiles. No bake, no PBF.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', 'tiles', 'barcelona');
const R_EARTH = 6378137;
const DROP_M = Number(process.env.DROP_M ?? 1.5);   // fall beside the lane that warrants an edge
const PROBE_M = Number(process.env.PROBE_M ?? 3.0); // how far off the edge to sample
const SHARP_R = Number(process.env.SHARP_R ?? 60);  // turn radius (m) below which a bend is "sharp"
const DRIVABLE = new Set(['motorway','trunk','primary','secondary','tertiary','unclassified',
  'residential','living_street','service','motorway_link','trunk_link','primary_link',
  'secondary_link','tertiary_link','busway']);

const files = [];
(function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) {
  const p = path.join(d,e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.bin')) files.push(p);
} })(ROOT);

let checked = 0, withDrop = 0, protectedAlready = 0, unprotected = 0, sharpUnprotected = 0;
const byType = {}, worst = [];
let sharpTotal = 0, sharpFast = 0;
const sharpByType = {};
const FAST = new Set(['motorway','trunk','primary','secondary','tertiary',
  'motorway_link','trunk_link','primary_link','secondary_link','tertiary_link']);

for (const f of files) {
  const b = fs.readFileSync(f); const hl = b.readUInt32LE(0);
  let e = hl; while (e > 0 && b[4+e-1] === 0) e--;
  let h; try { h = JSON.parse(b.toString('utf8',4,4+e)); } catch { continue; }
  const el = h.elevation, roads = h.roads;
  if (!el || el.elevationsOffset === undefined || !roads) continue;
  const ab = b.buffer.slice(b.byteOffset+4+hl, b.byteOffset+b.length);
  const grid = new Float32Array(ab, el.elevationsOffset, el.elevationsCount);
  const { south, west, north, east, gridRows, gridCols } = el;
  const sample = (lat, lon) => {
    const fy = (lat-south)/(north-south)*(gridRows-1), fx = (lon-west)/(east-west)*(gridCols-1);
    if (!(fx>=0 && fx<=gridCols-1 && fy>=0 && fy<=gridRows-1)) return null;
    const x0=Math.floor(fx), y0=Math.floor(fy), x1=Math.min(gridCols-1,x0+1), y1=Math.min(gridRows-1,y0+1);
    const tx=fx-x0, ty=fy-y0, g=(r,c)=>grid[r*gridCols+c];
    return (g(y0,x0)*(1-tx)+g(y0,x1)*tx)*(1-ty) + (g(y1,x0)*(1-tx)+g(y1,x1)*tx)*ty;
  };
  const toLL = (mx,my) => ({ lon: (mx/R_EARTH)*(180/Math.PI),
                             lat: (2*Math.atan(Math.exp(my/R_EARTH))-Math.PI/2)*(180/Math.PI) });

  for (const r of roads) {
    if (!DRIVABLE.has(r.highwayType)) continue;
    if (r.tunnel || r.pointsOffset === undefined || r.pointCount < 3) continue;
    const f32 = new Float32Array(ab, r.pointsOffset, r.pointCount*3);
    // the renderer's own gate — anything true here ALREADY gets a rail
    const guarded = !!(r.bridge || r.isRamp || (r.layer ?? 0) > 0 || r.crossesTrench);
    const halfW = (r.width || 6) / 2;
    let roadDrop = 0, roadSharp = false;

    for (let i = 1; i < r.pointCount - 1; i++) {
      const j = i*3;
      const ax = f32[j-3], az = f32[j-1], bx = f32[j], bz = f32[j+2], cx = f32[j+3], cz = f32[j+5];
      // perpendicular in mercator; metres-per-mercator-unit is ~cos(lat) but cancels for a unit vector
      let dx = cx-ax, dz = cz-az; const len = Math.hypot(dx,dz) || 1; dx/=len; dz/=len;
      const px = -dz, pz = dx;
      const deckY = f32[j+1];
      // metres -> mercator at this latitude
      const { lat } = toLL(bx, bz);
      const mPerUnit = Math.cos(lat*Math.PI/180);
      const off = (halfW + PROBE_M) / mPerUnit;
      for (const sgn of [1,-1]) {
        const ll = toLL(bx + px*off*sgn, bz + pz*off*sgn);
        const t = sample(ll.lat, ll.lon);
        if (t == null) continue;
        const drop = deckY - t;
        if (drop > roadDrop) roadDrop = drop;
      }
      // curvature: circumradius of the three consecutive points, in metres
      const A = Math.hypot(bx-ax, bz-az)*mPerUnit, B = Math.hypot(cx-bx, cz-bz)*mPerUnit,
            C = Math.hypot(cx-ax, cz-az)*mPerUnit;
      const s2 = Math.abs((bx-ax)*(cz-az)-(cx-ax)*(bz-az))*mPerUnit*mPerUnit/2;
      if (s2 > 1e-6 && A>1 && B>1) { const R = (A*B*C)/(4*s2); if (R < SHARP_R) roadSharp = true; }
    }
    checked++;
    if (roadSharp) sharpTotal++;
    if (roadDrop > DROP_M) {
      withDrop++;
      if (guarded) protectedAlready++;
      else {
        unprotected++;
        byType[r.highwayType] = (byType[r.highwayType]||0)+1;
        worst.push({ id: r.id, type: r.highwayType, drop: +roadDrop.toFixed(1) });
      }
    }
    // A crash barrier is a FAST-ROAD object. A tight service yard or a residential corner does not
    // want one — it wants a kerb. Sizing the fix by class is what keeps 3,333 from becoming 3,333
    // pieces of unwanted geometry.
    if (roadSharp && !guarded && roadDrop <= DROP_M) {
      sharpUnprotected++;
      if (FAST.has(r.highwayType)) { sharpFast++; sharpByType[r.highwayType] = (sharpByType[r.highwayType]||0)+1; }
    }
  }
}

console.log(`drivable road segments checked : ${checked.toLocaleString()}`);
console.log(`with a drop > ${DROP_M} m beside the lane : ${withDrop.toLocaleString()}`);
console.log(`   already guarded (bridge/ramp/layer/trench) : ${protectedAlready.toLocaleString()}`);
console.log(`   ⚠ UNPROTECTED                              : ${unprotected.toLocaleString()}`);
console.log(`sharp bends (R < ${SHARP_R} m), unguarded, no drop : ${sharpUnprotected.toLocaleString()} (of ${sharpTotal.toLocaleString()} sharp)`);
console.log(`   of those, on FAST roads (a crash barrier's actual job) : ${sharpFast.toLocaleString()}`);
console.log('   sharp-bend fast roads by type:', sharpByType);
console.log('\nunprotected drops by road type:', Object.fromEntries(Object.entries(byType).sort((a,b)=>b[1]-a[1]).slice(0,10)));
worst.sort((a,b)=>b.drop-a.drop);
console.log('\nworst unprotected drops:');
for (const w of worst.slice(0,10)) console.log(`   id ${String(w.id).padStart(11)}  ${String(w.type).padEnd(14)} ${w.drop} m`);
