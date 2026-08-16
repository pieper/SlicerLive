// Minimal ONNX-graph executor over hand-written WGSL compute kernels — the LiveCodec
// Decoder25D variant. Vendored + adapted from nnLive docs/js/wgpu-net.js (same design:
// pipeline cache keyed on WGSL source, uniforms prebuilt in _plan, liveness-pooled
// activation buffers, ONE command encoder per run, f16 storage with f32 accumulators).
//
// Differences from the nnLive original:
//   * Conv is generalized to anisotropic kernels/pads (KD,KH,KW / padZ,padY,padX) so
//     the plane-stage "2D convs on a batch of slices" run as KD=1 3D convs over the
//     c-major (1,C,D,H,W) layout that scripts/dump_graph25.py (LiveCodec) emits.
//   * GroupNorm(G) kernels (stats + apply, ±fused SiLU): per-group stats over the
//     whole volume (perSlice=0, mix stage) or per (slice, group) (perSlice=1, plane
//     stage — the fold of z into batch).
//   * SiLU activation, fused into its producer Conv (write-out epilogue) or
//     GroupNorm apply pass when it is the sole consumer.
//   * SwapAB: swaps the two leading dims of a (A,B,S) tensor — the final z-interleave
//     that puts decoded slice j of latent slice d at z = A*d + j.
//   * Optional f32 mode (dtype "f32") for adapters without shader-f16: identical
//     sources with f16 tokens rewritten to f32 (weights converted from the f16 blob
//     at load). Same math, 2x memory.
export const U = GPUBufferUsage;
export const f32tof16 = (() => { const b = new ArrayBuffer(4), f = new Float32Array(b), i = new Uint32Array(b);
  return x => { f[0] = x; const bits = i[0]; const s = (bits >>> 16) & 0x8000; let e = (bits >>> 23) & 0xff; let m = bits & 0x7fffff;
    if (e === 255) return s | 0x7c00 | (m ? 0x200 : 0); e = e - 127 + 15; if (e >= 31) return s | 0x7c00;
    if (e <= 0) { if (e < -10) return s; m |= 0x800000; return s | (m >>> (14 - e)); } return s | (e << 10) | (m >>> 13); }; })();
export const f16tof32 = h => { const s = (h & 0x8000) ? -1 : 1; const e = (h >> 10) & 0x1f; const m = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024); if (e === 31) return m ? NaN : s * Infinity; return s * Math.pow(2, e - 15) * (1 + m / 1024); };
export const toF16 = a => { const u = new Uint16Array(a.length); for (let i = 0; i < a.length; i++) u[i] = f32tof16(a[i]); return u; };
let _f16lut = null;                        // 64K-entry exact f16->f32 table: bulk readback convert is ~10x the per-call decode
export const fromF16 = u => {
  if (!_f16lut) { _f16lut = new Float32Array(65536); for (let i = 0; i < 65536; i++) _f16lut[i] = f16tof32(i); }
  const a = new Float32Array(u.length); for (let i = 0; i < u.length; i++) a[i] = _f16lut[u[i]]; return a;
};

export async function initDevice() {
  const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const feats = ['shader-f16'].filter(f => ad.features.has(f));
  const dev = await ad.requestDevice({ requiredFeatures: feats,
    requiredLimits: { maxBufferSize: ad.limits.maxBufferSize, maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize } });
  return { dev, info: ad.info || {}, hasF16: feats.includes('shader-f16') };
}

