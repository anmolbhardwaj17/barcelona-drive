/**
 * ROADS THAT MEET IN PLAN BUT NOT IN HEIGHT.
 *
 * User: "if you see them from top they look merged but actually there is height difference — why is
 * our common sense engine not able to find this?"
 *
 * Fair question, and rule 8 is the reason: it requires equal layer/bridge/tunnel and files the rest
 * as "needs a ramp". That framing assumes the height difference is REAL. If two ends sit within a
 * couple of metres of each other in plan with nothing between them, a ramp is the wrong answer —
 * they are one junction and one of the two heights is wrong.
 *
 * This prints WHY each pair differs in height, so the answer comes from the tags rather than from
 * my assumption about them: is it a bridge, a tunnel, a layer disagreement, or nothing at all?
 */
import fs from 'node:fs'; import path from 'node:path';
const ROOT='backend/tiles/barcelona', R=6378137;
const PLAN_M = Number(process.env.PLAN_M ?? 4);   // how close in plan counts as "the same place"
const DY_M   = Number(process.env.DY_M   ?? 1.0); // height difference that counts as a split
const DRIVABLE=new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
 'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service']);

const files=[]; (function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){
  const p=path.join(d,e.name); if(e.isDirectory()) w(p); else if(e.name.endsWith('.bin')) files.push(p);}})(ROOT);

const ways=new Map();
for(const f of files){
  const b=fs.readFileSync(f); const hl=b.readUInt32LE(0);
  let x=hl; while(x>0&&b[4+x-1]===0)x--;
  let h; try{h=JSON.parse(b.toString('utf8',4,4+x));}catch{continue;}
  const ab=b.buffer.slice(b.byteOffset+4+hl,b.byteOffset+b.length);
  for(const r of h.roads||[]){
    if(ways.has(r.id)||r.pointsOffset===undefined||r.pointCount<2) continue;
    if(!DRIVABLE.has(r.highwayType)) continue;
    const p=new Float32Array(ab,r.pointsOffset,r.pointCount*3);
    const pts=[];
    for(let i=0;i<r.pointCount;i++){
      const lon=(p[i*3]/R)*(180/Math.PI);
      const lat=(2*Math.atan(Math.exp(p[i*3+2]/R))-Math.PI/2)*(180/Math.PI);
      const k=Math.cos(lat*Math.PI/180);
      pts.push({x:p[i*3]*k, z:p[i*3+2], y:p[i*3+1], lat, lon});
    }
    ways.set(r.id,{id:r.id,type:r.highwayType,name:r.name||'',tunnel:!!r.tunnel,bridge:!!r.bridge,
                   layer:r.layer??0,ramp:!!r.isRamp,cross:!!r.crossesTrench,pts});
  }
}
const CELL=30, grid=new Map();
for(const w of ways.values()) for(let i=0;i<w.pts.length;i++){
  const k=`${Math.floor(w.pts[i].x/CELL)}|${Math.floor(w.pts[i].z/CELL)}`;
  if(!grid.has(k)) grid.set(k,[]); grid.get(k).push({w,i}); }
const around=(x,z)=>{const o=[];for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++){
  const c=grid.get(`${Math.floor(x/CELL)+a}|${Math.floor(z/CELL)+b}`); if(c)o.push(...c);} return o;};

const reason={}, rows=[]; let ends=0, split=0;
for(const w of ways.values()){
  for(const ei of [0,w.pts.length-1]){
    const e=w.pts[ei]; ends++;
    let best=null;
    for(const {w:o,i} of around(e.x,e.z)){
      if(o.id===w.id) continue;
      const q=o.pts[i];
      const d=Math.hypot(q.x-e.x,q.z-e.z);
      if(d>PLAN_M) continue;
      const dy=Math.abs(q.y-e.y);
      if(dy<=DY_M) { best=null; break; }          // it DOES meet something here — not split
      if(!best||d<best.d) best={d,dy,o,q};
    }
    if(!best) continue;
    split++;
    // WHY are they at different heights? Ask the tags, do not assume.
    const a=w, b=best.o;
    let why;
    if(a.tunnel!==b.tunnel) why='one is a TUNNEL';
    else if(a.bridge!==b.bridge) why='one is a BRIDGE';
    else if((a.layer??0)!==(b.layer??0)) why=`LAYER differs (${a.layer} vs ${b.layer})`;
    else if(a.ramp!==b.ramp) why='one was given a RAMP profile';
    else why='NOTHING — same layer, no bridge, no tunnel';
    reason[why]=(reason[why]||0)+1;
    rows.push({why, plan:+best.d.toFixed(1), dy:+best.dy.toFixed(1),
      a:`${a.type}${a.ramp?'/ramp':''}`, b:`${b.type}${b.o?'':''}`,
      at:`${e.lat.toFixed(5)},${e.lon.toFixed(5)}`});
  }
}
console.log(`drivable way ends examined            : ${ends.toLocaleString()}`);
console.log(`ends meeting another way within ${PLAN_M} m in PLAN but > ${DY_M} m apart in HEIGHT : ${split}\n`);
console.log('why they are at different heights:');
for(const [k,v] of Object.entries(reason).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
rows.sort((a,b)=>b.dy-a.dy);
console.log('\nworst 12 by height gap:');
for(const r of rows.slice(0,12))
  console.log(`  dY ${String(r.dy).padStart(5)} m  plan ${String(r.plan).padStart(4)} m  ${r.why.padEnd(34)} ?spawn=${r.at}`);
