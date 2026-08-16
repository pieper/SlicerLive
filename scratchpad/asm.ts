// Lean, low-footprint kidney-envelope assembly + stage viz (memory-frugal: factor-4 grid,
// ping-pong morph, no redundant copies). CPU relE. Goal: real Dice + a stage image.
import { loadCase, downsampleXY, writePNG, huToGray } from "./kits-io.ts";

const PID = Deno.args[0] || "KiTS-00057";
const F = 4;
const c = downsampleXY(await loadCase(PID), F);
const [nx, ny, nz] = c.dims, N = nx * ny * nz, ct = c.ct, lab = c.lab;

// anchors
const bins = new Int32Array(400); for (let i = 0; i < N; i++) { const b = (ct[i] + 1000) / 5 | 0; if (b >= 0 && b < 400) bins[b]++; }
let bb = -1, bi = 0; for (let b = 160; b < 194; b++) if (bins[b] > bb) { bb = bins[b]; bi = b; } const fat = bi * 5 - 1000;
const vv: number[] = []; for (let i = 0; i < N; i += 5) { const v = ct[i]; if (v > 20 && v < 300) vv.push(v); } vv.sort((a, b) => a - b); const cortex = vv[vv.length * 0.97 | 0] || 150;
let sx = 0, mn = 0; for (let z = nz * 0.2 | 0; z < (nz * 0.8 | 0); z++) for (let y = ny * 0.4 | 0; y < ny; y++) for (let x = nx * 0.3 | 0; x < (nx * 0.7 | 0); x++) if (ct[x + nx * (y + ny * z)] > 300) { sx += x; mn++; } const mid = mn ? sx / mn : nx / 2;
const den = Math.max(1, cortex - fat);
const relE = (i: number) => (ct[i] - fat) / den;

const nb = [1, -1, nx, -nx, nx * ny, -nx * ny];
const wrap = (j: number, x: number, d: number) => (d === 1 || d === -1) && Math.abs((j % nx) - x) > 1;

// grow: seed confident cortex, flood fixed band, fat wall, lateral zone
const region = new Uint8Array(N);
for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = x + nx * (y + ny * z); const l = Math.abs(x - mid) / nx; if (l < 0.05 || l > 0.34) continue; const v = ct[i]; if (v <= -30 || v >= 330) continue; const r = relE(i); if (r >= 0.72 && r <= 1.25) region[i] = 1; }
const stack = new Int32Array(N); let sp = 0; for (let i = 0; i < N; i++) if (region[i]) stack[sp++] = i;
while (sp > 0) { const i = stack[--sp]; const x = i % nx; for (let k = 0; k < 6; k++) { const j = i + nb[k]; if (j < 0 || j >= N || wrap(j, x, nb[k])) continue; if (region[j]) continue; const v = ct[j]; if (v <= -30 || v >= 330) continue; const r = relE(j); if (r < 0.55 || r > 1.30) continue; region[j] = 1; stack[sp++] = j; } }
let grownN = 0; for (let i = 0; i < N; i++) grownN += region[i];
const grown = region.slice();

// ping-pong morphological close (dilate R then erode R) — only 2 buffers
function morphClose(src: Uint8Array, R: number): Uint8Array {
  let a = src, b = new Uint8Array(N);
  const step = (dil: boolean) => { for (let i = 0; i < N; i++) { const x = i % nx; if (dil) { let on = a[i]; if (!on) { for (let k = 0; k < 6; k++) { const j = i + nb[k]; if (j < 0 || j >= N || wrap(j, x, nb[k])) continue; if (a[j]) { on = 1; break; } } } b[i] = on; } else { let on = a[i]; if (on) { for (let k = 0; k < 6; k++) { const j = i + nb[k]; if (j < 0 || j >= N) { on = 0; break; } if (wrap(j, x, nb[k])) continue; if (!a[j]) { on = 0; break; } } } b[i] = on; } } const t = a; a = b; b = t; };
  for (let r = 0; r < R; r++) step(true);
  for (let r = 0; r < R; r++) step(false);
  return a;
}
const closed = morphClose(grown, 3);

