// L-0 — CRITIC CALIBRATION (docs/SEGED-LOOP.md §6). The go/no-go experiment for the seged loop.
//
// Question: does a VLM critic's preference actually predict segmentation quality? If it doesn't,
// no amount of loop engineering converges — which is exactly how the previous seged loop failed
// (its objective was never measured). So: take KiTS ground truth from IDC, corrupt it in controlled
// ways with KNOWN Dice, render every variant through ONE canonical view, ask the critic pairwise
// which is better, and measure the rank correlation between its preference and the true ΔDice.
//
// No agent, no editing loop. Just: is the objective informative?
//
//   Kendall τ = (concordant − discordant) / pairs   (= 2·accuracy − 1 for forced-choice pairs)
//   τ ≈ 0    → the critic is noise; kill the design.
//   τ ≳ 0.5  → there is a hill to climb and the rest is engineering.
//
// Canonical-view discipline (the fix for failure #4 in SEGED-LOOP.md §1): the view is computed ONCE
// from the pristine ground truth and then RESTORED for every candidate. If each candidate were
// framed on its own centroid, "looks better" would partly measure framing, not segmentation.
//
// Usage:
//   1. Chrome, headed:  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//        --remote-debugging-port=9222 --remote-allow-origins='*' --user-data-dir=/tmp/chrome-l0 \
//        --no-first-run --window-size=1400,1000 about:blank &
//   2. Static server:   python3 -m http.server 8100   (from the SlicerLive repo root)
//   3. vLLM reachable at http://127.0.0.1:8000 (SSH-forwarded from the H100)
//   4. deno run -A algorithms/eval/l0-calibrate.ts --cases KiTS-00061,KiTS-00038 --test KiTS-00110
import { CDP } from "../../harness/cdp.ts";

const args = new Map<string, string>();
for (const a of Deno.args) { const m = a.match(/^--([^=]+)=?(.*)$/); if (m) args.set(m[1], m[2]); }
const BASE = args.get("base") ?? "http://127.0.0.1:8100/render/demos/seged-app.html";
const VLLM = args.get("vllm") ?? "http://127.0.0.1:8000/v1/chat/completions";
const MODEL = args.get("model") ?? "qwen3vl";
const EXEMPLARS = (args.get("cases") ?? "KiTS-00061,KiTS-00038").split(",").filter(Boolean);
const TESTS = (args.get("test") ?? "KiTS-00110").split(",").filter(Boolean);
const OUT = args.get("out") ?? "algorithms/eval/l0-out";
/** Ask every pair a second time with the candidates swapped, to separate real discrimination from
 *  position bias. Doubles the query count; on by default because without it a model that always
 *  answers 'A' is indistinguishable from a weak-but-honest critic. */
const SWAP = (args.get("swap") ?? "1") !== "0";

await Deno.mkdir(OUT, { recursive: true });

// ── the severity ladder: each variant has a KNOWN, monotone-ish relationship to Dice ──────────
type Spec = { name: string; op: "none" | "erode" | "dilate" | "leak" | "shift"; r: number; dir?: number[] };
const LADDER: Spec[] = [
  { name: "pristine", op: "none", r: 0 },
  { name: "erode1", op: "erode", r: 1 },
  { name: "erode3", op: "erode", r: 3 },
  { name: "dilate1", op: "dilate", r: 1 },
  { name: "dilate3", op: "dilate", r: 3 },
  { name: "leak4", op: "leak", r: 4, dir: [1, 0, 0] },
  { name: "leak8", op: "leak", r: 8, dir: [1, 0, 0] },
  { name: "shift3", op: "shift", r: 3, dir: [1, 1, 0] },
];

