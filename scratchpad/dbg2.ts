import { loadCase, downsampleXY } from "./kits-io.ts";
const c0 = await loadCase("KiTS-00057"); const c = downsampleXY(c0, 2);
const [nx,ny,nz]=c.dims,N=nx*ny*nz;
const bins=new Int32Array(400); for(let i=0;i<c.ct.length;i++){const b=(c.ct[i]+1000)/5|0;if(b>=0&&b<400)bins[b]++;} let bb=-1,bi=0;for(let b=160;b<194;b++)if(bins[b]>bb){bb=bins[b];bi=b;} const fat=bi*5-1000;
const vv:number[]=[];for(let z=nz*0.2|0;z<(nz*0.8|0);z+=2)for(let y=ny*0.25|0;y<(ny*0.75|0);y+=2)for(let x=nx*0.25|0;x<(nx*0.75|0);x+=2){const v=c.ct[x+nx*(y+ny*z)];if(v>20&&v<300)vv.push(v);}vv.sort((a,b)=>a-b);const cortex=vv[vv.length*0.97|0];
let sx=0,mn=0;for(let z=nz*0.2|0;z<(nz*0.8|0);z++)for(let y=ny*0.4|0;y<ny;y++)for(let x=nx*0.3|0;x<(nx*0.7|0);x++)if(c.ct[x+nx*(y+ny*z)]>300){sx+=x;mn++;}const mid=mn?sx/mn:nx/2;
const relE=new Float32Array(N);const denom=Math.max(1,cortex-fat);for(let i=0;i<N;i++)relE[i]=(c.ct[i]-fat)/denom;
const region=new Uint8Array(N);
for(let z=0;z<nz;z++)for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){const i=x+nx*(y+ny*z);const lat=Math.abs(x-mid)/nx;if(lat<0.05||lat>0.34)continue;const v=c.ct[i];if(v<=-30||v>=330)continue;if(relE[i]>=0.72&&relE[i]<=1.25)region[i]=1;}
let seeds=0;for(let i=0;i<N;i++)seeds+=region[i];
const nb=[1,-1,nx,-nx,nx*ny,-nx*ny];const stack=new Int32Array(N);let sp=0;for(let i=0;i<N;i++)if(region[i])stack[sp++]=i;
while(sp>0){const i=stack[--sp];const x=i%nx;for(let k=0;k<6;k++){const j=i+nb[k];if(j<0||j>=N)continue;if(k<2&&Math.abs((j%nx)-x)>1)continue;if(region[j])continue;const v=c.ct[j];if(v<=-30||v>=330)continue;const r=relE[j];if(r<0.55||r>1.30)continue;region[j]=1;if(sp<stack.length)stack[sp++]=j;}}
const dice=(m:Uint8Array)=>{let it=0,a=0,b=0;for(let i=0;i<N;i++){const p=m[i]?1:0,g=(c.lab[i]===1||c.lab[i]===2)?1:0;it+=p&g;a+=p;b+=g;}return `${(2*it/(a+b)).toFixed(3)} mask=${a} gt=${b} inter=${it}`;};
console.log(`dims=${nx}x${ny}x${nz} fat=${fat} cortex=${cortex} mid=${mid.toFixed(0)} seeds=${seeds}`);
console.log("grown dice:", dice(region));
const bbox=(pred:(i:number)=>boolean)=>{let x0=1e9,x1=-1,y0=1e9,y1=-1,z0=1e9,z1=-1;for(let i=0;i<N;i++)if(pred(i)){const z=i/(nx*ny)|0,r=i%(nx*ny),y=r/nx|0,x=r%nx;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;if(z<z0)z0=z;if(z>z1)z1=z;}return `x[${x0},${x1}] y[${y0},${y1}] z[${z0},${z1}]`;};
console.log("grown bbox:", bbox(i=>!!region[i]));
console.log("GT    bbox:", bbox(i=>!!c.lab[i]));
