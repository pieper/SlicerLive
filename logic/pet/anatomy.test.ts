// T1: automatic PERCIST reference placement — distance transform and the liver search.
// Phantoms are analytic, so a failure names the step that broke.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  bodyMask,
  deepestPoint,
  distanceInside,
  findLiverSphere,
  rightLungBase,
  type Dims,
  type Spacing,
} from "./anatomy.ts";

const at = (dims: Dims, i: number, j: number, k: number) => (k * dims[1] + j) * dims[0] + i;

Deno.test("distanceInside: a slab's interior distance is the distance to its nearest face", () => {
  const dims: Dims = [21, 5, 5];
  const spacing: Spacing = [1, 1, 1];
  // A 1D slab 11 voxels wide (i = 5..15), unbounded in j/k by making those dims fully masked.
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) for (let i = 5; i <= 15; i++) mask[at(dims, i, j, k)] = 1;
  }
  const d = distanceInside(mask, dims, spacing);
  // Mid-slab at i=10 is 5 voxels from the nearest unmasked voxel at i=4 -> but j/k faces are
  // closer at the edges, so sample the middle row.
  // Every j and k is masked, so the only boundary is along i: from i=10 to the unmasked i=4.
  const j = 2, k = 2;
  assertAlmostEquals(d[at(dims, 10, j, k)], 6, 1e-6, "distance to the nearest i face");
  assertEquals(d[at(dims, 4, j, k)], 0, "outside the mask is zero");
  // Just inside the i face: one voxel in.
  assertAlmostEquals(d[at(dims, 5, j, k)], 1, 1e-6);
});

Deno.test("distanceInside respects ANISOTROPIC spacing", () => {
  const dims: Dims = [9, 9, 9];
  const mask = new Uint8Array(729).fill(1);
  // Clear one face so distance is measured along k only.
  for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) mask[at(dims, i, j, 0)] = 0;
  for (let k = 1; k < 9; k++) for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) {
    if (i === 0 || i === 8 || j === 0 || j === 8 || k === 8) mask[at(dims, i, j, k)] = 0;
  }
  const iso = distanceInside(mask, dims, [1, 1, 1]);
  const thick = distanceInside(mask, dims, [1, 1, 5]);
  // With 5 mm slices the k direction is far away, so the limiting distance comes from i/j and is
  // unchanged; with 1 mm it can be limited by k.
  assert(thick[at(dims, 4, 4, 2)] >= iso[at(dims, 4, 4, 2)], "thicker slices cannot reduce depth");
});

Deno.test("deepestPoint finds the centre of a sphere, and its radius", () => {
  const dims: Dims = [41, 41, 41];
  const spacing: Spacing = [1, 1, 1];
  const mask = new Uint8Array(41 * 41 * 41);
  const R = 12;
  for (let k = 0; k < 41; k++) {
    for (let j = 0; j < 41; j++) {
      for (let i = 0; i < 41; i++) {
        const dx = i - 20, dy = j - 20, dz = k - 20;
        if (dx * dx + dy * dy + dz * dz <= R * R) mask[at(dims, i, j, k)] = 1;
      }
    }
  }
  const p = deepestPoint(mask, dims, spacing)!;
  assertEquals(p.center, [20, 20, 20]);
  assertAlmostEquals(p.depthMm, R, 1.2, "depth is the sphere radius");
});

Deno.test("deepestPoint prefers the fat lobe over a thin one — which is the whole point", () => {
  // Two blobs joined by a neck. PERCIST wants the ROI where the organ is thickest, not merely
  // somewhere inside it.
  const dims: Dims = [60, 30, 30];
  const spacing: Spacing = [1, 1, 1];
  const mask = new Uint8Array(60 * 30 * 30);
  const blob = (ci: number, r: number) => {
    for (let k = 0; k < 30; k++) {
      for (let j = 0; j < 30; j++) {
        for (let i = 0; i < 60; i++) {
          const dx = i - ci, dy = j - 15, dz = k - 15;
          if (dx * dx + dy * dy + dz * dz <= r * r) mask[at(dims, i, j, k)] = 1;
        }
      }
    }
  };
  blob(14, 11);   // fat lobe
  blob(45, 5);    // thin lobe
  const p = deepestPoint(mask, dims, spacing)!;
  assert(Math.abs(p.center[0] - 14) <= 2, `expected the fat lobe near i=14, got ${p.center}`);
  assert(p.depthMm > 9, `depth should be ~11 mm, got ${p.depthMm}`);
});

Deno.test("bodyMask drops surrounding air and a detached table", () => {
  const dims: Dims = [30, 30, 10];
  const ct = new Float32Array(30 * 30 * 10).fill(-1000);          // air
  for (let k = 0; k < 10; k++) {
    for (let j = 8; j < 22; j++) for (let i = 8; i < 22; i++) ct[at(dims, i, j, k)] = 40;   // patient
    for (let i = 2; i < 28; i++) ct[at(dims, i, 27, k)] = 200;                               // table, detached
  }
  const m = bodyMask(ct, dims);
  assertEquals(m[at(dims, 15, 15, 5)], 1, "patient kept");
  assertEquals(m[at(dims, 15, 27, 5)], 0, "detached table dropped");
  assertEquals(m[at(dims, 1, 1, 5)], 0, "air dropped");
});

