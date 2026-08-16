// Kidney segmentation v2 — the skill's approach: per-side, bounded, subtract confusers.
// Layer-0 frame + anchors + vessel/bone subtraction -> per-side (L/R of spine) confident-
// cortex seed -> grow within a kidney-sized bounding box (can't absorb liver) bounded by the
// fat wall + subtracted confusers -> shape-close -> keep seed-connected CC -> fill.
// Scores kidney envelope + mass vs GT. Writes NRRDs when a single pid arg + --nrrd given.
import { loadCase, type Case } from "./kits-io.ts";
import { makeRunner } from "../algorithms/features/runner.ts";
import { K } from "../algorithms/features/kernels.ts";
import { initDevice } from "../render/device.ts";
import { writeCT, writeSeg } from "./nrrd.ts";

const ARGS = Deno.args.filter((a) => !a.startsWith("--"));
const NRRD = Deno.args.includes("--nrrd");
const CASES = ARGS.length ? ARGS : ["KiTS-00013", "KiTS-00057", "KiTS-00081", "KiTS-00111"];

// weights (calibrated, fixed across cases)
const SEED_LO = 0.72, SEED_HI = 1.30;   // confident cortex
const ENC_MIN = 0.83;                    // fat-enclosure required for a seed (organ interior)
const BAND_LO = 0.50, BAND_HI = 1.35;   // parenchyma grow band
const FAT_HU = -30, HI_HU = 330;
const LAT_LO = 0.05, LAT_HI = 0.42;     // paravertebral |x-mid|/bodyW
const AP_POST = 0.22, AP_ANT = 0.24;    // retroperitoneal AP band relative to spineY (×bodyW): kidney sits at spine level, NOT anterior bowel
const BOX_MARGIN = 0.06;                // bbox dilation as fraction of bodyW
const CLOSE_R = 4, SEED_MIN = 250;

const gpu = await initDevice();

function anchors(c: Case) {
  const [nx, ny, nz] = c.dims;
  const b = new Int32Array(400); for (let i = 0; i < c.ct.length; i++) { const q = (c.ct[i] + 1000) / 5 | 0; if (q >= 0 && q < 400) b[q]++; }
  let m = -1, mi = 0; for (let q = 160; q < 194; q++) if (b[q] > m) { m = b[q]; mi = q; } const fat = mi * 5 - 1000;
  const v: number[] = []; for (let i = 0; i < c.ct.length; i += 7) { const h = c.ct[i]; if (h > 20 && h < 300) v.push(h); } v.sort((a, z) => a - z); const cortex = v[v.length * 0.97 | 0] || 150;
  let sx = 0, sy = 0, sn = 0; for (let z = nz * 0.15 | 0; z < (nz * 0.85 | 0); z++) for (let y = 0; y < ny; y++) for (let x = nx * 0.3 | 0; x < (nx * 0.7 | 0); x++) if (c.ct[x + nx * (y + ny * z)] > 250) { sx += x; sy += y; sn++; }
  const midX = sn ? sx / sn : nx / 2, spineY = sn ? sy / sn : ny / 2;
  const w: number[] = []; for (let z = nz * 0.2 | 0; z < (nz * 0.8 | 0); z += 4) { let x0 = nx, x1 = 0; const yy = ny / 2 | 0; for (let x = 0; x < nx; x++) if (c.ct[x + nx * (yy + ny * z)] > -400) { if (x < x0) x0 = x; if (x > x1) x1 = x; } if (x1 > x0) w.push(x1 - x0); } w.sort((a, z) => a - z); const bodyW = w[w.length >> 1] || nx * 0.7;
  return { fat, cortex, midX, spineY, bodyW };
}

