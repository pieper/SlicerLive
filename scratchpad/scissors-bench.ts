import { initDevice } from "../render/device.ts";
import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { ScissorsEffect } from "../algorithms/effects/scissors.ts";
import type { Vec3 } from "../algorithms/geom.ts";
const gpu = await initDevice();
for (const n of [128, 192, 256]) {
  const dims: Vec3 = [n,n,n];
  const ijk = [1,0,0,-n/2, 0,1,0,-n/2, 0,0,1,-n/2, 0,0,0,1];
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS: ijk });
  const sc = new ScissorsEffect(seg);
  const h = n*0.25;
  const square: Vec3[] = [[-h,-h,0],[h,-h,0],[h,h,0],[-h,h,0]];
  sc.apply(square, { u:[1,0,0], v:[0,1,0], operation:"fillInside", id:1 }); // warm
  await gpu.device.queue.onSubmittedWorkDone();
  const t0 = performance.now();
  sc.apply(square, { u:[1,0,0], v:[0,1,0], operation:"eraseInside" });
  await gpu.device.queue.onSubmittedWorkDone();
  console.log(`${n}³: WebGPU scissors dispatch ${(performance.now()-t0).toFixed(2)}ms`);
  seg.destroy(); sc.destroy();
}
gpu.device.destroy();
