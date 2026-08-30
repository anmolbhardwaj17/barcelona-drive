/**
 * N-54b · WHY IS THIS ROAD IN THE AIR? — three answers, not one.
 *
 * floatJustifyAudit found 21 drivable surface roads floating >2 m with clear ground beneath. The
 * reflex was "the layer model hoists them", and four spot checks killed that reading: the worst ones
 * are RAMPS whose high end touches a real BRIDGE deck at exactly their own top height. Their height
 * is CORRECT. What is missing under them is the embankment — the earth fill a real bridge approach
 * is built on — and this project has no fill geometry at all.
 *
 * So "floating" is three distinct defects wearing one symptom, and they want three different fixes
 * (or none). This classifies every one of them before a line of fix code is written:
 *
 *   APPROACH  the high end meets a bridge/tunnel structure at its own height. Height right,
 *             embankment missing. A height "fix" here would tear the road off the deck.
 *   ORPHAN    the high end meets NOTHING. The ramp climbs to a structure that is not there —
 *             the same family as BrokenRamp, and a genuine defect.
 *   TAG       not a ramp, layer > 0, flat: hoisted layer x LAYER_STEP with nothing to cross.
 *             The only class the layer model is actually responsible for.
 */
import fs from 'node:fs'; import path from 'node:path';
const ROOT='backend/tiles/barcelona', R=6378137, FLOAT_M=2.0, UNDER_CLEAR_M=3.0, END_R=12;
const DRIVABLE=new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
 'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service']);
const files=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?w(p):e.name.endsWith('.bin')&&files.push(p);}})(ROOT);
const ways=new Map();
for(const f of files){const b=fs.readFileSync(f),hl=b.readUInt32LE(0);let x=hl;while(x>0&&b[4+x-1]===0)x--;
 let h;try{h=JSON.parse(b.toString('utf8',4,4+x));}catch{continue;}
 const el=h.elevation; if(!el||el.elevationsOffset===undefined||!h.roads) continue;
 const ab=b.buffer.slice(b.byteOffset+4+hl,b.byteOffset+b.length);
 const grid=new Float32Array(ab,el.elevationsOffset,el.elevationsCount);
 const {south,west,north,east,gridRows,gridCols}=el;
 const S=(lat,lon)=>{const fy=(lat-south)/(north-south)*(gridRows-1),fx=(lon-west)/(east-west)*(gridCols-1);
  if(!(fx>=0&&fx<=gridCols-1&&fy>=0&&fy<=gridRows-1))return null;
  const x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(gridCols-1,x0+1),y1=Math.min(gridRows-1,y0+1);
  const tx=fx-x0,ty=fy-y0,G=(r,c)=>grid[r*gridCols+c];
  return (G(y0,x0)*(1-tx)+G(y0,x1)*tx)*(1-ty)+(G(y1,x0)*(1-tx)+G(y1,x1)*tx)*ty;};
 for(const r of h.roads||[]){if(ways.has(r.id)||r.pointsOffset===undefined||r.pointCount<2)continue;
  const p=new Float32Array(ab,r.pointsOffset,r.pointCount*3),pts=[];
  for(let i=0;i<r.pointCount;i++){const lon=(p[i*3]/R)*(180/Math.PI),lat=(2*Math.atan(Math.exp(p[i*3+2]/R))-Math.PI/2)*(180/Math.PI);
   pts.push({x:p[i*3]*Math.cos(lat*Math.PI/180),z:p[i*3+2],y:p[i*3+1],lat,lon,t:S(lat,lon)});}
  ways.set(r.id,{id:r.id,type:r.highwayType,name:r.name||'',w:r.width||6,br:!!r.bridge,tun:!!r.tunnel,
   ramp:!!r.isRamp,cross:!!r.crossesTrench,layer:r.layer??0,pts});}}
