// Browser entry for the SlicerWGPU selftest ports, on the REAL datasets the selftests
// load. One bundle serves all four via ?demo= so the pages stay in lockstep:
//
//   ?demo=single    Single Volume        — CTACardio
//   ?demo=fiducials Volume + Fiducials   — CTACardio + 4 markup lists x 25 points
//   ?demo=multi     Multi-Volume         — CTACardio + CTAAbdomenPanoramix (+200mm R)
//   ?demo=seg       Segmentation         — MRHead thresholds -> ColorizeVolume
//
// Camera + interaction use the faithful Slicer bindings (vtkMRMLCameraWidget).
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import type { Field } from "../fields.ts";
import { VtkCamera } from "../vtk-camera.ts";
import { CameraInteractor } from "../vtk-interactor.ts";
import { installIntrospection } from "../introspect.ts";
import { loadSceneVolumeField } from "../scene-volume.ts";
import { buildMultiVolume, buildSegmentation, buildVolumeAndFiducials, SCENES } from "./selftest-scenes.ts";
import type { Vec3 } from "../mat4.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};

async function main() {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement;
  const params = new URLSearchParams(location.search);
  const which = params.get("demo") ?? "single";
  if (params.get("base")) {                       // local iteration
    const b = params.get("base")!;
    SCENES.CTACardio = `${b}/scenes/CTACardio.json`;
    SCENES.Panoramix = `${b}/scenes/CTAAbdomenPanoramix.json`;
    SCENES.MRHead = `${b}/legacy/scenes/MRHead.json`;
  }
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }

  status("initializing WebGPU…");
  const gpu = await initDevice();
  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });

  let mb = 0;
  const prog = (n: number) => { mb += n; status(`streaming data… ${(mb / 1e6).toFixed(1)} MB`); };

  let fields: Field[] = [], center: Vec3 = [0, 0, 0], radius = 200, label = "";
  status("streaming data…");
  if (which === "fiducials") {
    const sc = await buildVolumeAndFiducials(gpu.device, prog);
    fields = [sc.image, ...sc.lists];
    center = sc.sv.center; radius = sc.sv.radius;
    label = `${sc.sv.name} + ${sc.lists.length} markup lists × 25 points`;
  } else if (which === "multi") {
    const sc = await buildMultiVolume(gpu.device, prog);
    fields = sc.fields;
    center = [
      (sc.cta.center[0] + sc.pano.center[0]) / 2,
      (sc.cta.center[1] + sc.pano.center[1]) / 2,
      (sc.cta.center[2] + sc.pano.center[2]) / 2,
    ];
    radius = Math.max(sc.cta.radius, sc.pano.radius) * 1.35;
    label = `${sc.cta.name} + ${sc.pano.name} (+200 mm R)`;
  } else if (which === "seg") {
    const sc = await buildSegmentation(gpu.device, prog);
    fields = [sc.field3d];
    center = sc.sv.center; radius = sc.sv.radius;
    label = `${sc.sv.name} · Brain ${sc.counts[0].toLocaleString()} + High ${sc.counts[1].toLocaleString()} voxels`;
  } else {
    const sv = await loadSceneVolumeField(gpu.device, SCENES.CTACardio, prog);
    fields = [sv.field];
    center = sv.center; radius = sv.radius;
    label = `${sv.name} ${sv.dims.join("×")}`;
  }

  const scene = new SceneRenderer(gpu, srgb);
  scene.build(fields);
  scene.setBackground(0.05, 0.06, 0.09);

  // Slicer-faithful camera: framed on the data, then driven by vtkMRMLCameraWidget bindings.
  const camera = new VtkCamera(
    [center[0], center[1] + radius * 2.6, center[2]] as Vec3,
    [...center] as Vec3, [0, 0, 1], 30,
  );
  const interactor = new CameraInteractor(camera, () => draw());

  const draw = () => {
    const w = canvas.width, h = canvas.height;
    scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h);
    const t0 = performance.now();
    scene.renderToView(ctx.getCurrentTexture().createView({ format: srgb }), w, h);
    status(`${label} · ${(performance.now() - t0).toFixed(0)} ms/frame · drag=rotate · shift/middle=pan · right=zoom`);
  };
  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const size = Math.min(760, Math.floor(canvas.clientWidth * dpr));
    canvas.width = size; canvas.height = size; draw();
  };
  globalThis.addEventListener("resize", resize);

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  const local = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener("pointerdown", (e) => {
    const { x, y } = local(e);
    interactor.start(e.button as 0 | 1 | 2, x, y, canvas.clientHeight, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointerup", (e) => { interactor.end(); canvas.releasePointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (interactor.action === "none") return;
    const { x, y } = local(e);
    interactor.move(x, y, canvas.clientWidth, canvas.clientHeight);
  });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); interactor.wheel(e.deltaY < 0); }, { passive: false });

  installIntrospection({
    getCamera: () => ({
      azimuth: 0, elevation: 0, distance: camera.distance,
      position: [...camera.position] as Vec3, focalPoint: [...camera.focalPoint] as Vec3,
      viewUp: [...camera.viewUp] as Vec3, viewAngle: camera.viewAngle,
    }),
    setCamera: (p) => {
      if (p.position) camera.position = [...p.position] as Vec3;
      if (p.focalPoint) camera.focalPoint = [...p.focalPoint] as Vec3;
      if (p.viewUp) camera.viewUp = [...p.viewUp] as Vec3;
      draw();
    },
    extra: () => ({ demo: which, label }),
    render: () => draw(),
  });
  resize();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
