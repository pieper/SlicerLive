// Run the feature-cortex on real cases and visualize the maps vs GT.
// Proves the GPU perception layer + shows phase-normalization working.
import { loadCase, writePNG, huToGray, type Case } from "./kits-io.ts";
import { makeRunner } from "../algorithms/features/runner.ts";
import { K } from "../algorithms/features/kernels.ts";

function fatMode(ct: Int16Array): number {
  const bins = new Int32Array(400);
  for (let i = 0; i < ct.length; i++) { const b = Math.floor((ct[i] + 1000) / 5); if (b >= 0 && b < 400) bins[b]++; }
  let best = -1, bi = 0; for (let b = 160; b < 194; b++) if (bins[b] > best) { best = bins[b]; bi = b; }
  return bi * 5 - 1000;
}
// cortex anchor WITHOUT GT: high percentile of soft tissue (20..300 HU) in central abdomen
function cortexAnchor(c: Case): number {
  const [nx, ny, nz] = c.dims; const vals: number[] = [];
  const x0 = nx * 0.25 | 0, x1 = nx * 0.75 | 0, y0 = ny * 0.25 | 0, y1 = ny * 0.75 | 0;
  const step = 3;
  for (let z = (nz * 0.2) | 0; z < (nz * 0.8) | 0; z += step)
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const v = c.ct[x + nx * (y + ny * z)]; if (v > 20 && v < 300) vals.push(v);
    }
  vals.sort((a, b) => a - b); return vals[(vals.length * 0.97) | 0] || 150;
}
function bestKidneyZ(c: Case): number {
  const [nx, ny, nz] = c.dims; let bz = 0, bn = -1;
  for (let z = 0; z < nz; z++) { let n = 0; const b = z * nx * ny; for (let i = b; i < b + nx * ny; i++) if (c.lab[i]) n++; if (n > bn) { bn = n; bz = z; } }
  return bz;
}
// scalar slice -> grayscale RGBA with optional [lo,hi] normalization; gt overlays green/red
function sliceRGBA(map: Float32Array | Int16Array, dims: [number, number, number], z: number, lo: number, hi: number, gt?: Uint8Array): Uint8Array {
  const [nx, ny] = dims; const out = new Uint8Array(nx * ny * 4); const base = z * nx * ny;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = base + y * nx + x; const g = Math.max(0, Math.min(255, Math.round(((map[i] - lo) / (hi - lo)) * 255)));
    const o = (y * nx + x) * 4; let r = g, gg = g, b = g;
    if (gt) { if (gt[i] === 1) { gg = Math.min(255, g + 70); r = g >> 1; b = g >> 1; } else if (gt[i] === 2) { r = Math.min(255, g + 90); gg = g >> 1; b = g >> 1; } }
    out[o] = r; out[o + 1] = gg; out[o + 2] = b; out[o + 3] = 255;
  }
  return out;
}
// tile panels (all same nx,ny) into a row
function tileRow(panels: Uint8Array[], nx: number, ny: number, pad = 3): { w: number; h: number; rgba: Uint8Array } {
  const W = panels.length * (nx + pad) + pad, H = ny + 2 * pad; const c = new Uint8Array(W * H * 4);
  for (let i = 0; i < c.length; i += 4) { c[i] = 12; c[i + 1] = 14; c[i + 2] = 22; c[i + 3] = 255; }
  let cx = pad;
  for (const p of panels) { for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const si = (y * nx + x) * 4, di = ((y + pad) * W + cx + x) * 4; c[di] = p[si]; c[di + 1] = p[si + 1]; c[di + 2] = p[si + 2]; c[di + 3] = 255; } cx += nx + pad; }
  return { w: W, h: H, rgba: c };
}

const CASES = ["KiTS-00013", "KiTS-00057"]; // bright phase, dark phase
const rows: { w: number; h: number; rgba: Uint8Array }[] = [];
for (const pid of CASES) {
  const c = await loadCase(pid);
  const [nx, ny] = c.dims;
  const fat = fatMode(c.ct), cortex = cortexAnchor(c);
  const ctF = Float32Array.from(c.ct);
  const t0 = performance.now();
  const rn = await makeRunner(ctF, c.dims);
  const relE = await rn.run("relEnhance", K.relEnhance.body, K.relEnhance.params(fat, cortex));
  const wall = await rn.run("fatWall", K.fatWall.body, K.fatWall.params(-30));
  const lvar = await rn.run("localVar", K.localVar.body, K.localVar.params(1));
  const grad = await rn.run("gradMag", K.gradMag.body, K.gradMag.params());
  rn.destroy();
  const dt = (performance.now() - t0).toFixed(0);
  const z = bestKidneyZ(c);
  // log-scale variance for display
  const lvarLog = new Float32Array(lvar.length); for (let i = 0; i < lvar.length; i++) lvarLog[i] = Math.log10(1 + lvar[i]);
  const panels = [
    sliceRGBA(c.ct, c.dims, z, -160, 240, c.lab),   // CT + GT
    sliceRGBA(relE, c.dims, z, 0, 1.2),              // phase-normalized enhancement
    sliceRGBA(wall, c.dims, z, 0, 1),                // fat wall
    sliceRGBA(lvarLog, c.dims, z, 1, 4),             // local variance (log)
    sliceRGBA(grad, c.dims, z, 0, 120),              // gradient magnitude
  ];
  rows.push(tileRow(panels, nx, ny));
  console.log(`${pid}: fat=${fat} cortex=${cortex} z=${z}  (4 GPU features in ${dt}ms)  panels: CT+GT | relEnhance | fatWall | localVar | gradMag`);
}
// stack rows
const W = Math.max(...rows.map((r) => r.w)), H = rows.reduce((s, r) => s + r.h, 0);
const canvas = new Uint8Array(W * H * 4); for (let i = 0; i < canvas.length; i += 4) { canvas[i] = 12; canvas[i + 1] = 14; canvas[i + 2] = 22; canvas[i + 3] = 255; }
let cy = 0;
for (const r of rows) { for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const si = (y * r.w + x) * 4, di = ((cy + y) * W + x) * 4; canvas[di] = r.rgba[si]; canvas[di + 1] = r.rgba[si + 1]; canvas[di + 2] = r.rgba[si + 2]; canvas[di + 3] = 255; } cy += r.h; }
await Deno.mkdir("scratchpad/feat", { recursive: true });
await writePNG("scratchpad/feat/features.png", W, H, canvas);
console.log(`\nwrote scratchpad/feat/features.png (${W}x${H}) — rows: ${CASES.join(", ")}`);
