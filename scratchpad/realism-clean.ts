// Realism cleanup pass — the "fix the defects I saw" step of the loop. Enforces the
// looked-at criteria: kidney = compact paravertebral components (no jagged liver-chunk);
// tumor = ONE coherent mass (despeckle). Renders nothing itself; writes a cleaned labelmap.
import { loadCase } from "./kits-io.ts";
const PID = Deno.args[0] || "KiTS-00003";
const dir = Deno.env.get("KITS_DIR") || ".";
const c = await loadCase(PID); const [nx, ny, nz] = c.dims, N = nx * ny * nz;
const buf = await Deno.readFile(`${dir}/${PID}.cand.u8`); const cand = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

const nb6 = [1, -1, nx, -nx, nx * ny, -nx * ny];
const nb26: number[] = []; for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) nb26.push(dx + nx * (dy + ny * dz));
const wrap = (j: number, x: number, d: number) => (d === 1 || d === -1) && Math.abs((j % nx) - x) > 1;
function morph(m: Uint8Array, R: number, erode: boolean) { let cur = m; for (let it = 0; it < R; it++) { const o = new Uint8Array(N); for (let i = 0; i < N; i++) { const x = i % nx; if (!erode) { let on = cur[i]; if (!on) for (const d of nb6) { const j = i + d; if (j < 0 || j >= N || wrap(j, x, d)) continue; if (cur[j]) { on = 1; break; } } o[i] = on; } else { let on = cur[i]; if (on) for (const d of nb6) { const j = i + d; if (j < 0 || j >= N) { on = 0; break; } if (wrap(j, x, d)) continue; if (!cur[j]) { on = 0; break; } } o[i] = on; } } cur = o; } return cur; }
// connected components -> list of {members,size,bbox,centroid}
function components(mask: Uint8Array) {
  const comp = new Int32Array(N).fill(-1); const st = new Int32Array(1 << 23); const out: { mem: number[]; sz: number; cx: number; fill: number }[] = []; let nc = 0;
  for (let s = 0; s < N; s++) { if (!mask[s] || comp[s] >= 0) continue; let sp = 0; st[sp++] = s; comp[s] = nc; const mem: number[] = []; let x0 = nx, x1 = 0, y0 = ny, y1 = 0, z0 = nz, z1 = 0, sxx = 0; while (sp > 0) { const i = st[--sp]; mem.push(i); const z = i / (nx * ny) | 0, r = i % (nx * ny), y = r / nx | 0, x = r % nx; sxx += x; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; for (const d of nb26) { const j = i + d; if (j < 0 || j >= N || Math.abs((j % nx) - x) > 1) continue; if (mask[j] && comp[j] < 0) { comp[j] = nc; if (sp < st.length) st[sp++] = j; } } } const bb = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1); out.push({ mem, sz: mem.length, cx: sxx / mem.length, fill: mem.length / bb }); nc++; }
  return out;
}

// spine midline for laterality
let sx = 0, sn = 0; for (let z = nz * 0.15 | 0; z < (nz * 0.85 | 0); z++) for (let y = 0; y < ny; y++) for (let x = nx * 0.3 | 0; x < (nx * 0.7 | 0); x++) if (c.ct[x + nx * (y + ny * z)] > 250) { sx += x; sn++; } const midX = sn ? sx / sn : nx / 2;

// 1) envelope (any label), OPEN to shed thin connections + specks, keep compact paravertebral organ-sized comps
let env = new Uint8Array(N); for (let i = 0; i < N; i++) env[i] = cand[i] ? 1 : 0;
env = morph(morph(env, 2, true), 2, false); // open r=2
const comps = components(env).filter((k) => k.sz >= 20000).sort((a, b) => b.sz - a.sz);
// realism: reniform organ is reasonably compact (fill 0.28..0.62) and lateral to spine; slabs fill high, liver is huge+low-fill.
const kept = comps.filter((k) => k.fill >= 0.24 && k.fill <= 0.62 && Math.abs(k.cx - midX) > 0.03 * nx).slice(0, 2);
const keepMem = new Set<number>(); for (const k of kept) for (const i of k.mem) keepMem.add(i);
const kidney = new Uint8Array(N); for (const i of keepMem) kidney[i] = 1;
// hole-fill per slice
const bg = new Uint8Array(nx * ny); const fq = new Int32Array(nx * ny);
for (let z = 0; z < nz; z++) { const base = z * nx * ny; bg.fill(0); let q = 0; const push = (x: number, y: number) => { const p = y * nx + x; if (!kidney[base + p] && !bg[p]) { bg[p] = 1; fq[q++] = p; } }; for (let x = 0; x < nx; x++) { push(x, 0); push(x, ny - 1); } for (let y = 0; y < ny; y++) { push(0, y); push(nx - 1, y); } while (q > 0) { const p = fq[--q]; const x = p % nx, y = p / nx | 0; if (x > 0) push(x - 1, y); if (x < nx - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < ny - 1) push(x, y + 1); } for (let p = 0; p < nx * ny; p++) if (!kidney[base + p] && !bg[p]) kidney[base + p] = 1; }

// 2) tumor = the SINGLE largest coherent candidate-tumor blob that lies inside the kept kidney
const tcand = new Uint8Array(N); for (let i = 0; i < N; i++) if (cand[i] === 2 && kidney[i]) tcand[i] = 1;
const topen = morph(morph(tcand, 1, true), 1, false); // despeckle
const tcomps = components(topen).sort((a, b) => b.sz - a.sz);
const tumor = new Uint8Array(N); if (tcomps.length && tcomps[0].sz >= 3000) for (const i of tcomps[0].mem) tumor[i] = 1;

// assemble cleaned: 1 kidney, 2 tumor
const clean = new Uint8Array(N); for (let i = 0; i < N; i++) { if (kidney[i]) clean[i] = tumor[i] ? 2 : 1; }
await Deno.writeFile(`${dir}/${PID}.clean.u8`, clean);

// scores
const gt = c.lab; const d = (pred: (i: number) => number, want: number[]) => { const s = new Set(want); let it = 0, a = 0, b = 0; for (let i = 0; i < N; i++) { const p = pred(i), g = s.has(gt[i]) ? 1 : 0; it += p & g; a += p; b += g; } return a + b ? 2 * it / (a + b) : 1; };
let ev = 0; for (let i = 0; i < N; i++) ev += clean[i] ? 1 : 0;
console.log(`${PID} CLEANED: kept ${kept.length} kidney comps (fills ${comps.slice(0, 4).map((k) => k.fill.toFixed(2)).join(",")}), tumor ${tcomps.length ? tcomps[0].sz : 0} vox`);
console.log(`  kidney(envelope) Dice=${d((i) => clean[i] ? 1 : 0, [1, 2]).toFixed(3)}  tumor Dice=${d((i) => clean[i] === 2 ? 1 : 0, [2]).toFixed(3)}  envVox=${ev}`);
console.log(`  wrote ${dir}/${PID}.clean.u8`);
