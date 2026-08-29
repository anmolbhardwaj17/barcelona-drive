/**
 * N-49 · ROADS THAT SIMPLY END.
 *
 * User, repeatedly, with screenshots: a carriageway runs along and then stops on open grass — no
 * cut, no continuation, nothing beyond it.
 *
 * ⚠ POPULATION FIRST. N-48 was built before it was counted and turned out to apply to 2 ways in the
 * whole city. So this counts and CLASSIFIES before any fix is written, because "a road ends" has
 * several very different causes and they need different repairs:
 *
 *   · at the REGION EDGE          — correct. The world stops there.
 *   · a real cul-de-sac           — correct. Barcelona has thousands.
 *   · something CONTINUES ahead   — a missed connection: rule 7/8 territory.
 *   · nothing ahead at all        — the way's continuation is absent from the tiles: either OSM
 *                                   never had it, or the bake dropped it (BrokenRamp still skips 29).
 */
import fs from 'node:fs'; import path from 'node:path';
const ROOT = 'backend/tiles/barcelona', R = 6378137;
const JOIN_TOL = 3;      // m — a vertex this close counts as joined
const LOOK_M   = 90;     // m — how far ahead to look for a continuation
const CONE_COS = 0.5;    // ~60° cone ahead of the stub
const EDGE_M   = 250;    // m — this close to the region bbox is "the world ends here"
const DRIVABLE = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
  'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service']);

const files = [];
(function w(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) {
  const p = path.join(d,e.name); if (e.isDirectory()) w(p); else if (e.name.endsWith('.bin')) files.push(p);
} })(ROOT);

const ways = new Map();
let minLat=Infinity,maxLat=-Infinity,minLon=Infinity,maxLon=-Infinity;
for (const f of files) {
  const b = fs.readFileSync(f); const hl = b.readUInt32LE(0);
  let x = hl; while (x>0 && b[4+x-1]===0) x--;
  let h; try { h = JSON.parse(b.toString('utf8',4,4+x)); } catch { continue; }
  const ab = b.buffer.slice(b.byteOffset+4+hl, b.byteOffset+b.length);
  for (const r of h.roads || []) {
    if (ways.has(r.id) || r.pointsOffset === undefined || r.pointCount < 2) continue;
    if (!DRIVABLE.has(r.highwayType)) continue;
    const p = new Float32Array(ab, r.pointsOffset, r.pointCount*3);
    const pts = [];
    for (let i=0;i<r.pointCount;i++){
      const lon=(p[i*3]/R)*(180/Math.PI);
      const lat=(2*Math.atan(Math.exp(p[i*3+2]/R))-Math.PI/2)*(180/Math.PI);
      const k=Math.cos(lat*Math.PI/180);
      pts.push({x:p[i*3]*k, z:p[i*3+2], lat, lon});
      if(lat<minLat)minLat=lat; if(lat>maxLat)maxLat=lat;
      if(lon<minLon)minLon=lon; if(lon>maxLon)maxLon=lon;
    }
    ways.set(r.id,{id:r.id,type:r.highwayType,name:r.name||'',tunnel:!!r.tunnel,pts});
  }
}
const CELL=50, grid=new Map();
for(const w of ways.values()) for(let i=0;i<w.pts.length;i++){
  const k=`${Math.floor(w.pts[i].x/CELL)}|${Math.floor(w.pts[i].z/CELL)}`;
  if(!grid.has(k))grid.set(k,[]); grid.get(k).push({w,i});
}
const near=(x,z,rad)=>{const o=[];const c=Math.ceil(rad/CELL);
  for(let a=-c;a<=c;a++)for(let b2=-c;b2<=c;b2++){const l=grid.get(`${Math.floor(x/CELL)+a}|${Math.floor(z/CELL)+b2}`); if(l)o.push(...l);} return o;};

const cls = { atEdge:0, joined:0, continuesAhead:0, nothingAhead:0 };
const rows = [];
for (const w of ways.values()) {
  for (const ei of [0, w.pts.length-1]) {
    const e = w.pts[ei];
    // joined?
    let joined=false;
    for(const {w:o,i} of near(e.x,e.z,JOIN_TOL+2)){
      if(o.id===w.id) continue;
      if(Math.hypot(o.pts[i].x-e.x,o.pts[i].z-e.z)<=JOIN_TOL){joined=true;break;}
    }
    if(joined){cls.joined++;continue;}
    // at the region edge?
    const dEdge = Math.min((e.lat-minLat)*111320,(maxLat-e.lat)*111320,
      (e.lon-minLon)*111320*Math.cos(e.lat*Math.PI/180),(maxLon-e.lon)*111320*Math.cos(e.lat*Math.PI/180));
    if(dEdge < EDGE_M){cls.atEdge++;continue;}
    // heading outward
    const inner = w.pts[ei===0?1:w.pts.length-2];
    let sx=e.x-inner.x, sz=e.z-inner.z; const sl=Math.hypot(sx,sz)||1; sx/=sl; sz/=sl;
    // anything ahead, in a cone?
    let ahead=null;
    for(const {w:o,i} of near(e.x,e.z,LOOK_M)){
      if(o.id===w.id) continue;
      const q=o.pts[i]; const dx=q.x-e.x, dz=q.z-e.z; const d=Math.hypot(dx,dz);
      if(d<1||d>LOOK_M) continue;
      if((dx*sx+dz*sz)/d < CONE_COS) continue;
      if(!ahead||d<ahead.d) ahead={d,o};
    }
    if(ahead){cls.continuesAhead++; rows.push({kind:'continuesAhead',gap:+ahead.d.toFixed(0),
      a:w.name||w.type, b:ahead.o.name||ahead.o.type, at:`${e.lat.toFixed(5)},${e.lon.toFixed(5)}`});}
    else {cls.nothingAhead++; rows.push({kind:'nothingAhead',gap:null,
      a:w.name||w.type, b:'—', at:`${e.lat.toFixed(5)},${e.lon.toFixed(5)}`});}
  }
}
const tot=cls.atEdge+cls.joined+cls.continuesAhead+cls.nothingAhead;
console.log(`drivable way ends: ${tot.toLocaleString()}\n`);
console.log(`  joined to something          : ${cls.joined.toLocaleString()}`);
console.log(`  at the region edge (correct)  : ${cls.atEdge}`);
console.log(`  DEAD END, something ahead <${LOOK_M}m : ${cls.continuesAhead}   <- a missed connection`);
console.log(`  DEAD END, nothing ahead       : ${cls.nothingAhead}   <- cul-de-sac, or the continuation is missing`);
console.log('\nclosest "something ahead" — these are the ones that look broken:');
rows.filter(r=>r.kind==='continuesAhead').sort((a,b)=>a.gap-b.gap).slice(0,10)
  .forEach(r=>console.log(`  ${String(r.gap).padStart(3)} m  ${r.a.slice(0,26).padEnd(27)} -> ${r.b.slice(0,24).padEnd(25)} ?mode=fly&spawn=${r.at}`));