// CC (26), keep 2 largest paravertebral organ-sized comps
const comp = new Int32Array(N).fill(-1); const nb26: number[] = [];
for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) nb26.push(dx + nx * (dy + ny * dz));
const comps: { id: number; size: number; cx: number }[] = []; let nc = 0;
for (let s = 0; s < N; s++) { if (!closed[s] || comp[s] >= 0) continue; let q = 0; stack[q++] = s; comp[s] = nc; let size = 0, sumx = 0; while (q > 0) { const i = stack[--q]; size++; const x = i % nx; sumx += x; for (const d of nb26) { const j = i + d; if (j < 0 || j >= N || Math.abs((j % nx) - x) > 1) continue; if (closed[j] && comp[j] < 0) { comp[j] = nc; stack[q++] = j; } } } comps.push({ id: nc, size, cx: sumx / size }); nc++; }
comps.sort((a, b) => b.size - a.size);
const MINSZ = 60000 / (F * F);
const keep = comps.filter((c2) => c2.size >= MINSZ && Math.abs(c2.cx - mid) / nx >= 0.05 && Math.abs(c2.cx - mid) / nx <= 0.34).slice(0, 2);
const ks = new Set(keep.map((k) => k.id));
const mask = new Uint8Array(N); for (let i = 0; i < N; i++) if (comp[i] >= 0 && ks.has(comp[i])) mask[i] = 1;

// per-slice hole fill (medulla)
const bg = new Uint8Array(nx * ny); const fq = new Int32Array(nx * ny);
for (let z = 0; z < nz; z++) { const base = z * nx * ny; bg.fill(0); let q = 0; const push = (x: number, y: number) => { const p = y * nx + x; if (!mask[base + p] && !bg[p]) { bg[p] = 1; fq[q++] = p; } }; for (let x = 0; x < nx; x++) { push(x, 0); push(x, ny - 1); } for (let y = 0; y < ny; y++) { push(0, y); push(nx - 1, y); } while (q > 0) { const p = fq[--q]; const x = p % nx, y = p / nx | 0; if (x > 0) push(x - 1, y); if (x < nx - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < ny - 1) push(x, y + 1); } for (let p = 0; p < nx * ny; p++) if (!mask[base + p] && !bg[p]) mask[base + p] = 1; }

let it = 0, ma = 0, gt = 0; for (let i = 0; i < N; i++) { const p = mask[i], g = (lab[i] === 1 || lab[i] === 2) ? 1 : 0; it += p & g; ma += p; gt += g; }
const dice = 2 * it / (ma + gt || 1);
console.log(`${PID} F=${F} dims=${nx}x${ny}x${nz} fat=${fat} cortex=${cortex} mid=${mid.toFixed(0)}`);
console.log(`grown=${grownN} kept=${keep.length} comps [${keep.map((k) => k.size).join(",")}] final=${ma} gt=${gt}  DICE=${dice.toFixed(3)}`);
console.log("top comps:", comps.slice(0, 5).map((c2) => `${c2.size}@lat${(Math.abs(c2.cx - mid) / nx).toFixed(2)}`).join(" "));

// stage viz on best kidney slice
let bz = 0, bn = -1; for (let z = 0; z < nz; z++) { let n = 0; const base = z * nx * ny; for (let i = base; i < base + nx * ny; i++) if (lab[i]) n++; if (n > bn) { bn = n; bz = z; } }
function panel(kind: string): Uint8Array { const out = new Uint8Array(nx * ny * 4); const base = bz * nx * ny; for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = base + y * nx + x; const g = huToGray(ct[i], 40, 400); const o = (y * nx + x) * 4; let r = g, gg = g, b = g; if (kind === "ctgt") { if (lab[i] === 1) { gg = Math.min(255, g + 80); r = g >> 1; b = g >> 1; } else if (lab[i] === 2) { r = Math.min(255, g + 90); gg = g >> 1; b = g >> 1; } } else if (kind === "grown") { if (grown[i]) { r = 40; gg = 140; b = 255; } } else if (kind === "mask") { if (mask[i]) { r = 255; gg = 40; b = 220; } if (lab[i]) gg = Math.min(255, gg + 70); } out[o] = r; out[o + 1] = gg; out[o + 2] = b; out[o + 3] = 255; } return out; }
const panels = ["ctgt", "grown", "mask"].map(panel);
const pad = 3, W = panels.length * (nx + pad) + pad, H = ny + 2 * pad; const canvas = new Uint8Array(W * H * 4); for (let i = 0; i < canvas.length; i += 4) { canvas[i] = 12; canvas[i + 1] = 14; canvas[i + 2] = 22; canvas[i + 3] = 255; }
let cxp = pad; for (const p of panels) { for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const si = (y * nx + x) * 4, di = ((y + pad) * W + cxp + x) * 4; canvas[di] = p[si]; canvas[di + 1] = p[si + 1]; canvas[di + 2] = p[si + 2]; canvas[di + 3] = 255; } cxp += nx + pad; }
await writePNG(`scratchpad/feat/stages-${PID}.png`, W, H, canvas);
console.log(`wrote scratchpad/feat/stages-${PID}.png — CT+GT | grown(blue) | mask(magenta,GT green)`);