function detectVessels(c: Case, relE: Float32Array, a: ReturnType<typeof anchors>, boneNear: Uint8Array) {
  const [nx, ny, nz] = c.dims, N = nx * ny * nz;
  const cand = new Uint8Array(N);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = x + nx * (y + ny * z); if (Math.abs(x - a.midX) > 0.14 * a.bodyW) continue; if (y > a.spineY) continue; if (boneNear[i]) continue; const h = c.ct[i]; if (h < 70 || h > 340) continue; if (relE[i] < 0.72) continue; cand[i] = 1; }
  const comp = new Int32Array(N).fill(-1); const st = new Int32Array(1 << 22);
  const nb26: number[] = []; for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) nb26.push(dx + nx * (dy + ny * dz));
  const mask = new Uint8Array(N);
  type C = { mem: number[]; sz: number; zs: number; bx: number; by: number };
  const comps: C[] = [];
  for (let s = 0; s < N; s++) { if (!cand[s] || comp[s] >= 0) continue; let sp = 0; st[sp++] = s; comp[s] = 0; let sz = 0, zmin = nz, zmax = 0, x0 = nx, x1 = 0, y0 = ny, y1 = 0; const mem: number[] = []; while (sp > 0) { const i = st[--sp]; sz++; mem.push(i); const z = i / (nx * ny) | 0, r = i % (nx * ny), yy = r / nx | 0, xx = r % nx; if (z < zmin) zmin = z; if (z > zmax) zmax = z; if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; for (const d of nb26) { const j = i + d; if (j < 0 || j >= N || Math.abs((j % nx) - xx) > 1) continue; if (cand[j] && comp[j] < 0) { comp[j] = 0; if (sp < st.length) st[sp++] = j; } } } comps.push({ mem, sz, zs: zmax - zmin + 1, bx: x1 - x0, by: y1 - y0 }); }
  comps.filter((k) => k.zs >= Math.max(10, nz * 0.12) && k.bx <= 0.16 * a.bodyW && k.by <= 0.22 * a.bodyW && k.sz / k.zs >= 25 && k.sz / k.zs <= 1600).sort((x, y) => y.sz - x.sz).slice(0, 3).forEach((t) => t.mem.forEach((i) => mask[i] = 1));
  return mask;
}

function dilate(mask: Uint8Array, nx: number, ny: number, N: number, R: number, erode = false): Uint8Array {
  const nb6 = [1, -1, nx, -nx, nx * ny, -nx * ny]; let cur = mask;
  for (let it = 0; it < R; it++) { const o = new Uint8Array(N); for (let i = 0; i < N; i++) { const x = i % nx; if (!erode) { let on = cur[i]; if (!on) for (const d of nb6) { const j = i + d; if (j < 0 || j >= N || ((d === 1 || d === -1) && Math.abs((j % nx) - x) > 1)) continue; if (cur[j]) { on = 1; break; } } o[i] = on; } else { let on = cur[i]; if (on) for (const d of nb6) { const j = i + d; if (j < 0 || j >= N) { on = 0; break; } if ((d === 1 || d === -1) && Math.abs((j % nx) - x) > 1) continue; if (!cur[j]) { on = 0; break; } } o[i] = on; } } cur = o; } return cur;
}
function fillHoles(m: Uint8Array, nx: number, ny: number, nz: number): Uint8Array {
  const out = m.slice(); const bg = new Uint8Array(nx * ny); const fq = new Int32Array(nx * ny);
  for (let z = 0; z < nz; z++) { const base = z * nx * ny; bg.fill(0); let q = 0; const push = (x: number, y: number) => { const p = y * nx + x; if (!m[base + p] && !bg[p]) { bg[p] = 1; fq[q++] = p; } }; for (let x = 0; x < nx; x++) { push(x, 0); push(x, ny - 1); } for (let y = 0; y < ny; y++) { push(0, y); push(nx - 1, y); } while (q > 0) { const p = fq[--q]; const x = p % nx, y = p / nx | 0; if (x > 0) push(x - 1, y); if (x < nx - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < ny - 1) push(x, y + 1); } for (let p = 0; p < nx * ny; p++) if (!m[base + p] && !bg[p]) out[base + p] = 1; }
  return out;
}

