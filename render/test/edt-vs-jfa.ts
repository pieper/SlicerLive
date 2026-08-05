// Is the exact EDT actually different from JFA+2 (i.e. worth a hard GPU port for image quality)?
// Compare RAW (unblurred) JFA+2 distance vs exact EDT distance on the same labelmap.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/edt-vs-jfa.ts
import { initDevice } from "../device.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { JfaSdfBaker } from "../sdf-bake.ts";
import { colorizedEdt } from "../edt-cpu.ts";

const gpu = await initDevice();
const nx = 96, ny = 96, nz = 96;
const dims: [number, number, number] = [nx, ny, nz];
const sp = 2;
const spacing: [number, number, number] = [sp, sp, sp];
const ijkToRAS = [sp, 0, 0, -96, 0, sp, 0, -96, 0, 0, sp, -96, 0, 0, 0, 1];
const labels = new Uint8Array(nx * ny * nz);
const put = (cx: number, cy: number, cz: number, r: number, id: number) => {
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    if (dx * dx + dy * dy + dz * dz <= r * r) labels[(z * ny + y) * nx + x] = id;
  }
};
put(38, 48, 48, 22, 1);
put(58, 48, 48, 20, 2);   // touches region 1 → the boundary that stresses the Voronoi partition
put(48, 24, 60, 12, 3);

// Exact EDT (signed distance).
const edt = colorizedEdt(labels, dims, spacing);

// RAW JFA+2 (smoothSigma 0 → no distance blur), signed distance read back.
const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
const baker = new JfaSdfBaker(gpu.device, seg.masterTexture(), dims, ijkToRAS, 0);
const pal = new Float32Array(256 * 4); for (let i = 1; i < 256; i++) pal[i * 4 + 3] = 1;
baker.setPalette(pal); baker.setModePalette(new Float32Array(256 * 4));
seg.loadLabelmap(labels);
baker.refine();   // JFA + 2 extra passes, no blur (smoothSigma 0)
const jfa = await baker.readDistance();

// DEBUG: sample a few near-surface voxels.
const idx = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
for (const [x, y, z] of [[16, 48, 48], [17, 48, 48], [38, 26, 48], [48, 48, 48], [38, 48, 48]] as [number, number, number][]) {
  const i = idx(x, y, z);
  console.log(`  voxel(${x},${y},${z}) label=${labels[i]} edt=${edt.signedDist[i].toFixed(2)} jfa=${jfa[i].toFixed(2)}`);
}

// Compare where it matters: within ±6 mm of a surface (the shell band region that's actually rendered).
let maxErr = 0, sumErr = 0, n = 0, over05vox = 0, over1vox = 0;
const voxMm = sp;
for (let i = 0; i < nx * ny * nz; i++) {
  if (Math.abs(edt.signedDist[i]) > 6) continue;
  const e = Math.abs(jfa[i] - edt.signedDist[i]);
  maxErr = Math.max(maxErr, e); sumErr += e; n++;
  if (e > 0.5 * voxMm) over05vox++;
  if (e > 1.0 * voxMm) over1vox++;
}
console.log(`near-surface voxels compared: ${n}`);
console.log(`JFA+2 vs exact-EDT signed distance:  max=${maxErr.toFixed(3)}mm  mean=${(sumErr / n).toFixed(4)}mm`);
console.log(`voxels differing > 0.5 voxel: ${over05vox} (${(100 * over05vox / n).toFixed(3)}%)   > 1 voxel: ${over1vox} (${(100 * over1vox / n).toFixed(3)}%)`);
console.log(over05vox / n < 0.01
  ? "→ JFA+2 ≈ exact EDT near surfaces (<1% differ by >½ voxel): exact EDT would NOT visibly improve the render."
  : "→ JFA+2 differs from exact EDT enough that an exact tier could visibly help.");
seg.destroy(); baker.destroy();
gpu.device.destroy();
