/**
 * How far is an AT-GRADE road from the terrain under it?
 *
 * roadVsTerrain.mjs answers this for every road and is dominated by bridges and tunnels — 27% of its
 * hits land on a LAYER_STEP multiple and its median bad point is 5.42 m, which are metres of
 * legitimate structure. The user's report is centimetres on ordinary streets: wheels slightly
 * sunk into the carriageway. That is a different population and needs its own number.
 *
 * Scope: drivable, layer 0, not bridge, not tunnel. Read-only, baked tiles.
 */
import fs from 'node:fs'; import path from 'node:path';
const R=6378137;
const DRIVABLE=new Set(['motorway','trunk','primary','secondary','tertiary','unclassified',
  'residential','living_street','service','motorway_link','trunk_link','primary_link',
  'secondary_link','tertiary_link','busway']);
const ROOT='/Users/apple/Desktop/delhi-drive/backend/tiles/barcelona';
const files=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?w(p):e.name.endsWith('.bin')&&files.push(p);}})(ROOT);

const devs=[]; let pts=0, tiles=0;
const worstBy=new Map();
for(const f of files){
  let b; try{b=fs.readFileSync(f);}catch{continue;} if(b.length<8)continue;
  const hl=b.readUInt32LE(0); let x=hl; while(x>0&&b[4+x-1]===0)x--;
  let h; try{h=JSON.parse(b.toString('utf8',4,4+x));}catch{continue;}
  // Same accessors roadVsTerrain.mjs uses — the SHIPPED (post trench-carve / water-sink) grid.
  const elh=h.elevation; if(!elh||elh.elevationsOffset===undefined||!h.roads)continue;
  const ab=b.buffer.slice(b.byteOffset+4+hl,b.byteOffset+b.length);
  const el=new Float32Array(ab,elh.elevationsOffset,elh.elevationsCount);
  const {south,west,north,east,gridRows,gridCols}=elh;
  tiles++;
  const sample=(lat,lon)=>{
    const fy=(lat-south)/(north-south)*(gridRows-1);
    const fx=(lon-west)/(east-west)*(gridCols-1);
    if(!(fx>=0&&fx<=gridCols-1&&fy>=0&&fy<=gridRows-1))return null;
    const x0=Math.floor(fx),y0=Math.floor(fy);
    const x1=Math.min(gridCols-1,x0+1),y1=Math.min(gridRows-1,y0+1);
    const tx=fx-x0,ty=fy-y0;
    const g=(r,c)=>el[r*gridCols+c];
    const a=g(y0,x0)*(1-tx)+g(y0,x1)*tx, d=g(y1,x0)*(1-tx)+g(y1,x1)*tx;
    const out=a*(1-ty)+d*ty;
    return Number.isFinite(out)?out:null;
  };
  for(const rd of h.roads||[]){
    if(!DRIVABLE.has(rd.highwayType))continue;
    if(rd.bridge||rd.tunnel)continue;
    if(rd.layer!=null&&rd.layer!==0)continue;
    if(rd.pointsOffset===undefined||rd.pointCount<2)continue;
    const p=new Float32Array(ab,rd.pointsOffset,rd.pointCount*3);
    for(let i=0;i<rd.pointCount;i++){
      const lat=(2*Math.atan(Math.exp(p[i*3+2]/R))-Math.PI/2)*(180/Math.PI);
      const lon=(p[i*3]/R)*(180/Math.PI);
      const g=sample(lat,lon); if(g===null)continue;
      const dv=p[i*3+1]-g; pts++; devs.push(dv);
      const k=rd.id; if(!worstBy.has(k)||Math.abs(dv)>Math.abs(worstBy.get(k).dv)) worstBy.set(k,{dv,type:rd.highwayType,name:rd.name||''});
    }
  }
}
devs.sort((a,b)=>a-b);
const q=(f)=>devs[Math.min(devs.length-1,Math.floor(devs.length*f))];
const band=(lo,hi)=>devs.filter(d=>Math.abs(d)>=lo&&Math.abs(d)<hi).length;
console.log(`\ntiles with a terrain grid: ${tiles}   at-grade drivable points: ${pts.toLocaleString()}\n`);
console.log(`road minus terrain  p5 ${q(0.05).toFixed(2)}  p50 ${q(0.5).toFixed(2)}  p95 ${q(0.95).toFixed(2)}  (m, + = road above terrain)`);
console.log(`mean |dev| ${(devs.reduce((s,d)=>s+Math.abs(d),0)/devs.length).toFixed(3)} m\n`);
console.log('|deviation| distribution:');
for(const [lo,hi,lbl] of [[0,0.05,'< 5 cm      (flush)'],[0.05,0.15,'5-15 cm'],[0.15,0.30,'15-30 cm    <- a wheel looks sunk'],[0.30,0.60,'30-60 cm'],[0.60,1.5,'0.6-1.5 m'],[1.5,1e9,'> 1.5 m']]) {
  const n=band(lo,hi); console.log(`  ${lbl.padEnd(30)} ${String(n).padStart(7)}  ${(n/pts*100).toFixed(1)}%`);
}
const bad=[...worstBy.entries()].filter(([,v])=>Math.abs(v.dv)>0.15).sort((a,b)=>Math.abs(b[1].dv)-Math.abs(a[1].dv));
console.log(`\nat-grade ways with any point >15 cm off: ${bad.length} of ${worstBy.size}`);
bad.slice(0,6).forEach(([id,v])=>console.log(`  ${String(id).padEnd(12)} ${v.type.padEnd(14)} ${v.dv>0?'+':''}${v.dv.toFixed(2)} m  ${v.name}`));
