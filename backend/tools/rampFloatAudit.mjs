/**
 * N-23 · WHY DO SURFACE ROADS FLOAT ABOVE THE GROUND?
 *
 * `_ddNoGround` found roads 3.4-7.4 m above terrain that is present, and a check of the baked tile
 * at the same spot showed the gap is ALREADY THERE in the bake — up to 11.72 m. So this is not a
 * runtime Y-frame problem, which is where N-22/N-23 had been pointed for days.
 *
 * The hypothesis the spot check suggests: the worst offenders are all `isRamp` at LAYER 0 with no
 * bridge and no tunnel — i.e. ordinary surface streets that RampResolver handed a ramp profile.
 * That profile is DEM-FREE by design, and the tile drape then adds ground elevation ON TOP of it
 * (`p[3] += groundElev`), so any non-zero profile on a surface road lifts it clean off the ground.
 *
 * This splits the population by `isRamp` to see whether the hypothesis survives contact with the
 * whole region, rather than one street corner.
 */
import fs from 'node:fs'; import path from 'node:path';
const R=6378137, FLOAT_M=2.0;
const files=[]; (function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){
  const p=path.join(d,e.name); if(e.isDirectory()) w(p); else if(e.name.endsWith('.bin')) files.push(p);}})('backend/tiles/barcelona');
const seen=new Set();
const stat={ramp:{n:0,float:0,worst:0,worstAt:''},plain:{n:0,float:0,worst:0,worstAt:''}};
const byType={};
for(const f of files){
  const b=fs.readFileSync(f); const hl=b.readUInt32LE(0);
  let x=hl; while(x>0&&b[4+x-1]===0)x--;
  let h; try{h=JSON.parse(b.toString('utf8',4,4+x));}catch{continue;}
  const el=h.elevation; if(!el||el.elevationsOffset===undefined||!h.roads) continue;
  const ab=b.buffer.slice(b.byteOffset+4+hl, b.byteOffset+b.length);
  const grid=new Float32Array(ab, el.elevationsOffset, el.elevationsCount);
  const {south,west,north,east,gridRows,gridCols}=el;
  const sample=(lat,lon)=>{
    const fy=(lat-south)/(north-south)*(gridRows-1), fx=(lon-west)/(east-west)*(gridCols-1);
    if(!(fx>=0&&fx<=gridCols-1&&fy>=0&&fy<=gridRows-1)) return null;
    const x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(gridCols-1,x0+1),y1=Math.min(gridRows-1,y0+1);
    const tx=fx-x0,ty=fy-y0,g=(r,c)=>grid[r*gridCols+c];
    return (g(y0,x0)*(1-tx)+g(y0,x1)*tx)*(1-ty)+(g(y1,x0)*(1-tx)+g(y1,x1)*tx)*ty; };
  for(const r of h.roads){
    // ONLY surface roads. A bridge is meant to be above the ground and a tunnel below it; including
    // them would drown the signal in correct-by-design cases (the same reason scanTerrainConflict
    // excludes them).
    if(r.bridge||r.tunnel||(r.layer??0)!==0) continue;
    if(r.pointsOffset===undefined||seen.has(r.id)) continue;
    seen.add(r.id);
    const p=new Float32Array(ab, r.pointsOffset, r.pointCount*3);
    const k=r.isRamp?'ramp':'plain'; stat[k].n++;
    let worst=0, worstLL=null;
    for(let i=0;i<r.pointCount;i++){
      const lon=(p[i*3]/R)*(180/Math.PI);
      const lat=(2*Math.atan(Math.exp(p[i*3+2]/R))-Math.PI/2)*(180/Math.PI);
      const t=sample(lat,lon); if(t==null) continue;
      const d=p[i*3+1]-t;
      if(d>worst){ worst=d; worstLL={lat,lon}; }
    }
    if(worst>FLOAT_M){
      stat[k].float++;
      byType[r.highwayType]=(byType[r.highwayType]||0)+1;
      if(worst>stat[k].worst){ stat[k].worst=worst;
        stat[k].worstAt=worstLL?`${worstLL.lat.toFixed(5)},${worstLL.lon.toFixed(5)}`:''; }
    }
  }
}
const pct=(a,b)=>b?((100*a/b).toFixed(1)+'%'):'—';
console.log(`SURFACE roads only (layer 0, no bridge, no tunnel), floating > ${FLOAT_M} m above baked terrain\n`);
console.log(`  isRamp = true : ${stat.ramp.float} of ${stat.ramp.n}  (${pct(stat.ramp.float,stat.ramp.n)})   worst ${stat.ramp.worst.toFixed(2)} m  ?spawn=${stat.ramp.worstAt}`);
console.log(`  isRamp = false: ${stat.plain.float} of ${stat.plain.n}  (${pct(stat.plain.float,stat.plain.n)})   worst ${stat.plain.worst.toFixed(2)} m  ?spawn=${stat.plain.worstAt}`);
console.log('\nfloating surface roads by type:');
for(const [k,v] of Object.entries(byType).sort((a,b)=>b[1]-a[1]).slice(0,10)) console.log(`   ${String(v).padStart(5)}  ${k}`);
