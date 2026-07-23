// Browser entry for the REAL-scene 4-up demo: loads a live SlicerLive scene
// (zarr volume streamed from the JS2 bucket, gunzipped in-browser) and renders
// three orthogonal MPR planes (real windowed grayscale) + a 3D volume-render —
// all with the SAME TS/WebGPU code the headless Deno tests run. Bundled to
// live/webgpu/real.js. Scroll a slice to scrub; drag the 3D view to orbit, wheel to zoom.
import { initDevice } from "../device.ts";
import { buildRealScene } from "./real-scene.ts";
import { orbitEye } from "./sphere-scene.ts";
import type { Vec3 } from "../mat4.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};
const el = (id: string) => document.getElementById(id) as HTMLCanvasElement;

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  const sceneUrl = new URLSearchParams(location.search).get("scene") ??
    "https://pieper.github.io/live/legacy/scenes/MRHead.json";

  status("initializing WebGPU…");
  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;

  const names = ["axial", "coronal", "sagittal", "threeD"] as const;
  const cv: Record<string, HTMLCanvasElement> = {}, cx: Record<string, GPUCanvasContext> = {};
  for (const n of names) {
    cv[n] = el("c-" + n);
    cx[n] = cv[n].getContext("webgpu") as GPUCanvasContext;
    cx[n].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  }

  let mb = 0;
  status("streaming volume from the bucket…");
  const rs = await buildRealScene(gpu, sceneUrl, srgb, (n) => { mb += n; status(`streaming volume… ${(mb / 1e6).toFixed(1)} MB`); });

  // Each MPR canvas renders its own anatomical (RAS) plane — the reslice is
  // intrinsically anatomical, so no IJK-axis mapping is needed.
  const planes = [
    { cell: "axial", orient: "axial" },
    { cell: "coronal", orient: "coronal" },
    { cell: "sagittal", orient: "sagittal" },
  ] as const;
  const off: Record<string, number> = { axial: 0.5, coronal: 0.5, sagittal: 0.5 };

  const { center, radius } = rs.sv;
  let az = 0.6, elev = 0.25, dist = radius * 3.0;
  const eyeAt = (): Vec3 => {
    const o = orbitEye(az, elev, dist);
    return [center[0] + o[0], center[1] + o[1], center[2] + o[2]];
  };

  const drawPlane = (p: { cell: "axial" | "coronal" | "sagittal"; orient: "axial" | "coronal" | "sagittal" }) => {
    rs.slice.setPlane(p.orient, off[p.cell]);
    rs.slice.renderToView(cx[p.cell].getCurrentTexture().createView({ format: srgb }), cv[p.cell].width, cv[p.cell].height);
  };
  const draw3d = () => {
    rs.scene.setCamera(eyeAt(), center, [0, 0, 1], 26, cv.threeD.width, cv.threeD.height);
    rs.scene.renderToView(cx.threeD.getCurrentTexture().createView({ format: srgb }), cv.threeD.width, cv.threeD.height);
  };
  const drawAll = () => { for (const p of planes) drawPlane(p); draw3d(); status(`${rs.sv.name} · real ${rs.sv.dims.join("×")} volume · 3 MPR + 3D VR · scroll a slice, drag 3D to orbit`); };

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const n of names) { const s = Math.floor(cv[n].clientWidth * dpr); cv[n].width = s; cv[n].height = s; }
    drawAll();
  };
  globalThis.addEventListener("resize", resize);

  for (const p of planes) {
    cv[p.cell].addEventListener("wheel", (e) => { e.preventDefault(); off[p.cell] = Math.max(0, Math.min(1, off[p.cell] + (e.deltaY > 0 ? 0.02 : -0.02))); drawPlane(p); }, { passive: false });
  }
  let dragging = false, lx = 0, ly = 0;
  cv.threeD.addEventListener("pointerdown", (e) => { dragging = true; lx = e.clientX; ly = e.clientY; cv.threeD.setPointerCapture(e.pointerId); });
  cv.threeD.addEventListener("pointerup", (e) => { dragging = false; cv.threeD.releasePointerCapture(e.pointerId); });
  cv.threeD.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    az += (e.clientX - lx) * 0.008; elev = Math.max(-1.4, Math.min(1.4, elev - (e.clientY - ly) * 0.008));
    lx = e.clientX; ly = e.clientY; draw3d();
  });
  cv.threeD.addEventListener("wheel", (e) => { e.preventDefault(); dist = Math.max(radius * 1.2, Math.min(radius * 8, dist * (e.deltaY > 0 ? 1.08 : 0.93))); draw3d(); }, { passive: false });

  resize();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
