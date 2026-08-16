import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 120000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const cdp = await CDP.attachToPage(9222, "seged-app.html");
// HYSTERESIS: low mask (medulla+cortex, excludes muscle) + keep only components that contain enough
// bright-cortex SEED voxels (excludes liver/bowel, which lack bright renal cortex) + paravertebral + organ-sized
const hyst = (P:any)=>`
  const ct=window.seged.ctArray(); const [nx,ny,nz]=window.seged.dimsArr();
  const N=nx*ny*nz; const I=(x,y,z)=>(z*ny+y)*nx+x; const P=${JSON.stringify({x0:112, zLo:120, zHi:220, yLo:78, yHi:174, latLo:12, latHi:60, minComp:1500})}; Object.assign(P, ${JSON.stringify(P)});
  const cand=new Uint8Array(N);
  for(let z=P.zLo;z<P.zHi;z++)for(let y=P.yLo;y<P.yHi;y++)for(let x=0;x<nx;x++){ const lat=Math.abs(x-P.x0); if(lat<P.latLo||lat>P.latHi)continue; const v=ct[I(x,y,z)]; if(v<P.lo||v>P.hi)continue; cand[I(x,y,z)]=1; }
  const comp=new Int32Array(N); let nc=0; const sizes=[],seeds=[]; const st=[];
  for(let z=P.zLo;z<P.zHi;z++)for(let y=P.yLo;y<P.yHi;y++)for(let x=0;x<nx;x++){ const s=I(x,y,z); if(!cand[s]||comp[s])continue; nc++; let sz=0,sd=0; st.length=0; st.push(s); comp[s]=nc;
    while(st.length){ const p=st.pop(); const pz=(p/(nx*ny))|0, rr=p-pz*nx*ny, py=(rr/nx)|0, px=rr-py*nx; sz++; if(ct[p]>P.seed)sd++;
      for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){ if(!dx&&!dy&&!dz)continue; const qx=px+dx,qy=py+dy,qz=pz+dz; if(qx<0||qy<0||qz<0||qx>=nx||qy>=ny||qz>=nz)continue; const q=I(qx,qy,qz); if(cand[q]&&!comp[q]){comp[q]=nc;st.push(q);} } } sizes.push(sz); seeds.push(sd); }
  // keep components that are organ-sized AND have enough bright-cortex seed voxels
  const keepMask=new Uint8Array(nc+1); const kept=[];
  for(let i=0;i<nc;i++){ if(sizes[i]>=P.minComp && seeds[i]>=P.minSeed){ keepMask[i+1]=1; kept.push({size:sizes[i],seed:seeds[i]}); } }
  const lab=new Uint8Array(N); let lv=0; for(let i=0;i<N;i++){ if(keepMask[comp[i]]){lab[i]=1;lv++;} }
  window.seged.applyLabelmap(lab); return { nc, kept, labeledVox:lv };
`;
let best={p:null as any, dice:0};
for (const [lo,seed,minSeed] of [[95,150,60],[100,150,80],[90,160,50],[105,155,80]]) {
  const r = await ev(cdp, `${hyst({lo, hi:400, seed, minSeed})}`, 110000);
  const sc = await ev(cdp, `return await globalThis.seged.scoreCandidate();`) as any[];
  console.log(`lo=${lo} seed=${seed} minSeed=${minSeed}: labeled=${(r as any).labeledVox} kept=${(r as any).kept.length}  kidneyDice=${sc[0].dice.toFixed(3)} (mine ${sc[0].mineVox}/gt ${sc[0].gtVox})`);
  if (sc[0].dice>best.dice) best={p:{lo,seed,minSeed}, dice:sc[0].dice};
}
console.log("BEST hysteresis:", JSON.stringify(best));
await ev(cdp, `${hyst({lo:best.p.lo, hi:400, seed:best.p.seed, minSeed:best.p.minSeed})}`, 110000);
await ev(cdp, `return globalThis.seged.view({axial:0.70, coronal:0.42});`);
await cdp.screenshot("scratchpad/c2/KiTS-00012-hyst.png");
console.log("screenshot saved");
cdp.close();
