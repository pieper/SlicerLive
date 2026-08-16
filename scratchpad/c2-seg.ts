import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 60000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const cdp = await CDP.attachToPage(9222, "seged-app.html");
// native-space kidney localization: retroperitoneal paravertebral zone + enhancing HU + connected components
const P = { x0:112, enhLo:30, enhHi:350, zLo:125, zHi:216, yLo:80, yHi:172, latLo:14, latHi:64, minComp:800 };
const r = await ev(cdp, `
  const ct=window.seged.ctArray(); const [nx,ny,nz]=window.seged.dimsArr(); const ijk=window.seged.ijkArr();
  const N=nx*ny*nz; const I=(x,y,z)=>(z*ny+y)*nx+x;
  const ras=(x,y,z)=>[ijk[0]*x+ijk[1]*y+ijk[2]*z+ijk[3], ijk[4]*x+ijk[5]*y+ijk[6]*z+ijk[7], ijk[8]*x+ijk[9]*y+ijk[10]*z+ijk[11]];
  const P=${JSON.stringify(P)};
  const cand=new Uint8Array(N);
  for(let z=P.zLo;z<P.zHi;z++)for(let y=P.yLo;y<P.yHi;y++)for(let x=0;x<nx;x++){
    const lat=Math.abs(x-P.x0); if(lat<P.latLo||lat>P.latHi)continue;
    const v=ct[I(x,y,z)]; if(v<P.enhLo||v>P.enhHi)continue; cand[I(x,y,z)]=1; }
  const comp=new Int32Array(N); let nc=0; const sizes=[],cents=[]; const st=[];
  for(let z=P.zLo;z<P.zHi;z++)for(let y=P.yLo;y<P.yHi;y++)for(let x=0;x<nx;x++){
    const s=I(x,y,z); if(!cand[s]||comp[s])continue; nc++; let sz=0,cx=0,cy=0,cz=0; st.length=0; st.push(s); comp[s]=nc;
    while(st.length){ const p=st.pop(); const pz=(p/(nx*ny))|0, rr=p-pz*nx*ny, py=(rr/nx)|0, px=rr-py*nx; sz++;cx+=px;cy+=py;cz+=pz;
      for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){ if(!dx&&!dy&&!dz)continue; const qx=px+dx,qy=py+dy,qz=pz+dz; if(qx<0||qy<0||qz<0||qx>=nx||qy>=ny||qz>=nz)continue; const q=I(qx,qy,qz); if(cand[q]&&!comp[q]){comp[q]=nc;st.push(q);} } }
    sizes.push(sz); cents.push([cx/sz,cy/sz,cz/sz]); }
  const order=sizes.map((s,i)=>[s,i]).sort((a,b)=>b[0]-a[0]);
  const keepMask=new Uint8Array(nc+1); const kept=[];
  for(const [s,i] of order){ if(s<P.minComp)break; keepMask[i+1]=1; kept.push({size:s,centRAS:ras(...cents[i]).map(x=>Math.round(x))}); if(kept.length>=4)break; }
  const lab=new Uint8Array(N); let lv=0; for(let i=0;i<N;i++){ if(keepMask[comp[i]]){lab[i]=1;lv++;} }
  window.seged.applyLabelmap(lab);
  return { nc, candVox: cand.reduce((a,b)=>a+b,0), top:order.slice(0,6).map(([s,i])=>({size:s,cent:ras(...cents[i]).map(x=>Math.round(x))})), keptN:kept.length, kept, labeledVox:lv };
`, 120000);
console.log("SEG RESULT:", JSON.stringify(r, null, 1));
const score = await ev(cdp, `return await globalThis.seged.scoreCandidate();`);
console.log("SCORE:", JSON.stringify(score));
await ev(cdp, `return globalThis.seged.view({axial:0.70, coronal:0.42});`);
await cdp.screenshot("scratchpad/c2/KiTS-00012-native1.png");
console.log("screenshot saved");
cdp.close();
