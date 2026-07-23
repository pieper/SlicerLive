import { VtkCamera } from "../render/vtk-camera.ts";
import { CameraInteractor, actionForButton } from "../render/vtk-interactor.ts";
import type { Vec3 } from "../render/mat4.ts";
const t = JSON.parse(await Deno.readTextFile("/tmp/slicer-actions-truth.json"));
const [W,H] = t.viewSize; const [x0,y0] = t.origin;
const BTN: Record<string, 0|1|2> = { left:0, middle:1, right:2 };
const cmp = (l:string,a:number[],b:number[],tol:number)=>{const d=Math.max(...a.map((v,i)=>Math.abs(v-b[i])));
  console.log(`  ${d<=tol?"OK ":"XX "} ${l.padEnd(11)} slicer=[${a.map(v=>v.toFixed(4)).join(", ")}] ts=[${b.map(v=>v.toFixed(4)).join(", ")}] d=${d.toExponential(2)}`); return d<=tol;};
let all = true;
for (const [name, c] of Object.entries<any>(t.cases)) {
  const cam = new VtkCamera(c.before.position as Vec3, c.before.focalPoint as Vec3, c.before.viewUp as Vec3, 30);
  const it = new CameraInteractor(cam);
  const cssY0 = H - y0;
  if (name === "wheel_forward") { it.wheel(true); }
  else {
    const mods = { shift: !!c.shift, ctrl: !!c.ctrl };
    console.log(`\n${name}: button=${c.button} shift=${!!c.shift} -> action="${actionForButton(BTN[c.button], mods)}"`);
    it.start(BTN[c.button], x0, cssY0, H, mods);
    it.move(x0 + c.dx, cssY0 - c.dy, W, H);
  }
  if (name === "wheel_forward") console.log(`\n${name}:`);
  all = cmp("position", c.after.position, cam.position as unknown as number[], 1e-4) && all;
  all = cmp("focalPoint", c.after.focalPoint, cam.focalPoint as unknown as number[], 1e-4) && all;
}
console.log(`\n${all ? "ALL ACTIONS MATCH" : "SOME ACTIONS DIFFER"}\n`);