// ---------- WGSL kernels ----------
// Implicit-GEMM conv with on-the-fly im2col. 16x16 workgroup; each thread owns a TMxTN
// output micro-tile; tile = 16TM x 16TN; KT=16 K-tiling; vec4<f16> shared staging; f32
// accumulate. silu=true fuses the activation into the write-out. kb (optional)
// = {KD,KH,KW,pz,py,px} baked as compile-time literals (stride 1): the im2col address
// div/mod chains strength-reduce, and KD=1/pz=0 drops the z bounds check entirely —
// a large win on the high-res low-channel decoder layers.
export function genConv(TM, TN, silu = false, kb = null) {
  const AS = 64 * TM, BS = 64 * TN, ACC = TM * TN;
  let af = '', bf = '', fma = '', wr = '';
  for (let i = 0; i < TM; i++) af += `af[${i}u]=As[(ar+${i}u)*4u+k4];`;
  for (let j = 0; j < TN; j++) bf += `bf[${j}u]=Bs[(br+${j}u)*4u+k4];`;
  for (let i = 0; i < TM; i++) for (let j = 0; j < TN; j++) fma += `acc[${i * TN + j}u]+=f32(dot(af[${i}u],bf[${j}u]));`;
  for (let i = 0; i < TM; i++) for (let j = 0; j < TN; j++) {
    wr += silu
      ? `{let gm=rowBase+ar+${i}u;let gn=colBase+br+${j}u;if(gm<d.Co&&gn<Nvox){let v=acc[${i * TN + j}u]+f32(bias[gm]);outp[gm*Nvox+gn]=f16(v/(1.0+exp(-v)));}}`
      : `{let gm=rowBase+ar+${i}u;let gn=colBase+br+${j}u;if(gm<d.Co&&gn<Nvox){outp[gm*Nvox+gn]=f16(acc[${i * TN + j}u])+bias[gm];}}`;
  }
  let gB;
  if (kb) {
    const { KD, KH, KW, pz, py, px } = kb, taps = KD * KH * KW;
    const zCheck = (KD === 1 && pz === 0)
      ? 'let iz=i32(oz);'
      : `let iz=i32(oz)+i32(kz)-${pz}; if(iz<0||iz>=i32(d.ID)){return f16(0);}`;
    gB = `fn gB(gk:u32,oz:u32,oy:u32,ox:u32)->f16{ let ci=gk/${taps}u; let tap=gk%${taps}u;
  let kz=tap/${KH * KW}u; let ky=(tap/${KW}u)%${KH}u; let kx=tap%${KW}u;
  ${zCheck}
  let iy=i32(oy)+i32(ky)-${py}; let ix=i32(ox)+i32(kx)-${px};
  if(iy<0||iy>=i32(d.IH)||ix<0||ix>=i32(d.IW)){return f16(0);}
  return inp[((ci*d.ID+u32(iz))*d.IH+u32(iy))*d.IW+u32(ix)]; }`;
  } else {
    gB = `fn gB(gk:u32,oz:u32,oy:u32,ox:u32)->f16{ let taps=d.KD*d.KH*d.KW; let ci=gk/taps; let tap=gk%taps;
  let kz=tap/(d.KH*d.KW); let ky=(tap/d.KW)%d.KH; let kx=tap%d.KW;
  let iz=i32(oz*d.S)+i32(kz)-i32(d.pz); let iy=i32(oy*d.S)+i32(ky)-i32(d.py); let ix=i32(ox*d.S)+i32(kx)-i32(d.px);
  if(iz<0||iz>=i32(d.ID)||iy<0||iy>=i32(d.IH)||ix<0||ix>=i32(d.IW)){return f16(0);}
  return inp[((ci*d.ID+u32(iz))*d.IH+u32(iy))*d.IW+u32(ix)]; }`;
  }
  const ktot = kb ? `d.Ci*${kb.KD * kb.KH * kb.KW}u` : 'd.Ci*d.KD*d.KH*d.KW';
  return `struct D{Ci:u32,Co:u32,OD:u32,OH:u32,OW:u32,ID:u32,IH:u32,IW:u32,KD:u32,KH:u32,KW:u32,S:u32,pz:u32,py:u32,px:u32,aux:u32};
@group(0)@binding(0) var<storage,read> inp:array<f16>; @group(0)@binding(1) var<storage,read> wgt:array<f16>;
@group(0)@binding(2) var<storage,read> bias:array<f16>; @group(0)@binding(3) var<storage,read_write> outp:array<f16>;
@group(0)@binding(4) var<uniform> d:D;
var<workgroup> As:array<vec4<f16>,${AS}>; var<workgroup> Bs:array<vec4<f16>,${BS}>;
${gB}
@compute @workgroup_size(16,16)
fn main(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid:vec3<u32>){
  let Nvox=d.OD*d.OH*d.OW; let Ktot=${ktot}; let Ktiles=(Ktot+15u)/16u;
  let tid=lid.y*16u+lid.x; let rowBase=wid.y*${16 * TM}u; let ntile=wid.z*d.aux+wid.x; let colBase=ntile*${16 * TN}u;
  let OHW=d.OH*d.OW; let ar=lid.y*${TM}u; let br=lid.x*${TN}u;
  var acc:array<f32,${ACC}>; for(var i=0u;i<${ACC}u;i++){acc[i]=0.0;}
  for(var kk:u32=0u;kk<Ktiles;kk++){
    for(var e=tid;e<${AS}u;e+=256u){ let m=e/4u;let k4=e%4u;let gm=rowBase+m;let base=kk*16u+k4*4u; var v=vec4<f16>(0.0,0.0,0.0,0.0);
      if(gm<d.Co){let o=gm*Ktot+base; if(base<Ktot){v.x=wgt[o];} if(base+1u<Ktot){v.y=wgt[o+1u];} if(base+2u<Ktot){v.z=wgt[o+2u];} if(base+3u<Ktot){v.w=wgt[o+3u];}} As[e]=v; }
    for(var e=tid;e<${BS}u;e+=256u){ let n=e/4u;let k4=e%4u;let gn=colBase+n;let base=kk*16u+k4*4u; var v=vec4<f16>(0.0,0.0,0.0,0.0);
      if(gn<Nvox){let oz=gn/OHW;let rem=gn%OHW;let oy=rem/d.OW;let ox=rem%d.OW; v.x=gB(base,oz,oy,ox);v.y=gB(base+1u,oz,oy,ox);v.z=gB(base+2u,oz,oy,ox);v.w=gB(base+3u,oz,oy,ox);} Bs[e]=v; }
    workgroupBarrier();
    for(var k4=0u;k4<4u;k4++){ var af:array<vec4<f16>,${TM}>; var bf:array<vec4<f16>,${TN}>; ${af} ${bf} ${fma} }
    workgroupBarrier();
  }
  ${wr}
}`;
}
// GroupNorm stats: ONE 256-thread workgroup per instance. perSlice=0: instance = group g,
// reducing over the contiguous (C/G)*D*HW span (c-major layout). perSlice=1: instance =
// (g,d) — workgroup w = g*D+d — reducing over the (C/G)*HW elements of slice d, strided by D.
const GN_STATS = `struct P{Cg:u32,D:u32,HW:u32,G:u32,ps:u32};
@group(0)@binding(0) var<storage,read> x:array<f16>;
@group(0)@binding(1) var<storage,read_write> st:array<f32>; @group(0)@binding(2) var<uniform> p:P;
var<workgroup> ss:array<f32,256>; var<workgroup> sq:array<f32,256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid:vec3<u32>){
  let w=wid.x; var g=w; var d0=0u; var N=p.Cg*p.D*p.HW;
  if(p.ps==1u){ g=w/p.D; d0=w%p.D; N=p.Cg*p.HW; }
  var s=0.0; var q=0.0;
  for(var i=lid.x;i<N;i+=256u){ var idx=g*N+i;
    if(p.ps==1u){ let cc=i/p.HW; let sp=i%p.HW; idx=((g*p.Cg+cc)*p.D+d0)*p.HW+sp; }
    let v=f32(x[idx]); s+=v; q+=v*v; }
  ss[lid.x]=s; sq[lid.x]=q; workgroupBarrier();
  for(var t=128u;t>0u;t>>=1u){ if(lid.x<t){ss[lid.x]+=ss[lid.x+t];sq[lid.x]+=sq[lid.x+t];} workgroupBarrier(); }
  if(lid.x==0u){ let m=ss[0]/f32(N); let vr=sq[0]/f32(N)-m*m; st[w*2u]=m; st[w*2u+1u]=inverseSqrt(max(vr,0.0)+1e-5); } }`;
