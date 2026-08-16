// Weight-learning / cue-validation pass. Using KiTS GT, measure per case the
// quantities the feature operators are calibrated on, and test the skill's claims:
//  (1) fat is a phase-invariant wall  -> what fraction of the kidney SURFACE abuts fat?
//  (2) absolute HU is fragile         -> cortex/medulla/mass HU spread ACROSS cases
//  (3) texture separates tumor        -> local variance in kidney vs mass
import { loadCase, idx, type Case } from "./kits-io.ts";

const TRAIN = ["KiTS-00013", "KiTS-00057", "KiTS-00081", "KiTS-00111", "KiTS-00010"];

function pct(vals: number[], ps: number[]): number[] {
  const a = Float64Array.from(vals).sort(); return ps.map((p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))]);
}
function fatMode(ct: Int16Array): number {
  const bins = new Int32Array(400); // -1000..1000 step 5
  for (let i = 0; i < ct.length; i++) { const b = Math.floor((ct[i] + 1000) / 5); if (b >= 0 && b < 400) bins[b]++; }
  let best = -1, bi = 0; for (let b = 160; b < 194; b++) if (bins[b] > best) { best = bins[b]; bi = b; } // [-200,-30]
  return bi * 5 - 1000;
}
// local variance in a 3x3x3 window at (x,y,z)
function localVar(ct: Int16Array, d: [number, number, number], x: number, y: number, z: number): number {
  let s = 0, s2 = 0, n = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy, zz = z + dz;
    if (xx < 0 || yy < 0 || zz < 0 || xx >= d[0] || yy >= d[1] || zz >= d[2]) continue;
    const v = ct[idx(d, xx, yy, zz)]; s += v; s2 += v * v; n++;
  }
  const m = s / n; return s2 / n - m * m;
}

function analyze(c: Case) {
  const d = c.dims, ct = c.ct, lab = c.lab;
  const kid: number[] = [], mass: number[] = [];
  for (let i = 0; i < lab.length; i++) { if (lab[i] === 1) kid.push(ct[i]); else if (lab[i] === 2) mass.push(ct[i]); }
  // surface-fat analysis: kidney voxel with a background 6-neighbor = surface; classify that neighbor
  let surf = 0, surfFat = 0, surfSoft = 0;
  const off: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let z = 1; z < d[2] - 1; z++) for (let y = 1; y < d[1] - 1; y++) for (let x = 1; x < d[0] - 1; x++) {
    const i = idx(d, x, y, z); if (lab[i] !== 1 && lab[i] !== 2) continue; // organ envelope surface (kidney+mass)
    for (const [ox, oy, oz] of off) {
      const j = idx(d, x + ox, y + oy, z + oz);
      if (lab[j] === 0) { surf++; if (ct[j] < -30) surfFat++; else surfSoft++; break; }
    }
  }
  // texture: sample up to 4000 voxels each
  const sample = (want: number, val: number) => {
    const out: number[] = []; const step = Math.max(1, Math.floor(lab.length / 400000));
    for (let i = 0; i < lab.length && out.length < want; i += step) {
      if (lab[i] !== val) continue; const z = Math.floor(i / (d[0] * d[1])), r = i % (d[0] * d[1]), y = Math.floor(r / d[0]), x = r % d[0];
      if (x < 1 || y < 1 || z < 1 || x >= d[0] - 1 || y >= d[1] - 1 || z >= d[2] - 1) continue;
      out.push(localVar(ct, d, x, y, z));
    }
    return out;
  };
  const kVar = sample(4000, 1), mVar = sample(4000, 2);
  const kP = pct(kid, [0.1, 0.5, 0.9]), mP = mass.length ? pct(mass, [0.1, 0.5, 0.9]) : [NaN, NaN, NaN];
  return {
    pid: c.pid, dims: d, kidVox: kid.length, massVox: mass.length,
    fatMode: fatMode(ct),
    kidney_p10_50_90: kP.map(Math.round), mass_p10_50_90: mP.map(Math.round),
    cortexMinusMedulla: Math.round(kP[2] - kP[0]),
    surfaceFatFrac: +(surfFat / Math.max(1, surf)).toFixed(3), surfaceSoftFrac: +(surfSoft / Math.max(1, surf)).toFixed(3),
    kidVar_med: Math.round(pct(kVar, [0.5])[0]), massVar_med: mVar.length ? Math.round(pct(mVar, [0.5])[0]) : NaN,
    kidVar_p90: Math.round(pct(kVar, [0.9])[0]), massVar_p90: mVar.length ? Math.round(pct(mVar, [0.9])[0]) : NaN,
  };
}

const rows = [];
for (const pid of TRAIN) { const c = await loadCase(pid); const r = analyze(c); rows.push(r); console.log(JSON.stringify(r)); }
await Deno.writeTextFile("scratchpad/truth-stats.json", JSON.stringify(rows, null, 2));
// cross-case spread summary
const spread = (k: string) => { const v = rows.map((r: Record<string, number>) => r[k]).filter((x) => !isNaN(x)); return `${Math.min(...v)}..${Math.max(...v)}`; };
console.log("\n== CROSS-CASE SPREAD (the 'absolute HU is fragile' test) ==");
console.log("fatMode:", spread("fatMode"), "| kidney p50:", rows.map((r: any) => r.kidney_p10_50_90[1]).join(","), "| mass p50:", rows.map((r: any) => r.mass_p10_50_90[1]).join(","));
console.log("surfaceFatFrac:", rows.map((r: any) => r.surfaceFatFrac).join(","), "(fat-wall coverage of organ surface)");
console.log("kidVar_med vs massVar_med:", rows.map((r: any) => `${r.kidVar_med}/${r.massVar_med}`).join(",  "), "(texture separation)");
