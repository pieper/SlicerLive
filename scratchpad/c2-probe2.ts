import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 40000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const PID="KiTS-00012";
const nav = await CDP.attachToPage(9222); await nav.send("Page.navigate", { url: `http://127.0.0.1:8140/render/demos/seged-app.html?pid=${PID}&blind=1` }); nav.close();
await new Promise(r=>setTimeout(r,3000));
const cdp = await CDP.attachToPage(9222, "seged-app.html");
let loaded=false;
for (let i=0;i<80 && !loaded;i++){ const s=await ev<{segments:any[]}>(cdp,"try{return await globalThis.seged?.state?.();}catch(e){return null;}",8000); loaded=!!(s&&s.segments&&s.segments.length); if(!loaded) await new Promise(r=>setTimeout(r,1500)); }
if(!loaded){ console.log("FAILED"); Deno.exit(1); }
// probe the raw CT array directly (runs in-page)
const probe = await ev(cdp, `
  const ct = window.seged.ctArray(); const [nx,ny,nz]=window.seged.dimsArr(); const ijk=window.seged.ijkArr();
  const N=nx*ny*nz;
  const ras=(x,y,z)=>[ijk[0]*x+ijk[1]*y+ijk[2]*z+ijk[3], ijk[4]*x+ijk[5]*y+ijk[6]*z+ijk[7], ijk[8]*x+ijk[9]*y+ijk[10]*z+ijk[11]];
  // overall HU percentiles (subsample)
  const samp=[]; for(let i=0;i<N;i+=97) samp.push(ct[i]); samp.sort((a,b)=>a-b);
  const pct=p=>samp[Math.floor(p*samp.length)];
  // bone (HU>300) centroid -> midline & orientation
  let bx=0,by=0,bz=0,bn=0; for(let z=0;z<nz;z++)for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){const v=ct[(z*ny+y)*nx+x]; if(v>300){bx+=x;by+=y;bz+=z;bn++;}}
  const bc=bn?[bx/bn,by/bn,bz/bn]:[0,0,0];
  return { dims:[nx,ny,nz], ijk, corners:{lo:ras(0,0,0), hi:ras(nx-1,ny-1,nz-1)}, huPct:{p1:pct(0.01),p10:pct(0.1),p50:pct(0.5),p90:pct(0.9),p99:pct(0.99)}, boneCentroidVox:bc, boneCentroidRAS:ras(bc[0],bc[1],bc[2]), boneN:bn };
`);
console.log(JSON.stringify(probe, null, 1));
cdp.close();