// GroupNorm apply: stats indexed by instance (group or group*D+slice), scale/bias per channel.
const GN_APPLY = `struct P{C:u32,Cg:u32,D:u32,HW:u32,ps:u32,gx:u32};
@group(0)@binding(0) var<storage,read> x:array<f16>; @group(0)@binding(1) var<storage,read> st:array<f32>;
@group(0)@binding(2) var<storage,read> sc:array<f16>; @group(0)@binding(3) var<storage,read> bi:array<f16>;
@group(0)@binding(4) var<storage,read_write> y:array<f16>; @group(0)@binding(5) var<uniform> p:P;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid:vec3<u32>){
  let idx=(wid.y*p.gx+wid.x)*256u+lid.x; if(idx>=p.C*p.D*p.HW){return;}
  let c=idx/(p.D*p.HW); let g=c/p.Cg; var w=g;
  if(p.ps==1u){ w=g*p.D+(idx/p.HW)%p.D; }
  y[idx]=f16((f32(x[idx])-st[w*2u])*st[w*2u+1u]*f32(sc[c])+f32(bi[c])); }`;
const GN_APPLY_SILU = GN_APPLY.replace(
  'y[idx]=f16((f32(x[idx])-st[w*2u])*st[w*2u+1u]*f32(sc[c])+f32(bi[c])); }',
  'let v=(f32(x[idx])-st[w*2u])*st[w*2u+1u]*f32(sc[c])+f32(bi[c]); y[idx]=f16(v/(1.0+exp(-v))); }');
