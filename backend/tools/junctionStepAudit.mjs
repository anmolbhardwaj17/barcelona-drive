/**
 * N-56 · THE 142 JUNCTION HEIGHT-STEPS THAT SURVIVED N-45/47.
 *
 * The last "orphan ramp" turned out not to be an orphan. Way 425799884 shares a node with
 * `Moll Adossat` (bridge, layer 1) at zero distance, and the two disagree about the height of that
 * node by exactly 6.0 m — LAYER_STEP. The ramp climbed to the bridge's BASE layer height while the
 * bridge descended along its own profile to meet the ground. Both ramped, in opposite directions,
 * each targeting the other's base rather than its actual profile.
 *
 * That is verbatim the bug N-45/47 fixed at tunnel portals, which took drivable junction steps
 * 462 -> 142. This asks what the surviving 142 are made of, and specifically how many sit at
 * exactly one LAYER_STEP — the fingerprint of base-height-instead-of-profile.
 *
 * Read-only, against the shipped tiles.
 */
import fs from 'node:fs'; import path from 'node:path';
const R = 6378137, JOIN_M = 1.0, STEP_MIN = 1.0, LAYER_STEP = 6;
const DRIVABLE = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
  'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service']);
const files=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?w(p):e.name.endsWith('.bin')&&files.push(p);}})('backend/tiles/barcelona');
const ways=new Map();
for(const f of files){const b=fs.readFileSync(f),hl=b.readUInt32LE(0);let x=hl;while(x>0&&b[4+x-1]===0)x--;
 let h;try{h=JSON.parse(b.toString('utf8',4,4+x));}catch{continue;}
 const ab=b.buffer.slice(b.byteOffset+4+hl,b.byteOffset+b.length);
 for(const r of h.roads||[]){if(ways.has(r.id)||r.pointsOffset===undefined||r.pointCount<2)continue;
  const p=new Float32Array(ab,r.pointsOffset,r.pointCount*3),pts=[];
  for(let i=0;i<r.pointCount;i++){const lon=(p[i*3]/R)*(180/Math.PI),lat=(2*Math.atan(Math.exp(p[i*3+2]/R))-Math.PI/2)*(180/Math.PI);
   pts.push({x:p[i*3]*Math.cos(lat*Math.PI/180),z:p[i*3+2],y:p[i*3+1],lat,lon});}
  let len=0; for(let i=0;i<pts.length-1;i++) len+=Math.hypot(pts[i+1].x-pts[i].x, pts[i+1].z-pts[i].z);
  ways.set(r.id,{id:r.id,type:r.highwayType,name:r.name||'',br:!!r.bridge,tun:!!r.tunnel,
   ramp:!!r.isRamp,cross:!!r.crossesTrench,layer:r.layer??0,len,pts});}}

// index every ENDPOINT — a step matters where ways actually join, not where one passes over another
const C=20, g=new Map();
for(const w of ways.values()){ if(!DRIVABLE.has(w.type)) continue;
  for(const idx of [0, w.pts.length-1]){ const p=w.pts[idx];
    const k=`${Math.floor(p.x/C)}|${Math.floor(p.z/C)}`;
    if(!g.has(k))g.set(k,[]); g.get(k).push({w,p}); } }

const seen=new Set(); const steps=[];
for(const list of g.values()) for(const A of list){
  for(let a=-1;a<=1;a++) for(let b=-1;b<=1;b++){
    const l=g.get(`${Math.floor(A.p.x/C)+a}|${Math.floor(A.p.z/C)+b}`); if(!l) continue;
    for(const B of l){
      if(B.w.id===A.w.id) continue;
      const key=A.w.id<B.w.id?`${A.w.id}_${B.w.id}`:`${B.w.id}_${A.w.id}`;
      if(seen.has(key)) continue;
      if(Math.hypot(A.p.x-B.p.x, A.p.z-B.p.z) > JOIN_M) continue;
      const d=Math.abs(A.p.y-B.p.y);
      if(d < STEP_MIN) continue;
      seen.add(key);
      steps.push({ d, a:A.w, b:B.w, lat:A.p.lat, lon:A.p.lon });
    }}}
steps.sort((x,y)=>y.d-x.d);
// ── CAN THE STEP EVEN BE BLENDED AWAY? (N-57) ─────────────────────────────────────────────────
// A correction is absorbed over `reach = step / grade` metres of road. At CONSTRUCT_RAMP_GRADE
// (0.12) a 6 m step needs 50 m, and most ways meeting at a junction are link roads far shorter —
// which is exactly why the first N-57 bake only fixed 7 of 133. Reporting the length of the SHORTER
// side turns "it did not fix them" into "it could not", which are different problems with
// different answers.
const MAX_FIX_GRADE = 0.25;
const blendable = steps.filter(s => {
  const shortest = Math.min(s.a.len, s.b.len);
  // Either side may absorb it; a way can spend at most ~90% of its length.
  return Math.max(s.a.len, s.b.len) * 0.9 > 0 && (s.d / (Math.max(s.a.len, s.b.len) * 0.9)) <= MAX_FIX_GRADE;
});
const bothTunnel = steps.filter(s => s.a.tun && s.b.tun);
const nearStep = steps.filter(s => Math.abs(s.d - LAYER_STEP) < 0.5);
const involvesStructure = steps.filter(s => s.a.br||s.b.br||s.a.tun||s.b.tun||s.a.cross||s.b.cross);
const involvesRamp = steps.filter(s => s.a.ramp||s.b.ramp);
console.log(`drivable ways joined at a shared endpoint but disagreeing on its height (>${STEP_MIN} m): ${steps.length}\n`);
console.log(`  step within 0.5 m of LAYER_STEP (${LAYER_STEP} m) : ${nearStep.length}   <- base-height-instead-of-profile`);
console.log(`  at least one side is bridge/tunnel/trench        : ${involvesStructure.length}`);
console.log(`  at least one side is a RAMP                      : ${involvesRamp.length}`);
console.log(`  BLENDABLE at <=${MAX_FIX_GRADE * 100}% grade (N-57 could fix)   : ${blendable.length}`);
console.log(`  both sides are TUNNELS (never moved)            : ${bothTunnel.length}`);
console.log(`  -> unfixable by reconciliation                  : ${steps.length - blendable.length}\n`);
const hist={};
for(const s of steps){ const b=Math.round(s.d); hist[b]=(hist[b]||0)+1; }
console.log('step size histogram (m -> count):');
for(const [k,v] of Object.entries(hist).sort((a,b)=>+a[0]-+b[0]))
  console.log(`  ${String(k).padStart(3)}  ${'█'.repeat(Math.min(50,v))} ${v}`);
console.log('\nworst:');
console.log('   step   lenA/lenB  A                              B                              spawn');
for(const s of steps.slice(0,12))
  console.log(`  ${s.d.toFixed(1).padStart(5)}  ${(String(Math.round(s.a.len))+'/'+String(Math.round(s.b.len))+'m').padStart(9)}  ${((s.a.name||s.a.type)+`[${s.a.type}]`+(s.a.br?'BR':'')+(s.a.tun?'TU':'')+(s.a.ramp?'/ramp':'')).slice(0,30).padEnd(31)}${((s.b.name||s.b.type)+`[${s.b.type}]`+(s.b.br?'BR':'')+(s.b.tun?'TU':'')+(s.b.ramp?'/ramp':'')).slice(0,30).padEnd(31)}?mode=fly&spawn=${s.lat.toFixed(5)},${s.lon.toFixed(5)}`);
