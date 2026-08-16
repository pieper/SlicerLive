// Live sequence: build the scene with an EMPTY seg field, render, THEN paint + re-render WITHOUT
// rebuilding the scene (what seged does: setField once, then redraw on edit). Does content appear?
import { initDevice } from "../render/device.ts";
import { SceneRenderer } from "../render/scene-renderer.ts";
import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { SegEditDriver } from "../algorithms/seg-edit-driver.ts";
import { SegmentationLogic } from "../logic/segmentation-logic.ts";
import type { Vec3 } from "../algorithms/geom.ts";

const gpu = await initDevice();
const dims: Vec3 = [96,96,96], sp = 2;
const ijk = [sp,0,0,-96, 0,sp,0,-96, 0,0,sp,-96, 0,0,0,1];
const paint = (rgba: Uint8Array) => { let n=0; for (let i=0;i<480*480;i++) if (Math.max(rgba[i*4],rgba[i*4+1],rgba[i*4+2])>45) n++; return n; };

const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS: ijk });
seg.loadLabelmap(new Uint8Array(dims[0]*dims[1]*dims[2]));   // EMPTY
const logic = new SegmentationLogic(gpu.device, seg, { renderMode:"sdf", boundaryMode:"all", opacity:1, color:[0.3,0.85,0.55] });
const driver = new SegEditDriver(seg, { labelForSegment: () => 1 });
const scene = new SceneRenderer(gpu);
scene.build([logic.field()]);                                 // BUILD WHILE EMPTY (like seged)
scene.setBackground(0.05,0.06,0.09);
scene.setCamera([90,-430,150],[0,0,0],[0,0,1],30,480,480);
console.log(`empty build: ${paint(await scene.renderToRGBA(480,480))} px`);

await driver.applyEdit({ event:"SegEdit", sourceId:"s", edit:{ kind:"stroke", segmentId:"S1", effect:"Paint", points:[[-30,0,0],[30,0,0]], brush:{shape:"sphere",diameterMm:16}, mode:"add" }});
logic.refineNow();
console.log(`after paint, NO rebuild (renderToRGBA): ${paint(await scene.renderToRGBA(480,480))} px`);
scene.build([logic.field()]);                                 // rebuild
console.log(`after paint, WITH rebuild: ${paint(await scene.renderToRGBA(480,480))} px`);
gpu.device.destroy();
