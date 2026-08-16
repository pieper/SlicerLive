// Visualize the assembly pipeline stages on one case to SEE where it fails.
// CPU relE (identical to GPU, crash-proof for debugging). Panels on best-kidney slice:
//   CT+GT | relE | grown | closed | kept-comps
import { loadCase, downsampleXY, writePNG, huToGray } from "./kits-io.ts";

const PID = Deno.args[0] || "KiTS-00057";
const c = downsampleXY(await loadCase(PID), 3); const [nx, ny, nz] = c.dims, N = nx * ny * nz;

// anchors
const bins = new Int32Array(400); for (let i = 0; i < N; i++) { const b = (c.ct[i] + 1000) / 5 | 0; if (b >= 0 && b < 400) bins[b]++; }
let bb = -1, bi = 0; for (let b = 160; b < 194; b++) if (bins[b] > bb) { bb = bins[b]; bi = b; } const fat = bi * 5 - 1000;
const vv: number[] = []; for (let z = nz * 0.2 | 0; z < (nz * 0.8 | 0); z += 2) for (let y = ny * 0.25 | 0; y < (ny * 0.75 | 0); y += 2) for (let x = nx * 0.25 | 0; x < (nx * 0.75 | 0); x += 2) { const v = c.ct[x + nx * (y + ny * z)]; if (v > 20 && v < 300) vv.push(v); }
vv.sort((a, b) => a - b); const cortex = vv[vv.length * 0.97 | 0];
let sx = 0, mn = 0; for (let z = nz * 0.2 | 0; z < (nz * 0.8 | 0); z++) for (let y = ny * 0.4 | 0; y < ny; y++) for (let x = nx * 0.3 | 0; x < (nx * 0.7 | 0); x++) if (c.ct[x + nx * (y + ny * z)] > 300) { sx += x; mn++; } const mid = mn ? sx / mn : nx / 2;
const relE = new Float32Array(N); const den = Math.max(1, cortex - fat); for (let i = 0; i < N; i++) relE[i] = (c.ct[i] - fat) / den;

// grow (fixed band, fat wall, lateral zone)
const region = new Uint8Array(N);
for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = x + nx * (y + ny * z); const lat = Math.abs(x - mid) / nx; if (lat < 0.05 || lat > 0.34) continue; const v = c.ct[i]; if (v <= -30 || v >= 330) continue; if (relE[i] >= 0.72 && relE[i] <= 1.25) region[i] = 1; }
const nb = [1, -1, nx, -nx, nx * ny, -nx * ny]; const stack = new Int32Array(N); let sp = 0; for (let i = 0; i < N; i++) if (region[i]) stack[sp++] = i;
while (sp > 0) { const i = stack[--sp]; const x = i % nx; for (let k = 0; k < 6; k++) { const j = i + nb[k]; if (j < 0 || j >= N) continue; if (k < 2 && Math.abs((j % nx) - x) > 1) continue; if (region[j]) continue; const v = c.ct[j]; if (v <= -30 || v >= 330) continue; const r = relE[j]; if (r < 0.55 || r > 1.30) continue; region[j] = 1; if (sp < stack.length) stack[sp++] = j; } }
const grown = region.slice();

// close R=4
function morph(m: Uint8Array, dil: boolean, R: number) { let cur = m; for (let it = 0; it < R; it++) { const o = new Uint8Array(cur.length); for (let i = 0; i < cur.length; i++) { const x = i % nx; if (dil) { let on = cur[i]; if (!on) for (const d of nb) { const j = i + d; if (j < 0 || j >= cur.length) continue; if (Math.abs((j % nx) - x) > 1 && (d === 1 || d === -1)) continue; if (cur[j]) { on = 1; break; } } o[i] = on; } else { let on = cur[i]; if (on) for (const d of nb) { const j = i + d; if (j < 0 || j >= cur.length) { on = 0; break; } if (Math.abs((j % nx) - x) > 1 && (d === 1 || d === -1)) continue; if (!cur[j]) { on = 0; break; } } o[i] = on; } } cur = o; } return cur; }
const closed = morph(morph(grown, true, 4), false, 4);

