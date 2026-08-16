// Best-guess kidney+mass segmentation on a BLIND (never-seen) KiTS case, full res on A100.
// Relational kidney: paravertebral zone (spine frame) INTERSECT enhancement band, MINUS
// detected vessels/bone/fat, keep-2 compact, shape-close, hole-fill; best-effort mass split
// by low fine-variance (architectural-disruption). Writes ct/gt/seged NRRDs for Slicer.
import { loadCase, type Case } from "./kits-io.ts";
import { makeRunner } from "../algorithms/features/runner.ts";
import { K } from "../algorithms/features/kernels.ts";
import { initDevice } from "../render/device.ts";
import { writeCT, writeSeg } from "./nrrd.ts";

const PID = Deno.args[0] || "KiTS-00003";
const OUT = Deno.args[1] || "/home/ubuntu/out";
const c = await loadCase(PID);
const [nx, ny, nz] = c.dims, N = nx * ny * nz;
const nb6 = [1, -1, nx, -nx, nx * ny, -nx * ny];
const nb26: number[] = []; for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) nb26.push(dx + nx * (dy + ny * dz));
const wrapX = (j: number, x: number, d: number) => (d === 1 || d === -1) && Math.abs((j % nx) - x) > 1;

// anchors + frame
function fatMode(ct: Int16Array) { const b = new Int32Array(400); for (let i = 0; i < N; i++) { const q = (ct[i] + 1000) / 5 | 0; if (q >= 0 && q < 400) b[q]++; } let m = -1, mi = 0; for (let q = 160; q < 194; q++) if (b[q] > m) { m = b[q]; mi = q; } return mi * 5 - 1000; }
function cortexAnchor() { const v: number[] = []; for (let i = 0; i < N; i += 7) { const h = c.ct[i]; if (h > 20 && h < 300) v.push(h); } v.sort((a, b) => a - b); return v[v.length * 0.97 | 0] || 150; }
const fat = fatMode(c.ct), cortex = cortexAnchor();
let sx = 0, sy = 0, sn = 0; for (let z = nz * 0.15 | 0; z < (nz * 0.85 | 0); z++) for (let y = 0; y < ny; y++) for (let x = nx * 0.3 | 0; x < (nx * 0.7 | 0); x++) if (c.ct[x + nx * (y + ny * z)] > 250) { sx += x; sy += y; sn++; }
const midX = sn ? sx / sn : nx / 2, spineY = sn ? sy / sn : ny / 2;
const widths: number[] = []; for (let z = nz * 0.2 | 0; z < (nz * 0.8 | 0); z += 4) { let x0 = nx, x1 = 0; const yy = ny / 2 | 0; for (let x = 0; x < nx; x++) if (c.ct[x + nx * (yy + ny * z)] > -400) { if (x < x0) x0 = x; if (x > x1) x1 = x; } if (x1 > x0) widths.push(x1 - x0); } widths.sort((a, b) => a - b); const bodyW = widths[widths.length >> 1] || nx * 0.7;

// GPU features
const gpu = await initDevice();
const rn = await makeRunner(Float32Array.from(c.ct), c.dims, gpu);
const relE = await rn.run("relEnhance", K.relEnhance.body, K.relEnhance.params(fat, cortex));
const lvar = await rn.run("localVar", K.localVar.body, K.localVar.params(1));
rn.destroy();

// bone-near (dilate bone)
const boneNear = (() => { let cur = new Uint8Array(N); for (let i = 0; i < N; i++) if (c.ct[i] > 300) cur[i] = 1; for (let it = 0; it < 4; it++) { const o = new Uint8Array(N); for (let i = 0; i < N; i++) { let on = cur[i]; if (!on) { const x = i % nx; for (const d of nb6) { const j = i + d; if (j < 0 || j >= N || wrapX(j, x, d)) continue; if (cur[j]) { on = 1; break; } } } o[i] = on; } cur = o; } return cur; })();

