// Semantic anatomy detection layers v1 (full res, A100). Build a coordinate frame from
// the spine, then detect the aorta/IVC as VERTICAL MIDLINE TUBES (position + tubular
// shape + vertical continuity) — not by intensity. These are the structures the kidney
// keeps merging into; detecting them lets the kidney be defined relationally + gives the
// per-case enhancement reference (aorta HU). Visualize each layer vs GT.
import { loadCase, writePNG, huToGray, type Case } from "./kits-io.ts";
import { makeRunner } from "../algorithms/features/runner.ts";
import { K } from "../algorithms/features/kernels.ts";
import { initDevice } from "../render/device.ts";

const CASES = Deno.args.length ? Deno.args : ["KiTS-00013", "KiTS-00057", "KiTS-00111"];

function fatMode(ct: Int16Array): number {
  const bins = new Int32Array(400); for (let i = 0; i < ct.length; i++) { const b = (ct[i] + 1000) / 5 | 0; if (b >= 0 && b < 400) bins[b]++; }
  let bb = -1, bi = 0; for (let b = 160; b < 194; b++) if (bins[b] > bb) { bb = bins[b]; bi = b; } return bi * 5 - 1000;
}
function cortexAnchor(c: Case): number {
  const [nx, ny, nz] = c.dims; const v: number[] = [];
  for (let i = 0; i < c.ct.length; i += 7) { const h = c.ct[i]; if (h > 20 && h < 300) v.push(h); }
  v.sort((a, b) => a - b); return v[v.length * 0.97 | 0] || 150;
}

// ---- coordinate frame from spine (bone) + body outline ----
function frame(c: Case) {
  const [nx, ny, nz] = c.dims;
  let sx = 0, sy = 0, sn = 0;
  for (let z = nz * 0.15 | 0; z < (nz * 0.85 | 0); z++) for (let y = 0; y < ny; y++) for (let x = nx * 0.3 | 0; x < (nx * 0.7 | 0); x++) {
    if (c.ct[x + nx * (y + ny * z)] > 250) { sx += x; sy += y; sn++; }
  }
  const midX = sn ? sx / sn : nx / 2, spineY = sn ? sy / sn : ny / 2;
  // body half-width: median per-slice x-extent of HU>-400
  const widths: number[] = [];
  for (let z = nz * 0.2 | 0; z < (nz * 0.8 | 0); z += 4) { let x0 = nx, x1 = 0; const yy = ny / 2 | 0; for (let x = 0; x < nx; x++) if (c.ct[x + nx * (yy + ny * z)] > -400) { if (x < x0) x0 = x; if (x > x1) x1 = x; } if (x1 > x0) widths.push(x1 - x0); }
  widths.sort((a, b) => a - b); const bodyW = widths[widths.length >> 1] || nx * 0.7;
  // R direction: sign of ijkToRAS[0] (i-step R component); patient-right = liver side
  const rSign = Math.sign(c.ijkToRAS[0]) || 1;
  return { midX, spineY, bodyW, rSign };
}

// ---- aorta/IVC: 3D vertical tubes near midline, anterior to spine, enhancing ----
function detectVessels(c: Case, relE: Float32Array, f: ReturnType<typeof frame>) {
  const [nx, ny, nz] = c.dims, N = nx * ny * nz;
  // bone-proximity exclusion: mark bone, dilate a few voxels (skip vertebra/marrow smear)
  const bone = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (c.ct[i] > 300) bone[i] = 1;
  const nb6 = [1, -1, nx, -nx, nx * ny, -nx * ny];
  let cur = bone;
  for (let it = 0; it < 4; it++) { const o = new Uint8Array(N); for (let i = 0; i < N; i++) { let on = cur[i]; if (!on) { const x = i % nx; for (const d of nb6) { const j = i + d; if (j < 0 || j >= N) continue; if ((d === 1 || d === -1) && Math.abs((j % nx) - x) > 1) continue; if (cur[j]) { on = 1; break; } } } o[i] = on; } cur = o; }
  const boneNear = cur;
  const cand = new Uint8Array(N);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + nx * (y + ny * z);
    if (Math.abs(x - f.midX) > 0.14 * f.bodyW) continue;       // near midline
    if (y > f.spineY) continue;                                // anterior to vertebral body center
    if (boneNear[i]) continue;                                 // not on/against bone
    const h = c.ct[i]; if (h < 70 || h > 340) continue;        // blood/contrast, not bone
    if (relE[i] < 0.72) continue;                              // strongly enhancing
    cand[i] = 1;
  }
  // 3D-CC; score each comp for "vertical thin tube" and keep the dominant ones
  const comp = new Int32Array(N).fill(-1); const st = new Int32Array(1 << 22);
  const nb26: number[] = []; for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) nb26.push(dx + nx * (dy + ny * dz));
  type C = { members: number[]; size: number; zspan: number; bx: number; by: number };
  const comps: C[] = [];
  for (let s = 0; s < N; s++) {
    if (!cand[s] || comp[s] >= 0) continue;
    let sp = 0; st[sp++] = s; comp[s] = 0; let size = 0, zmin = nz, zmax = 0, x0 = nx, x1 = 0, y0 = ny, y1 = 0; const members: number[] = [];
    while (sp > 0) { const i = st[--sp]; size++; members.push(i); const z = i / (nx * ny) | 0, r = i % (nx * ny), y = r / nx | 0, x = r % nx; if (z < zmin) zmin = z; if (z > zmax) zmax = z; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const d of nb26) { const j = i + d; if (j < 0 || j >= N || Math.abs((j % nx) - x) > 1) continue; if (cand[j] && comp[j] < 0) { comp[j] = 0; if (sp < st.length) st[sp++] = j; } } }
    comps.push({ members, size, zspan: zmax - zmin + 1, bx: x1 - x0, by: y1 - y0 });
  }
  // tube test: tall (zspan), thin per-slice (bbox small), reasonable mean area
  const tubes = comps.filter((k) => k.zspan >= Math.max(10, nz * 0.12) && k.bx <= 0.16 * f.bodyW && k.by <= 0.22 * f.bodyW && (k.size / k.zspan) >= 25 && (k.size / k.zspan) <= 1600)
    .sort((a, b) => b.size - a.size).slice(0, 3); // aorta + IVC (+1 slack)
  const mask = new Uint8Array(N); let vsum = 0, vn = 0;
  for (const t of tubes) for (const i of t.members) { mask[i] = 1; vsum += c.ct[i]; vn++; }
  return { mask, aortaHU: vn ? Math.round(vsum / vn) : NaN, count: vn };
}