// --- a small torso phantom ----------------------------------------------------------------------

/** Torso with two lungs (air) superiorly and a liver-density block on the patient's right
 *  inferiorly, plus a spleen-density block on the left to prove sidedness matters. */
function torso(dims: Dims, rightIsPositiveI: boolean) {
  const [nx, ny, nz] = dims;
  const ct = new Float32Array(nx * ny * nz).fill(-1000);
  const midI = nx / 2;
  const rightSide = (i: number) => (rightIsPositiveI ? i > midI : i < midI);
  for (let k = 0; k < nz; k++) {
    for (let j = 4; j < ny - 4; j++) {
      for (let i = 4; i < nx - 4; i++) ct[at(dims, i, j, k)] = 40;     // soft tissue body
    }
  }
  // Lungs in the superior third (k high = superior here).
  for (let k = Math.floor(nz * 0.66); k < nz; k++) {
    for (let j = 8; j < ny - 8; j++) {
      for (let i = 8; i < nx - 8; i++) {
        if (Math.abs(i - midI) > 2) ct[at(dims, i, j, k)] = -800;
      }
    }
  }
  // Liver block just inferior to the lungs, patient-right, big and uniform.
  const liverTop = Math.floor(nz * 0.66) - 1;
  const liverBot = Math.floor(nz * 0.25);
  for (let k = liverBot; k <= liverTop; k++) {
    for (let j = 7; j < ny - 7; j++) {
      for (let i = 5; i < nx - 5; i++) if (rightSide(i)) ct[at(dims, i, j, k)] = 60;
    }
  }
  // Spleen: same density, other side, smaller. Must not win.
  for (let k = liverTop - 4; k <= liverTop; k++) {
    for (let j = 12; j < ny - 12; j++) {
      for (let i = 6; i < nx - 6; i++) if (!rightSide(i)) ct[at(dims, i, j, k)] = 60;
    }
  }
  return ct;
}

Deno.test("rightLungBase finds the inferior extent of the patient-right lung", () => {
  const dims: Dims = [48, 40, 48];
  const ct = torso(dims, true);
  const body = bodyMask(ct, dims);
  // The lungs span k = 31..47 in this phantom and +k is superior, so the BASE is the LOWEST lung
  // slice (31), not the apex (47). Asserting a range that spans both ends would accept the bug
  // that sent the real search hunting for liver in the neck.
  const base = rightLungBase(ct, dims, body, true, true)!;
  assertEquals(base, 31, "base is the INFERIOR extent of the lung");
  // With k inverted, the base is at the other end.
  const flipped = rightLungBase(ct, dims, body, true, false)!;
  assertEquals(flipped, 47);
});

Deno.test("findLiverSphere lands inside the liver, on the patient's right, below the lungs", () => {
  const dims: Dims = [48, 40, 48];
  const spacing: Spacing = [3, 3, 3];
  const ct = torso(dims, true);
  const r = findLiverSphere(ct, dims, spacing, { rightIsPositiveI: true, superiorIsPositiveK: true })!;
  assert(r, "a liver location was found");
  assert(r.center[0] > dims[0] / 2, `must be on the patient's right, got i=${r.center[0]}`);
  assert(r.center[2] < Math.floor(dims[2] * 0.66), `must be below the lungs, got k=${r.center[2]}`);
  assert(r.note.includes("lung base"), `should anchor on the lung base: ${r.note}`);
  assert(r.fits, `a 15 mm sphere should fit in this phantom, depth was ${r.depthMm.toFixed(1)} mm`);
});

Deno.test("findLiverSphere follows the patient's LEFT when the volume is mirrored", () => {
  const dims: Dims = [48, 40, 48];
  const spacing: Spacing = [3, 3, 3];
  // Same anatomy, but now patient-right is -i. The search must follow the patient, not the array.
  const ct = torso(dims, false);
  const r = findLiverSphere(ct, dims, spacing, { rightIsPositiveI: false, superiorIsPositiveK: true })!;
  assert(r.center[0] < dims[0] / 2, `must follow the patient's right to low i, got i=${r.center[0]}`);
});

Deno.test("findLiverSphere reports when no 3 cm sphere actually fits", () => {
  // A thin sliver of liver-density tissue: a location exists, but PERCIST's sphere does not fit,
  // and the caller must be told rather than shown a confident number.
  const dims: Dims = [40, 40, 12];
  const spacing: Spacing = [3, 3, 3];
  const ct = new Float32Array(40 * 40 * 12).fill(-1000);
  for (let k = 5; k <= 6; k++) {
    for (let j = 10; j < 30; j++) for (let i = 22; i < 36; i++) ct[at(dims, i, j, k)] = 60;
  }
  const r = findLiverSphere(ct, dims, spacing, { rightIsPositiveI: true, superiorIsPositiveK: true })!;
  assertEquals(r.fits, false, "a 2-slice sliver cannot hold a 15 mm radius");
  assert(r.depthMm < 15);
});
