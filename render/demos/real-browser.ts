// Browser entry for the REAL-scene 4-up demo: loads a live SlicerLive scene
// (zarr volume streamed from the JS2 bucket, gunzipped in-browser) and renders
// three orthogonal MPR planes (real windowed grayscale) + a 3D volume-render —
// all with the SAME TS/WebGPU code the headless Deno tests run. Bundled to
// live/webgpu/real.js. Scroll a slice to scrub; drag the 3D view to orbit, wheel to zoom.
import { initDevice } from "../device.ts";
import { buildRealScene } from "./real-scene.ts";
import { slicerDefaultOffset01 } from "../slice-renderer.ts";
import { orbitEye } from "./sphere-scene.ts";
import type { Vec3 } from "../mat4.ts";
import { installIntrospection } from "../introspect.ts";

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
  // Slicer parity: slices default to the snapped voxel-centre plane, not the bbox centre.
  const [rasLo0, rasHi0] = rs.sv.field.aabb();
  const off: Record<string, number> = {
    axial: slicerDefaultOffset01("axial", rs.sv.dims, rs.sv.ijkToRAS, rasLo0, rasHi0),
    coronal: slicerDefaultOffset01("coronal", rs.sv.dims, rs.sv.ijkToRAS, rasLo0, rasHi0),
    sagittal: slicerDefaultOffset01("sagittal", rs.sv.dims, rs.sv.ijkToRAS, rasLo0, rasHi0),
  };

  const { radius } = rs.sv;
  // Slicer's DEFAULT 3D camera (vtkMRMLCameraNode): position (0,500,0), focalPoint at the
  // RAS ORIGIN (not the volume centre), viewUp +S, viewAngle 30. Slicer does not refit the
  // camera when a volume is loaded, so parity means adopting the same fixed default.
  const center: Vec3 = [0, 0, 0];
  const FOVY = 30;
  let az = Math.PI, elev = 0, dist = 500;
  const eyeAt = (): Vec3 => {
    const o = orbitEye(az, elev, dist);
    return [center[0] + o[0], center[1] + o[1], center[2] + o[2]];
  };

  const drawPlane = (p: { cell: "axial" | "coronal" | "sagittal"; orient: "axial" | "coronal" | "sagittal" }) => {
    rs.slice.setPlane(p.orient, off[p.cell]);
    rs.slice.renderToView(cx[p.cell].getCurrentTexture().createView({ format: srgb }), cv[p.cell].width, cv[p.cell].height);
  };
  const draw3d = () => {
    rs.scene.setCamera(eyeAt(), center, [0, 0, 1], FOVY, cv.threeD.width, cv.threeD.height);
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
  cv.threeD.addEventListener("wheel", (e) => { e.preventDefault(); dist = Math.max(50, Math.min(3000, dist * (e.deltaY > 0 ? 1.08 : 0.93))); draw3d(); }, { passive: false });

  // --- automation/introspection hook for the Slicer A/B harness ----------------
  const [rasLo, rasHi] = rs.sv.field.aabb();
  const hook = installIntrospection({
    getCamera: () => ({
      azimuth: az, elevation: elev, distance: dist,
      position: eyeAt(), focalPoint: [...center] as Vec3, viewUp: [0, 0, 1], viewAngle: FOVY,
    }),
    setCamera: (p) => {
      if (p.azimuth !== undefined) az = p.azimuth;
      if (p.elevation !== undefined) elev = p.elevation;
      if (p.distance !== undefined) dist = p.distance;
      draw3d();
    },
    getPlanes: () => {
      const out: Record<string, { orient: string; offset01: number; offsetMm: number; spanMm: number }> = {};
      const nAxis: Record<string, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 };
      for (const p of planes) {
        const a = nAxis[p.orient];
        out[p.cell] = { orient: p.orient, offset01: off[p.cell], offsetMm: rasLo[a] + off[p.cell] * (rasHi[a] - rasLo[a]), spanMm: rs.slice.spanMmFor(p.orient) };
      }
      return out;
    },
    setPlane: (cell, offset01) => {
      off[cell] = Math.max(0, Math.min(1, offset01));
      const p = planes.find((q) => q.cell === cell);
      if (p) drawPlane(p);
    },
    getVolume: () => ({
      name: rs.sv.name, dims: rs.sv.dims, ijkToRAS: rs.sv.ijkToRAS,
      rasLo, rasHi, window: rs.sv.win, level: rs.sv.lev,
    }),
    viewToVoxel: (cell, u, v) => {
      const p = planes.find((q) => q.cell === cell);
      if (!p) throw new Error("unknown cell " + cell);
      rs.slice.setPlane(p.orient, off[cell]);
      const t = rs.slice.viewToTex(u, v);
      const [X, Y, Z] = rs.sv.dims;
      return [
        Math.max(0, Math.min(X - 1, Math.round(t[0] * X - 0.5))),
        Math.max(0, Math.min(Y - 1, Math.round(t[1] * Y - 0.5))),
        Math.max(0, Math.min(Z - 1, Math.round(t[2] * Z - 0.5))),
      ];
    },
    render: () => drawAll(),
  });
  // log every interaction so the harness can prove WHICH binding fired
  for (const p of planes) {
    cv[p.cell].addEventListener("wheel", (e) => hook.logEvent("wheel", { cell: p.cell, deltaY: e.deltaY, offset01: off[p.cell] }), { passive: true });
    cv[p.cell].addEventListener("pointerdown", (e) => hook.logEvent("pointerdown", { cell: p.cell, x: e.offsetX, y: e.offsetY, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey }));
  }
  cv.threeD.addEventListener("pointerdown", (e) => hook.logEvent("pointerdown", { cell: "threeD", x: e.offsetX, y: e.offsetY, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey }));
  cv.threeD.addEventListener("wheel", (e) => hook.logEvent("wheel", { cell: "threeD", deltaY: e.deltaY, distance: dist }), { passive: true });

  resize();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
