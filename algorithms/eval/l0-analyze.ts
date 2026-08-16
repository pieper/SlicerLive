// Analyze an L-0 calibration run (algorithms/eval/l0-calibrate.ts → results.json).
//
// Beyond the headline τ, the questions that decide whether a critic can drive a search loop:
//   1. Can it recognize the PERFECT segmentation? (pristine vs anything should be ~100%)
//   2. Does it have a DIRECTIONAL bias? A critic that systematically prefers over-inclusive masks
//      doesn't just add noise — it points the loop at a wrong optimum (reward hacking, SEGED-LOOP §8.1).
//   3. Does accuracy scale with the Dice gap? (coarse-but-usable vs uniformly blind)
//   4. Is it just picking position A?
//
// Usage: deno run -A algorithms/eval/l0-analyze.ts algorithms/eval/l0-out-big/results.json
type Pair = { pid: string; a: string; b: string; dA: number; dB: number; pick: string; correct: number; reason: string };
const path = Deno.args[0] ?? "algorithms/eval/l0-out/results.json";
const d = JSON.parse(await Deno.readTextFile(path)) as { model: string; pairs: Pair[]; accuracy: number; tau: number };
const P = d.pairs;

const acc = (rs: Pair[]) => rs.length ? rs.reduce((s, r) => s + r.correct, 0) / rs.length : NaN;
const tau = (rs: Pair[]) => 2 * acc(rs) - 1;
// Wilson 95% interval — with ~100 forced-choice trials the naive point estimate is badly overconfident.
function wilson(k: number, n: number): [number, number] {
  if (!n) return [NaN, NaN];
  const z = 1.96, p = k / n, dnm = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / dnm;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / dnm;
  return [c - h, c + h];
}
const pct = (x: number) => (x * 100).toFixed(1) + "%";

console.log(`\nL-0 ANALYSIS — ${d.model}   (${path})`);
console.log("═".repeat(74));
const n = P.length, k = P.reduce((s, r) => s + r.correct, 0);
const [lo, hi] = wilson(k, n);
console.log(`overall: ${k}/${n} = ${pct(acc(P))}  τ=${tau(P).toFixed(3)}   95% CI ${pct(lo)}–${pct(hi)}`);
console.log(`  → chance is 50%. ${lo > 0.5 ? "ABOVE chance." : "NOT significantly above chance."}`);

// 1. can it spot the perfect one?
const pr = P.filter((r) => r.a === "pristine" || r.b === "pristine");
const prHit = pr.filter((r) => r.pick === (r.a === "pristine" ? "A" : "B")).length;
const [plo, phi] = wilson(prHit, pr.length);
console.log(`\n1. PRISTINE (Dice 1.0) vs a corrupted variant — should be ~100%:`);
console.log(`   ${prHit}/${pr.length} = ${pct(prHit / pr.length)}   95% CI ${pct(plo)}–${pct(phi)}`);

// 2. directional bias: which corruption fools it?
console.log(`\n2. accuracy by the corruption involved (which flaws does it fail to see?):`);
const kinds = ["erode1", "erode3", "dilate1", "dilate3", "leak4", "leak8", "shift3", "pristine"];
for (const kd of kinds) {
  const rs = P.filter((r) => r.a === kd || r.b === kd);
  if (!rs.length) continue;
  const bar = "█".repeat(Math.round(acc(rs) * 20));
  console.log(`   ${kd.padEnd(9)} ${String(rs.reduce((s, r) => s + r.correct, 0)).padStart(3)}/${String(rs.length).padEnd(3)} ${pct(acc(rs)).padStart(6)} ${bar}`);
}

// the sharpest version: when the critic was WRONG, what did it wrongly prefer?
const wrong = P.filter((r) => !r.correct);
const preferred: Record<string, number> = {};
for (const r of wrong) { const p = r.pick === "A" ? r.a : r.b; preferred[p] = (preferred[p] ?? 0) + 1; }
console.log(`\n   when WRONG (${wrong.length} pairs), the variant it wrongly preferred:`);
for (const [k2, v] of Object.entries(preferred).sort((a, b) => b[1] - a[1])) {
  console.log(`     ${k2.padEnd(9)} ${v}`);
}
const overInc = wrong.filter((r) => /dilate|leak/.test(r.pick === "A" ? r.a : r.b)).length;
console.log(`   over-inclusive (dilate/leak) share of its errors: ${pct(overInc / Math.max(1, wrong.length))}`);

// 3. does it scale with the gap?
console.log(`\n3. accuracy vs |ΔDice| (can it at least resolve coarse differences?):`);
for (const [lo2, hi2] of [[0, 0.05], [0.05, 0.15], [0.15, 0.3], [0.3, 1]] as [number, number][]) {
  const rs = P.filter((r) => { const g = Math.abs(r.dA - r.dB); return g >= lo2 && g < hi2; });
  if (!rs.length) continue;
  console.log(`   Δ ${lo2.toFixed(2)}–${hi2.toFixed(2)}  ${String(rs.length).padStart(3)} pairs  ${pct(acc(rs)).padStart(6)}  τ=${tau(rs).toFixed(3)}`);
}

// 4. position bias + reason diversity
const pickA = P.filter((r) => r.pick === "A").length, truthA = P.filter((r) => r.dA > r.dB).length;
console.log(`\n4. position bias: picked A ${pickA}/${n} (${pct(pickA / n)}); truth was A ${truthA}/${n} (${pct(truthA / n)})`);
console.log(`   reason diversity: ${new Set(P.map((r) => r.reason.slice(0, 45))).size} distinct openings across ${n} verdicts`);

// per-case, to see whether one case carries the result
console.log(`\n5. per test case:`);
for (const pid of [...new Set(P.map((r) => r.pid))]) {
  const rs = P.filter((r) => r.pid === pid);
  console.log(`   ${pid}  ${String(rs.length).padStart(3)} pairs  ${pct(acc(rs)).padStart(6)}  τ=${tau(rs).toFixed(3)}`);
}
console.log("═".repeat(74));