const SILU = `struct P{n:u32,gx:u32}; @group(0)@binding(0) var<storage,read> a:array<f16>;
@group(0)@binding(1) var<storage,read_write> y:array<f16>; @group(0)@binding(2) var<uniform> p:P;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid:vec3<u32>){
  let i=(wid.y*p.gx+wid.x)*256u+lid.x; if(i>=p.n){return;} let v=f32(a[i]); y[i]=f16(v/(1.0+exp(-v))); }`;
const ADD = `struct P{n:u32,gx:u32}; @group(0)@binding(0) var<storage,read> a:array<f16>;
@group(0)@binding(1) var<storage,read> b:array<f16>; @group(0)@binding(2) var<storage,read_write> y:array<f16>;
@group(0)@binding(3) var<uniform> p:P;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid:vec3<u32>){
  let i=(wid.y*p.gx+wid.x)*256u+lid.x; if(i>=p.n){return;} y[i]=a[i]+b[i]; }`;
const RESIZE = `struct D{C:u32,OD:u32,OH:u32,OW:u32,ID:u32,IH:u32,IW:u32,gx:u32};
@group(0)@binding(0) var<storage,read> x:array<f16>; @group(0)@binding(1) var<storage,read_write> y:array<f16>;
@group(0)@binding(2) var<uniform> d:D;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid:vec3<u32>){
  let idx=(wid.y*d.gx+wid.x)*256u+lid.x; let Nout=d.C*d.OD*d.OH*d.OW; if(idx>=Nout){return;}
  let OHW=d.OH*d.OW; let c=idx/(d.OD*OHW); let r=idx%(d.OD*OHW); let oz=r/OHW; let rr=r%OHW; let oy=rr/d.OW; let ox=rr%d.OW;
  let iz=(oz*d.ID)/d.OD; let iy=(oy*d.IH)/d.OH; let ix=(ox*d.IW)/d.OW;   // nearest/floor asymmetric
  y[idx]=x[((c*d.ID+iz)*d.IH+iy)*d.IW+ix]; }`;
// DepthToSpace, mode=CRD — nn.PixelShuffle(B) as ONE node (the v3 decoder's
// upsample: convolve at the LOWER resolution emitting B*B x channels, then
// scatter each channel group into a BxB pixel block, so no wide feature map is
// ever materialized at the higher resolution).
//   out[c, z, B*y+i, B*x+j] = in[c*B*B + i*B + j, z, y, x]
// CRD = channels-rightmost: output channel c's B*B sub-pixels come from
// CONSECUTIVE input channels (verified against torch, not assumed — the DCR
// ordering interleaves the other way and silently produces a scrambled image).
// A pure gather, one dispatch, elementwise over the OUTPUT.
const D2S = `struct P{C:u32,D:u32,OH:u32,OW:u32,IH:u32,IW:u32,B:u32,gx:u32};
@group(0)@binding(0) var<storage,read> x:array<f16>; @group(0)@binding(1) var<storage,read_write> y:array<f16>;
@group(0)@binding(2) var<uniform> p:P;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid:vec3<u32>){
  let idx=(wid.y*p.gx+wid.x)*256u+lid.x; let OHW=p.OH*p.OW; if(idx>=p.C*p.D*OHW){return;}
  let c=idx/(p.D*OHW); let r=idx%(p.D*OHW); let z=r/OHW; let rr=r%OHW; let oy=rr/p.OW; let ox=rr%p.OW;
  let ci=c*p.B*p.B+(oy%p.B)*p.B+(ox%p.B);
  let v=x[((ci*p.D+z)*p.IH+oy/p.B)*p.IW+ox/p.B];
  y[idx]=v; }`;
// SiLU fused into the gather's write-out: v3 follows every upsample with one, and
// the tensor is at the HIGHER resolution, so a separate pass would cost a whole
// extra round trip through the widest activation in the plane stage.
const D2S_SILU = D2S.replace('y[idx]=v; }', 'let f=f32(v); y[idx]=f16(f/(1.0+exp(-f))); }');
// swap the two leading dims of an (A,B,S) tensor: y[(b*A+a)*S+s] = x[(a*B+b)*S+s]
const SWAPAB = `struct P{A:u32,B:u32,S:u32,gx:u32};
@group(0)@binding(0) var<storage,read> x:array<f16>; @group(0)@binding(1) var<storage,read_write> y:array<f16>;
@group(0)@binding(2) var<uniform> p:P;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid:vec3<u32>){
  let idx=(wid.y*p.gx+wid.x)*256u+lid.x; if(idx>=p.A*p.B*p.S){return;}
  let a=idx/(p.B*p.S); let b=(idx/p.S)%p.B; let s=idx%p.S;
  y[(b*p.A+a)*p.S+s]=x[idx]; }`;

