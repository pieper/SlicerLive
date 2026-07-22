// LiveSegmenter — the SlicerLive side of the nnLive LiveModule: turn CT voxels +
// user clicks into an nnInteractive-style patch input, run a pluggable inference
// backend, and splat the returned mask back into a full-volume labelmap. The input
// encoding is a faithful port of nnLive's interactive.html buildInput (8-channel
// [1,8,P,P,P]: ch0 z-scored image, ch1 prev-seg, ch4 +points, ch5 -points).
//
// The inference backend is injected (Segmenter interface) so the pure encode/splat
// logic is testable headlessly with a synthetic segmenter, and the real ORT-Web
// nnLive model drops in unchanged in the browser.

export interface Click { x: number; y: number; z: number; sign: 1 | -1 }  // voxel coords (i,j,k), sign +fg/-bg

export interface PatchInput { input: Float32Array; lo: [number, number, number] }  // [8*P^3], patch origin (z0,y0,x0)

/** Solid-ball voxel offsets (radius r) for painting prompt points. */
function ball(r: number): [number, number, number][] {
  const o: [number, number, number][] = [];
  for (let z = -r; z <= r; z++) for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y + z * z <= r * r) o.push([z, y, x]);
  return o;
}
const BALL2 = ball(2);

/** Clamp the patch origin so a P^3 patch centered on `center` stays inside dims=[X,Y,Z]. */
export function patchOrigin(center: Click, dims: [number, number, number], P: number): [number, number, number] {
  const [X, Y, Z] = dims;
  const c = [center.z, center.y, center.x], dim = [Z, Y, X];
  return c.map((v, i) => Math.max(0, Math.min(v - (P >> 1), dim[i] - P))) as [number, number, number];
}

/** Build the 8-channel nnInteractive input for the patch around the latest click.
 *  `vol` is the raw scalar volume (HU for CT) in (z,y,x) C-order, dims=[X,Y,Z].
 *  `prevMask` (optional) is the accumulated full-volume labelmap (ch1 continuity). */
export function buildPatchInput(
  vol: Float32Array,
  dims: [number, number, number],
  clicks: Click[],
  P: number,
  prevMask?: Uint8Array,
): PatchInput {
  const [X, Y, Z] = dims;
  const center = clicks[clicks.length - 1];
  const [z0, y0, x0] = patchOrigin(center, dims, P);
  const P3 = P * P * P;
  const inp = new Float32Array(8 * P3);

  // ch0 image (z-scored over the patch) + ch1 prev-seg
  let sum = 0, sum2 = 0;
  for (let z = 0; z < P; z++) for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    const src = (z0 + z) * Y * X + (y0 + y) * X + (x0 + x), pi = z * P * P + y * P + x;
    const gv = vol[src];
    inp[pi] = gv; sum += gv; sum2 += gv * gv;
    if (prevMask && prevMask[src]) inp[P3 + pi] = 1;
  }
  const mean = sum / P3, std = Math.sqrt(Math.max(1e-6, sum2 / P3 - mean * mean));
  for (let i = 0; i < P3; i++) inp[i] = (inp[i] - mean) / std;

  // ch4 positive points, ch5 negative points — every click landing in this patch, painted as r=2 balls
  for (const c of clicks) {
    const lz = c.z - z0, ly = c.y - y0, lx = c.x - x0;
    if (lz < 0 || ly < 0 || lx < 0 || lz >= P || ly >= P || lx >= P) continue;
    const ch = c.sign > 0 ? 4 : 5;
    for (const [dz, dy, dx] of BALL2) {
      const z = lz + dz, y = ly + dy, x = lx + dx;
      if (z < 0 || y < 0 || x < 0 || z >= P || y >= P || x >= P) continue;
      inp[ch * P3 + z * P * P + y * P + x] = 1;
    }
  }
  return { inp, lo: [z0, y0, x0] };
}

/** Splat a P^3 patch mask back into the full-volume labelmap at origin `lo`, writing `label`. */
export function applyMaskDelta(
  labelmap: Uint8Array,
  dims: [number, number, number],
  mask: Uint8Array,
  lo: [number, number, number],
  P: number,
  label = 1,
): number {
  const [X, Y] = dims;
  const [z0, y0, x0] = lo;
  let fg = 0;
  for (let z = 0; z < P; z++) for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    const m = mask[z * P * P + y * P + x];
    const dst = (z0 + z) * Y * X + (y0 + y) * X + (x0 + x);
    labelmap[dst] = m ? label : 0;   // replace the patch box (ch1 prev-seg gives cross-click continuity)
    if (m) fg++;
  }
  return fg;
}

/** Inference backend: [1,8,P,P,P] f32 input -> P^3 uint8 mask. */
export interface Segmenter {
  readonly patch: number;
  ready(): Promise<void>;
  infer(input: Float32Array): Promise<Uint8Array>;
  dispose?(): void;
}

/** Deterministic no-model backend for headless tests / graceful fallback: region-grow
 *  from the +point through voxels of similar intensity to ch0 at the click, bounded by
 *  the -points. Proves the encode→mask→splat→colorize pipeline without the 200 MB model. */
export class SyntheticSegmenter implements Segmenter {
  // `band` (z-score units) is the half-width kept around the seed when the seed
  // isn't clearly bright; for a bright seed the primary test is relative to its
  // own z-score (ch0 has mean 0 by construction, so this is air-robust).
  constructor(readonly patch = 64, private band = 0.6) {}
  ready(): Promise<void> { return Promise.resolve(); }
  infer(input: Float32Array): Promise<Uint8Array> {
    const P = this.patch, P3 = P * P * P;
    const img = input.subarray(0, P3);        // ch0 (z-scored, mean 0)
    const pos = input.subarray(4 * P3, 5 * P3);
    const neg = input.subarray(5 * P3, 6 * P3);
    let sx = 0, sy = 0, sz = 0, ns = 0;
    for (let z = 0; z < P; z++) for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
      if (pos[z * P * P + y * P + x]) { sx += x; sy += y; sz += z; ns++; }
    }
    const mask = new Uint8Array(P3);
    if (!ns) return Promise.resolve(mask);
    const seed = [Math.round(sz / ns), Math.round(sy / ns), Math.round(sx / ns)] as const;
    const at = (z: number, y: number, x: number) => z * P * P + y * P + x;
    const ref = img[at(seed[0], seed[1], seed[2])];
    // A voxel joins the organ if it's close to the seed AND not much dimmer than it.
    // For a bright seed (ref>0) "not much dimmer" = above half the seed z-score, which
    // separates organ from surrounding tissue regardless of air inflating the std.
    const floor = ref > 0 ? 0.5 * ref : -Infinity;
    const ok = (i: number) => !neg[i] && Math.abs(img[i] - ref) <= Math.max(this.band, Math.abs(ref) * 0.5) && img[i] >= floor;
    const stack = [seed]; mask[at(seed[0], seed[1], seed[2])] = 1;
    while (stack.length) {
      const [z, y, x] = stack.pop()!;
      for (const [dz, dy, dx] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
        const nz = z + dz, ny = y + dy, nx = x + dx;
        if (nz < 0 || ny < 0 || nx < 0 || nz >= P || ny >= P || nx >= P) continue;
        const i = at(nz, ny, nx);
        if (mask[i]) continue;
        if (ok(i)) { mask[i] = 1; stack.push([nz, ny, nx]); }
      }
    }
    return Promise.resolve(mask);
  }
}
