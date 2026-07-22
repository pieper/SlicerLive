// Browser entry for the 4-up gallery demo: 3 MPR slice views (grayscale CT +
// colored seg overlay) + a 3D ColorizeVolume view — the WebGPU replacement for the
// vtk.js 4-up. Scroll a slice to scrub; drag the 3D view to orbit. Bundled to
// live/webgpu/fourup.js.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { buildFourUpScene } from "./fourup-scene.ts";
import { orbitEye } from "./sphere-scene.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};
const el = (id: string) => document.getElementById(id) as HTMLCanvasElement;

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
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

  status("baking segmentation…");
  const sc = buildFourUpScene(gpu.device);
  const scene = new SceneRenderer(gpu, srgb);
  scene.build([sc.field3d]);
  scene.setBackground(0.05, 0.06, 0.09);
  const slice = new SliceRenderer(gpu, srgb);
  slice.setTextures(sc.scalarTex, sc.colorizeTex);
  slice.setWindowLevel(sc.win, sc.lev);
  slice.setOverlayOpacity(0.6);

  const off = { axial: 0.5, coronal: 0.5, sagittal: 0.55 };
  const axisOf: Record<string, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 };
  let az = 0.5, elev = 0.3, dist = 430;

  const drawSlice = (n: "axial" | "coronal" | "sagittal") => {
    slice.setSlice(axisOf[n], off[n]);
    slice.renderToView(cx[n].getCurrentTexture().createView({ format: srgb }), cv[n].width, cv[n].height);
  };
  const draw3d = () => {
    scene.setCamera(orbitEye(az, elev, dist), [0, 0, 0], [0, 0, 1], 28, cv.threeD.width, cv.threeD.height);
    scene.renderToView(cx.threeD.getCurrentTexture().createView({ format: srgb }), cv.threeD.width, cv.threeD.height);
  };
  const drawAll = () => { drawSlice("axial"); drawSlice("coronal"); drawSlice("sagittal"); draw3d(); status("4-up · 3 MPR + 3D ColorizeVolume · scroll a slice to scrub, drag 3D to orbit"); };

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const n of names) { const s = Math.floor(cv[n].clientWidth * dpr); cv[n].width = s; cv[n].height = s; }
    drawAll();
  };
  globalThis.addEventListener("resize", resize);

  for (const n of ["axial", "coronal", "sagittal"] as const) {
    cv[n].addEventListener("wheel", (e) => { e.preventDefault(); off[n] = Math.max(0, Math.min(1, off[n] + (e.deltaY > 0 ? 0.02 : -0.02))); drawSlice(n); }, { passive: false });
  }
  let dragging = false, lx = 0, ly = 0;
  cv.threeD.addEventListener("pointerdown", (e) => { dragging = true; lx = e.clientX; ly = e.clientY; cv.threeD.setPointerCapture(e.pointerId); });
  cv.threeD.addEventListener("pointerup", (e) => { dragging = false; cv.threeD.releasePointerCapture(e.pointerId); });
  cv.threeD.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    az += (e.clientX - lx) * 0.008; elev = Math.max(-1.4, Math.min(1.4, elev - (e.clientY - ly) * 0.008));
    lx = e.clientX; ly = e.clientY; draw3d();
  });
  cv.threeD.addEventListener("wheel", (e) => { e.preventDefault(); dist = Math.max(200, Math.min(1100, dist * (e.deltaY > 0 ? 1.08 : 0.93))); draw3d(); }, { passive: false });

  resize();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