// ---- viz: 3 axial slices per case, overlay spine(blue)/vessel(red)/GT-kidney(green) ----
function panelRow(c: Case, f: ReturnType<typeof frame>, vessel: Uint8Array): { w: number; h: number; rgba: Uint8Array } {
  const [nx, ny, nz] = c.dims;
  // pick 3 z through kidney extent
  let zlo = nz, zhi = 0; for (let i = 0; i < c.lab.length; i++) if (c.lab[i]) { const z = i / (nx * ny) | 0; if (z < zlo) zlo = z; if (z > zhi) zhi = z; }
  const zs = [zlo + (zhi - zlo) * 0.3 | 0, (zlo + zhi) / 2 | 0, zlo + (zhi - zlo) * 0.7 | 0];
  const tile = (z: number) => { const out = new Uint8Array(nx * ny * 4); const base = z * nx * ny;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = base + y * nx + x; const g = huToGray(c.ct[i], 40, 400); const o = (y * nx + x) * 4; let r = g, gg = g, b = g;
      if (c.ct[i] > 250 && Math.abs(x - f.midX) < 0.18 * f.bodyW && y > f.spineY - 0.25 * f.bodyW) { b = Math.min(255, g + 120); r = g >> 1; }  // spine blue
      if (vessel[i]) { r = 255; gg = 30; b = 30; }                                                                                              // vessel red
      if (c.lab[i]) { gg = Math.min(255, g + 110); r = g >> 1; b = g >> 1; }                                                                    // GT kidney/mass green
      out[o] = r; out[o + 1] = gg; out[o + 2] = b; out[o + 3] = 255; } return out; };
  const pad = 3, W = 3 * (nx + pad) + pad, H = ny + 2 * pad; const cv = new Uint8Array(W * H * 4);
  for (let i = 0; i < cv.length; i += 4) { cv[i] = 12; cv[i + 1] = 14; cv[i + 2] = 22; cv[i + 3] = 255; }
  let cx = pad; for (const z of zs) { const t = tile(z); for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const si = (y * nx + x) * 4, di = ((y + pad) * W + cx + x) * 4; cv[di] = t[si]; cv[di + 1] = t[si + 1]; cv[di + 2] = t[si + 2]; cv[di + 3] = 255; } cx += nx + pad; }
  return { w: W, h: H, rgba: cv };
}

const gpu = await initDevice();
const rows: { w: number; h: number; rgba: Uint8Array }[] = [];
for (const pid of CASES) {
  const c = await loadCase(pid);
  const fat = fatMode(c.ct), cortex = cortexAnchor(c);
  const rn = await makeRunner(Float32Array.from(c.ct), c.dims, gpu);
  const relE = await rn.run("relEnhance", K.relEnhance.body, K.relEnhance.params(fat, cortex)); rn.destroy();
  const f = frame(c);
  const v = detectVessels(c, relE, f);
  console.log(`${pid}: midX=${f.midX.toFixed(0)} spineY=${f.spineY.toFixed(0)} bodyW=${f.bodyW.toFixed(0)} rSign=${f.rSign} | vessel voxels=${v.count} aortaHU=${v.aortaHU}`);
  rows.push(panelRow(c, f, v.mask));
}
const W = Math.max(...rows.map((r) => r.w)), H = rows.reduce((s, r) => s + r.h, 0);
const cv = new Uint8Array(W * H * 4); for (let i = 0; i < cv.length; i += 4) { cv[i] = 12; cv[i + 1] = 14; cv[i + 2] = 22; cv[i + 3] = 255; }
let cy = 0; for (const r of rows) { for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const si = (y * r.w + x) * 4, di = ((cy + y) * W + x) * 4; cv[di] = r.rgba[si]; cv[di + 1] = r.rgba[si + 1]; cv[di + 2] = r.rgba[si + 2]; cv[di + 3] = 255; } cy += r.h; }
await Deno.mkdir("scratchpad/feat", { recursive: true });
await writePNG("scratchpad/feat/detect-vessels.png", W, H, cv);
console.log(`wrote scratchpad/feat/detect-vessels.png (${W}x${H}) — rows: ${CASES.join(", ")}; spine=blue vessel=red GT=green`);