const C=40,g=new Map();
for(const w of ways.values())for(let i=0;i<w.pts.length-1;i++){const k=`${Math.floor(w.pts[i].x/C)}|${Math.floor(w.pts[i].z/C)}`;
 if(!g.has(k))g.set(k,[]);g.get(k).push({w,i});}
const near=(x,z)=>{const o=[];for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++){const l=g.get(`${Math.floor(x/C)+a}|${Math.floor(z/C)+b}`);if(l)o.push(...l);}return o;};

const cls={APPROACH:[],ORPHAN:[],TAG:[]};
for(const w of ways.values()){
 if(w.br||w.tun||w.cross||(w.layer??0)<0) continue;
 if(!DRIVABLE.has(w.type)) continue;
 let hi=0,at=null;
 for(const p of w.pts) if(p.t!=null&&p.y-p.t>hi){hi=p.y-p.t;at=p;}
 if(hi<=FLOAT_M||!at) continue;
 // justified? something passes beneath anywhere
 let just=false;
 for(const p of w.pts){ if(p.t==null)continue;
  for(const {w:o,i} of near(p.x,p.z)){ if(o.id===w.id)continue;
   const a=o.pts[i],b2=o.pts[i+1],dx=b2.x-a.x,dz=b2.z-a.z,l2=dx*dx+dz*dz; if(l2<1e-9)continue;
   const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/l2));
   if(Math.hypot(p.x-(a.x+t*dx),p.z-(a.z+t*dz))>(w.w+o.w)/2)continue;
   if(p.y-(a.y+t*(b2.y-a.y))>=UNDER_CLEAR_M){just=true;break;} }
  if(just)break; }
 if(just) continue;
 // ── CLASSIFY AT THE FLOATING END, NOT THE HIGHEST ONE (N-56) ─────────────────────────────────
 // This used to take the point of greatest absolute Y. On a hillside that is the UPHILL end, which
 // is sitting flat on the ground — so all three "ORPHAN" verdicts were read off the wrong end of
 // the road. `Viaducte de Vallcarca` was reported as meeting NOTHING; its floating end joins
 // `Viaducte de Vallcarca [BRIDGE] L1` at exactly its own height. The question is "what does the
 // part that is IN THE AIR touch", so the anchor is max FLOAT, which is `at`.
 const top=at;
 let struct=null, sameH=null;
 for(const o of ways.values()){ if(o.id===w.id)continue;
  for(const q of o.pts){ if(Math.hypot(q.x-top.x,q.z-top.z)>END_R)continue;
   if(Math.abs(q.y-top.y)>1.5)continue;
   if(o.br||o.tun||o.cross){struct=o;break;} sameH=sameH||o; }
  if(struct)break; }
 const row={id:w.id,h:+hi.toFixed(1),type:w.type,ramp:w.ramp,layer:w.layer,
  name:w.name||'(unnamed)',at:`${at.lat.toFixed(5)},${at.lon.toFixed(5)}`,
  meets:struct?`${struct.br?'bridge':struct.tun?'tunnel':'trench'} ${struct.name||struct.type}`:(sameH?`road ${sameH.name||sameH.type}`:'NOTHING')};
 if(struct) cls.APPROACH.push(row);
 else if(!w.ramp&&w.layer>0) cls.TAG.push(row);
 else cls.ORPHAN.push(row);
}
const tot=cls.APPROACH.length+cls.ORPHAN.length+cls.TAG.length;
console.log(`unjustified floaters: ${tot}\n`);
for(const k of ['APPROACH','ORPHAN','TAG']){
 const L=cls[k]; console.log(`${k}  ${L.length}`);
 for(const r of L.sort((a,b)=>b.h-a.h).slice(0,10))
  console.log(`   ${String(r.h).padStart(5)} m  L${r.layer} ${r.ramp?'ramp':'    '} ${r.type.padEnd(12)} ${r.name.slice(0,20).padEnd(21)} meets ${String(r.meets).padEnd(26)} ?mode=fly&spawn=${r.at}`);
 console.log('');
}
