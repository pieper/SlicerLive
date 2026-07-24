// Regression for the ROI-crop feature (ARCHITECTURE-2026-07-24 §6.4):
//   1. setClipBox crops the volume (fewer lit px); clearClip restores byte-identical.
//   2. The RoiBoxField wireframe renders (yellow pixels present).
//   3. applyDrag on a face handle resizes the box; on the centre handle it translates it.
//   All updates are Tier-A (syncUniforms, no rebuild).
//   deno run --unstable-webgpu --allow-read --allow-net render/test/verify-roi-clip.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { buildRoiScene } from "../demos/roi-scene.ts";
import { framedCamera } from "../demos/camera-control.ts";
import type { Vec3 } from "../mat4.ts";

const Q = 360;
const gpu = await initDevice();
const roi = await buildRoiScene(gpu.device);
const scene = new SceneRenderer(gpu);
scene.build([roi.image, roi.box, roi.handles]);
scene.setBackground(0.05, 0.06, 0.09);
const cam = framedCamera(roi.sv.center as Vec3, roi.sv.radius, 2.8);
const render = async () => { scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, Q, Q); return await scene.renderToRGBA(Q, Q); };
const lit = (a: Uint8Array) => { let n = 0; for (let i = 0; i < Q * Q; i++) if (Math.max(a[i * 4], a[i * 4 + 1], a[i * 4 + 2]) > 110) n++; return n; };
const yellow = (a: Uint8Array) => { let n = 0; for (let i = 0; i < Q * Q; i++) { const R = a[i * 4], G = a[i * 4 + 1], B = a[i * 4 + 2]; if (R > 140 && G > 110 && B < 90 && Math.min(R, G) - B > 50) n++; } return n; };
const diff = (a: Uint8Array, b: Uint8Array) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
const vol = () => { const h = roi.snapshot().half; return 8 * h[0] * h[1] * h[2]; };
let fail = 0;
const check = (name: string, ok: boolean, note = "") => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(28)} ${note}`); };

// 1) clip crops, clears to byte-identical
scene.clearClip(); scene.syncUniforms();
const noClip = await render();
scene.setClipBox(roi.lo(), roi.hi()); scene.syncUniforms();
const clipped = await render();
check("box crops the volume", lit(clipped) < lit(noClip) * 0.9, `lit ${lit(clipped)} < ${lit(noClip)}`);
check("wireframe renders", yellow(clipped) > 150, `${yellow(clipped)} yellow px`);
scene.clearClip(); scene.syncUniforms();
check("clearClip byte-identical", diff(await render(), noClip) === 0);

// 2) face drag resizes; centre drag translates
scene.setClipBox(roi.lo(), roi.hi()); scene.syncUniforms();
const v0 = vol();
const box0 = roi.snapshot();
// shrink the +R face by pulling it 40mm inward (-x)
roi.applyDrag({ kind: "face", axis: 0, sign: 1 }, box0, [-40, 0, 0] as Vec3);
check("face drag shrinks box", vol() < v0, `vol ${(v0 / 1e3).toFixed(0)}k -> ${(vol() / 1e3).toFixed(0)}k`);

const c0 = roi.snapshot().center;
const box1 = roi.snapshot();
roi.applyDrag({ kind: "center" }, box1, [25, -15, 10] as Vec3);
const c1 = roi.snapshot().center;
const movedBy = Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]);
check("centre drag translates", Math.abs(movedBy - Math.hypot(25, 15, 10)) < 1e-3 && roi.snapshot().half[0] === box1.half[0], `moved ${movedBy.toFixed(1)}mm, half unchanged`);

gpu.device.destroy();
console.log(fail === 0 ? "\nROI clip verified." : `\n${fail} FAILED`);
if (fail) Deno.exit(1);
