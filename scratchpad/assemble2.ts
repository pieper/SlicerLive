// Kidney-envelope assembly v2 — the real skill operator:
//   seed confident cortex -> confidence-connected GROW (adaptive band, fat wall barrier)
//   -> morphological OPENING (sever thin liver/psoas bridges at bare areas)
//   -> keep 2 compact paravertebral components -> per-slice hole fill (medulla).
// Driven by GPU relative-enhancement. Fixed weights across all cases.
import { loadCase, downsampleXY, type Case } from "./kits-io.ts";
import { makeRunner } from "../algorithms/features/runner.ts";
import { K } from "../algorithms/features/kernels.ts";
import { initDevice } from "../render/device.ts";

const TRAIN = ["KiTS-00013", "KiTS-00057", "KiTS-00081", "KiTS-00111", "KiTS-00010"];
const SEED_LO = 0.72, SEED_HI = 1.25;  // confident cortex seed in phase-normalized enhancement
// FIXED cortex+parenchyma band for growth (NO adaptive re-broadening — that self-leaks).
const BAND_LO = 0.55, BAND_HI = 1.30;
const FAT_HU = -30, HI_HU = 330;
const LAT_LO = 0.05, LAT_HI = 0.34;
const CLOSE_R = 4;                       // dilate-then-erode radius: bridge cortex rim, enclose medulla
const SIZE_LO = 25000, SIZE_HI = 700000;

function anchors(c: Case) {
  const [nx, ny, nz] = c.dims;
  const bins = new Int32Array(400); for (let i = 0; i < c.ct.length; i++) { const b = (c.ct[i] + 1000) / 5 | 0; if (b >= 0 && b < 400) bins[b]++; }
  let bb = -1, bi = 0; for (let b = 160; b < 194; b++) if (bins[b] > bb) { bb = bins[b]; bi = b; } const fat = bi * 5 - 1000;
  const vv: number[] = []; for (let z = nz * 0.2 | 0; z < (nz * 0.8 | 0); z += 3) for (let y = ny * 0.25 | 0; y < (ny * 0.75 | 0); y += 3) for (let x = nx * 0.25 | 0; x < (nx * 0.75 | 0); x += 3) { const v = c.ct[x + nx * (y + ny * z)]; if (v > 20 && v < 300) vv.push(v); }
  vv.sort((a, b) => a - b); const cortex = vv[vv.length * 0.97 | 0] || 150;
  let sx = 0, mn = 0; for (let z = nz * 0.2 | 0; z < (nz * 0.8 | 0); z += 2) for (let y = ny * 0.4 | 0; y < ny; y += 2) for (let x = nx * 0.3 | 0; x < (nx * 0.7 | 0); x += 2) if (c.ct[x + nx * (y + ny * z)] > 300) { sx += x; mn++; }
  return { fat, cortex, mid: mn ? sx / mn : nx / 2 };
}

// 6-neighbor offsets
function neigh6(nx: number, ny: number) { return [1, -1, nx, -nx, nx * ny, -nx * ny]; }

function mean_sd(relE: Float32Array, region: Uint8Array): [number, number] {
  let s = 0, s2 = 0, n = 0; for (let i = 0; i < region.length; i++) if (region[i]) { const v = relE[i]; s += v; s2 += v * v; n++; }
  const m = s / n; return [m, Math.sqrt(Math.max(0, s2 / n - m * m))];
}

function grow(c: Case, relE: Float32Array, a: ReturnType<typeof anchors>) {
  const [nx, ny, nz] = c.dims, N = nx * ny * nz;
  const region = new Uint8Array(N);
  // seeds: confident cortex, paravertebral, not fat
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + nx * (y + ny * z); const latf = Math.abs(x - a.mid) / nx;
    if (latf < LAT_LO || latf > LAT_HI) continue;
    const v = c.ct[i]; if (v <= FAT_HU || v >= HI_HU) continue;
    if (relE[i] >= SEED_LO && relE[i] <= SEED_HI) region[i] = 1;
  }
  const nb = neigh6(nx, ny); const stack = new Int32Array(1 << 23);
  // single flood over a FIXED band (cortex+parenchyma), fat wall barrier, no re-broadening
  let sp = 0; for (let i = 0; i < N; i++) if (region[i]) { if (sp < stack.length) stack[sp++] = i; }
  while (sp > 0) {
    const i = stack[--sp]; const x = i % nx;
    for (let k = 0; k < 6; k++) {
      const j = i + nb[k]; if (j < 0 || j >= N) continue;
      if (k < 2 && Math.abs((j % nx) - x) > 1) continue; // x-wrap guard
      if (region[j]) continue;
      const v = c.ct[j]; if (v <= FAT_HU || v >= HI_HU) continue; // fat wall + bone/contrast
      const r = relE[j]; if (r < BAND_LO || r > BAND_HI) continue;
      region[j] = 1; if (sp < stack.length) stack[sp++] = j;
    }
  }
  return region;
}

