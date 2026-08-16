// Kidney-envelope assembly v1, following SEGMENTATION-SKILL probe recipe, driven by the
// GPU feature-cortex. Tests whether phase-normalized relative-enhancement makes ONE fixed
// envelope band work across contrast phases (raw-HU threshold capped at Dice 0.42).
//
// Probe 0 anchors (fat, cortex) -> GPU relEnhance -> Probe1 localize (spine midline +
// paravertebral zone) -> Probe3 envelope candidate (relE band, not-fat) -> 26-CC keep the
// two paravertebral organ-sized comps -> Probe4 shape-close (per-slice hole fill) -> score.
import { loadCase, type Case } from "./kits-io.ts";
import { makeRunner } from "../algorithms/features/runner.ts";
import { K } from "../algorithms/features/kernels.ts";
import { initDevice } from "../render/device.ts";

const TRAIN = ["KiTS-00013", "KiTS-00057", "KiTS-00081", "KiTS-00111", "KiTS-00010"];
// fixed "weights" (calibrated, not per-case):
const REL_LO = 0.30, REL_HI = 1.35;   // envelope band in phase-normalized enhancement
const FAT_HU = -30;                    // wall
const HI_HU = 330;                     // exclude bone / excreted contrast
const LAT_LO = 0.05, LAT_HI = 0.32;    // |x-midline|/nx paravertebral band
const SIZE_LO = 30000, SIZE_HI = 600000;

function fatMode(ct: Int16Array): number {
  const bins = new Int32Array(400);
  for (let i = 0; i < ct.length; i++) { const b = (ct[i] + 1000) / 5 | 0; if (b >= 0 && b < 400) bins[b]++; }
  let best = -1, bi = 0; for (let b = 160; b < 194; b++) if (bins[b] > best) { best = bins[b]; bi = b; }
  return bi * 5 - 1000;
}
function cortexAnchor(c: Case): number {
  const [nx, ny, nz] = c.dims; const vals: number[] = [];
  for (let z = nz * 0.2 | 0; z < (nz * 0.8 | 0); z += 3) for (let y = ny * 0.25 | 0; y < (ny * 0.75 | 0); y += 3) for (let x = nx * 0.25 | 0; x < (nx * 0.75 | 0); x += 3) {
    const v = c.ct[x + nx * (y + ny * z)]; if (v > 20 && v < 300) vals.push(v);
  }
  vals.sort((a, b) => a - b); return vals[vals.length * 0.97 | 0] || 150;
}
// spine midline x: centroid of bone (HU>300) voxels in central band, robust per-volume
function midlineX(c: Case): number {
  const [nx, ny, nz] = c.dims; let sx = 0, n = 0;
  for (let z = nz * 0.2 | 0; z < (nz * 0.8 | 0); z += 2) for (let y = ny * 0.4 | 0; y < ny; y += 2) for (let x = nx * 0.3 | 0; x < (nx * 0.7 | 0); x += 2) {
    if (c.ct[x + nx * (y + ny * z)] > 300) { sx += x; n++; }
  }
  return n ? sx / n : nx / 2;
}

function dice(a: Uint8Array, pred: (i: number) => boolean, gt: (v: number) => boolean, lab: Uint8Array): number {
  let inter = 0, pa = 0, pb = 0;
  for (let i = 0; i < a.length; i++) { const p = pred(i) ? 1 : 0, g = gt(lab[i]) ? 1 : 0; inter += p & g; pa += p; pb += g; }
  return pa + pb ? (2 * inter) / (pa + pb) : 1;
}

