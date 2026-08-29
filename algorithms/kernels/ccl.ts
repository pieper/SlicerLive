// Connected-components labeling (W5) — the kernel under the Segment Editor's Islands effect (replaces
// vtkITKIslandMath / vtkImageConnectivityFilter) and a building block for shape stats. Labels the nonzero
// voxels of a 3D mask into components (6-, 18-, or 26-connectivity), returns per-voxel labels + component
// sizes. Two-pass union-find (Hoshen-Kopelman style), C-order (z,y,x), dims [nx,ny,nz]. Pure typed arrays.
//
//   deno test -A --no-check algorithms/kernels/ccl.test.ts
export type Mask = { length: number; [i: number]: number };
export type Connectivity = 6 | 18 | 26;

export interface Components { labels: Int32Array; count: number; sizes: number[]; } // labels: 0 = background, 1..count

// neighbor offsets (di,dj,dk) with only "already visited" (lexicographically-earlier) neighbors for pass 1
function priorOffsets(conn: Connectivity): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let dk = -1; dk <= 0; dk++) {
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (dk === 0 && (dj > 0 || (dj === 0 && di >= 0))) continue;   // only earlier voxels
        const man = Math.abs(di) + Math.abs(dj) + Math.abs(dk);
        if (man === 0) continue;
        if (conn === 6 && man !== 1) continue;
        if (conn === 18 && man === 3) continue;
        out.push([di, dj, dk]);
      }
    }
  }
  return out;
}

export function connectedComponents(mask: Mask, dims: [number, number, number], conn: Connectivity = 6): Components {
  const [nx, ny, nz] = dims;
  const labels = new Int32Array(nx * ny * nz);
  const parent: number[] = [0];                    // union-find; index 0 unused
  const find = (x: number): number => { let r = x; while (parent[r] !== r) r = parent[r]; while (parent[x] !== r) { const n = parent[x]; parent[x] = r; x = n; } return r; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  const offs = priorOffsets(conn);
  let next = 1;
  const idx = (i: number, j: number, k: number) => k * nx * ny + j * nx + i;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!mask[idx(i, j, k)]) continue;
    let lab = 0;
    for (const [di, dj, dk] of offs) {
      const ii = i + di, jj = j + dj, kk = k + dk;
      if (ii < 0 || ii >= nx || jj < 0 || jj >= ny || kk < 0 || kk >= nz) continue;
      const nl = labels[idx(ii, jj, kk)];
      if (!nl) continue;
      if (!lab) lab = nl; else union(lab, nl);
    }
    if (!lab) { lab = next++; parent[lab] = lab; }
    labels[idx(i, j, k)] = lab;
  }
  // pass 2: flatten to consecutive component ids, accumulate sizes
  const remap = new Map<number, number>();
  const sizes: number[] = [];
  for (let p = 0; p < labels.length; p++) {
    if (!labels[p]) continue;
    const r = find(labels[p]);
    let id = remap.get(r);
    if (id === undefined) { id = remap.size + 1; remap.set(r, id); sizes.push(0); }
    labels[p] = id; sizes[id - 1]++;
  }
  return { labels, count: remap.size, sizes };
}

/** Islands: keep only the largest component (Slicer "Keep largest island"). Returns a new mask (1/0). */
export function keepLargestIsland(mask: Mask, dims: [number, number, number], conn: Connectivity = 6): Uint8Array {
  const cc = connectedComponents(mask, dims, conn);
  const out = new Uint8Array(mask.length);
  if (!cc.count) return out;
  let big = 1; for (let i = 1; i < cc.sizes.length; i++) if (cc.sizes[i] > cc.sizes[big - 1]) big = i + 1;
  for (let p = 0; p < cc.labels.length; p++) if (cc.labels[p] === big) out[p] = 1;
  return out;
}

/** Islands: remove components smaller than `minSize` voxels (Slicer "Remove small islands"). */
export function removeSmallIslands(mask: Mask, dims: [number, number, number], minSize: number, conn: Connectivity = 6): Uint8Array {
  const cc = connectedComponents(mask, dims, conn);
  const keep = cc.sizes.map((s) => s >= minSize);
  const out = new Uint8Array(mask.length);
  for (let p = 0; p < cc.labels.length; p++) { const l = cc.labels[p]; if (l && keep[l - 1]) out[p] = 1; }
  return out;
}
