// Reproduce seged's 3D path: build an EditableSegmentation from ZEROS, paint one stroke via SegEditDriver,
// render the SegmentationLogic field. Compare boundaryMode "all" (seged's current) vs "outer".
import { initDevice } from "../render/device.ts";
import { SceneRenderer } from "../render/scene-renderer.ts";
import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { SegEditDriver } from "../algorithms/seg-edit-driver.ts";
import { SegmentationLogic } from "../logic/segmentation-logic.ts";
import type { Vec3 } from "../algorithms/geom.ts";

const gpu = await initDevice();
const dims: Vec3 = [96, 96, 96];
const sp = 2;
const ijk = [sp,0,0,-96, 0,sp,0,-96, 0,0,sp,-96, 0,0,0,1];
const countPainted = (rgba: Uint8Array, w: number, h: number) => { let n=0; for (let i=0;i<w*h;i++) if (Math.max(rgba[i*4],rgba[i*4+1],rgba[i*4+2])>45) n++; return n; };

for (const mode of ["outer","all"] as const) {
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS: ijk });
  seg.loadLabelmap(new Uint8Array(dims[0]*dims[1]*dims[2]));   // ZEROS (empty start, like seged)
  const logic = new SegmentationLogic(gpu.device, seg, { renderMode:"sdf", boundaryMode: mode, color:[0.3,0.85,0.55], opacity:1 });
  const driver = new SegEditDriver(seg, { labelForSegment: () => 1 });
  // one committed stroke, sphere brush 12mm, through the centre
  await driver.applyEdit({ event:"SegEdit", sourceId:"s", edit:{ kind:"stroke", segmentId:"S1", effect:"Paint", points:[[-30,0,0],[30,0,0]], brush:{shape:"sphere",diameterMm:16}, mode:"add" }});
  logic.refineNow();
  const scene = new SceneRenderer(gpu);
  scene.build([logic.field()]);
  scene.setBackground(0.05,0.06,0.09);
  scene.setCamera([90,-430,150],[0,0,0],[0,0,1],30,480,480);
  const px = countPainted(await scene.renderToRGBA(480,480), 480, 480);
  const lab = await seg.readLabelmap(); let vox=0; for (const v of lab) if (v) vox++;
  console.log(`boundaryMode="${mode}": painted voxels=${vox}, rendered pixels=${px}`);
  seg.destroy(); logic.destroy(); driver.destroy();
}
gpu.device.destroy();