// separable-ish 3D erode/dilate with 6-neighborhood, R iterations
function morph(mask: Uint8Array, nx: number, ny: number, nz: number, R: number, dilate: boolean): Uint8Array {
  const nb = neigh6(nx, ny); let cur = mask;
  for (let it = 0; it < R; it++) {
    const out = new Uint8Array(cur.length);
    for (let i = 0; i < cur.length; i++) {
      const x = i % nx;
      if (dilate) {
        let on = cur[i]; if (!on) for (let k = 0; k < 6; k++) { const j = i + nb[k]; if (j < 0 || j >= cur.length) continue; if (k < 2 && Math.abs((j % nx) - x) > 1) continue; if (cur[j]) { on = 1; break; } }
        out[i] = on;
      } else {
        let on = cur[i]; if (on) for (let k = 0; k < 6; k++) { const j = i + nb[k]; if (j < 0 || j >= cur.length) { on = 0; break; } if (k < 2 && Math.abs((j % nx) - x) > 1) continue; if (!cur[j]) { on = 0; break; } }
        out[i] = on;
      }
    }
    cur = out;
  }
  return cur;
}

function keepCompact(mask: Uint8Array, nx: number, ny: number, nz: number, mid: number): Uint8Array {
  const N = mask.length; const comp = new Int32Array(N).fill(-1); const stack = new Int32Array(1 << 23);
  const nb: number[] = []; for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) nb.push(dx + nx * (dy + ny * dz));
  const comps: { id: number; size: number; cx: number }[] = []; let nc = 0;
  for (let s = 0; s < N; s++) {
    if (!mask[s] || comp[s] >= 0) continue; let sp = 0; stack[sp++] = s; comp[s] = nc; let size = 0, sumx = 0;
    while (sp > 0) { const i = stack[--sp]; size++; const x = i % nx; sumx += x;
      for (let k = 0; k < nb.length; k++) { const j = i + nb[k]; if (j < 0 || j >= N) continue; if (Math.abs((j % nx) - x) > 1) continue; if (mask[j] && comp[j] < 0) { comp[j] = nc; if (sp < stack.length) stack[sp++] = j; } } }
    comps.push({ id: nc, size, cx: sumx / size }); nc++;
  }
  const keep = comps.filter((c2) => c2.size >= SIZE_LO && c2.size <= SIZE_HI && Math.abs(c2.cx - mid) / nx >= LAT_LO && Math.abs(c2.cx - mid) / nx <= LAT_HI).sort((a, b) => b.size - a.size).slice(0, 2);
  const ks = new Set(keep.map((k) => k.id)); const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (comp[i] >= 0 && ks.has(comp[i])) out[i] = 1;
  return out;
}

function fillHoles(mask: Uint8Array, nx: number, ny: number, nz: number): Uint8Array {
  const out = mask.slice(); const bg = new Uint8Array(nx * ny); const st = new Int32Array(nx * ny);
  for (let z = 0; z < nz; z++) { const base = z * nx * ny; bg.fill(0); let sp = 0;
    const push = (x: number, y: number) => { const p = y * nx + x; if (!mask[base + p] && !bg[p]) { bg[p] = 1; st[sp++] = p; } };
    for (let x = 0; x < nx; x++) { push(x, 0); push(x, ny - 1); } for (let y = 0; y < ny; y++) { push(0, y); push(nx - 1, y); }
    while (sp > 0) { const p = st[--sp]; const x = p % nx, y = p / nx | 0; if (x > 0) push(x - 1, y); if (x < nx - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < ny - 1) push(x, y + 1); }
    for (let p = 0; p < nx * ny; p++) if (!mask[base + p] && !bg[p]) out[base + p] = 1;
  }
  return out;
}

function diceVs(mask: Uint8Array, lab: Uint8Array): number { let inter = 0, a = 0, b = 0; for (let i = 0; i < mask.length; i++) { const p = mask[i], g = (lab[i] === 1 || lab[i] === 2) ? 1 : 0; inter += p & g; a += p; b += g; } return a + b ? 2 * inter / (a + b) : 1; }

const gpu = await initDevice();
const results = [];
for (const pid of TRAIN) {
  const c = downsampleXY(await loadCase(pid), 2); const [nx, ny, nz] = c.dims;
  const a = anchors(c);
  const rn = await makeRunner(Float32Array.from(c.ct), c.dims, gpu);
  const relE = await rn.run("relEnhance", K.relEnhance.body, K.relEnhance.params(a.fat, a.cortex)); rn.destroy();
  const t0 = performance.now();
  const grown = grow(c, relE, a);
  const closed = morph(morph(grown, nx, ny, nz, CLOSE_R, true), nx, ny, nz, CLOSE_R, false); // dilate then erode = close (enclose medulla)
  const kept = keepCompact(closed, nx, ny, nz, a.mid);
  const filled = fillHoles(kept, nx, ny, nz);
  const dt = (performance.now() - t0).toFixed(0);
  let gn = 0, kn = 0; for (let i = 0; i < grown.length; i++) { gn += grown[i]; kn += filled[i]; }
  const d = diceVs(filled, c.lab);
  results.push({ pid, dice: +d.toFixed(3), grownVox: gn, finalVox: kn });
  console.log(`${pid}: Dice=${d.toFixed(3)}  grown=${gn} final=${kn}  (fat=${a.fat} cortex=${a.cortex}, ${dt}ms)`);
}
const mean = results.reduce((s, r) => s + r.dice, 0) / results.length;
console.log(`\nMEAN envelope Dice = ${mean.toFixed(3)}`);
await Deno.writeTextFile("scratchpad/assemble2-results.json", JSON.stringify(results, null, 2));