// ── in-page helpers: all heavy arrays stay in the browser; only numbers cross the wire ────────
const INPAGE = `
window.__l0 = (() => {
  const I = (x,y,z,d) => x + d[0]*(y + d[1]*z);
  // separable box morphology on a binary mask (max = dilate, min = erode)
  function sweep(m, d, rx, ry, rz, isMax) {
    const [nx,ny,nz] = d; let src = m, dst = new Uint8Array(m.length);
    const pass = (r, axis) => {
      if (r <= 0) return;
      const n = [nx,ny,nz][axis];
      const stride = axis===0 ? 1 : axis===1 ? nx : nx*ny;
      const outer0 = axis===0 ? ny : nx, outer1 = axis===2 ? ny : nz;
      for (let b=0;b<outer1;b++) for (let a=0;a<outer0;a++) {
        let base;
        if (axis===0) base = I(0,a,b,d); else if (axis===1) base = I(a,0,b,d); else base = I(a,b,0,d);
        for (let i=0;i<n;i++) {
          let acc = isMax ? 0 : 1;
          for (let k=-r;k<=r;k++) { const j=i+k; if (j<0||j>=n) { if(!isMax) acc=0; continue; }
            const v = src[base + j*stride]; acc = isMax ? (acc|v) : (acc&v); }
          dst[base + i*stride] = acc;
        }
      }
      const t = src; src = dst; dst = (t===m ? new Uint8Array(m.length) : t);
    };
    pass(rx,0); pass(ry,1); pass(rz,2);
    return src;
  }
  // one-sided dilation along the dominant axis of dir — a directional "leak" into neighbouring tissue
  function leak(m, d, r, dir) {
    const [nx,ny,nz]=d; const ax = dir[0]!==0?0:(dir[1]!==0?1:2); const sgn = Math.sign(dir[ax]||1);
    const n=[nx,ny,nz][ax]; const stride = ax===0?1:ax===1?nx:nx*ny;
    const outer0 = ax===0?ny:nx, outer1 = ax===2?ny:nz;
    const out = new Uint8Array(m);
    for (let b=0;b<outer1;b++) for (let a=0;a<outer0;a++) {
      let base; if (ax===0) base=I(0,a,b,d); else if (ax===1) base=I(a,0,b,d); else base=I(a,b,0,d);
      for (let i=0;i<n;i++) if (m[base+i*stride]) {
        for (let k=1;k<=r;k++) { const j=i+sgn*k; if (j<0||j>=n) break; out[base+j*stride]=1; }
      }
    }
    return out;
  }
  function shift(m, d, r, dir) {
    const [nx,ny,nz]=d; const out=new Uint8Array(m.length);
    const dx=Math.round((dir[0]||0)*r), dy=Math.round((dir[1]||0)*r), dz=Math.round((dir[2]||0)*r);
    for (let z=0;z<nz;z++){ const z2=z+dz; if(z2<0||z2>=nz) continue;
      for (let y=0;y<ny;y++){ const y2=y+dy; if(y2<0||y2>=ny) continue;
        for (let x=0;x<nx;x++){ const x2=x+dx; if(x2<0||x2>=nx) continue;
          if (m[I(x,y,z,d)]) out[I(x2,y2,z2,d)]=1; } } }
    return out;
  }
  function dice(a,b,label){ let i=0,na=0,nb=0;
    for (let k=0;k<a.length;k++){ const x=a[k]===label?1:0, y=b[k]===label?1:0; i+=x&y; na+=x; nb+=y; }
    return na+nb===0 ? 1 : 2*i/(na+nb); }
  return {
    async init() {
      window.__gt = await seged.labArray();
      window.__dims = seged.dimsArr();
      const st = await seged.state();
      return { len: window.__gt.length, dims: window.__dims, segments: st.segments };
    },
    /** Canonical view: framed ONCE on the pristine GT, then reused for every candidate. */
    async canonical(label) {
      seged.applyLabelmap(window.__gt);
      await seged.focus(label);
      const st = await seged.state();
      window.__view = { axial: st.view.axial, coronal: st.view.coronal, sagittal: st.view.sagittal, camera: st.camera };
      return window.__view;
    },
    restore() { seged.view(window.__view); return true; },
    /** Build a variant from the pristine GT, install it, return its TRUE Dice vs GT. */
    make(op, r, label, dir) {
      const gt = window.__gt, d = window.__dims;
      let m = new Uint8Array(gt.length);
      for (let i=0;i<gt.length;i++) m[i] = gt[i]===label ? 1 : 0;
      if (op==="dilate") m = sweep(m,d,r,r,r,true);
      else if (op==="erode") m = sweep(m,d,r,r,r,false);
      else if (op==="leak") m = leak(m,d,r,dir||[1,0,0]);
      else if (op==="shift") m = shift(m,d,r,dir||[1,0,0]);
      const out = new Uint8Array(gt);
      for (let i=0;i<out.length;i++) if (out[i]===label) out[i]=0;          // clear the old extent
      for (let i=0;i<out.length;i++) if (m[i] && out[i]===0) out[i]=label;  // paint the new one, never over another segment
      seged.applyLabelmap(out);
      seged.view(window.__view);                                            // canonical view, always
      return dice(out, gt, label);
    },
  };
})(); return 1;
`;

