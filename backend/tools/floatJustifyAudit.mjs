/**
 * N-54 · IS A FLOATING ROAD HOLDING ANYTHING UP?
 *
 * 79 surface roads still sit more than 2 m above their own terrain (35 ramps, 44 not), worst 24 m.
 * The cause is the layer model: OSM `layer` is TOPOLOGICAL — it says what crosses what — and the
 * bake reads it as metres, `layer x LAYER_STEP`. A street tagged layer=2 beside flat ground is
 * hoisted 12 m whether or not anything passes under it.
 *
 * The locked vertical-model spec lists LAYER_STEP=6 as correct and I am not touching it. The
 * question this asks is narrower and does not require touching it: for each floating road, does any
 * OTHER way actually pass BENEATH it? A road that crosses something has earned its height. A road
 * with clear ground under it has not, and its elevation is an artefact of a tag.
 *
 * Read-only. Counts the population before any fix is written.
 */
import fs from 'node:fs'; import path from 'node:path';
const ROOT = 'backend/tiles/barcelona', R = 6378137;
const FLOAT_M = 2.0;
const UNDER_CLEAR_M = 3.0;   // a way this far below counts as passing underneath
const DRIVABLE = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
  'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service']);

const files = [];
(function w(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) {
  const p = path.join(d,e.name); if (e.isDirectory()) w(p); else if (e.name.endsWith('.bin')) files.push(p);
} })(ROOT);

const ways = new Map();
const terrainOf = new Map();
for (const f of files) {
  const b = fs.readFileSync(f); const hl = b.readUInt32LE(0);
  let x = hl; while (x>0 && b[4+x-1]===0) x--;
  let h; try { h = JSON.parse(b.toString('utf8',4,4+x)); } catch { continue; }
  const el = h.elevation; if (!el || el.elevationsOffset === undefined || !h.roads) continue;
  const ab = b.buffer.slice(b.byteOffset+4+hl, b.byteOffset+b.length);
  const grid = new Float32Array(ab, el.elevationsOffset, el.elevationsCount);
  const { south, west, north, east, gridRows, gridCols } = el;
  const S = (lat,lon)=>{ const fy=(lat-south)/(north-south)*(gridRows-1), fx=(lon-west)/(east-west)*(gridCols-1);
    if(!(fx>=0&&fx<=gridCols-1&&fy>=0&&fy<=gridRows-1)) return null;
    const x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(gridCols-1,x0+1),y1=Math.min(gridRows-1,y0+1);
    const tx=fx-x0,ty=fy-y0,G=(r,c)=>grid[r*gridCols+c];
    return (G(y0,x0)*(1-tx)+G(y0,x1)*tx)*(1-ty)+(G(y1,x0)*(1-tx)+G(y1,x1)*tx)*ty; };
  for (const r of h.roads||[]) {
    if (ways.has(r.id) || r.pointsOffset===undefined || r.pointCount<2) continue;
    const p = new Float32Array(ab, r.pointsOffset, r.pointCount*3);
    const pts = [];
    for (let i=0;i<r.pointCount;i++){
      const lon=(p[i*3]/R)*(180/Math.PI), lat=(2*Math.atan(Math.exp(p[i*3+2]/R))-Math.PI/2)*(180/Math.PI);
      const k=Math.cos(lat*Math.PI/180);
      pts.push({x:p[i*3]*k, z:p[i*3+2], y:p[i*3+1], lat, lon, t:S(lat,lon)});
    }
    ways.set(r.id,{id:r.id,type:r.highwayType,name:r.name||'',w:r.width||6,
      br:!!r.bridge,tun:!!r.tunnel,ramp:!!r.isRamp,cross:!!r.crossesTrench,layer:r.layer??0,pts});
  }
}
const C=40,g=new Map();
for(const w of ways.values()) for(let i=0;i<w.pts.length-1;i++){
  const k=`${Math.floor(w.pts[i].x/C)}|${Math.floor(w.pts[i].z/C)}`;
  if(!g.has(k))g.set(k,[]); g.get(k).push({w,i});
}
const near=(x,z)=>{const o=[];for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++){const l=g.get(`${Math.floor(x/C)+a}|${Math.floor(z/C)+b}`);if(l)o.push(...l);}return o;};

let floating=0, justified=0, unjustified=0;
const rows=[];
for (const w of ways.values()) {
  if (w.br || w.tun || w.cross || (w.layer??0) < 0) continue;   // meant to be off the ground
  if (!DRIVABLE.has(w.type)) continue;
  let hi=0, at=null;
  for (const p of w.pts) if (p.t!=null && p.y-p.t>hi) { hi=p.y-p.t; at=p; }
  if (hi<=FLOAT_M || !at) continue;
  floating++;
  // does ANYTHING pass beneath this road, anywhere along it?
  let under=null;
  for (const p of w.pts) {
    if (p.t==null) continue;
    for (const {w:o,i} of near(p.x,p.z)) {
      if (o.id===w.id) continue;
      const a=o.pts[i], b2=o.pts[i+1];
      const dx=b2.x-a.x, dz=b2.z-a.z, l2=dx*dx+dz*dz; if(l2<1e-9) continue;
      const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/l2));
      const d=Math.hypot(p.x-(a.x+t*dx), p.z-(a.z+t*dz));
      if (d > (w.w+o.w)/2) continue;                 // not actually crossing its footprint
      const oy=a.y+t*(b2.y-a.y);
      if (p.y - oy >= UNDER_CLEAR_M) { under={o,clear:p.y-oy}; break; }
    }
    if (under) break;
  }
  if (under) { justified++; }
  else { unjustified++;
    rows.push({h:+hi.toFixed(1), type:w.type, ramp:w.ramp, layer:w.layer,
      name:w.name||'(unnamed)', at:`${at.lat.toFixed(5)},${at.lon.toFixed(5)}`}); }
}
rows.sort((a,b)=>b.h-a.h);
console.log(`drivable SURFACE roads floating > ${FLOAT_M} m above their own terrain: ${floating}`);
console.log(`  something passes BENEATH it (earned its height) : ${justified}`);
console.log(`  clear ground underneath — height is a tag artefact : ${unjustified}\n`);
console.log('worst unjustified:');
console.log('  float  ramp layer  class          name                     spawn');
for (const r of rows.slice(0,14))
  console.log(`  ${String(r.h).padStart(5)}   ${r.ramp?'Y':'.'}   ${String(r.layer).padStart(2)}   ${r.type.padEnd(14)} ${r.name.slice(0,22).padEnd(23)}?mode=fly&spawn=${r.at}`);