async function segment(c: Case, gpu: Awaited<ReturnType<typeof initDevice>>) {
  const [nx, ny, nz] = c.dims, N = nx * ny * nz;
  const fat = fatMode(c.ct), cortex = cortexAnchor(c), mid = midlineX(c);
  const ctF = Float32Array.from(c.ct);
  const rn = await makeRunner(ctF, c.dims, gpu);
  const relE = await rn.run("relEnhance", K.relEnhance.body, K.relEnhance.params(fat, cortex));
  rn.destroy();
  // candidate mask
  const cand = new Uint8Array(N);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + nx * (y + ny * z);
    const latf = Math.abs(x - mid) / nx;
    if (latf < LAT_LO || latf > LAT_HI) continue;
    const v = c.ct[i]; if (v <= FAT_HU || v >= HI_HU) continue;
    const r = relE[i]; if (r < REL_LO || r > REL_HI) continue;
    cand[i] = 1;
  }
  // 26-connected components (BFS), keep paravertebral organ-sized comps
  const comp = new Int32Array(N).fill(-1);
  const stack = new Int32Array(1 << 22); let ncomp = 0;
  const comps: { id: number; size: number; cx: number }[] = [];
  const nb: number[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) nb.push(dx + nx * (dy + ny * dz));
  for (let s = 0; s < N; s++) {
    if (!cand[s] || comp[s] >= 0) continue;
    let sp = 0; stack[sp++] = s; comp[s] = ncomp; let size = 0, sumx = 0;
    while (sp > 0) {
      const i = stack[--sp]; size++;
      const z = i / (nx * ny) | 0, r = i % (nx * ny), y = r / nx | 0, x = r % nx; sumx += x;
      for (let k = 0; k < nb.length; k++) {
        const j = i + nb[k];
        if (j < 0 || j >= N) continue;
        // guard x-wrap
        const jx = j % nx; if (Math.abs(jx - x) > 1) continue;
        if (cand[j] && comp[j] < 0) { comp[j] = ncomp; if (sp < stack.length) stack[sp++] = j; }
      }
    }
    comps.push({ id: ncomp, size, cx: sumx / size }); ncomp++;
  }
  // keep organ-sized, paravertebral comps; take up to 2 largest
  const keep = comps.filter((c2) => c2.size >= SIZE_LO && c2.size <= SIZE_HI && Math.abs(c2.cx - mid) / nx >= LAT_LO && Math.abs(c2.cx - mid) / nx <= LAT_HI)
    .sort((a, b) => b.size - a.size).slice(0, 2);
  const keepSet = new Set(keep.map((k) => k.id));
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (comp[i] >= 0 && keepSet.has(comp[i])) mask[i] = 1;
  // Probe4: per-slice hole fill (captures enclosed medulla the band dropped)
  const filled = fillHoles(mask, nx, ny, nz);
  return { mask: filled, fat, cortex, mid, keptComps: keep.length };
}

// 2D hole fill per axial slice: background reachable from border stays 0; enclosed 0 -> 1
function fillHoles(mask: Uint8Array, nx: number, ny: number, nz: number): Uint8Array {
  const out = mask.slice(); const bg = new Uint8Array(nx * ny); const st = new Int32Array(nx * ny);
  for (let z = 0; z < nz; z++) {
    const base = z * nx * ny; bg.fill(0); let sp = 0;
    const push = (x: number, y: number) => { const p = y * nx + x; if (!mask[base + p] && !bg[p]) { bg[p] = 1; st[sp++] = p; } };
    for (let x = 0; x < nx; x++) { push(x, 0); push(x, ny - 1); }
    for (let y = 0; y < ny; y++) { push(0, y); push(nx - 1, y); }
    while (sp > 0) { const p = st[--sp]; const x = p % nx, y = p / nx | 0;
      if (x > 0) push(x - 1, y); if (x < nx - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < ny - 1) push(x, y + 1); }
    for (let p = 0; p < nx * ny; p++) if (!mask[base + p] && !bg[p]) out[base + p] = 1; // enclosed hole
  }
  return out;
}

const gpu = await initDevice();
const results = [];
for (const pid of TRAIN) {
  const c = await loadCase(pid);
  const t0 = performance.now();
  const { mask, fat, cortex, mid, keptComps } = await segment(c, gpu);
  const dt = (performance.now() - t0).toFixed(0);
  const dKidney = dice(mask, (i) => mask[i] === 1, (v) => v === 1 || v === 2, c.lab); // envelope vs kidney+mass
  results.push({ pid, dice: +dKidney.toFixed(3), keptComps, fat, cortex, mid: Math.round(mid) });
  console.log(`${pid}: envelope Dice=${dKidney.toFixed(3)}  (kept ${keptComps} comps, fat=${fat} cortex=${cortex} mid=${Math.round(mid)}, ${dt}ms)`);
}
const mean = results.reduce((s, r) => s + r.dice, 0) / results.length;
console.log(`\nMEAN envelope Dice = ${mean.toFixed(3)}  (fixed band relE[${REL_LO},${REL_HI}], no per-case tuning)`);
await Deno.writeTextFile("scratchpad/assemble1-results.json", JSON.stringify(results, null, 2));
