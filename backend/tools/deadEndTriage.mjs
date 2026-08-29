/**
 * N-49 · WHICH DEAD ENDS ARE WRONG?
 *
 * User: "for some roads obviously they are dead ends inside a city ... but some just don't belong
 * or feel like not proper — I want to figure those out by numbers and then start work."
 *
 * Right question, and the data can answer it. A dead end is not a defect by itself: Barcelona has
 * thousands of legitimate ones. What makes a dead end WRONG is evidence that the road was meant to
 * continue, and four such signals exist in the tiles already:
 *
 *   CLASS      A motorway or trunk road does not simply stop. A service road stopping is a car park.
 *              This is the single strongest signal and it needs no geometry at all.
 *   NAME AHEAD The same street name exists beyond the gap. A street does not resume 40 m later by
 *              coincidence — that is one road with its middle missing.
 *   WIDTH      A 4-lane carriageway ending is not a cul-de-sac. Kerb-to-kerb width stands in for it.
 *   LENGTH     A 600 m arterial ending in the open is different from a 20 m stub off a courtyard.
 *
 * Scored, not thresholded, so the ranking is inspectable and the cut can be chosen after seeing the
 * distribution rather than guessed beforehand — which is the mistake N-48 made.
 */
import fs from 'node:fs'; import path from 'node:path';
const ROOT='backend/tiles/barcelona', R=6378137;
const JOIN_TOL=3, LOOK_M=90, CONE_COS=0.5, EDGE_M=250;
const DRIVABLE=new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
  'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service']);
// How wrong is it for a road of this class to just stop? 0 = normal, 3 = should never happen.
const CLASS_WRONGNESS = { motorway:3, trunk:3, motorway_link:3, trunk_link:3, primary:3, primary_link:2,
  secondary:2, secondary_link:2, tertiary:2, tertiary_link:1, unclassified:1, residential:1,
  living_street:0, service:0 };

const files=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){
  const p=path.join(d,e.name); if(e.isDirectory()) w(p); else if(e.name.endsWith('.bin')) files.push(p);}})(ROOT);

const ways=new Map(); let mnLa=Infinity,mxLa=-Infinity,mnLo=Infinity,mxLo=-Infinity;
for(const f of files){
  const b=fs.readFileSync(f),hl=b.readUInt32LE(0); let x=hl; while(x>0&&b[4+x-1]===0)x--;
  let h; try{h=JSON.parse(b.toString('utf8',4,4+x));}catch{continue;}
  const ab=b.buffer.slice(b.byteOffset+4+hl,b.byteOffset+b.length);
  for(const r of h.roads||[]){
    if(ways.has(r.id)||r.pointsOffset===undefined||r.pointCount<2||!DRIVABLE.has(r.highwayType)) continue;
    const p=new Float32Array(ab,r.pointsOffset,r.pointCount*3),pts=[];
    let len=0;
    for(let i=0;i<r.pointCount;i++){
      const lon=(p[i*3]/R)*(180/Math.PI), lat=(2*Math.atan(Math.exp(p[i*3+2]/R))-Math.PI/2)*(180/Math.PI);
      const k=Math.cos(lat*Math.PI/180);
      pts.push({x:p[i*3]*k,z:p[i*3+2],lat,lon});
      if(i)len+=Math.hypot(pts[i].x-pts[i-1].x,pts[i].z-pts[i-1].z);
      if(lat<mnLa)mnLa=lat; if(lat>mxLa)mxLa=lat; if(lon<mnLo)mnLo=lon; if(lon>mxLo)mxLo=lon;
    }
    ways.set(r.id,{id:r.id,type:r.highwayType,name:(r.name||'').trim(),width:r.width||0,len,pts});
  }
}
const C=50,g=new Map();
for(const w of ways.values()) for(let i=0;i<w.pts.length;i++){
  const k=`${Math.floor(w.pts[i].x/C)}|${Math.floor(w.pts[i].z/C)}`;
  if(!g.has(k))g.set(k,[]); g.get(k).push({w,i});
}
const near=(x,z,rad)=>{const o=[],c=Math.ceil(rad/C);
  for(let a=-c;a<=c;a++)for(let b=-c;b<=c;b++){const l=g.get(`${Math.floor(x/C)+a}|${Math.floor(z/C)+b}`); if(l)o.push(...l);} return o;};

