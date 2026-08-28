/**
 * ROUNDABOUT RAIL AUDIT — how much elevated roundabout is currently unrailed, and why?
 *
 * User report: "this is a floating roundabout but here we dont have proper ramp on it, this is
 * risky". Two independent rules in `computeGuardRailMask` both delete rails from a roundabout, and
 * this measures each separately — because they need different fixes and a single total would hide
 * which one is doing the damage.
 *
 *   A · the CLOSED-LOOP rejection.  `isElevatedGuardRailRoad` line 1: `if (road.closedLoop) return
 *       false`. A roundabout ring is one closed way, so the ring itself is never even considered.
 *   B · the PROXIMITY ZONE.  rule 3 zeroes every point within (ring radius + 22 m) of a roundabout
 *       centre — which also eats the rails off the elevated APPROACH roads feeding it.
 *
 * Both rules are right for a roundabout on the ground: a ring of barrier around a normal
 * roundabout would wall off every entry. Neither is right for one on a deck.
 *
 * Read-only over baked tiles.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', 'tiles', 'barcelona');
const R_EARTH = 6378137;
const DROP_M = 1.5;      // LATERAL_DROP_M
const PROBE_M = 3.0;     // LATERAL_PROBE_M
const PROX_M = 22;       // GUARD_RAIL_ROUNDABOUT_PROX
const DRIVABLE = new Set(['motorway','trunk','primary','secondary','tertiary','unclassified',
  'residential','living_street','service','motorway_link','trunk_link','primary_link',
  'secondary_link','tertiary_link','busway']);

const files = [];
(function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) {
  const p = path.join(d,e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.bin')) files.push(p);
} })(ROOT);

const seen = new Set();
let loops = 0, loopsElevated = 0, ringsFlagged = 0;
let approachChecked = 0, approachElevatedInZone = 0;
const worst = [];

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

  // ── the renderer's own roundabout-zone detector, on this tile's roads ──
  const zones = [];
  for (const r of roads) {
    if (r.tunnel || r.pointsOffset === undefined || r.pointCount < 3) continue;
    const p = new Float32Array(ab, r.pointsOffset, r.pointCount*3);
    const n = r.pointCount;
    const dx = p[(n-1)*3]-p[0], dz = p[(n-1)*3+2]-p[2];
    const { lat } = toLL(p[0], p[2]); const mPerUnit = Math.cos(lat*Math.PI/180);
    const closeM = Math.hypot(dx,dz)*mPerUnit;
    if (!(r.closedLoop || closeM < 5)) continue;
    let cx=0, cz=0; for (let i=0;i<n;i++){ cx+=p[i*3]; cz+=p[i*3+2]; } cx/=n; cz/=n;
    let maxD=0; for (let i=0;i<n;i++){ const d=(p[i*3]-cx)**2+(p[i*3+2]-cz)**2; if(d>maxD) maxD=d; }
    const rad = Math.sqrt(maxD)*mPerUnit + PROX_M;
    zones.push({ cx, cz, radM: rad, mPerUnit });
  }

  for (const r of roads) {
    if (!DRIVABLE.has(r.highwayType)) continue;
    if (r.tunnel || r.pointsOffset === undefined || r.pointCount < 3) continue;
    if (seen.has(r.id)) continue;   // H18: every tile carries the FULL way
    seen.add(r.id);
    const p = new Float32Array(ab, r.pointsOffset, r.pointCount*3);
    const halfW = (r.width || 6) / 2;
    let drop = 0;
    for (let i = 1; i < r.pointCount - 1; i++) {
      const j = i*3;
      let dx = p[j+3]-p[j-3], dz = p[j+5]-p[j-1];
      const len = Math.hypot(dx,dz) || 1; dx/=len; dz/=len;
      const { lat } = toLL(p[j], p[j+2]);
      const mPerUnit = Math.cos(lat*Math.PI/180);
      const off = (halfW + PROBE_M) / mPerUnit;
      for (const sgn of [1,-1]) {
        const ll = toLL(p[j] + -dz*off*sgn, p[j+2] + dx*off*sgn);
        const t = sample(ll.lat, ll.lon);
        if (t == null) continue;
        if (p[j+1] - t > drop) drop = p[j+1] - t;
      }
    }
    const elevated = drop > DROP_M;
    const n = r.pointCount;
    const { lat: la0 } = toLL(p[0], p[2]); const mpu = Math.cos(la0*Math.PI/180);
    const closeM = Math.hypot(p[(n-1)*3]-p[0], p[(n-1)*3+2]-p[2])*mpu;
    const isRing = !!(r.closedLoop || r.isRoundabout || closeM < 5);

    if (r.closedLoop) { loops++; if (elevated) loopsElevated++; }
    if (isRing && elevated) {
      ringsFlagged++;
      const mid = Math.floor(n/2)*3;
      const ll = toLL(p[mid], p[mid+2]);
      worst.push({ id:r.id, type:r.highwayType, drop:+drop.toFixed(1), why:
        r.closedLoop ? 'A closedLoop' : (r.isRoundabout ? 'A isRoundabout' : 'A ends-meet'),
        lat:+ll.lat.toFixed(5), lon:+ll.lon.toFixed(5) });
    } else {
      approachChecked++;
      if (elevated) {
        // does its MIDPOINT sit inside a roundabout proximity zone? (rule B)
        const mid = Math.floor(n/2)*3;
        for (const z of zones) {
          const d = Math.hypot(p[mid]-z.cx, p[mid+2]-z.cz) * z.mPerUnit;
          if (d < z.radM) {
            approachElevatedInZone++;
            const ll = toLL(p[mid], p[mid+2]);
            worst.push({ id:r.id, type:r.highwayType, drop:+drop.toFixed(1), why:'B in-zone',
                         lat:+ll.lat.toFixed(5), lon:+ll.lon.toFixed(5) });
            break;
          }
        }
      }
    }
  }
}

console.log(`closed-loop ways                              : ${loops.toLocaleString()}`);
console.log(`   of those, ELEVATED (drop > ${DROP_M} m beside)  : ${loopsElevated.toLocaleString()}`);
console.log(`RING ways (loop / isRoundabout / ends meet) elevated and unrailed by rule A : ${ringsFlagged}`);
console.log(`non-ring roads checked                        : ${approachChecked.toLocaleString()}`);
console.log(`   elevated AND inside a roundabout zone : ${approachElevatedInZone}`);
console.log('   ⚠ This counts the DATA, not the renderer. N-36 fixed rule B in roadRenderer.js, so');
console.log('     this number does NOT drop after the fix and must not be read as "still broken".');
console.log('     It is the size of the population the height test now protects. Use');
console.log('     window._ddRailStats() to see what the renderer actually did on a load.');
worst.sort((a,b)=>b.drop-a.drop);
console.log('\nworst — drive to these:');
for (const w of worst.filter(w=>process.env.ONLY_A? w.why.startsWith("A"):true).slice(0,15))
  console.log(`   ${String(w.drop).padStart(5)} m  ${w.why.padEnd(15)} ${String(w.type).padEnd(14)} ?spawn=${w.lat},${w.lon}  (way ${w.id})`);
