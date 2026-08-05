// Exact Euclidean Distance Transform with FEATURE TRANSFORM (nearest seed), CPU reference.
//
// This is the ground-truth for the (future) GPU EDT tier and, for small volumes, a usable exact
// refinement of the colorized SDF. It's the separable Felzenszwalb–Huttenlocher algorithm: the same
// 1D lower-envelope-of-parabolas transform applied along x, then y, then z, each pass consuming the
// previous pass's squared distance as the parabola heights, and carrying the nearest SEED index so we
// recover the region label (for colour) and exact signed distance.
//
// Seeds match the JFA path: a boundary voxel (6-neighbourhood inside-ness differs) seeds with its
// REGION label — its own if inside, else its inside neighbour's — so distances measure to the surface
// and colour comes from the region the surface bounds.

export interface EdtResult {
  dims: [number, number, number];
  signedDist: Float32Array;   // mm; negative inside a segment, positive outside
  siteLabel: Uint8Array;      // region label of the nearest seed (0 = none), per voxel
}

const LARGE = 1e18;

/** 1D lower-envelope transform along one axis, scaled by spacing `s`. f = squared distance from the
 *  axes already processed (LARGE where no seed yet); carries the winning seed index. In place on the
 *  passed line arrays (writes results back into f/site). */
function transform1D(n: number, f: Float64Array, site: Int32Array, s: number, v: Int32Array, z: Float64Array, outF: Float64Array, outSite: Int32Array) {
  const s2 = s * s;
  const g = (q: number) => f[q] + (q * s) * (q * s);   // parabola constant (for intersections)
  let k = 0;
  v[0] = 0; z[0] = -LARGE; z[1] = LARGE;
  for (let q = 1; q < n; q++) {
    let sIx: number;
    // pop parabolas the new one occludes; z[0]=-LARGE guarantees k never goes below 0
    while (true) {
      const r = v[k];
      sIx = (g(q) - g(r)) / (2 * s2 * (q - r));
      if (sIx <= z[k]) k--;
      else break;
    }
    k++;
    v[k] = q; z[k] = sIx; z[k + 1] = LARGE;
  }
  k = 0;
  for (let p = 0; p < n; p++) {
    while (z[k + 1] < p) k++;
    const q = v[k];
    outF[p] = (p - q) * (p - q) * s2 + f[q];
    outSite[p] = site[q];
  }
}

/** Exact colorized EDT of a label volume. `spacing` in mm (per axis). */
export function colorizedEdt(labels: ArrayLike<number>, dims: [number, number, number], spacing: [number, number, number]): EdtResult {
  const [nx, ny, nz] = dims, N = nx * ny * nz;
  const [sx, sy, sz] = spacing;
  const at = (x: number, y: number, z: number) => labels[(z * ny + y) * nx + x];
  const inside = (x: number, y: number, z: number) => at(x, y, z) !== 0;

  const d2 = new Float64Array(N).fill(LARGE);
  const site = new Int32Array(N).fill(-1);
  const seedRegion = new Uint8Array(N);   // region label at each SEED voxel

  // Seed the boundary voxels with region labels (same rule as the JFA INIT).
  const off: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const me = inside(x, y, z);
    let boundary = false, region = at(x, y, z);
    for (const [dx, dy, dz] of off) {
      const cx = Math.min(nx - 1, Math.max(0, x + dx)), cy = Math.min(ny - 1, Math.max(0, y + dy)), cz = Math.min(nz - 1, Math.max(0, z + dz));
      const nIn = inside(cx, cy, cz);
      if (nIn !== me) { boundary = true; if (!me) region = at(cx, cy, cz); }
    }
    if (boundary) { const i = (z * ny + y) * nx + x; d2[i] = 0; site[i] = i; seedRegion[i] = region; }
  }

  const maxDim = Math.max(nx, ny, nz);
  const v = new Int32Array(maxDim), z = new Float64Array(maxDim + 1);
  const lf = new Float64Array(maxDim), ls = new Int32Array(maxDim), of = new Float64Array(maxDim), os = new Int32Array(maxDim);

  // Pass along X (rows vary x, fixed y,z).
  for (let zz = 0; zz < nz; zz++) for (let yy = 0; yy < ny; yy++) {
    const base = (zz * ny + yy) * nx;
    for (let x = 0; x < nx; x++) { lf[x] = d2[base + x]; ls[x] = site[base + x]; }
    transform1D(nx, lf, ls, sx, v, z, of, os);
    for (let x = 0; x < nx; x++) { d2[base + x] = of[x]; site[base + x] = os[x]; }
  }
  // Pass along Y (fixed x,z).
  for (let zz = 0; zz < nz; zz++) for (let xx = 0; xx < nx; xx++) {
    for (let y = 0; y < ny; y++) { const i = (zz * ny + y) * nx + xx; lf[y] = d2[i]; ls[y] = site[i]; }
    transform1D(ny, lf, ls, sy, v, z, of, os);
    for (let y = 0; y < ny; y++) { const i = (zz * ny + y) * nx + xx; d2[i] = of[y]; site[i] = os[y]; }
  }
  // Pass along Z (fixed x,y).
  for (let yy = 0; yy < ny; yy++) for (let xx = 0; xx < nx; xx++) {
    for (let zc = 0; zc < nz; zc++) { const i = (zc * ny + yy) * nx + xx; lf[zc] = d2[i]; ls[zc] = site[i]; }
    transform1D(nz, lf, ls, sz, v, z, of, os);
    for (let zc = 0; zc < nz; zc++) { const i = (zc * ny + yy) * nx + xx; d2[i] = of[zc]; site[i] = os[zc]; }
  }

  const signedDist = new Float32Array(N), siteLabel = new Uint8Array(N);
  for (let z2 = 0; z2 < nz; z2++) for (let y2 = 0; y2 < ny; y2++) for (let x2 = 0; x2 < nx; x2++) {
    const i = (z2 * ny + y2) * nx + x2;
    const s = site[i];
    const dist = s >= 0 ? Math.sqrt(d2[i]) : 1e6;
    signedDist[i] = inside(x2, y2, z2) ? -dist : dist;
    siteLabel[i] = s >= 0 ? seedRegion[s] : 0;
  }
  return { dims, signedDist, siteLabel };
}