// ── critic ────────────────────────────────────────────────────────────────────────────────────
const b64 = (u: Uint8Array) => { let s = ""; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
const img = (data: string) => ({ type: "image_url", image_url: { url: "data:image/png;base64," + data } });
const txt = (text: string) => ({ type: "text", text });

const SYSTEM =
  "You are grading 3D medical image segmentations of kidney and kidney tumor on CT. " +
  "You are shown reference examples of CORRECT expert segmentation, then two candidate segmentations " +
  "of a DIFFERENT patient. Judge only how well each candidate's colored label follows the true organ " +
  "boundary in the underlying CT: it should cover the whole structure, stop at its edge, and not spill " +
  "into neighbouring tissue or leave gaps. Ignore differences in patient anatomy, slice position and framing.";

async function askCritic(refs: string[][], a: string[], b: string[]): Promise<{ better: "A" | "B"; reason: string } | null> {
  const content: unknown[] = [txt(`Reference examples of CORRECT kidney/tumor segmentation (${refs.length} different patient(s), axial then coronal):`)];
  for (const r of refs) for (const p of r) content.push(img(p));
  content.push(txt("Candidate A (axial, then coronal):"));
  for (const p of a) content.push(img(p));
  content.push(txt("Candidate B (axial, then coronal) — the SAME patient and the SAME slices as A, so any difference you see is the segmentation itself:"));
  for (const p of b) content.push(img(p));
  content.push(txt('Which candidate is the better segmentation? Reply with ONLY JSON: {"better":"A" or "B","reason":"<one short sentence>"}'));
  const body = {
    model: MODEL, max_tokens: 150, temperature: 0,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content }],
  };
  const r = await fetch(VLLM, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { console.error("critic HTTP", r.status, (await r.text()).slice(0, 200)); return null; }
  const j = await r.json();
  const raw = (j.choices?.[0]?.message?.content ?? "").trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) { console.error("critic unparseable:", raw.slice(0, 120)); return null; }
  try {
    const p = JSON.parse(m[0]);
    const better = String(p.better).toUpperCase().startsWith("B") ? "B" : "A";
    return { better, reason: String(p.reason ?? "").slice(0, 200) };
  } catch { return null; }
}

// ── driver ────────────────────────────────────────────────────────────────────────────────────
type Variant = { name: string; dice: number; png: string; b64: string[] };

async function loadCase(cdp: CDP, pid: string): Promise<{ segments: { num: number; name: string; voxels: number }[] }> {
  await cdp.goto(`${BASE}?pid=${pid}`);
  const ok = await cdp.waitFor("window.seged && window.seged.state", 180000);
  if (!ok) throw new Error(`${pid}: seged API never appeared`);
  // the scene loads asynchronously after the API is installed — wait for real segments
  const ready = await cdp.waitFor("(async()=>{try{const s=await seged.state();return s.segments.length>0&&s.segments.some(x=>x.voxels>0)}catch(e){return false}})()", 240000, 500);
  if (!ready) throw new Error(`${pid}: segments never populated`);
  await cdp.eval(INPAGE);
  return await cdp.eval(`return await window.__l0.init();`);
}

