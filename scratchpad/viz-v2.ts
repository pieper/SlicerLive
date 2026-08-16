// Diagnose seg-v2 on one case: render CT+GT | fat-enclosure | seeds | envelope on 3 slices.
import { loadCase, writePNG, huToGray } from "./kits-io.ts";
import { makeRunner } from "../algorithms/features/runner.ts";
import { K } from "../algorithms/features/kernels.ts";
import { initDevice } from "../render/device.ts";

const PID = Deno.args[0] || "KiTS-00013";
const c = await loadCase(PID); const [nx, ny, nz] = c.dims, N = nx * ny * nz;
// anchors (compact copy of seg-v2)
const b = new Int32Array(400); for (let i = 0; i < N; i++) { const q = (c.ct[i] + 1000) / 5 | 0; if (q >= 0 && q < 400) b[q]++; } let mm = -1, mi = 0; for (let q = 160; q < 194; q++) if (b[q] > mm) { mm = b[q]; mi = q; } const fat = mi * 5 - 1000;
const vv: number[] = []; for (let i = 0; i < N; i += 7) { const h = c.ct[i]; if (h > 20 && h < 300) vv.push(h); } vv.sort((a, z) => a - z); const cortex = vv[vv.length * 0.97 | 0] || 150;
let sx = 0, sy = 0, sn = 0; for (let z = nz * 0.15 | 0; z < (nz * 0.85 | 0); z++) for (let y = 0; y < ny; y++) for (let x = nx * 0.3 | 0; x < (nx * 0.7 | 0); x++) if (c.ct[x + nx * (y + ny * z)] > 250) { sx += x; sy += y; sn++; } const midX = sn ? sx / sn : nx / 2, spineY = sn ? sy / sn : ny / 2;
const w: number[] = []; for (let z = nz * 0.2 | 0; z < (nz * 0.8 | 0); z += 4) { let x0 = nx, x1 = 0; const yy = ny / 2 | 0; for (let x = 0; x < nx; x++) if (c.ct[x + nx * (yy + ny * z)] > -400) { if (x < x0) x0 = x; if (x > x1) x1 = x; } if (x1 > x0) w.push(x1 - x0); } w.sort((a, z) => a - z); const bodyW = w[w.length >> 1] || nx * 0.7;

const gpu = await initDevice(); const rn = await makeRunner(Float32Array.from(c.ct), c.dims, gpu);
const relE = await rn.run("relEnhance", K.relEnhance.body, K.relEnhance.params(fat, cortex));
const enc = await rn.run("fatEnclose", K.fatEnclose.body, K.fatEnclose.params(-30, 22)); rn.destroy();
// seeds (both sides), ENC_MIN 0.83
const seed = new Uint8Array(N);
for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = x + nx * (y + ny * z); const lat = Math.abs(x - midX) / bodyW; if (lat < 0.05 || lat > 0.42 || y < spineY - 0.22 * bodyW || y > spineY + 0.24 * bodyW) continue; if (enc[i] < 0.83) continue; const h = c.ct[i]; if (h <= -30 || h >= 330) continue; const r = relE[i]; if (r >= 0.72 && r <= 1.30) seed[i] = 1; }
let ns = 0; for (let i = 0; i < N; i++) ns += seed[i];
console.log(`${PID}: fat=${fat} cortex=${cortex} midX=${midX.toFixed(0)} bodyW=${bodyW.toFixed(0)} seeds=${ns}`);

let bz = 0, bn = -1; for (let z = 0; z < nz; z++) { let n = 0; const base = z * nx * ny; for (let i = base; i < base + nx * ny; i++) if (c.lab[i]) n++; if (n > bn) { bn = n; bz = z; } }
const zs = [bz - 12, bz, bz + 12].filter((z) => z >= 0 && z < nz);
function tile(z: number, kind: string): Uint8Array { const out = new Uint8Array(nx * ny * 4); const base = z * nx * ny;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = base + y * nx + x; const g = huToGray(c.ct[i], 40, 400); const o = (y * nx + x) * 4; let r = g, gg = g, bb2 = g;
    if (kind === "ctgt") { if (c.lab[i] === 1) { gg = Math.min(255, g + 90); r = g >> 1; bb2 = g >> 1; } else if (c.lab[i] === 2) { r = Math.min(255, g + 100); gg = g >> 1; bb2 = g >> 1; } }
    else if (kind === "enc") { const v = Math.max(0, Math.min(255, enc[i] * 255)); r = gg = bb2 = v; }
    else if (kind === "seed") { if (seed[i]) { r = 255; gg = 230; bb2 = 20; } if (c.lab[i]) { gg = Math.min(255, gg + 40); } }
    out[o] = r; out[o + 1] = gg; out[o + 2] = bb2; out[o + 3] = 255; } return out; }
const cols = ["ctgt", "enc", "seed"]; const pad = 3;
const cw = nx, ch = ny; const W = cols.length * (cw + pad) + pad, H = zs.length * (ch + pad) + pad;
const cv = new Uint8Array(W * H * 4); for (let i = 0; i < cv.length; i += 4) { cv[i] = 12; cv[i + 1] = 14; cv[i + 2] = 22; cv[i + 3] = 255; }
for (let row = 0; row < zs.length; row++) for (let col = 0; col < cols.length; col++) { const t = tile(zs[row], cols[col]); const ox = pad + col * (cw + pad), oy = pad + row * (ch + pad); for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const si = (y * nx + x) * 4, di = ((oy + y) * W + ox + x) * 4; cv[di] = t[si]; cv[di + 1] = t[si + 1]; cv[di + 2] = t[si + 2]; cv[di + 3] = 255; } }
await Deno.mkdir("scratchpad/feat", { recursive: true });
await writePNG(`scratchpad/feat/viz-v2-${PID}.png`, W, H, cv);
console.log(`wrote scratchpad/feat/viz-v2-${PID}.png (${W}x${H}) — cols: CT+GT | fat-enclosure | seeds(yellow,GT green); rows z=${zs.join(",")}`);
