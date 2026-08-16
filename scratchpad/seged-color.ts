import { initDevice } from "../render/device.ts";
import { SceneRenderer } from "../render/scene-renderer.ts";
import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { SegEditDriver } from "../algorithms/seg-edit-driver.ts";
import { SegmentationLogic } from "../logic/segmentation-logic.ts";
import type { Vec3 } from "../algorithms/geom.ts";

const gpu = await initDevice();
const dims: Vec3 = [96,96,96], sp=2;
const ijk=[sp,0,0,-96,0,sp,0,-96,0,0,sp,-96,0,0,0,1];
const COL: [number,number,number] = [0.90, 0.55, 0.30];   // a distinctive tan (like a default Slicer segment)
for (const mode of ["outer","all"] as const) {
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS: ijk });
  seg.loadLabelmap(new Uint8Array(dims[0]*dims[1]*dims[2]));
  const logic = new SegmentationLogic(gpu.device, seg, { renderMode:"sdf", boundaryMode:mode, color:COL, opacity:1 });
  const driver = new SegEditDriver(seg, { labelForSegment: () => 1 });
  await driver.applyEdit({ event:"SegEdit", sourceId:"s", edit:{ kind:"stroke", segmentId:"S1", effect:"Paint", points:[[-30,0,0],[30,0,0]], brush:{shape:"sphere",diameterMm:20}, mode:"add" }});
  logic.refineNow();
  const scene = new SceneRenderer(gpu);
  scene.build([logic.field()]);
  scene.setBackground(0.0,0.0,0.0);
  scene.setCamera([90,-430,150],[0,0,0],[0,0,1],30,480,480);
  const rgba = await scene.renderToRGBA(480,480);
  // mean color over lit (non-background) pixels
  let r=0,g=0,b=0,n=0; for (let i=0;i<480*480;i++){const R=rgba[i*4],G=rgba[i*4+1],B=rgba[i*4+2]; if (Math.max(R,G,B)>30){r+=R;g+=G;b+=B;n++;}}
  const mean = n? [Math.round(r/n),Math.round(g/n),Math.round(b/n)] : [0,0,0];
  // hue ratio to compare independent of brightness
  const ratio = (mean as number[]).map(x=>+(x/Math.max(...mean as number[])).toFixed(2));
  console.log(`${mode}: mean lit RGB=${JSON.stringify(mean)} ratio=${JSON.stringify(ratio)}  (input hue ratio=${JSON.stringify(COL.map(x=>+(x/Math.max(...COL)).toFixed(2)))})`);
  seg.destroy(); logic.destroy(); driver.destroy();
}
gpu.device.destroy();
