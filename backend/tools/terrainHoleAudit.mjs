/**
 * Is there terrain under the road? Measured from the BAKED tiles.
 *
 * `_ddColumn` at a road stub near Ronda de Dalt returned ONE surface and nothing beneath it — the
 * ray fell 4 km and hit no ground. A column a few metres away found terrain normally. So the
 * question is whether the elevation grid has NaN holes (G-06) and whether roads sit over them.
 */
import fs from 'node:fs'; import path from 'node:path';
const ROOT='backend/tiles/barcelona', R=6378137;
const files=[]; (function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){
  const p=path.join(d,e.name); if(e.isDirectory()) w(p); else if(e.name.endsWith('.bin')) files.push(p);}})(ROOT);

let tilesWithNaN=0, totalNaN=0, totalCells=0, roadPtsOverNaN=0, roadPtsChecked=0;
const worstTiles=[]; const roadsOverHoles=new Map();
for(const f of files){
  const b=fs.readFileSync(f); const hl=b.readUInt32LE(0);
  let x=hl; while(x>0&&b[4+x-1]===0)x--;
  let h; try{h=JSON.parse(b.toString('utf8',4,4+x));}catch{continue;}
  const el=h.elevation; if(!el||el.elevationsOffset===undefined) continue;
  const ab=b.buffer.slice(b.byteOffset+4+hl, b.byteOffset+b.length);
  const grid=new Float32Array(ab, el.elevationsOffset, el.elevationsCount);
  const {south,west,north,east,gridRows,gridCols}=el;
  let nan=0; for(let i=0;i<grid.length;i++) if(!Number.isFinite(grid[i])) nan++;
  totalCells+=grid.length; totalNaN+=nan;
  if(nan){ tilesWithNaN++; worstTiles.push([path.basename(path.dirname(f))+'/'+path.basename(f), nan, grid.length]); }

  // Do any ROAD points sit over a NaN cell?
  if(nan && h.roads){
    const toLL=(mx,my)=>({lon:(mx/R)*(180/Math.PI), lat:(2*Math.atan(Math.exp(my/R))-Math.PI/2)*(180/Math.PI)});
    for(const r of h.roads){
      if(r.pointsOffset===undefined||!r.pointCount) continue;
      const p=new Float32Array(ab, r.pointsOffset, r.pointCount*3);
      for(let i=0;i<r.pointCount;i++){
        const ll=toLL(p[i*3], p[i*3+2]);
        const fy=(ll.lat-south)/(north-south)*(gridRows-1), fx=(ll.lon-west)/(east-west)*(gridCols-1);
        if(!(fx>=0&&fx<=gridCols-1&&fy>=0&&fy<=gridRows-1)) continue;
        roadPtsChecked++;
        const v=grid[Math.round(fy)*gridCols+Math.round(fx)];
        if(!Number.isFinite(v)){
          roadPtsOverNaN++;
          if(!roadsOverHoles.has(r.id)) roadsOverHoles.set(r.id,
            {type:r.highwayType, name:r.name||'', lat:+ll.lat.toFixed(5), lon:+ll.lon.toFixed(5)});
        }
      }
    }
  }
}
console.log(`elevation cells total     : ${totalCells.toLocaleString()}`);
console.log(`NaN cells (G-06 holes)    : ${totalNaN.toLocaleString()}  in ${tilesWithNaN} tiles`);
console.log(`road points over a hole   : ${roadPtsOverNaN.toLocaleString()} of ${roadPtsChecked.toLocaleString()} checked`);
console.log(`distinct roads over holes : ${roadsOverHoles.size}`);
worstTiles.sort((a,b)=>b[1]-a[1]);
console.log('\ntiles with the most NaN:');
for(const [t,n,tot] of worstTiles.slice(0,8)) console.log(`   ${t}  ${n}/${tot} cells (${(100*n/tot).toFixed(1)}%)`);
console.log('\nroads standing over a hole:');
for(const [id,v] of [...roadsOverHoles].slice(0,12))
  console.log(`   ${String(v.type).padEnd(14)} ${(v.name||'(unnamed)').padEnd(28)} ?spawn=${v.lat},${v.lon}  (way ${id})`);