// vessels: 3D tubes near midline, anterior to spine, enhancing (detect1 logic)
const vessel = (() => {
  const cand = new Uint8Array(N);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = x + nx * (y + ny * z); if (Math.abs(x - midX) > 0.14 * bodyW) continue; if (y > spineY) continue; if (boneNear[i]) continue; const h = c.ct[i]; if (h < 70 || h > 340) continue; if (relE[i] < 0.72) continue; cand[i] = 1; }
  const comp = new Int32Array(N).fill(-1); const st = new Int32Array(1 << 22); const mask = new Uint8Array(N);
  type C = { mem: number[]; sz: number; zs: number; bx: number; by: number };
  const comps: C[] = [];
  for (let s = 0; s < N; s++) { if (!cand[s] || comp[s] >= 0) continue; let sp = 0; st[sp++] = s; comp[s] = 0; let sz = 0, zmin = nz, zmax = 0, x0 = nx, x1 = 0, y0 = ny, y1 = 0; const mem: number[] = []; while (sp > 0) { const i = st[--sp]; sz++; mem.push(i); const z = i / (nx * ny) | 0, r = i % (nx * ny), yy = r / nx | 0, xx = r % nx; if (z < zmin) zmin = z; if (z > zmax) zmax = z; if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; for (const d of nb26) { const j = i + d; if (j < 0 || j >= N || Math.abs((j % nx) - xx) > 1) continue; if (cand[j] && comp[j] < 0) { comp[j] = 0; if (sp < st.length) st[sp++] = j; } } } comps.push({ mem, sz, zs: zmax - zmin + 1, bx: x1 - x0, by: y1 - y0 }); }
  comps.filter((k) => k.zs >= Math.max(10, nz * 0.12) && k.bx <= 0.16 * bodyW && k.by <= 0.22 * bodyW && (k.sz / k.zs) >= 25 && (k.sz / k.zs) <= 1600).sort((a, b) => b.sz - a.sz).slice(0, 3).forEach((t) => t.mem.forEach((i) => mask[i] = 1));
  return mask;
})();

// candidate kidney: paravertebral band ∩ enhancement band, minus fat/vessel/bone
const cand = new Uint8Array(N);
for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = x + nx * (y + ny * z); const lat = Math.abs(x - midX) / bodyW; if (lat < 0.06 || lat > 0.40) continue; const h = c.ct[i]; if (h <= -30 || h >= 330) continue; if (boneNear[i] || vessel[i]) continue; const r = relE[i]; if (r < 0.55 || r > 1.35) continue; cand[i] = 1; }

// CC keep 2 largest paravertebral organ-sized
function keep2(m: Uint8Array): Uint8Array {
  const comp = new Int32Array(N).fill(-1); const st = new Int32Array(1 << 23); const comps: { id: number; sz: number; cx: number }[] = []; let nc = 0;
  for (let s = 0; s < N; s++) { if (!m[s] || comp[s] >= 0) continue; let sp = 0; st[sp++] = s; comp[s] = nc; let sz = 0, sxx = 0; while (sp > 0) { const i = st[--sp]; sz++; const x = i % nx; sxx += x; for (const d of nb26) { const j = i + d; if (j < 0 || j >= N || Math.abs((j % nx) - x) > 1) continue; if (m[j] && comp[j] < 0) { comp[j] = nc; if (sp < st.length) st[sp++] = j; } } } comps.push({ id: nc, sz, cx: sxx / sz }); nc++; }
  const keep = comps.filter((k) => k.sz >= 40000 && k.sz <= 1200000 && Math.abs(k.cx - midX) / bodyW >= 0.06 && Math.abs(k.cx - midX) / bodyW <= 0.40).sort((a, b) => b.sz - a.sz).slice(0, 2);
  const ks = new Set(keep.map((k) => k.id)); const o = new Uint8Array(N); for (let i = 0; i < N; i++) if (comp[i] >= 0 && ks.has(comp[i])) o[i] = 1; return o;
}
function morphClose(src: Uint8Array, R: number): Uint8Array { let a = src, b = new Uint8Array(N); const step = (dil: boolean) => { for (let i = 0; i < N; i++) { const x = i % nx; if (dil) { let on = a[i]; if (!on) for (const d of nb6) { const j = i + d; if (j < 0 || j >= N || wrapX(j, x, d)) continue; if (a[j]) { on = 1; break; } } b[i] = on; } else { let on = a[i]; if (on) for (const d of nb6) { const j = i + d; if (j < 0 || j >= N) { on = 0; break; } if (wrapX(j, x, d)) continue; if (!a[j]) { on = 0; break; } } b[i] = on; } } const t = a; a = b; b = t; }; for (let r = 0; r < R; r++) step(true); for (let r = 0; r < R; r++) step(false); return a; }
function fillHoles(m: Uint8Array): Uint8Array { const out = m.slice(); const bg = new Uint8Array(nx * ny); const fq = new Int32Array(nx * ny); for (let z = 0; z < nz; z++) { const base = z * nx * ny; bg.fill(0); let q = 0; const push = (x: number, y: number) => { const p = y * nx + x; if (!m[base + p] && !bg[p]) { bg[p] = 1; fq[q++] = p; } }; for (let x = 0; x < nx; x++) { push(x, 0); push(x, ny - 1); } for (let y = 0; y < ny; y++) { push(0, y); push(nx - 1, y); } while (q > 0) { const p = fq[--q]; const x = p % nx, y = p / nx | 0; if (x > 0) push(x - 1, y); if (x < nx - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < ny - 1) push(x, y + 1); } for (let p = 0; p < nx * ny; p++) if (!m[base + p] && !bg[p]) out[base + p] = 1; } return out; }