/** Capture ONE panel at full resolution.
 *
 *  The first version clipped all four cells into a single montage; inspecting the captures showed
 *  that was a mistake. The 3D cell renders as gray noise (focus() frames the camera 55 mm from the
 *  centroid, i.e. inside the volume) and the sagittal cell is empty (the kidney label spans BOTH
 *  kidneys, so its centroid lands on the midline, where a sagittal cut sees only spine). Half the
 *  montage was uninformative — and since the VLM downscales whatever it is given, that halved the
 *  resolution available to the panels that DO carry the signal. The critic even reported "no
 *  difference exists" on pairs that differ visibly. So: send the informative planes, separately,
 *  each at full resolution. */
const PANELS = ["c-axial", "c-coronal"] as const;

async function shot(cdp: CDP, path: string): Promise<string[]> {
  const out: string[] = [];
  for (const id of PANELS) {
    const clip = await cdp.eval<{ x: number; y: number; width: number; height: number } | null>(`
      const e = document.getElementById(${JSON.stringify(id)});
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };`);
    const params: Record<string, unknown> = { format: "png", captureBeyondViewport: false };
    if (clip) params.clip = { ...clip, scale: 1 };
    const r = await cdp.send<{ data: string }>("Page.captureScreenshot", params);
    await Deno.writeFile(path.replace(/\.png$/, `-${id.replace("c-", "")}.png`), Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
    out.push(r.data);
  }
  return out;
}

function pickLabel(segments: { num: number; name: string; voxels: number }[]): { num: number; name: string } {
  const withVox = segments.filter((s) => s.voxels > 0);
  const kidney = withVox.find((s) => /kidney/i.test(s.name));
  const s = kidney ?? withVox.slice().sort((a, b) => b.voxels - a.voxels)[0];
  return { num: s.num, name: s.name };
}

const cdp = await CDP.attachToPage(9222);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

// 1. exemplars — pristine GT renders from OTHER patients, in the canonical view
const refs: string[][] = [];
for (const pid of EXEMPLARS) {
  console.log(`exemplar: loading ${pid}…`);
  const { segments } = await loadCase(cdp, pid);
  const lab = pickLabel(segments);
  await cdp.eval(`return await window.__l0.canonical(${lab.num});`);
  const data = await shot(cdp, `${OUT}/ref-${pid}.png`);
  refs.push(data);
  console.log(`  ${pid}: label ${lab.num} (${lab.name}) → ref-${pid}.png`);
}

// 2. test cases — severity ladder under the canonical view
const rows: { pid: string; a: string; b: string; dA: number; dB: number; pick: string; correct: number; reason: string; consistent: number | null }[] = [];
for (const pid of TESTS) {
  console.log(`\ntest: loading ${pid}…`);
  const { segments } = await loadCase(cdp, pid);
  const lab = pickLabel(segments);
  console.log(`  grading label ${lab.num} (${lab.name})`);
  await cdp.eval(`return await window.__l0.canonical(${lab.num});`);

  const variants: Variant[] = [];
  for (const s of LADDER) {
    const dice = await cdp.eval<number>(
      `return window.__l0.make(${JSON.stringify(s.op)}, ${s.r}, ${lab.num}, ${JSON.stringify(s.dir ?? [1, 0, 0])});`,
    );
    await new Promise((r) => setTimeout(r, 400)); // let the SDF re-bake settle before capturing
    const png = `${OUT}/${pid}-${s.name}.png`;
    const data = await shot(cdp, png);
    variants.push({ name: s.name, dice, png, b64: data });
    console.log(`  ${s.name.padEnd(9)} dice=${dice.toFixed(4)}`);
  }

  // 3. all pairs with a meaningful Dice gap, A/B order randomized to cancel position bias
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const [v1, v2] = [variants[i], variants[j]];
      if (Math.abs(v1.dice - v2.dice) < 0.005) continue;
      const flip = Math.random() < 0.5;
      const A = flip ? v2 : v1, B = flip ? v1 : v2;
      const verdict = await askCritic(refs, A.b64, B.b64);
      if (!verdict) continue;
      // ORDER-SWAP CONSISTENCY (added after Lingshu-7B answered "A" in 13/14 trials regardless of
      // content). Ask the same pair with the candidates swapped: a critic that is actually looking
      // picks the same VARIANT both times; one with position bias picks the same POSITION. Without
      // this, a pure position-bias model scores ~50% on randomized pairs and is indistinguishable
      // from an honest-but-weak critic. `consistent` lets the analysis separate the two.
      let consistent: number | null = null;
      if (SWAP) {
        const v2nd = await askCritic(refs, B.b64, A.b64);
        if (v2nd) consistent = (verdict.better === "A") === (v2nd.better === "B") ? 1 : 0;
      }
      const truth = A.dice > B.dice ? "A" : "B";
      const correct = verdict.better === truth ? 1 : 0;
      rows.push({ pid, a: A.name, b: B.name, dA: A.dice, dB: B.dice, pick: verdict.better, correct, reason: verdict.reason, consistent });
      console.log(`  ${A.name} (${A.dice.toFixed(3)}) vs ${B.name} (${B.dice.toFixed(3)}) → critic:${verdict.better} truth:${truth} ${correct ? "✓" : "✗"}  "${verdict.reason.slice(0, 70)}"`);
    }
  }
}

