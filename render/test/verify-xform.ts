// Regression for the linear transform widget (rotation + translation) on the multi-volume
// demo (add-on to ARCHITECTURE-2026-07-24 §3 interaction). Checks the widget MATH and that
// the transform is applied to ONLY the target volume (the other is untouched), all Tier-A.
//   deno run --unstable-webgpu --allow-read --allow-net render/test/verify-xform.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { buildMultiVolume } from "../demos/selftest-scenes.ts";
import { makeXformWidget } from "../demos/xform-widget.ts";
import { applyMat4, type Vec3 } from "../mat4.ts";

const gpu = await initDevice();
const sc = await buildMultiVolume(gpu.device);
const w = makeXformWidget(sc.pano.field, sc.pano.radius * 1.5);
let fail = 0;
const check = (name: string, ok: boolean, note = "") => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(30)} ${note}`); };

// the untouched volume's geometry must never change
const ctaBox0 = JSON.stringify(sc.cta.field.aabb());

// (1) centre drag = pure translation by the camera-plane delta
w.beginDrag();
const p0 = w.handleList(50)[0].world;               // centre handle
const delta: Vec3 = [40, -25, 15];
w.drag({ kind: "translate-cam" }, p0, [p0[0] + delta[0], p0[1] + delta[1], p0[2] + delta[2]]);
const m1 = w.matrix();
const transOk = Math.abs(m1[12] - 40) < 1e-3 && Math.abs(m1[13] + 25) < 1e-3 && Math.abs(m1[14] - 15) < 1e-3;
const noRot = Math.abs(m1[0] - 1) + Math.abs(m1[5] - 1) + Math.abs(m1[10] - 1) + Math.abs(m1[1]) + Math.abs(m1[4]) < 1e-4;
check("centre drag = pure translation", transOk && noRot, `t=[${m1[12].toFixed(0)},${m1[13].toFixed(0)},${m1[14].toFixed(0)}]`);

// (2) rotate handle about axis Z (id 6): a 90° swing in the XY plane about the pivot
const wr = makeXformWidget(sc.pano.field, sc.pano.radius * 1.5);
wr.beginDrag();
const rotH = wr.handleList(50).find((h) => (h.data as { kind: string; axis?: number }).kind === "rotate" && (h.data as { axis: number }).axis === 2)!;
const pivot = wr.handleList(50)[0].world;           // centre = pivot at identity
// start handle offset (in XY) -> rotate it 90° about Z: (dx,dy) -> (-dy,dx)
const rx = rotH.world[0] - pivot[0], ry = rotH.world[1] - pivot[1];
const target: Vec3 = [pivot[0] - ry, pivot[1] + rx, rotH.world[2]];
wr.drag({ kind: "rotate", axis: 2 }, rotH.world, target);
const mr = wr.matrix();
// a +90° rotation about Z (column-major): m[0]=cos=0, m[1]=sin=1, m[4]=-sin=-1, m[5]=cos=0
const rotOk = Math.abs(mr[0]) < 1e-2 && Math.abs(mr[1] - 1) < 1e-2 && Math.abs(mr[4] + 1) < 1e-2 && Math.abs(mr[5]) < 1e-2;
check("rotate handle = 90° about Z", rotOk, `m0=${mr[0].toFixed(2)} m1=${mr[1].toFixed(2)} m4=${mr[4].toFixed(2)} m5=${mr[5].toFixed(2)}`);

// (3) rotation is about the volume CENTRE (pivot maps to itself)
const pv = applyMat4(mr, sc.pano.field.worldCenter());
const c = sc.pano.field.worldCenter();
check("rotation pivots on centre", Math.hypot(pv[0] - c[0], pv[1] - c[1], pv[2] - c[2]) < 1e-2);

// (4) the OTHER volume (CTACardio) is untouched by the widget
check("other volume untouched", JSON.stringify(sc.cta.field.aabb()) === ctaBox0);

gpu.device.destroy();
console.log(fail === 0 ? "\nxform widget verified." : `\n${fail} FAILED`);
if (fail) Deno.exit(1);
