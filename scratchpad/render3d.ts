// Headless 3D review renderer for a KiTS labelmap — the "look at it" tool for the loop.
// Produces a 3x3 review sheet: rows = {full seg, kidney @45% + tumor solid, tumor only},
// cols = {anterior, right-oblique, left-oblique}. Plus an MPR montage with corrected z-aspect.
//   deno run --unstable-webgpu -A render3d.ts <PID> [gt|<path-to-lab.u8>]
import { loadCase, writePNG, huToGray } from "./kits-io.ts";
import { buildSegedScene } from "../render/demos/seged-app-scene.ts";
import { initDevice } from "../render/device.ts";

const PID = Deno.args[0] || "KiTS-00013";
const LABSRC = Deno.args[1] || "gt";
const c = await loadCase(PID);
let lab = c.lab;
if (LABSRC !== "gt") { const buf = await Deno.readFile(LABSRC); lab = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); }

const gpu = await initDevice();
const ctVol = { vol: c.ct, dims: c.dims, ijkToRAS: c.ijkToRAS, win: c.win || 400, lev: c.lev || 40, dtype: "int16" as const, modality: "CT" };
const seg = { lab, colors: [[1, 0.25, 0.85, 0.4], [2, 0.95, 0.22, 0.22]] as [number, number, number, number][], names: { 1: "Kidney", 2: "Mass" } };
const rs = buildSegedScene(gpu, undefined as unknown as GPUTextureFormat, ctVol, seg, { sdfMaxDim: 220 }) as unknown as {
  scene: { setCamera: (e: Float32Array, c: Float32Array, u: Float32Array, f: number, w: number, h: number) => void; renderToRGBA: (w: number, h: number) => Promise<Uint8Array> };
  center: [number, number, number]; radius: number; setVolumeOpacity: (o: number) => void; setLabelOpacity: (l: number, o: number) => void;
};
rs.setVolumeOpacity(0.0);

const W = 440, H = 440;
const [cx, cy, cz] = rs.center; const R = rs.radius * 3.0;
const up = new Float32Array([0, 0, 1]);
const cam = (eye: number[]) => { rs.scene.setCamera(new Float32Array(eye), new Float32Array(rs.center), up, 28, W, H); };
const angles: [string, number[]][] = [
  ["anterior", [cx, cy - R, cz + R * 0.15]],
  ["right-obl", [cx - R * 0.75, cy - R * 0.6, cz + R * 0.35]],
  ["left-obl", [cx + R * 0.75, cy - R * 0.6, cz + R * 0.35]],
];
const modes: [string, () => void][] = [
  ["full", () => { rs.setLabelOpacity(1, 1); rs.setLabelOpacity(2, 1); }],
  ["kidney45+tumor", () => { rs.setLabelOpacity(1, 0.45); rs.setLabelOpacity(2, 1); }],
  ["tumor-only", () => { rs.setLabelOpacity(1, 0.0); rs.setLabelOpacity(2, 1); }],
];
const grid: Uint8Array[] = [];
for (const [, setMode] of modes) { setMode(); for (const [, eye] of angles) { cam(eye); grid.push(await rs.scene.renderToRGBA(W, H)); } }
// montage 3 rows x 3 cols
const pad = 4, cols = 3, rows = 3, MW = cols * (W + pad) + pad, MH = rows * (H + pad) + pad;
const cv = new Uint8Array(MW * MH * 4); for (let i = 0; i < cv.length; i += 4) { cv[i] = 10; cv[i + 1] = 12; cv[i + 2] = 18; cv[i + 3] = 255; }
grid.forEach((t, k) => { const col = k % cols, row = k / cols | 0; const ox = pad + col * (W + pad), oy = pad + row * (H + pad); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const si = (y * W + x) * 4, di = ((oy + y) * MW + ox + x) * 4; cv[di] = t[si]; cv[di + 1] = t[si + 1]; cv[di + 2] = t[si + 2]; cv[di + 3] = 255; } });
await Deno.mkdir("scratchpad/feat", { recursive: true });
const tag = LABSRC === "gt" ? "gt" : "pred";
await writePNG(`scratchpad/feat/review3d-${PID}-${tag}.png`, MW, MH, cv);
console.log(`wrote scratchpad/feat/review3d-${PID}-${tag}.png (${MW}x${MH}) — rows: full | kidney45%+tumor | tumor-only ; cols: anterior | right-obl | left-obl`);

