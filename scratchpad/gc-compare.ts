import { initDevice } from "../render/device.ts";
import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { GrowCutEffect, uploadImage } from "../algorithms/effects/growcut.ts";
import type { Vec3 } from "../algorithms/geom.ts";
const gpu = await initDevice();
for (const n of [128, 192, 256]) {
  const dims: Vec3 = [n,n,n], N = n*n*n;
  const ijk = [1,0,0,-n/2, 0,1,0,-n/2, 0,0,1,-n/2, 0,0,0,1];
  const c = n/2, r = n*0.32;
  const img = new Float32Array(N), seeds = new Uint8Array(N), truth = new Uint8Array(N);
  for (let z=0;z<n;z++) for (let y=0;y<n;y++) for (let x=0;x<n;x++){ const i=(z*n+y)*n+x; const ins=(x-c)**2+(y-c)**2+(z-c)**2<=r*r; truth[i]=ins?1:0; img[i]=ins?0.75:0.25; }
  const put=(x:number,y:number,z:number,id:number)=>{for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++)for(let d=-1;d<=1;d++)seeds[(((z+a)*n+(y+b))*n+(x+d))]=id;};
  put(c,c,c,1); for(const[x,y,z]of[[3,3,3],[n-4,3,3],[3,n-4,3],[3,3,n-4],[n-4,n-4,3],[n-4,3,n-4],[3,n-4,n-4],[n-4,n-4,n-4]] as Vec3[])put(x,y,z,2);
  const seg=new EditableSegmentation(gpu.device,dims,{ijkToRAS:ijk}); seg.loadLabelmap(seeds);
  const it=uploadImage(gpu.device,img,dims); const gc=new GrowCutEffect(seg,it);
  const t0=performance.now(); const iters=await gc.grow({intensityRange:0.5}); await gpu.device.queue.onSubmittedWorkDone(); const ms=performance.now()-t0;
  const out=await seg.readLabelmap(); let inter=0,a=0,b=0; for(let i=0;i<N;i++){const s=out[i]===1?1:0; inter+=s&truth[i]; a+=s; b+=truth[i];}
  console.log(`${n}³: WebGPU growcut ${ms.toFixed(0)}ms (${iters} iters), Dice=${(2*inter/(a+b)).toFixed(4)}`);
  seg.destroy(); gc.destroy(); it.destroy();
}
gpu.device.destroy();