// grow one side within a kidney-sized box around the seed cluster
function segmentSide(c: Case, relE: Float32Array, enc: Float32Array, gas: Float32Array, a: ReturnType<typeof anchors>, block: Uint8Array, side: -1 | 1): Uint8Array {
  const [nx, ny, nz] = c.dims, N = nx * ny * nz;
  const inZone = (x: number, y: number) => { const lat = (x - a.midX) / a.bodyW; const apOK = y >= a.spineY - AP_POST * a.bodyW && y <= a.spineY + AP_ANT * a.bodyW; return (side < 0 ? lat <= -LAT_LO && lat >= -LAT_HI : lat >= LAT_LO && lat <= LAT_HI) && apOK; };
  // seeds: cortex enhancement AND fat-enclosed (organ interior) AND paravertebral
  const seed0 = new Uint8Array(N);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = x + nx * (y + ny * z); if (block[i]) continue; if (!inZone(x, y)) continue; if (enc[i] < ENC_MIN) continue; if (gas[i] > 0.5) continue; const h = c.ct[i]; if (h <= FAT_HU || h >= HI_HU) continue; const r = relE[i]; if (r >= SEED_LO && r <= SEED_HI) seed0[i] = 1; }
  // keep the LARGEST seed cluster (kidney cortex is contiguous; bowel seeds are scattered specks).
  // Dilate first so a fragmented cortex rim connects into one cluster while distant bowel stays separate.
  const dil = dilate(seed0, nx, ny, N, 2, false);
  const comp = new Int32Array(N).fill(-1); const cs = new Int32Array(1 << 22);
  const nb26: number[] = []; for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) nb26.push(dx + nx * (dy + ny * dz));
  let bestMem: number[] = [];
  for (let s = 0; s < N; s++) { if (!dil[s] || comp[s] >= 0) continue; let q = 0; cs[q++] = s; comp[s] = 0; const mem: number[] = []; while (q > 0) { const i = cs[--q]; mem.push(i); const x = i % nx; for (const d of nb26) { const j = i + d; if (j < 0 || j >= N || Math.abs((j % nx) - x) > 1) continue; if (dil[j] && comp[j] < 0) { comp[j] = 0; if (q < cs.length) cs[q++] = j; } } } if (mem.length > bestMem.length) bestMem = mem; }
  // seeds = original seed0 voxels inside the largest dilated cluster
  const inBest = new Uint8Array(N); for (const i of bestMem) inBest[i] = 1;
  const seed = new Uint8Array(N); let sn = 0, x0 = nx, x1 = 0, y0 = ny, y1 = 0, z0 = nz, z1 = 0;
  for (let i = 0; i < N; i++) if (seed0[i] && inBest[i]) { seed[i] = 1; sn++; const z = i / (nx * ny) | 0, r = i % (nx * ny), yy = r / nx | 0, xx = r % nx; if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  if (sn < SEED_MIN) return new Uint8Array(N); // side absent → (future: branch to variant)
  const m = Math.round(BOX_MARGIN * a.bodyW);
  const bx0 = x0 - m, bx1 = x1 + m, by0 = y0 - m, by1 = y1 + m, bz0 = z0 - 2, bz1 = z1 + 2;
  const inBox = (x: number, y: number, z: number) => x >= bx0 && x <= bx1 && y >= by0 && y <= by1 && z >= bz0 && z <= bz1;
  // flood fixed band within box, bounded by fat wall + confusers (block)
  const reg = seed.slice(); const st = new Int32Array(1 << 23); let sp = 0; for (let i = 0; i < N; i++) if (reg[i]) st[sp++] = i;
  const nb6 = [1, -1, nx, -nx, nx * ny, -nx * ny];
  while (sp > 0) { const i = st[--sp]; const x = i % nx; for (const d of nb6) { const j = i + d; if (j < 0 || j >= N) continue; if ((d === 1 || d === -1) && Math.abs((j % nx) - x) > 1) continue; if (reg[j] || block[j]) continue; const z = j / (nx * ny) | 0, r2 = j % (nx * ny), yy = r2 / nx | 0, xx = r2 % nx; if (!inBox(xx, yy, z)) continue; const h = c.ct[j]; if (h <= FAT_HU || h >= HI_HU) continue; const rr = relE[j]; if (rr < BAND_LO || rr > BAND_HI) continue; reg[j] = 1; st[sp++] = j; } }
  // close + fill
  return fillHoles(dilate(dilate(reg, nx, ny, N, CLOSE_R, false), nx, ny, N, CLOSE_R, true), nx, ny, nz);
}