// MPR with corrected z aspect (stretch coronal/sagittal vertical by z/xy spacing)
const [nx, ny, nz] = c.dims;
const M = c.ijkToRAS; const colLen = (a: number, b: number, cc: number) => Math.hypot(a, b, cc);
const sx = colLen(M[0], M[4], M[8]), sz = colLen(M[2], M[6], M[10]); const zsc = Math.max(1, Math.round(sz / Math.max(1e-3, sx)));
let mx0 = 0, my0 = 0, mz0 = 0, mn = 0; for (let i = 0; i < lab.length; i++) if (lab[i]) { const z = i / (nx * ny) | 0, r = i % (nx * ny), y = r / nx | 0, x = r % nx; mx0 += x; my0 += y; mz0 += z; mn++; }
const kx = mn ? mx0 / mn | 0 : nx >> 1, ky = mn ? my0 / mn | 0 : ny >> 1, kz = mn ? mz0 / mn | 0 : nz >> 1;
function ov(v: number, l: number) { const g = huToGray(v, 40, 400); if (l === 1) return [g >> 1, Math.min(255, g + 90), g >> 1]; if (l === 2) return [Math.min(255, g + 100), g >> 1, g >> 1]; return [g, g, g]; }
function ax(z: number) { const o = new Uint8Array(nx * ny * 4); const b = z * nx * ny; for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = b + y * nx + x; const [r, g, bl] = ov(c.ct[i], lab[i]); const d = (y * nx + x) * 4; o[d] = r; o[d + 1] = g; o[d + 2] = bl; o[d + 3] = 255; } return { o, w: nx, h: ny }; }
function co(y: number) { const hh = nz * zsc; const o = new Uint8Array(nx * hh * 4); for (let zz = 0; zz < hh; zz++) { const z = zz / zsc | 0; for (let x = 0; x < nx; x++) { const i = x + nx * (y + ny * z); const [r, g, bl] = ov(c.ct[i], lab[i]); const d = ((hh - 1 - zz) * nx + x) * 4; o[d] = r; o[d + 1] = g; o[d + 2] = bl; o[d + 3] = 255; } } return { o, w: nx, h: hh }; }
function sa(x: number) { const hh = nz * zsc; const o = new Uint8Array(ny * hh * 4); for (let zz = 0; zz < hh; zz++) { const z = zz / zsc | 0; for (let y = 0; y < ny; y++) { const i = x + nx * (y + ny * z); const [r, g, bl] = ov(c.ct[i], lab[i]); const d = ((hh - 1 - zz) * ny + y) * 4; o[d] = r; o[d + 1] = g; o[d + 2] = bl; o[d + 3] = 255; } } return { o, w: ny, h: hh }; }
const mp = [ax(kz), co(ky), sa(kx)];
const MPW = mp.reduce((s, m) => s + m.w + pad, pad), MPH = Math.max(...mp.map((m) => m.h)) + 2 * pad;
const mc = new Uint8Array(MPW * MPH * 4); for (let i = 0; i < mc.length; i += 4) { mc[i] = 10; mc[i + 1] = 12; mc[i + 2] = 18; mc[i + 3] = 255; }
let mmx = pad; for (const m of mp) { for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) { const si = (y * m.w + x) * 4, di = ((y + pad) * MPW + mmx + x) * 4; mc[di] = m.o[si]; mc[di + 1] = m.o[si + 1]; mc[di + 2] = m.o[si + 2]; mc[di + 3] = 255; } mmx += m.w + pad; }
await writePNG(`scratchpad/feat/mpr-${PID}-${tag}.png`, MPW, MPH, mc);
console.log(`wrote scratchpad/feat/mpr-${PID}-${tag}.png (z-aspect x${zsc}) — axial | coronal | sagittal at kidney centroid`);
