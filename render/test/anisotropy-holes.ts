// Thick-slice anisotropy → holes in slice-parallel (z-facing) surfaces: a near-horizontal surface
// falls BETWEEN two far-apart z-slices, and the SDF shell band can't bridge the gap, so the top of a
// structure renders as a ring with an empty centre when viewed down the slice axis. resampleIsotropic
// (algorithms/geom) upsamples the slice axis toward isotropic → the surface is sampled → the hole fills.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/anisotropy-holes.ts
import { initDevice } from "../device.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { resampleIsotropic } from "../../algorithms/geom.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { VtkCamera } from "../vtk-camera.ts";

const W = 400, H = 400;
const gpu = await initDevice();
const nx = 80, ny = 80, nz = 26, dims: [number, number, number] = [nx, ny, nz];
const sxy = 1.0, sz = 3.4;                                   // thick z slices (chest-CT-like)
const ijkToRAS = [sxy, 0, 0, -sxy * nx / 2, 0, sxy, 0, -sxy * ny / 2, 0, 0, sz, -sz * nz / 2, 0, 0, 0, 1];
const lab = new Uint8Array(nx * ny * nz);
const cx = nx / 2, cy = ny / 2, cz = nz / 2, rx = 30, ry = 24, rz = 9;
for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
  if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1) lab[(z * ny + y) * nx + x] = 1;
}

// Look straight DOWN the slice axis (-Z) at the top surface; measure how filled the CENTRE is.
const topCentreFill = async (iso: boolean) => {
  const g = iso ? resampleIsotropic(lab, dims, ijkToRAS, 200) : { lab, dims, ijkToRAS };
  const seg = new EditableSegmentation(gpu.device, g.dims, { ijkToRAS: g.ijkToRAS });
  const logic = new SegmentationLogic(gpu.device, seg, { renderMode: "sdf", boundaryMode: "all" });
  logic.setLabelColor(1, [0.85, 0.4, 0.5]); logic.setLabelOpacity(1, 1.0);
  seg.loadLabelmap(g.lab as Uint8Array); logic.refineNow();
  const scene = new SceneRenderer(gpu, undefined);
  scene.build([logic.field()]); scene.setBackground(0.02, 0.02, 0.03);
  const cam = new VtkCamera([0, 0, 200], [0, 0, 0], [0, 1, 0], 30);
  scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, W, H);
  const rgba = await scene.renderToRGBA(W, H);
  let lit = 0, tot = 0;                                       // central 60×60 patch = the middle of the top surface
  for (let y = H / 2 - 30; y < H / 2 + 30; y++) for (let x = W / 2 - 30; x < W / 2 + 30; x++, tot++) {
    if (Math.max(rgba[(y * W + x) * 4], rgba[(y * W + x) * 4 + 1], rgba[(y * W + x) * 4 + 2]) >= 40) lit++;
  }
  seg.destroy(); logic.destroy();
  return lit / tot;
};

const raw = await topCentreFill(false);
const iso = await topCentreFill(true);
console.log(`top-surface centre fill — anisotropic=${(raw * 100).toFixed(0)}%  isotropic-resampled=${(iso * 100).toFixed(0)}%`);
const ok = raw < 0.35 && iso > 0.9;   // aniso = ring with a hole; iso = solid top
console.log(ok ? "PASS — isotropic resample fills the slice-parallel-surface hole from thick-slice anisotropy" : "FAIL");
gpu.device.destroy();
if (!ok) Deno.exit(1);
