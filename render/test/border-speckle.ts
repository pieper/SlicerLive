// SYNTHETIC BACKGROUND BORDER (sdf-bake INIT): a segment voxel sitting ON the volume face must become
// a SURFACE (|sdf|≈0) so its shell closes with a flat cap at the ray-entry boundary. With the old
// clamp-to-edge labelAt those face voxels read their own label across the face, were never boundary-
// seeded, and got a deep-interior distance → an open/degenerate SDF at the border that rendered as
// black speckles (user report: bone at the top of the body, and other segs touching the volume edge).
// Ground truth at the SDF level (the render metric wasn't sensitive to it):
//   deno run --unstable-webgpu --allow-read --allow-write render/test/border-speckle.ts
import { initDevice } from "../device.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { JfaSdfBaker } from "../sdf-bake.ts";

const gpu = await initDevice();
const n = 64, dims: [number, number, number] = [n, n, n];
const ijkToRAS = [1, 0, 0, -n / 2, 0, 1, 0, -n / 2, 0, 0, 1, -n / 2, 0, 0, 0, 1];
const lab = new Uint8Array(n * n * n);
// Solid cube in a corner: touches the x/y/z = 0 volume FACES and has interior faces at x/y/z = 40.
for (let z = 0; z < 40; z++) for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) lab[(z * n + y) * n + x] = 1;

const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
const baker = new JfaSdfBaker(gpu.device, seg.masterTexture(), dims, ijkToRAS, 0);   // no blur → exact seeded distances
const pal = new Float32Array(256 * 4); for (let i = 1; i < 256; i++) pal[i * 4 + 3] = 1;
baker.setPalette(pal); baker.setModePalette(new Float32Array(256 * 4));
seg.loadLabelmap(lab); baker.refine();
const d = await baker.readDistance();
const pad = baker.padVoxels(), P = n + 2 * pad;   // readDistance is on the padded grid
const at = (x: number, y: number, z: number) => Math.abs(d[((z + pad) * P + (y + pad)) * P + (x + pad)]);

// Voxels ON the volume boundary faces, inside the cube — must be a surface (|sdf|≈0), same as the
// interior faces. Sample across all three boundary faces + a couple interior-face references.
const boundary: [number, number, number][] = [[0, 20, 20], [0, 10, 30], [20, 0, 20], [30, 20, 0], [0, 0, 20], [5, 35, 0]];
const interior: [number, number, number][] = [[39, 20, 20], [20, 39, 20], [20, 20, 39]];
const bMax = Math.max(...boundary.map(([x, y, z]) => at(x, y, z)));
const iMax = Math.max(...interior.map(([x, y, z]) => at(x, y, z)));
console.log("boundary-face |sdf|: " + boundary.map(([x, y, z]) => `(${x},${y},${z})=${at(x, y, z).toFixed(1)}`).join(" "));
console.log("interior-face |sdf|: " + interior.map(([x, y, z]) => `(${x},${y},${z})=${at(x, y, z).toFixed(1)}`).join(" "));
const ok = bMax < 0.75 && iMax < 0.75;   // both are 1-voxel-thick surfaces; clamp gave boundary |sdf| up to ~29
console.log(`boundary max |sdf|=${bMax.toFixed(2)}  interior max |sdf|=${iMax.toFixed(2)}`);
console.log(ok ? "PASS — segments touching the volume face are seeded as surfaces (closed cap, no border speckle)" : "FAIL — boundary faces not seeded → open SDF → speckle");
seg.destroy(); baker.destroy(); gpu.device.destroy();
if (!ok) Deno.exit(1);
