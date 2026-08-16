// First reviewable artifact: for several cases, render the axial slice with the most
// kidney, at a FIXED abdominal window (W400/L40), with GT overlay. Purpose: show that
// the same window makes the kidney look wildly different across cases (phase variability)
// while the KiTS GT (green=kidney, red=mass) is the source of truth. Proves PNG loop.
import { loadCase, writePNG, huToGray } from "./kits-io.ts";

const CASES = ["KiTS-00057", "KiTS-00081", "KiTS-00111", "KiTS-00013", "KiTS-00010"];
const W = 400, L = 40; // fixed abdominal window
const tiles: { pid: string; slice: Uint8Array; w: number; h: number; z: number; p50: number }[] = [];

for (const pid of CASES) {
  const c = await loadCase(pid);
  const [nx, ny, nz] = c.dims;
  // pick z (axial slice) with most kidney/mass voxels
  let bestZ = 0, bestN = -1;
  for (let z = 0; z < nz; z++) {
    let n = 0; const base = z * nx * ny;
    for (let i = base; i < base + nx * ny; i++) if (c.lab[i] === 1 || c.lab[i] === 2) n++;
    if (n > bestN) { bestN = n; bestZ = z; }
  }
  const kid: number[] = [];
  const rgba = new Uint8Array(nx * ny * 4);
  const base = bestZ * nx * ny;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = base + y * nx + x; const g = huToGray(c.ct[i], L, W); const o = (y * nx + x) * 4;
    let r = g, gr = g, b = g;
    if (c.lab[i] === 1) { gr = Math.min(255, g + 90); r = g >> 1; b = g >> 1; kid.push(c.ct[i]); }     // kidney green
    else if (c.lab[i] === 2) { r = Math.min(255, g + 110); gr = g >> 1; b = g >> 1; }                    // mass red
    rgba[o] = r; rgba[o + 1] = gr; rgba[o + 2] = b; rgba[o + 3] = 255;
  }
  const p50 = kid.length ? Math.round(Float64Array.from(kid).sort()[kid.length >> 1]) : 0;
  tiles.push({ pid, slice: rgba, w: nx, h: ny, z: bestZ, p50 });
  console.log(`${pid}: axial z=${bestZ}/${nz}, kidney p50=${p50} HU (same W400/L40 window)`);
}

// tile horizontally, scaled to a common height (256)
const TH = 256, pad = 4;
const scaled = tiles.map((t) => {
  const s = TH / t.h, TW = Math.round(t.w * s);
  const out = new Uint8Array(TW * TH * 4);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    const sx = Math.min(t.w - 1, Math.floor(x / s)), sy = Math.min(t.h - 1, Math.floor(y / s));
    const si = (sy * t.w + sx) * 4, di = (y * TW + x) * 4;
    out[di] = t.slice[si]; out[di + 1] = t.slice[si + 1]; out[di + 2] = t.slice[si + 2]; out[di + 3] = 255;
  }
  return { w: TW, h: TH, rgba: out };
});
const totalW = scaled.reduce((s, t) => s + t.w + pad, pad), H = TH + 2 * pad;
const canvas = new Uint8Array(totalW * H * 4);
for (let i = 0; i < canvas.length; i += 4) { canvas[i] = 12; canvas[i + 1] = 14; canvas[i + 2] = 22; canvas[i + 3] = 255; }
let cx = pad;
for (const t of scaled) {
  for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
    const si = (y * t.w + x) * 4, di = ((y + pad) * totalW + (cx + x)) * 4;
    canvas[di] = t.rgba[si]; canvas[di + 1] = t.rgba[si + 1]; canvas[di + 2] = t.rgba[si + 2]; canvas[di + 3] = 255;
  }
  cx += t.w + pad;
}
await Deno.mkdir("scratchpad/feat", { recursive: true });
await writePNG("scratchpad/feat/phase-montage.png", totalW, H, canvas);
console.log(`\nwrote scratchpad/feat/phase-montage.png (${totalW}x${H}) — order: ${CASES.join(", ")}`);
