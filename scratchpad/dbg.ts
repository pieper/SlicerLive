import { loadCase } from "./kits-io.ts";
import { makeRunner } from "../algorithms/features/runner.ts";
import { K } from "../algorithms/features/kernels.ts";
import { initDevice } from "../render/device.ts";
const gpu = await initDevice();
for (const pid of ["KiTS-00057","KiTS-00013"]) {
  const c = await loadCase(pid); const [nx,ny,nz]=c.dims, N=nx*ny*nz;
  // anchors
  const bins=new Int32Array(400); for(let i=0;i<c.ct.length;i++){const b=(c.ct[i]+1000)/5|0; if(b>=0&&b<400)bins[b]++;}
  let bb=-1,bi=0; for(let b=160;b<194;b++) if(bins[b]>bb){bb=bins[b];bi=b;} const fat=bi*5-1000;
  const vv:number[]=[]; for(let z=nz*0.2|0;z<(nz*0.8|0);z+=3)for(let y=ny*0.25|0;y<(ny*0.75|0);y+=3)for(let x=nx*0.25|0;x<(nx*0.75|0);x+=3){const v=c.ct[x+nx*(y+ny*z)]; if(v>20&&v<300)vv.push(v);} vv.sort((a,b)=>a-b); const cortex=vv[vv.length*0.97|0];
  const rn=await makeRunner(Float32Array.from(c.ct),c.dims,gpu);
  const relE=await rn.run("relEnhance",K.relEnhance.body,K.relEnhance.params(fat,cortex)); rn.destroy();
  // midline
  let sx=0,mn=0; for(let z=nz*0.2|0;z<(nz*0.8|0);z+=2)for(let y=ny*0.4|0;y<ny;y+=2)for(let x=nx*0.3|0;x<(nx*0.7|0);x+=2) if(c.ct[x+nx*(y+ny*z)]>300){sx+=x;mn++;} const mid=mn?sx/mn:nx/2;
  // candidate + how many GT-kidney voxels pass the band
  let cand=0, gtK=0, gtInBand=0, gtInLat=0;
  for(let z=0;z<nz;z++)for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){const i=x+nx*(y+ny*z);
    const inLat=Math.abs(x-mid)/nx>=0.05 && Math.abs(x-mid)/nx<=0.32;
    const v=c.ct[i], r=relE[i];
    const pass = inLat && v>-30 && v<330 && r>=0.30 && r<=1.35;
    if(pass)cand++;
    if(c.lab[i]===1||c.lab[i]===2){gtK++; if(v>-30&&v<330&&r>=0.30&&r<=1.35)gtInBand++; if(inLat)gtInLat++;}
  }
  console.log(`${pid}: fat=${fat} cortex=${cortex} mid=${mid.toFixed(0)} | cand=${cand} gtK=${gtK} gtInBand=${gtInBand}(${(100*gtInBand/gtK).toFixed(0)}%) gtInLat=${gtInLat}(${(100*gtInLat/gtK).toFixed(0)}%)`);
}