const envelope = fillHoles(morphClose(keep2(cand), 4));

// best-effort mass: inside envelope, low fine-variance (uniform blob), largest compact CC
const massCand = new Uint8Array(N); for (let i = 0; i < N; i++) if (envelope[i] && lvar[i] < 700) massCand[i] = 1;
const massBlob = (() => { const comp = new Int32Array(N).fill(-1); const st = new Int32Array(1 << 22); let best: number[] = []; for (let s = 0; s < N; s++) { if (!massCand[s] || comp[s] >= 0) continue; let sp = 0; st[sp++] = s; comp[s] = 0; const mem: number[] = []; while (sp > 0) { const i = st[--sp]; mem.push(i); const x = i % nx; for (const d of nb26) { const j = i + d; if (j < 0 || j >= N || Math.abs((j % nx) - x) > 1) continue; if (massCand[j] && comp[j] < 0) { comp[j] = 0; if (sp < st.length) st[sp++] = j; } } } if (mem.length > best.length) best = mem; } const o = new Uint8Array(N); if (best.length > 8000) for (const i of best) o[i] = 1; return o; })();

// assemble seged: 1=kidney, 2=mass
const seged = new Uint8Array(N); for (let i = 0; i < N; i++) { if (envelope[i]) seged[i] = massBlob[i] ? 2 : 1; }

// scores
function dice(pred: (i: number) => number, gtv: number[]) { let it = 0, a = 0, b = 0; const gs = new Set(gtv); for (let i = 0; i < N; i++) { const p = pred(i) ? 1 : 0, g = gs.has(c.lab[i]) ? 1 : 0; it += p & g; a += p; b += g; } return a + b ? 2 * it / (a + b) : 1; }
const dKidney = dice((i) => (seged[i] === 1 || seged[i] === 2) ? 1 : 0, [1, 2]);   // whole kidney footprint
const dMass = dice((i) => seged[i] === 2 ? 1 : 0, [2]);
console.log(`${PID}: envelope(kidney) Dice=${dKidney.toFixed(3)} | mass Dice=${dMass.toFixed(3)}  (fat=${fat} cortex=${cortex} midX=${midX.toFixed(0)} bodyW=${bodyW.toFixed(0)})`);

// write NRRDs
await Deno.mkdir(OUT, { recursive: true });
await writeCT(`${OUT}/ct.nrrd`, c.ct, c.dims, c.ijkToRAS);
await writeSeg(`${OUT}/gt.seg.nrrd`, c.lab, c.dims, c.ijkToRAS, [{ value: 1, name: "Kidney", color: [0.9, 0.4, 0.4] }, { value: 2, name: "Mass", color: [0.4, 0.7, 0.95] }]);
await writeSeg(`${OUT}/seged.seg.nrrd`, seged, c.dims, c.ijkToRAS, [{ value: 1, name: "Kidney", color: [0.9, 0.4, 0.4] }, { value: 2, name: "Mass", color: [0.4, 0.7, 0.95] }]);
console.log(`wrote ${OUT}/{ct.nrrd, gt.seg.nrrd, seged.seg.nrrd}`);
