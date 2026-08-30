/**
 * N-55 · WHY DID THE FIXER REFUSE THIS DEAD END?
 *
 * The N-52 overlap gates fixed the z-fighting the user reported (313 of 366 connectors were being
 * drawn INSIDE an existing ribbon) and cost 7 dead ends doing it: score>=8 went 49 -> 56. That is a
 * debt, and paying it starts with knowing WHICH gate refused.
 *
 * The two gates want opposite fixes:
 *   HAIRLINE       the ends already touch. Nothing is wanted — refusing is correct and final.
 *   ON EXISTING    a road ALREADY RUNS along the path. The street DOES continue, as a different
 *                  way — so what is missing is a topological JOIN, not a new ribbon. Drawing one
 *                  is what caused the z-fighting; welding the endpoint costs no geometry at all.
 *
 * Measured against the SHIPPED tiles, so every dead end counted here is one the rules actually
 * refused — not one they never saw.
 */
import fs from 'node:fs'; import path from 'node:path';
const R = 6378137;
const DRIVABLE = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
  'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service']);
const JOIN_TOL_M = 1.0;      // an endpoint this close to another way is already joined
const REACH_M    = 90;       // rule 9's reach
const CONE_COS   = Math.cos(53 * Math.PI / 180);

const files = [];
(function w(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) {
  const p = path.join(d,e.name); e.isDirectory() ? w(p) : e.name.endsWith('.bin') && files.push(p);
} })('backend/tiles/barcelona');

const ways = new Map();
for (const f of files) {
  const b = fs.readFileSync(f); const hl = b.readUInt32LE(0);
  let x = hl; while (x>0 && b[4+x-1]===0) x--;
  let h; try { h = JSON.parse(b.toString('utf8',4,4+x)); } catch { continue; }
  const ab = b.buffer.slice(b.byteOffset+4+hl, b.byteOffset+b.length);
  for (const r of h.roads||[]) {
    if (ways.has(r.id) || r.pointsOffset===undefined || r.pointCount<2) continue;
    const p = new Float32Array(ab, r.pointsOffset, r.pointCount*3), pts=[];
    for (let i=0;i<r.pointCount;i++){
      const lon=(p[i*3]/R)*(180/Math.PI), lat=(2*Math.atan(Math.exp(p[i*3+2]/R))-Math.PI/2)*(180/Math.PI);
      pts.push({ x:p[i*3]*Math.cos(lat*Math.PI/180), z:p[i*3+2], lat, lon });
    }
    ways.set(r.id,{ id:r.id, type:r.highwayType, name:r.name||'', w:r.width||6, tun:!!r.tunnel, pts });
  }
}

const C = 60, grid = new Map();
for (const w of ways.values()) for (let i=0;i<w.pts.length;i++){
  const k = `${Math.floor(w.pts[i].x/C)}|${Math.floor(w.pts[i].z/C)}`;
  if (!grid.has(k)) grid.set(k,[]); grid.get(k).push({ w, i });
}
const near = (x,z,r=1) => { const o=[]; for(let a=-r;a<=r;a++) for(let b=-r;b<=r;b++){
  const l = grid.get(`${Math.floor(x/C)+a}|${Math.floor(z/C)+b}`); if(l) o.push(...l); } return o; };

/** Does any OTHER way's ribbon cover this point? */
function coveredBy(x, z, skipA, skipB) {
  for (const { w:o, i } of near(x,z)) {
    if (o.id===skipA || o.id===skipB || o.tun) continue;
    for (const j of [i-1, i]) {
      if (j < 0 || j >= o.pts.length-1) continue;
      const a=o.pts[j], b=o.pts[j+1];
      const dx=b.x-a.x, dz=b.z-a.z, l2=dx*dx+dz*dz; if (l2<1e-9) continue;
      const t=Math.max(0,Math.min(1,((x-a.x)*dx+(z-a.z)*dz)/l2));
      if (Math.hypot(x-(a.x+t*dx), z-(a.z+t*dz)) < o.w/2) return o;
    }
  }
  return null;
}