// Reusable graph net: load graph.json + weights.bin once, run per input (pooled buffers,
// swappable graph inputs). dtype "f16" (default) or "f32" (no shader-f16 fallback).
export class Net {
  constructor(dev, R, dtype = 'f16') {
    this.dev = dev; this.R = R; this.dtype = dtype; this.esz = dtype === 'f16' ? 2 : 4;
    this.ext = {}; this.inBuf = {}; this.convTM = 4; this.convTN = 4;   // best on M4 with the per-layer TM clamp (autotune can override)
  }
  async load(graphUrl, weightsUrl) {
    const dev = this.dev;
    this.graph = await (await fetch(graphUrl)).json();
    const wblob = new Uint16Array(await (await fetch(weightsUrl)).arrayBuffer());
    this.prod = s => s.reduce((a, b) => a * b, 1);
    this.mk = b => dev.createBuffer({ size: Math.max(16, b), usage: U.STORAGE | U.COPY_SRC | U.COPY_DST });
    this.W = {};
    for (const [n, w] of Object.entries(this.graph.weights)) {
      const b = this.mk(w.numel * this.esz);
      const src = wblob.subarray(w.offset, w.offset + w.numel);
      dev.queue.writeBuffer(b, 0, this.dtype === 'f16' ? src : fromF16(src));
      this.W[n] = b;
    }
    this._plan();
    return this;
  }
  bytesOf(n) { return this.prod(this.graph.tensors[n]) * this.esz; }
  _plan() {
    const g = this.graph, R = this.R;
    const inSet = new Set(g.inputs.map(i => i.name));
    const cons = {}; for (const nd of g.nodes) for (const i of nd.in) (cons[i] = cons[i] || []).push(nd);
    // fuse a single-consumer Silu into its Conv / GroupNorm / DepthToSpace producer
    const FUSABLE = new Set(['Conv', 'GroupNorm', 'DepthToSpace']);
    const skip = new Set(), fuseOut = {};
    for (const nd of g.nodes) if (FUSABLE.has(nd.op)) {
      const c = cons[nd.out[0]];
      if (c && c.length === 1 && c[0].op === 'Silu') { skip.add(c[0]); fuseOut[nd.out[0]] = c[0].out[0]; }
    }
    const ops = [];
    for (const nd of g.nodes) {
      if (skip.has(nd)) continue;
      const fo = FUSABLE.has(nd.op) ? fuseOut[nd.out[0]] : undefined;
      ops.push({ nd, out: fo || nd.out[0], fused: !!fo });
    }
    const lastUse = {}; ops.forEach((o, i) => { for (const t of o.nd.in) lastUse[t] = i; });
    g.outputs.forEach(o => lastUse[o.name] = 1e18);
    const T = {}, pool = []; this.zeroBias = {};
    const acquire = b => { let bi = -1; for (let i = 0; i < pool.length; i++) if (pool[i].size >= b && (bi < 0 || pool[i].size < pool[bi].size)) bi = i; return bi >= 0 ? pool.splice(bi, 1)[0] : this.mk(b); };
    const zB = C => (this.zeroBias[C] = this.zeroBias[C] || this.mk(C * this.esz));
    this.recs = [];
    ops.forEach((o, i) => {
      const nd = o.nd, tsr = g.tensors;
      if (!inSet.has(o.out)) T[o.out] = acquire(this.bytesOf(o.out));
      const r = { op: nd.op, ins: nd.in, out: o.out };
      if (nd.op === 'Conv') {
        const os = tsr[o.out], is = tsr[nd.in[0]]; const Nvox = os[2] * os[3] * os[4];
        r.bias = nd.bias ? nd.in[2] : null; r.Co = nd.Co; r.silu = o.fused;
        r.kb = { KD: nd.KD, KH: nd.KH, KW: nd.KW, pz: nd.padZ, py: nd.padY, px: nd.padX };
        r.cs = [nd.Ci, nd.Co, os[2], os[3], os[4], is[2], is[3], is[4], nd.KD, nd.KH, nd.KW, nd.S, nd.padZ, nd.padY, nd.padX];
        this._convDispatch(r);
      } else if (nd.op === 'GroupNorm') {
        const s = tsr[o.out]; const C = s[1], D = s[2], HW = s[3] * s[4];
        const G = nd.G, Cg = C / G, ps = nd.perSlice ? 1 : 0, nInst = ps ? G * D : G;
        r.stats = this.mk(nInst * 2 * 4); r.u1 = R.uni([Cg, D, HW, G, ps]); r.statsWg = [nInst, 1, 1];
        const gd = R.grid(C * D * HW); r.u2 = R.uni([C, Cg, D, HW, ps, gd.gx]); r.wg = gd.wg;
        r.applyK = o.fused ? R.GN_APPLY_SILU : R.GN_APPLY;
      } else if (nd.op === 'Silu' || nd.op === 'Add') {
        const n = this.prod(tsr[o.out]); const gd = R.grid(n); r.u = R.uni([n, gd.gx]); r.wg = gd.wg;
      } else if (nd.op === 'Concat') { r.parts = nd.in.map(x => this.bytesOf(x)); }
      else if (nd.op === 'Resize') {
        const os = tsr[o.out], is = tsr[nd.in[0]]; const Nout = os[1] * os[2] * os[3] * os[4];
        const gd = R.grid(Nout); r.u = R.uni([os[1], os[2], os[3], os[4], is[2], is[3], is[4], gd.gx]); r.wg = gd.wg;
      } else if (nd.op === 'DepthToSpace') {
        const os = tsr[o.out], is = tsr[nd.in[0]], bs = nd.blocksize;
        if (nd.mode !== 'CRD') throw new Error('DepthToSpace mode ' + nd.mode + ' unsupported (CRD only)');
        const gd = R.grid(os[1] * os[2] * os[3] * os[4]);
        r.u = R.uni([os[1], os[2], os[3], os[4], is[3], is[4], bs, gd.gx]); r.wg = gd.wg;
        r.k = o.fused ? R.D2S_SILU : R.D2S;
      } else if (nd.op === 'SwapAB') {
        const S = this.prod(tsr[o.out]) / (nd.A * nd.B); const gd = R.grid(nd.A * nd.B * S);
        r.u = R.uni([nd.A, nd.B, S, gd.gx]); r.wg = gd.wg;
      } else throw new Error('unsupported op ' + nd.op);
      r.inB = nd.in.map(n => inSet.has(n) ? { inp: n } : (this.W[n] || T[n]));
      r.outB = T[o.out]; if (r.bias) r.biasB = this.W[r.bias];
      this.recs.push(r);
      for (const t of nd.in) if (lastUse[t] === i && !(t in this.W) && !inSet.has(t) && T[t]) { pool.push(T[t]); T[t] = null; }
    });
    this.T = T; this.zB = zB;
  }
  _convDispatch(r) {                       // uniform + workgroups + source for the current (TM,TN) tiling
    const cs = r.cs, Nvox = cs[2] * cs[3] * cs[4];
    const TM = Math.min(this.convTM, Math.max(1, Math.ceil(cs[1] / 16)));  // no wasted tile rows on small-Co layers
    const tileR = 16 * TM, tileC = 16 * this.convTN;
    const gx = Math.min(65535, Math.ceil(Nvox / tileC));
    r.u = this.R.uni([...cs, gx]);
    r.wg = [gx, Math.ceil(cs[1] / tileR), Math.ceil(Nvox / tileC / gx)];
    r.src = genConv(TM, this.convTN, r.silu, r.kb);            // pipeline cache dedups identical sources
  }
  setInputBuffer(name, buf) { this.ext[name] = buf; }
  setInputData(name, f32) {
    if (!this.inBuf[name]) this.inBuf[name] = this.mk(this.bytesOf(name));
    this.dev.queue.writeBuffer(this.inBuf[name], 0, this.dtype === 'f16' ? toF16(f32) : f32);
    this.ext[name] = this.inBuf[name];
  }
  run() {
    const B = x => x && x.inp ? this.ext[x.inp] : x, R = this.R, enc = this.dev.createCommandEncoder();
    for (const r of this.recs) {
      const i = r.inB, out = r.outB;
      if (r.op === 'Conv') R.pass(enc, r.src, [B(i[0]), B(i[1]), r.bias ? r.biasB : this.zB(r.Co), out, r.u], r.wg);
      else if (r.op === 'GroupNorm') { R.pass(enc, R.GN_STATS, [B(i[0]), r.stats, r.u1], r.statsWg); R.pass(enc, r.applyK, [B(i[0]), r.stats, B(i[1]), B(i[2]), out, r.u2], r.wg); }
      else if (r.op === 'Silu') R.pass(enc, R.SILU, [B(i[0]), out, r.u], r.wg);
      else if (r.op === 'Add') R.pass(enc, R.ADD, [B(i[0]), B(i[1]), out, r.u], r.wg);
      else if (r.op === 'Concat') { let off = 0; i.forEach((x, k) => { enc.copyBufferToBuffer(B(x), 0, out, off, r.parts[k]); off += r.parts[k]; }); }
      else if (r.op === 'Resize') R.pass(enc, R.RESIZE, [B(i[0]), out, r.u], r.wg);
      else if (r.op === 'DepthToSpace') R.pass(enc, r.k, [B(i[0]), out, r.u], r.wg);
      else if (r.op === 'SwapAB') R.pass(enc, R.SWAPAB, [B(i[0]), out, r.u], r.wg);
    }
    this.dev.queue.submit([enc.finish()]);
  }
  outBufFor(name) { for (const r of this.recs) if (r.out === name) return r.outB; return this.ext[name]; }
  async read(name) {
    const buf = this.outBufFor(name), n = this.prod(this.graph.tensors[name]);
    const rb = this.dev.createBuffer({ size: n * this.esz, usage: U.MAP_READ | U.COPY_DST });
    const e = this.dev.createCommandEncoder(); e.copyBufferToBuffer(buf, 0, rb, 0, n * this.esz); this.dev.queue.submit([e.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = this.dtype === 'f16'
      ? fromF16(new Uint16Array(rb.getMappedRange().slice(0)))
      : new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap(); rb.destroy();
    return out;
  }
  // ---- per-GPU conv autotuning (nnLive scheme: verify against the reference tiling, then time) ----
  setConvConfig(TM, TN) {
    this.convTM = TM; this.convTN = TN;
    for (const r of this.recs) if (r.op === 'Conv') this._convDispatch(r);
  }
  async _verifyConfigs(configs) {
    const dev = this.dev, R = this.R;
    const Ci = 8, Co = 20, OD = 9, OH = 9, OW = 9, K = 3, pad = 1;
    const Nin = Ci * OD * OH * OW, Nw = Co * Ci * K * K * K, Nout = Co * OD * OH * OW, Nvox = OD * OH * OW;
    const rnd = (n, seed) => { const a = new Float32Array(n); let s = seed >>> 0; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; a[i] = s / 0x7fffffff - 0.5; } return a; };
    const mkb = f => { const b = this.mk(f.length * this.esz); dev.queue.writeBuffer(b, 0, this.dtype === 'f16' ? toF16(f) : f); return b; };
    const inB = mkb(rnd(Nin, 1)), wB = mkb(rnd(Nw, 2)), biasB = mkb(rnd(Co, 3)), outB = this.mk(Nout * this.esz);
    const readOut = async () => { const rb = dev.createBuffer({ size: Nout * this.esz, usage: U.MAP_READ | U.COPY_DST }); const e = dev.createCommandEncoder(); e.copyBufferToBuffer(outB, 0, rb, 0, Nout * this.esz); dev.queue.submit([e.finish()]); await rb.mapAsync(GPUMapMode.READ); const o = this.dtype === 'f16' ? fromF16(new Uint16Array(rb.getMappedRange().slice(0))) : new Float32Array(rb.getMappedRange().slice(0)); rb.unmap(); rb.destroy(); return o; };
    const runCfg = (TM, TN) => { const tileC = 16 * TN, tileR = 16 * TM, gx = Math.min(65535, Math.ceil(Nvox / tileC));
      const u = R.uni([Ci, Co, OD, OH, OW, OD, OH, OW, K, K, K, 1, pad, pad, pad, gx]); const wg = [gx, Math.ceil(Co / tileR), Math.ceil(Nvox / tileC / gx)];
      const e = dev.createCommandEncoder(); R.pass(e, genConv(TM, TN), [inB, wB, biasB, outB, u], wg); dev.queue.submit([e.finish()]); };
    runCfg(4, 4); const ref = await readOut();
    const ok = [];
    for (const [TM, TN] of configs) {
      try { runCfg(TM, TN); const o = await readOut(); let md = 0; for (let i = 0; i < Nout; i++) { const dd = Math.abs(o[i] - ref[i]); if (dd > md) md = dd; } if (md < 0.05) ok.push([TM, TN]); }
      catch (e) { /* shader/validation error -> drop this config */ }
    }
    return ok.length ? ok : [[4, 4]];
  }
  // pick the fastest verified conv tiling for THIS gpu by timing the real forward. Inputs must be set.
  async autotuneConv(candidates = [[4, 4], [2, 8], [8, 2], [2, 4], [4, 2], [4, 8], [8, 4]], reps = 3) {
    const verified = await this._verifyConfigs(candidates);
    let best = [4, 4], bestMs = Infinity;
    for (const [TM, TN] of verified) {
      this.setConvConfig(TM, TN);
      this.run(); await this.dev.queue.onSubmittedWorkDone();               // warm (compile pipelines)
      const t = performance.now(); for (let i = 0; i < reps; i++) this.run(); await this.dev.queue.onSubmittedWorkDone();
      const ms = (performance.now() - t) / reps;
      if (ms < bestMs - 0.5) { bestMs = ms; best = [TM, TN]; }               // require a real margin
    }
    this.setConvConfig(best[0], best[1]);
    return { TM: best[0], TN: best[1], ms: Math.round(bestMs), verified: verified.length, tried: candidates.length };
  }
  // FNV-1a over the graph's structure (nodes + tensor shapes, NOT the weights):
  // the conv tiling depends on the shapes being dispatched, so two checkpoints of
  // the same architecture legitimately share a tuning result.
  graphHash() {
    const s = JSON.stringify([this.graph.nodes, this.graph.tensors]);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36);
  }
  // autotuneConv + a localStorage memo keyed on (adapter, dtype, graph shape).
  // Tuning times the REAL forward, so it costs a few SECONDS — hence the memo:
  // once per browser per (GPU, graph). Inputs must already be set (zeros are
  // fine: the timing depends on shapes, not values).
  //   cachedOnly: apply a memoized tiling if there is one, but never pay to
  //     measure — for callers on a latency-critical path (the race page reads
  //     the cache before decoding and warms it afterwards, on an idle GPU, so
  //     tuning never lands on time-to-first-image).
  // Never throws: a failed tune, a blocked localStorage (private mode, no
  // origin) or a corrupt entry all leave the default tiling in place.
  async autotune(gpuKey = '', { candidates, reps, force = false, cachedOnly = false } = {}) {
    const key = `lcnet.conv:${gpuKey}:${this.dtype}:${this.graphHash()}`;
    let ls = null;
    try { ls = globalThis.localStorage; } catch { /* blocked (private mode / no origin) */ }
    if (!force) {
      try {
        const c = JSON.parse(ls?.getItem(key) ?? 'null');
        if (c && c.TM > 0 && c.TN > 0) { this.setConvConfig(c.TM, c.TN); return { ...c, cached: true, key }; }
      } catch { /* corrupt entry -> retune */ }
      if (cachedOnly) return { TM: this.convTM, TN: this.convTN, cached: false, skipped: true, key };
    }
    let res;
    try { res = await this.autotuneConv(candidates, reps); }
    catch (e) { this.setConvConfig(4, 4); return { TM: 4, TN: 4, cached: false, key, error: String(e?.message ?? e) }; }
    try { ls?.setItem(key, JSON.stringify({ TM: res.TM, TN: res.TN, ms: res.ms })); } catch { /* full/blocked */ }
    return { ...res, cached: false, key };
  }
}