// 4. the number
const n = rows.length, nc = rows.reduce((s, r) => s + r.correct, 0);
const acc = n ? nc / n : 0, tau = 2 * acc - 1;
const big = rows.filter((r) => Math.abs(r.dA - r.dB) >= 0.15);
const small = rows.filter((r) => Math.abs(r.dA - r.dB) < 0.15);
const accOf = (rs: typeof rows) => rs.length ? rs.reduce((s, r) => s + r.correct, 0) / rs.length : NaN;

console.log("\n" + "═".repeat(72));
console.log(`L-0 CRITIC CALIBRATION — ${MODEL}`);
console.log(`pairs: ${n}   accuracy: ${(acc * 100).toFixed(1)}%   Kendall τ: ${tau.toFixed(3)}`);
console.log(`  large Dice gap (≥0.15): ${big.length} pairs, acc ${(accOf(big) * 100).toFixed(1)}%  τ ${(2 * accOf(big) - 1).toFixed(3)}`);
console.log(`  small Dice gap (<0.15): ${small.length} pairs, acc ${(accOf(small) * 100).toFixed(1)}%  τ ${(2 * accOf(small) - 1).toFixed(3)}`);
const sw = rows.filter((r) => r.consistent !== null);
if (sw.length) {
  const cons = sw.filter((r) => r.consistent === 1);
  console.log(`  order-swap consistency: ${cons.length}/${sw.length} = ${((cons.length / sw.length) * 100).toFixed(1)}%  (50% = coin flip, i.e. pure position bias)`);
  console.log(`    accuracy on CONSISTENT pairs only: ${(accOf(cons) * 100).toFixed(1)}%  τ ${(2 * accOf(cons) - 1).toFixed(3)}`);
}
console.log("═".repeat(72));

await Deno.writeTextFile(`${OUT}/results.json`, JSON.stringify({ model: MODEL, exemplars: EXEMPLARS, tests: TESTS, ladder: LADDER, pairs: rows, accuracy: acc, tau }, null, 2));
console.log(`wrote ${OUT}/results.json`);
cdp.close();
