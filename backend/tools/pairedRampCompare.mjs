// Paired: the SAME ways in both bakes. N-41 also rescued 123 roads from the grade backstop, so an
// unpaired count compares different populations and understates the fix.
import fs from 'node:fs'; import path from 'node:path';
const R=6378137, FLOAT_M=2.0;
function scan(root){
  const out=new Map();
  const files=[]; (function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){
    const p=path.join(d,e.name); if(e.isDirectory()) w(p); else if(e.name.endsWith('.bin')) files.push(p);}})(root);
  for(const f of files){
    const b=fs.readFileSync(f); const hl=b.readUInt32LE(0);
    let x=hl; while(x>0&&b[4+x-1]===0)x--;
    let h; try{h=JSON.parse(b.toString('utf8',4,4+x));}catch{continue;}
    const el=h.elevation; if(!el||el.elevationsOffset===undefined||!h.roads) continue;
    const ab=b.buffer.slice(b.byteOffset+4+hl,b.byteOffset+b.length);
    const grid=new Float32Array(ab,el.elevationsOffset,el.elevationsCount);
    const {south,west,north,east,gridRows,gridCols}=el;
    const sample=(lat,lon)=>{const fy=(lat-south)/(north-south)*(gridRows-1),fx=(lon-west)/(east-west)*(gridCols-1);
      if(!(fx>=0&&fx<=gridCols-1&&fy>=0&&fy<=gridRows-1))return null;
      const x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(gridCols-1,x0+1),y1=Math.min(gridRows-1,y0+1);
      const tx=fx-x0,ty=fy-y0,g=(r,c)=>grid[r*gridCols+c];
      return (g(y0,x0)*(1-tx)+g(y0,x1)*tx)*(1-ty)+(g(y1,x0)*(1-tx)+g(y1,x1)*tx)*ty;};
    for(const r of h.roads){
      if(r.bridge||r.tunnel||(r.layer??0)!==0||!r.isRamp) continue;
      if(r.pointsOffset===undefined||out.has(r.id)) continue;
      const p=new Float32Array(ab,r.pointsOffset,r.pointCount*3);
      let n=0,fl=0,worst=0;
      for(let i=0;i<r.pointCount;i++){
        const lon=(p[i*3]/R)*(180/Math.PI), lat=(2*Math.atan(Math.exp(p[i*3+2]/R))-Math.PI/2)*(180/Math.PI);
        const t=sample(lat,lon); if(t==null) continue;
        const d=p[i*3+1]-t; n++; if(d>FLOAT_M) fl++; if(d>worst) worst=d; }
      if(n) out.set(r.id,{n,fl,worst}); }
  }
  return out;
}
const before=scan(process.argv[2]), after=scan(process.argv[3]);
let bn=0,bf=0,an=0,af=0,improved=0,worse=0,same=0;
for(const [id,b] of before){
  const a=after.get(id); if(!a) continue;
  bn+=b.n; bf+=b.fl; an+=a.n; af+=a.fl;
  if(a.fl<b.fl) improved++; else if(a.fl>b.fl) worse++; else same++;
}
const pct=(a,b)=>b?(100*a/b).toFixed(1)+'%':'—';
console.log(`ramps present in BOTH bakes: ${improved+worse+same}\n`);
console.log(`  road points in the air, BEFORE : ${bf} of ${bn}  (${pct(bf,bn)})`);
console.log(`  road points in the air, AFTER  : ${af} of ${an}  (${pct(af,an)})`);
console.log(`\n  ways with LESS road in the air : ${improved}`);
console.log(`  ways with MORE road in the air : ${worse}`);
console.log(`  unchanged                      : ${same}`);
console.log(`\nplus ${after.size - (improved+worse+same)} ramps that exist only in the AFTER bake `
  + `(rescued from the >60% grade backstop: BrokenRamp 328 -> 205)`);