export function makeRunner(dev, dtype = 'f16') {
  const pc = new Map();
  const xform = src => dtype === 'f16' ? 'enable f16;\n' + src : src.replace(/f16/g, 'f32');
  const pipe = src => { if (pc.has(src)) return pc.get(src); const m = dev.createShaderModule({ code: xform(src) });
    const p = dev.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } }); pc.set(src, p); return p; };
  const uni = arr => { const b = dev.createBuffer({ size: Math.max(16, arr.length * 4), usage: U.UNIFORM | U.COPY_DST }); dev.queue.writeBuffer(b, 0, new Uint32Array(arr)); return b; };
  const pass = (enc, src, bufs, wg) => { const p = pipe(src);
    const bg = dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    const cp = enc.beginComputePass(); cp.setPipeline(p); cp.setBindGroup(0, bg); cp.dispatchWorkgroups(wg[0], wg[1] || 1, wg[2] || 1); cp.end(); };
  const grid = n => { const nWG = Math.ceil(n / 256), gx = Math.min(65535, nWG); return { gx, wg: [gx, Math.ceil(nWG / gx), 1] }; };
  return { pipe, uni, pass, grid, GN_STATS, GN_APPLY, GN_APPLY_SILU, SILU, ADD, RESIZE, D2S, D2S_SILU, SWAPAB };
}
