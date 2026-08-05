// Verify the CPU EDT (render/edt-cpu.ts) against a BRUTE-FORCE exact nearest-seed scan — the math
// must be exactly right before any GPU port.
//   deno run render/test/edt-verify.ts
import { colorizedEdt } from "../edt-cpu.ts";

const nx = 40, ny = 40, nz = 36;
const dims: [number, number, number] = [nx, ny, nz];
const spacing: [number, number, number] = [1.5, 1.5, 2.0];   // anisotropic, to stress the scaling
const labels = new Uint8Array(nx * ny * nz);
const put = (cx: number, cy: number, cz: number, r: number, id: number) => {
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const dx = (x - cx) * spacing[0], dy = (y - cy) * spacing[1], dz = (z - cz) * spacing[2];
    if (dx * dx + dy * dy + dz * dz <= r * r) labels[(z * ny + y) * nx + x] = id;   // later ids win in overlap
  }
};
put(15, 20, 18, 16, 1);   // region 1
put(26, 20, 18, 14, 2);   // region 2 (overlaps region 1)
put(20, 8, 26, 9, 3);     // region 3 (separate)

// Reference edt.
const edt = colorizedEdt(labels, dims, spacing);

// Brute force: identical boundary seeding, then exact nearest-seed per voxel.
const at = (x: number, y: number, z: number) => labels[(z * ny + y) * nx + x];
const inside = (x: number, y: number, z: number) => at(x, y, z) !== 0;
const off: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const seeds: { x: number; y: number; z: number; region: number }[] = [];
for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
  const me = inside(x, y, z); let boundary = false, region = at(x, y, z);
  for (const [dx, dy, dz] of off) {
    const cx = Math.min(nx - 1, Math.max(0, x + dx)), cy = Math.min(ny - 1, Math.max(0, y + dy)), cz = Math.min(nz - 1, Math.max(0, z + dz));
    if (inside(cx, cy, cz) !== me) { boundary = true; if (!me) region = at(cx, cy, cz); }
  }
  if (boundary) seeds.push({ x, y, z, region });
}
console.log(`volume ${nx}×${ny}×${nz}, ${seeds.length} seeds`);

let maxDistErr = 0, labelMismatch = 0, tieExplained = 0;
const [sx, sy, sz] = spacing;
for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
  let best = Infinity, bestRegion = 0, secondBest = Infinity;
  for (const s of seeds) {
    const dx = (x - s.x) * sx, dy = (y - s.y) * sy, dz = (z - s.z) * sz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) { secondBest = best; best = d2; bestRegion = s.region; }
    else if (d2 < secondBest) secondBest = d2;
  }
  const bruteDist = Math.sqrt(best);
  const i = (z * ny + y) * nx + x;
  const edtDist = Math.abs(edt.signedDist[i]);
  maxDistErr = Math.max(maxDistErr, Math.abs(edtDist - bruteDist));
  if (edt.siteLabel[i] !== bestRegion) {
    labelMismatch++;
    if (Math.abs(Math.sqrt(secondBest) - bruteDist) < 1e-6) tieExplained++;   // equidistant seeds → either label is exact
  }
}
const unexplained = labelMismatch - tieExplained;
console.log(`max distance error = ${maxDistErr.toExponential(2)} mm`);
console.log(`label mismatches = ${labelMismatch} (${tieExplained} at exact distance ties, ${unexplained} unexplained)`);
const ok = maxDistErr < 1e-4 && unexplained === 0;
console.log(ok ? "PASS — CPU EDT matches brute-force exactly (distance + nearest-region, ties aside)" : "FAIL");
if (!ok) Deno.exit(1);