const rows=[];
for(const w of ways.values()) for(const ei of [0,w.pts.length-1]){
  const e=w.pts[ei];
  let joined=false;
  for(const {w:o,i} of near(e.x,e.z,JOIN_TOL+2)){ if(o.id===w.id)continue;
    if(Math.hypot(o.pts[i].x-e.x,o.pts[i].z-e.z)<=JOIN_TOL){joined=true;break;} }
  if(joined) continue;
  const dEdge=Math.min((e.lat-mnLa)*111320,(mxLa-e.lat)*111320,
    (e.lon-mnLo)*111320*Math.cos(e.lat*Math.PI/180),(mxLo-e.lon)*111320*Math.cos(e.lat*Math.PI/180));
  if(dEdge<EDGE_M) continue;
  const inn=w.pts[ei===0?1:w.pts.length-2];
  let sx=e.x-inn.x,sz=e.z-inn.z; const sl=Math.hypot(sx,sz)||1; sx/=sl; sz/=sl;
  let ahead=null, sameName=null;
  for(const {w:o,i} of near(e.x,e.z,LOOK_M)){
    if(o.id===w.id)continue;
    const q=o.pts[i],dx=q.x-e.x,dz=q.z-e.z,d=Math.hypot(dx,dz);
    if(d<1||d>LOOK_M)continue;
    if((dx*sx+dz*sz)/d<CONE_COS)continue;
    if(!ahead||d<ahead.d) ahead={d,o};
    if(w.name && o.name===w.name && (!sameName||d<sameName.d)) sameName={d,o};
  }
  const cw = CLASS_WRONGNESS[w.type] ?? 1;
  // score: class dominates, name-ahead is near-proof, width and length are supporting evidence
  let score = cw * 2;
  if(sameName) score += 4;
  else if(ahead) score += 1;
  if(w.width >= 10) score += 2; else if(w.width >= 7) score += 1;
  if(w.len >= 200) score += 2; else if(w.len >= 80) score += 1;
  rows.push({score, type:w.type, name:w.name||'(unnamed)', width:+w.width.toFixed(1),
    len:Math.round(w.len), gap: ahead?Math.round(ahead.d):null,
    sameName: !!sameName, at:`${e.lat.toFixed(5)},${e.lon.toFixed(5)}`});
}
rows.sort((a,b)=>b.score-a.score);
const hist={};
for(const r of rows) hist[r.score]=(hist[r.score]||0)+1;
console.log(`unjoined drivable ends away from the region edge: ${rows.length}\n`);
console.log('wrongness score  count   (class×2 + sameNameAhead 4 / anythingAhead 1 + width + length)');
for(const k of Object.keys(hist).map(Number).sort((a,b)=>b-a))
  console.log(`  ${String(k).padStart(3)}  ${'█'.repeat(Math.min(50,Math.round(hist[k]/6)))} ${hist[k]}`);
const bad = rows.filter(r=>r.score>=8);
console.log(`\nscore >= 8 — "this road was meant to continue": ${bad.length}`);
console.log('\ntop 14:');
console.log('  scr  gap  same  width  len   class          name                     spawn');
for(const r of rows.slice(0,14))
  console.log(`  ${String(r.score).padStart(3)} ${String(r.gap??'—').padStart(4)}  ${r.sameName?'YES ':'  . '} ${String(r.width).padStart(5)} ${String(r.len).padStart(5)}   ${r.type.padEnd(14)} ${r.name.slice(0,24).padEnd(25)}?mode=fly&spawn=${r.at}`);
