// Scissors: a square contour on the axial (u=R, v=A) plane extruded through the volume. fillInside → a
// rectangular prism (square × all slices); then eraseInside a smaller square → a through-hole.
//   deno run --unstable-webgpu --allow-read algorithms/test/scissors.ts
import { initDevice } from "../../render/device.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { ScissorsEffect } from "../effects/scissors.ts";
import type { Vec3 } from "../geom.ts";

const gpu = await initDevice();
const n = 64, dims: Vec3 = [n, n, n];
const ijk = [1, 0, 0, -n / 2, 0, 1, 0, -n / 2, 0, 0, 1, -n / 2, 0, 0, 0, 1];   // 1mm, centred → RAS (x,y,z) = ijk - 32
const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS: ijk });
const sc = new ScissorsEffect(seg);
const uX: Vec3 = [1, 0, 0], vY: Vec3 = [0, 1, 0];   // axial view basis
const square = (h: number): Vec3[] => [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0]];

// fillInside a 30×30 square (RAS |x|,|y| < 15) extruded through all 64 z.
sc.apply(square(15), { u: uX, v: vY, operation: "fillInside", id: 1 });
let out = await seg.readLabelmap();
let fill = 0; for (let i = 0; i < out.length; i++) if (out[i] === 1) fill++;
const expectFill = 30 * 30 * 64;   // |x|<15 → x∈[-15,14]→30 cols, same y, all 64 z
const t0 = performance.now();
// eraseInside a 10×10 square → punch a through-hole in the prism.
sc.apply(square(5), { u: uX, v: vY, operation: "eraseInside" });
await gpu.device.queue.onSubmittedWorkDone();
const ms = performance.now() - t0;
out = await seg.readLabelmap();
let after = 0; for (let i = 0; i < out.length; i++) if (out[i] === 1) after++;
const hole = 10 * 10 * 64;

console.log(`fillInside 30² prism: ${fill} voxels (expect ~${expectFill})`);
console.log(`eraseInside 10² hole: removed ${fill - after} (expect ~${hole})  scissors dispatch ${ms.toFixed(1)}ms @${n}³`);
const near = (a: number, b: number) => Math.abs(a - b) / b < 0.05;
const ok = near(fill, expectFill) && near(fill - after, hole);
console.log(ok ? "PASS — scissors fills/erases the extruded contour region" : "FAIL");
seg.destroy(); sc.destroy(); gpu.device.destroy();
if (!ok) Deno.exit(1);