// connected comps, label by size rank
const comp = new Int32Array(N).fill(-1); const cs = new Int32Array(N); const nb26: number[] = [];
for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) nb26.push(dx + nx * (dy + ny * dz));
const comps: { id: number; size: number; cx: number }[] = []; let nc = 0;
for (let s = 0; s < N; s++) { if (!closed[s] || comp[s] >= 0) continue; let q = 0; cs[q++] = s; comp[s] = nc; let size = 0, sumx = 0; while (q > 0) { const i = cs[--q]; size++; const x = i % nx; sumx += x; for (const d of nb26) { const j = i + d; if (j < 0 || j >= N) continue; if (Math.abs((j % nx) - x) > 1) continue; if (closed[j] && comp[j] < 0) { comp[j] = nc; if (q < cs.length) cs[q++] = j; } } } comps.push({ id: nc, size, cx: sumx / size }); nc++; }
comps.sort((a, b) => b.size - a.size);
console.log(`${PID} dims=${nx}x${ny}x${nz} fat=${fat} cortex=${cortex} mid=${mid.toFixed(0)}`);
console.log("top comps (size, cx, lat=|cx-mid|/nx):", comps.slice(0, 6).map((c2) => `${c2.size}@${c2.cx.toFixed(0)}(lat${(Math.abs(c2.cx - mid) / nx).toFixed(2)})`).join("  "));
const top2 = new Set(comps.slice(0, 2).map((c) => c.id));

// best kidney slice
let bz = 0, bn = -1; for (let z = 0; z < nz; z++) { let n = 0; const base = z * nx * ny; for (let i = base; i < base + nx * ny; i++) if (c.lab[i]) n++; if (n > bn) { bn = n; bz = z; } }

function panel(kind: string): Uint8Array {
  const out = new Uint8Array(nx * ny * 4); const base = bz * nx * ny;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = base + y * nx + x; const g = huToGray(c.ct[i], 40, 400); const o = (y * nx + x) * 4; let r = g, gg = g, b = g;
    if (kind === "ctgt") { if (c.lab[i] === 1) { gg = Math.min(255, g + 80); r = g >> 1; b = g >> 1; } else if (c.lab[i] === 2) { r = Math.min(255, g + 90); gg = g >> 1; b = g >> 1; } }
    else if (kind === "relE") { const v = Math.max(0, Math.min(255, relE[i] / 1.2 * 255)); r = gg = b = v; }
    else if (kind === "grown") { if (grown[i]) { r = 40; gg = 140; b = 255; } }
    else if (kind === "closed") { if (closed[i]) { r = 255; gg = 120; b = 40; } }
    else if (kind === "kept") { if (comp[i] >= 0 && top2.has(comp[i])) { r = 255; gg = 40; b = 220; } if (c.lab[i]) { gg = Math.min(255, gg + 60); } }
    out[o] = r; out[o + 1] = gg; out[o + 2] = b; out[o + 3] = 255;
  }
  return out;
}
const panels = ["ctgt", "relE", "grown", "closed", "kept"].map(panel);
const pad = 3, W = panels.length * (nx + pad) + pad, H = ny + 2 * pad; const canvas = new Uint8Array(W * H * 4);
for (let i = 0; i < canvas.length; i += 4) { canvas[i] = 12; canvas[i + 1] = 14; canvas[i + 2] = 22; canvas[i + 3] = 255; }
let cx = pad; for (const p of panels) { for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const si = (y * nx + x) * 4, di = ((y + pad) * W + cx + x) * 4; canvas[di] = p[si]; canvas[di + 1] = p[si + 1]; canvas[di + 2] = p[si + 2]; canvas[di + 3] = 255; } cx += nx + pad; }
await Deno.mkdir("scratchpad/feat", { recursive: true });
await writePNG(`scratchpad/feat/stages-${PID}.png`, W, H, canvas);
console.log(`wrote scratchpad/feat/stages-${PID}.png (${W}x${H}) — CT+GT | relE | grown(blue) | closed(orange) | kept-top2(magenta,GT green)`);
