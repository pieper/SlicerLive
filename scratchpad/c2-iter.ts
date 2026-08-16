import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 120000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const cdp = await CDP.attachToPage(9222, "seged-app.html");
const seg = (P:any)=>`
  const ct=window.seged.ctArray(); const [nx,ny,nz]=window.seged.dimsArr(); const ijk=window.seged.ijkArr();
  const N=nx*ny*nz; const I=(x,y,z)=>(z*ny+y)*nx+x; const P=${JSON.stringify({x0:112, zLo:125, zHi:216, yLo:80, yHi:172, latLo:14, latHi:58, minComp:1500})};
  Object.assign(P, ${JSON.stringify(P)});
  const cand=new Uint8Array(N);
  for(let z=P.zLo;z<P.zHi;z++)for(let y=P.yLo;y<P.yHi;y++)for(let x=0;x<nx;x++){ const lat=Math.abs(x-P.x0); if(lat<P.latLo||lat>P.latHi)continue; const v=ct[I(x,y,z)]; if(v<P.enhLo||v>P.enhHi)continue; cand[I(x,y,z)]=1; }
  const comp=new Int32Array(N); let nc=0; const sizes=[]; const st=[];
  for(let z=P.zLo;z<P.zHi;z++)for(let y=P.yLo;y<P.yHi;y++)for(let x=0;x<nx;x++){ const s=I(x,y,z); if(!cand[s]||comp[s])continue; nc++; let sz=0; st.length=0; st.push(s); comp[s]=nc;
    while(st.length){ const p=st.pop(); const pz=(p/(nx*ny))|0, rr=p-pz*nx*ny, py=(rr/nx)|0, px=rr-py*nx; sz++;
      for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){ if(!dx&&!dy&&!dz)continue; const qx=px+dx,qy=py+dy,qz=pz+dz; if(qx<0||qy<0||qz<0||qx>=nx||qy>=ny||qz>=nz)continue; const q=I(qx,qy,qz); if(cand[q]&&!comp[q]){comp[q]=nc;st.push(q);} } }
    sizes.push(sz); }
  const order=sizes.map((s,i)=>[s,i]).sort((a,b)=>b[0]-a[0]);
  const keepMask=new Uint8Array(nc+1); let kn=0;
  for(const [s,i] of order){ if(s<P.minComp)break; keepMask[i+1]=1; kn++; if(kn>=2)break; }
  const lab=new Uint8Array(N); let lv=0; for(let i=0;i<N;i++){ if(keepMask[comp[i]]){lab[i]=1;lv++;} }
  window.seged.applyLabelmap(lab);
  return { topSizes:order.slice(0,5).map(o=>o[0]), keptN:kn, labeledVox:lv };
`;
for (const enhLo of [60, 85, 110]) {
  const r = await ev(cdp, `${seg({enhLo, enhHi:350})}`, 120000);
  const sc = await ev(cdp, `return await globalThis.seged.scoreCandidate();`) as any[];
  console.log(`enhLo=${enhLo}: labeled=${(r as any).labeledVox} topSizes=${JSON.stringify((r as any).topSizes)}  kidneyDice=${sc[0].dice.toFixed(3)} (mine ${sc[0].mineVox}/gt ${sc[0].gtVox})`);
}
await ev(cdp, `return globalThis.seged.view({axial:0.70});`);
await cdp.screenshot("scratchpad/c2/KiTS-00012-native2.png");
cdp.close();