// ── THE SCORE COUNTS CORRECT ENDINGS AS DEFECTS (N-55) ────────────────────────────────────────
// deadEndTriage scores wrongness as class x2 + name-ahead + width + length. Nothing in that asks
// whether the road SHOULD continue as a road. Reading the top of the list one by one:
//   Esteve Terradas (12)  its continuation is `Carrer d'Esteve Terradas [footway]` — the street
//                         really does become pedestrian, and joining tertiary to footway is wrong.
//   Ronda de Dalt   (11)  layer=-1, tunnel. A tunnel PORTAL. The road continues underground.
//   Ronda Litoral   (11)  same.
// So "score >= 8 = 56" is not 56 defects, and the 49 -> 56 regression is partly a metric artefact.
// Classify the ending instead of scoring it.
const PEDESTRIAN = new Set(['footway','pedestrian','path','steps','cycleway','track','corridor']);
let unjoined=0, noCont=0, hairline=0, onExisting=0, genuineGap=0;
let endsPedestrian=0, endsTunnel=0, endsDrivable=0;
const realDefects=[];
const weldable=[];
for (const w of ways.values()) {
  if (!DRIVABLE.has(w.type)) continue;
  for (const end of [0, 1]) {
    const p = end ? w.pts[w.pts.length-1] : w.pts[0];
    const q = end ? w.pts[w.pts.length-2] : w.pts[1];
    // already joined to something?
    let joined = false;
    for (const { w:o, i } of near(p.x,p.z)) {
      if (o.id===w.id) continue;
      if (Math.hypot(o.pts[i].x-p.x, o.pts[i].z-p.z) < JOIN_TOL_M) { joined = true; break; }
    }
    if (joined) continue;
    unjoined++;
    // outward direction
    const dx=p.x-q.x, dz=p.z-q.z, dl=Math.hypot(dx,dz)||1;
    const ux=dx/dl, uz=dz/dl;
    // best continuation ahead, in the cone
    let best=null;
    for (const { w:o, i } of near(p.x,p.z,2)) {
      if (o.id===w.id || o.tun) continue;
      const c=o.pts[i];
      const vx=c.x-p.x, vz=c.z-p.z, d=Math.hypot(vx,vz);
      if (d<0.5 || d>REACH_M) continue;
      if ((vx/d)*ux + (vz/d)*uz < CONE_COS) continue;
      if (!best || d<best.d) best={ o, c, d };
    }
    if (!best) { noCont++; continue; }

    // ── WHAT KIND OF ENDING IS THIS? ─────────────────────────────────────────────────────────
    // A tunnel portal and a street that turns into a rambla are both "unjoined ends" and neither
    // is a missing connector. Only an end with a DRIVABLE continuation ahead is a defect.
    const ahead = near(p.x, p.z, 2).map(({ w:o }) => o).filter((o) => {
      if (o.id === w.id) return false;
      const c = o.pts.reduce((m, q) => {
        const d = Math.hypot(q.x-p.x, q.z-p.z); return d < m.d ? { d, q } : m;
      }, { d: Infinity });
      if (!(c.d > 0.5 && c.d <= REACH_M)) return false;
      return ((c.q.x-p.x)/c.d)*ux + ((c.q.z-p.z)/c.d)*uz >= CONE_COS;
    });
    const drivableAhead = ahead.filter(o => DRIVABLE.has(o.type) && !o.tun);
    if (w.tun || w.layer < 0) { endsTunnel++; continue; }
    if (drivableAhead.length === 0) {
      if (ahead.some(o => PEDESTRIAN.has(o.type))) endsPedestrian++; else noCont++;
      continue;
    }
    endsDrivable++;
    // Evidence is collected here but NOT counted yet. The first version pushed at this point and
    // the list filled with 2 m gaps between two 6 m service roads — ends already touching, which
    // the hairline gate exists to dismiss. A defect list has to survive the same gates the fixer
    // applies, or it is just a list of endings.
    // ⚠ The gap and the evidence MUST come from the same road. The first version gated on
    // `best.d` — the nearest way in the cone — while naming the matched way, so a 9 m reading could
    // belong to a different road than the one sharing the name. That is the N-1 shape again:
    // measuring one thing and deciding about another.
    const nearestTo = (o) => o.pts.reduce((m, q) => Math.min(m, Math.hypot(q.x-p.x, q.z-p.z)), Infinity);
    const sameName = drivableAhead.find(o => o.name && o.name === w.name);
    const sameClass = drivableAhead.find(o => o.type === w.type);
    const matched = sameName || sameClass;
    const matchD = matched ? nearestTo(matched) : Infinity;
    // The matched road must clear the SAME hairline gate the fixer applies, measured against ITS
    // width — not the nearest way's.
    const matchRealGap = matched && matchD > (w.w + matched.w) / 2 + 1;
    const evidence = sameName
      ? (sameName.type === w.type ? 'same name AND class' : 'same name, other class')
      : (sameClass ? 'same class, other name' : null);
    const defect = evidence && matchRealGap
      ? { name: w.name || '(unnamed)', type: w.type, d: +matchD.toFixed(0), why: evidence,
          at: `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` }
      : null;
    // gate 1 — hairline
    if (!(best.d > (w.w + best.o.w)/2 + 1)) { hairline++; continue; }
    // gate 2 — does a road already lie along the path?
    let inside=0; const S=8; let cover=null;
    for (let k=0;k<=S;k++){
      const f=k/S, cx=p.x+(best.c.x-p.x)*f, cz=p.z+(best.c.z-p.z)*f;
      const hit=coveredBy(cx,cz,w.id,best.o.id);
      if (hit) { inside++; cover=cover||hit; }
    }
    if (inside/(S+1) > 0.5) {
      onExisting++;
      weldable.push({ name:w.name||'(unnamed)', type:w.type, d:+best.d.toFixed(0),
        onto:cover?.name || cover?.type || '?', at:`${p.lat.toFixed(5)},${p.lon.toFixed(5)}` });
    } else {
      genuineGap++;
      if (defect) realDefects.push(defect);
    }
  }
}
console.log(`unjoined drivable ends            : ${unjoined}`);
console.log(`  ── what kind of ending is it? ──`);
console.log(`  TUNNEL PORTAL (continues below)  : ${endsTunnel}   <- correct, not a defect`);
console.log(`  BECOMES PEDESTRIAN               : ${endsPedestrian}   <- correct, not a defect`);
console.log(`  DRIVABLE ROAD AHEAD              : ${endsDrivable}   <- the only real candidates`);
console.log(`    of those, same name or class   : ${endsDrivable ? '(gated below)' : 0}\n`);
console.log(`  no continuation ahead (real end): ${noCont}`);
console.log(`  HAIRLINE  ends already touching : ${hairline}   <- refusing is correct and final`);
console.log(`  ON EXISTING ROAD                : ${onExisting}   <- a WELD, not a connector`);
console.log(`  genuine gap, still unexplained  : ${genuineGap}\n`);
realDefects.sort((a,b)=>a.d-b.d);
// ── EVIDENCE TIERS, BECAUSE "SAME CLASS" IS BARELY EVIDENCE ───────────────────────────────────
// Two unnamed service roads in adjacent car parks are both `service`; that says nothing about them
// being one road. A shared NAME is the strong signal, and it is the one rule 9 already trusts.
// Splitting the 258 by tier is what decides whether a new rule is worth writing and how safe it is.
const tiers = {};
for (const r of realDefects) tiers[r.why] = (tiers[r.why] || 0) + 1;
const named = realDefects.filter(r => r.why.startsWith('same name'));
console.log('evidence tiers:');
for (const [k, v] of Object.entries(tiers).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log(`\nNAME-BACKED only (the safely actionable set): ${named.length}`);
console.log('  gap  class          name                      evidence               spawn');
for (const r of named.sort((a,b)=>a.d-b.d).slice(0,14))
  console.log(`  ${String(r.d).padStart(3)}  ${r.type.padEnd(14)} ${r.name.slice(0,24).padEnd(25)} ${r.why.padEnd(22)} ?mode=fly&spawn=${r.at}`);
console.log('');
console.log(`(all ${realDefects.length} defects, weakest evidence included, follow)`);
console.log('  gap  class          name                      evidence               spawn');
for (const r of realDefects.slice(0,14))
  console.log(`  ${String(r.d).padStart(3)}  ${r.type.padEnd(14)} ${r.name.slice(0,24).padEnd(25)} ${r.why.padEnd(22)} ?mode=fly&spawn=${r.at}`);
console.log('');
weldable.sort((a,b)=>a.d-b.d);
console.log('weldable — the street continues, as another way:');
console.log('  gap  class          name                      lies on                  spawn');
for (const r of weldable.slice(0,12))
  console.log(`  ${String(r.d).padStart(3)}  ${r.type.padEnd(14)} ${r.name.slice(0,24).padEnd(25)} ${String(r.onto).slice(0,22).padEnd(23)} ?mode=fly&spawn=${r.at}`);