function dice(pred: Uint8Array, lab: Uint8Array, want: number[]): number { const s = new Set(want); let it = 0, pa = 0, pb = 0; for (let i = 0; i < pred.length; i++) { const p = pred[i] ? 1 : 0, g = s.has(lab[i]) ? 1 : 0; it += p & g; pa += p; pb += g; } return pa + pb ? 2 * it / (pa + pb) : 1; }

const results = [];
for (const pid of CASES) {
  const c = await loadCase(pid); const [nx, ny, nz] = c.dims, N = nx * ny * nz;
  const a = anchors(c);
  const rn = await makeRunner(Float32Array.from(c.ct), c.dims, gpu);
  const relE = await rn.run("relEnhance", K.relEnhance.body, K.relEnhance.params(a.fat, a.cortex));
  const enc = await rn.run("fatEnclose", K.fatEnclose.body, K.fatEnclose.params(FAT_HU, 22));
  const gas = await rn.run("gasNear", K.gasNear.body, K.gasNear.params(-200, 12));
  const lvar = await rn.run("localVar", K.localVar.body, K.localVar.params(1)); rn.destroy();
  // confusers to subtract: bone-near + vessels
  let boneNear = new Uint8Array(N); for (let i = 0; i < N; i++) if (c.ct[i] > 300) boneNear[i] = 1; boneNear = dilate(boneNear, nx, ny, N, 4, false);
  const vessel = detectVessels(c, relE, a, boneNear);
  const block = new Uint8Array(N); for (let i = 0; i < N; i++) if (boneNear[i] || vessel[i]) block[i] = 1;
  const t0 = performance.now();
  const left = segmentSide(c, relE, enc, gas, a, block, -1), right = segmentSide(c, relE, enc, gas, a, block, 1);
  const envelope = new Uint8Array(N); for (let i = 0; i < N; i++) if (left[i] || right[i]) envelope[i] = 1;
  // best-effort mass: low fine-variance blob inside envelope
  const massCand = new Uint8Array(N); for (let i = 0; i < N; i++) if (envelope[i] && lvar[i] < 700) massCand[i] = 1;
  const seged = new Uint8Array(N); for (let i = 0; i < N; i++) if (envelope[i]) seged[i] = massCand[i] ? 2 : 1;
  const dt = (performance.now() - t0).toFixed(0);
  let ev = 0; for (let i = 0; i < N; i++) ev += envelope[i];
  const dK = dice(envelope, c.lab, [1, 2]);
  results.push({ pid, kidneyDice: +dK.toFixed(3), envVox: ev });
  console.log(`${pid}: kidney(envelope) Dice=${dK.toFixed(3)}  envVox=${ev}  (${dt}ms)`);
  if (CASES.length === 1) { const dir = Deno.env.get("KITS_DIR") || "."; await Deno.writeFile(`${dir}/${pid}.cand.u8`, seged); console.log(`wrote candidate ${dir}/${pid}.cand.u8`); }
  if (NRRD && CASES.length === 1) { await Deno.mkdir("/home/ubuntu/out", { recursive: true }); await writeCT("/home/ubuntu/out/ct.nrrd", c.ct, c.dims, c.ijkToRAS); await writeSeg("/home/ubuntu/out/gt.seg.nrrd", c.lab, c.dims, c.ijkToRAS, [{ value: 1, name: "Kidney", color: [0.9, 0.4, 0.4] }, { value: 2, name: "Mass", color: [0.4, 0.7, 0.95] }]); await writeSeg("/home/ubuntu/out/seged.seg.nrrd", seged, c.dims, c.ijkToRAS, [{ value: 1, name: "Kidney", color: [0.9, 0.4, 0.4] }, { value: 2, name: "Mass", color: [0.4, 0.7, 0.95] }]); console.log("wrote NRRDs to /home/ubuntu/out/"); }
}
const mean = results.reduce((s, r) => s + r.kidneyDice, 0) / results.length;
console.log(`\nMEAN kidney(envelope) Dice = ${mean.toFixed(3)}  (v1 blind baseline was 0.27)`);
