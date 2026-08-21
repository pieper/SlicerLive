// Remote-render client (M3/M4): the SAME scene rendered either LOCALLY (this browser's GPU) or
// REMOTELY (a Deno LiveRenderer over WebSocket) — a per-view RenderMode the user toggles. Remote
// sends the camera and RECONSTRUCTS the traced samples the server streams; local uses the shared
// mountAdaptive3d. Both share one camera and one gizmo, so switching modes is instant.
//
// LOCAL MODE OWES THE SERVER NOTHING: it builds the scene from the same public scene URLs the
// gallery demos use and renders through this browser's WebGPU. The server is only a source of
// remote frames, so the page still works when it is down, and `?local=1` never opens a socket at
// all. `?server=wss://host/` points the remote half at a renderer elsewhere (e.g. Modal) — which is
// what lets this page live in the static gallery instead of only being served by the renderer.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { loadSceneVolumeField } from "../scene-volume.ts";
import { Reconstructor } from "../reconstructor.ts";
import { mountAdaptive3d, type Adaptive3d } from "./accum-loop.ts";
import { attachCameraControls, framedCamera } from "./camera-control.ts";
import { attachWidgetControls, type Handle, projectToCanvasCss, unprojectToCameraPlane } from "./widget-control.ts";
import { componentOf, makeXformWidget, type XformTarget, type XformWidget, type XMeta } from "./xform-widget.ts";
import { buildMultiVolume } from "./selftest-scenes.ts";
import { Av1Presenter } from "../av1-presenter.ts";
import type { ImageField } from "../fields.ts";
import { identity, type Mat4, type Vec3 } from "../mat4.ts";
import type { VtkCamera } from "../vtk-camera.ts";

// The one-volume scene the server defaults to, so a standalone page can load it too.
const SINGLE_SCENE = "https://pieper.github.io/live/scenes/CTACardio.json";
// Must match the server's PROTO. On mismatch the client reloads once (cache-bypassing) instead of
// rendering garbage from a wire format it cannot parse.
const PROTO = 4;

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};

async function main() {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement;
  const params = new URLSearchParams(location.search);
  // Same-origin renderer by default (this page is usually served BY it); "" = never connect.
  // When this page is hosted STATICALLY (the live gallery), it loads instantly and connects out to
  // the Modal endpoint — so the cold start is the GPU spinning up, not the page. Served BY Modal it
  // is same-origin. Override with ?server=, or ?local=1 to never connect.
  const DEFAULT_REMOTE = "wss://pieper--slicerlive-live-renderer-live-renderer.modal.run/";
  const staticHost = !/\.modal\.run$/.test(location.host) && location.host !== "";
  const serverUrl = params.has("local")
    ? ""
    : params.get("server") ?? (staticHost && location.protocol === "https:" ? DEFAULT_REMOTE
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`);
  const modeBtn = document.getElementById("mode") as HTMLButtonElement | null;
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  const gpu = await initDevice();
  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  // COPY_DST: frames are reconstructed into our OWN view texture and copied here, so a PATCH can
  // repaint a rect of the last image instead of the whole view (a swapchain texture is transient).
  ctx.configure({
    device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
  });
  const recon = new Reconstructor(gpu, srgb);
  recon.setBackground(0.05, 0.06, 0.09);
  // AV1 patches decode + draw through this; gzip/raw patches still go through the Reconstructor.
  // Real decode probe (not just "is VideoDecoder defined"): old Safari / older phones lack AV1.
  const av1CanDecode = await Av1Presenter.canDecode();
  const av1 = av1CanDecode ? new Av1Presenter(gpu, srgb) : null;

  // The remote image lives here between frames; the canvas is a copy of it. Patches paint into it.
  // `surfaceValid` is the safety interlock: a patch may only be applied ON TOP of a full frame at
  // the CURRENT size. A fresh texture's contents are undefined — painting a patch into one and
  // showing the result is how uninitialised GPU memory ends up on screen as a solid colour block.
  let viewTex: GPUTexture | null = null, viewW = 0, viewH = 0, surfaceValid = false;
  const makeViewTex = (w: number, h: number) => {
    const t = gpu.device.createTexture({
      size: [w, h], format: preferred, viewFormats: [srgb],
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
    });
    // Define every texel immediately: nothing undefined may ever reach the screen.
    const enc = gpu.device.createCommandEncoder();
    enc.beginRenderPass({
      colorAttachments: [{
        view: t.createView({ format: srgb }), loadOp: "clear", storeOp: "store",
        clearValue: { r: 0.05, g: 0.06, b: 0.09, a: 1 },
      }],
    }).end();
    gpu.device.queue.submit([enc.finish()]);
    return t;
  };
  const ensureViewTex = () => {
    if (!viewTex || viewW !== canvas.width || viewH !== canvas.height) {
      viewTex?.destroy();
      viewW = canvas.width; viewH = canvas.height;
      surfaceValid = false;
      viewTex = makeViewTex(viewW, viewH);
    }
    return viewTex;
  };
  const blitToCanvas = () => {
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: viewTex! }, { texture: ctx.getCurrentTexture() }, [viewW, viewH]);
    gpu.device.queue.submit([enc.finish()]);
  };

  // Stretch-draw one texture over another — visual CONTINUITY across a resize: the old image stays
  // up (scaled) until the correctly-sized frame arrives, instead of a cleared black canvas being
  // "filled in by patches".
  const stretchWGSL = /* wgsl */ `
@group(0) @binding(0) var t : texture_2d<f32>;
@group(0) @binding(1) var s : sampler;
struct V { @builtin(position) p : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i : u32) -> V {
  let x = select(-1.0, 3.0, i == 1u); let y = select(-1.0, 3.0, i == 2u);
  var o : V; o.p = vec4<f32>(x, y, 0.0, 1.0); o.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5); return o;
}
@fragment fn fs(v : V) -> @location(0) vec4<f32> { return textureSample(t, s, v.uv); }`;
  const stretchMod = gpu.device.createShaderModule({ code: stretchWGSL });
  const stretchPipe = gpu.device.createRenderPipeline({
    layout: "auto",
    vertex: { module: stretchMod, entryPoint: "vs" },
    fragment: { module: stretchMod, entryPoint: "fs", targets: [{ format: srgb }] },
    primitive: { topology: "triangle-list" },
  });
  const stretchSampler = gpu.device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const stretchInto = (dst: GPUTexture, src: GPUTexture) => {
    const bind = gpu.device.createBindGroup({
      layout: stretchPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: src.createView() }, { binding: 1, resource: stretchSampler }],
    });
    const enc = gpu.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst.createView({ format: srgb }), loadOp: "clear", storeOp: "store", clearValue: { r: 0.05, g: 0.06, b: 0.09, a: 1 } }] });
    pass.setPipeline(stretchPipe); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
    gpu.device.queue.submit([enc.finish()]);
  };

  const MAX_DIM = 3840;   // 4K cap: a maximized retina window can ask for more than that
  /** Resize the drawing buffer IF the layout actually changed. Assigning canvas.width CLEARS the
   *  canvas — even to the same value — so this must never run unconditionally: doing it on every
   *  ResizeObserver tick is what made the view blank on interaction and "fill back in". Returns
   *  whether the size changed. On change the old image is stretch-blitted across for continuity. */
  const resize = (): boolean => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cw = Math.floor(canvas.clientWidth * dpr), ch = Math.floor(canvas.clientHeight * dpr);
    if (cw <= 0 || ch <= 0) return false;               // not laid out yet — keep what we have
    const k = Math.min(1, MAX_DIM / Math.max(cw, ch));
    const w = Math.max(16, Math.round(cw * k)), h = Math.max(16, Math.round(ch * k));
    if (w === canvas.width && h === canvas.height) return false;
    const old = viewTex; viewTex = null;                // keep the old image out of destroy()'s reach
    canvas.width = w; canvas.height = h;                // (this clears the canvas)
    ensureViewTex();                                    // new surface, background-cleared, INVALID
    if (old) { stretchInto(viewTex!, old); old.destroy(); }
    blitToCanvas();                                     // continuity: old image, scaled, immediately
    return true;
  };
  new ResizeObserver(() => { if (resize()) { requestResync(); onCam(); } }).observe(canvas);
  globalThis.addEventListener("resize", () => { if (resize()) { requestResync(); onCam(); } });
  resize();

  let camera: VtkCamera | null = null;
  let sceneName = "scene", sceneUrl = "", demo = params.get("demo") ?? "multi";
  let mode: "remote" | "local" = "remote";
  let frames = 0, bytes = 0, frameBytes = 0, lastCamSentAt = 0;
  let camDirty = true;   // the camera is worth sending (it moved, the view resized, or it is new)
  let pdown = false;     // finger state, shipped with the camera: the server settles sooner once released
  const rtt: number[] = [];
  const parts: Uint8Array[] = [];   // chunks of the frame currently arriving
  // The self-healing valve: whenever a frame cannot be applied (size mismatch, no full frame under
  // a patch yet), tell the server once and let it start over from a full frame. Debounced until
  // that full frame arrives so a burst of stale frames does not trigger a burst of resets.
  let resyncSent = false;
  let dbgDropped = 0, dbgResyncs = 0, dbgApplied = 0;
  let lastErr = "";
  const requestResync = () => {
    dbgDropped++;
    if (resyncSent || ws?.readyState !== WebSocket.OPEN) return;
    resyncSent = true; dbgResyncs++;
    ws.send('{"type":"resync"}');
  };
  let lastFrame: { kind: number; sw: number; sh: number; pw: number; ph: number; kB: number; settled: number; codec: number } | null = null;
  let dbgStarts = 0, dbgDrags = 0;   // widget-drag counters for the CDP harness
  let dbgPresentMs = 0, dbgGunzipMs = 0, dbgQueued = 0;   // where client-side frame time goes
  const concat = (bs: Uint8Array[]) => {
    const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of bs) { out.set(b, o); o += b.length; }
    return out;
  };

  // ---- the transform GIZMO (DEMO=multi) ----
  // The widget is pure geometry, so it runs HERE in both modes: picking, the camera-plane drag and
  // the resulting rigid matrix are computed client-side. Remotely that matrix is a {xform} message
  // (the server applies it to its Panoramix field); locally it goes straight into this browser's
  // copy of that field. One widget, one gizmo field — so toggling modes never loses the pose.
  let widget: XformWidget | null = null;
  let widgetSeed: { center: Vec3; m: number[] } | null = null;   // wire form: a plain 16-number array
  // A Mat4 is a Float32Array, so JSON.stringify turns one into an OBJECT — accept either shape and
  // fall back to identity rather than building a zero-length matrix (which silently NaNs the pick
  // geometry: handles project to nowhere and every drag falls through to the camera).
  const toMat4 = (v: unknown): Mat4 => {
    const a = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Record<string, number>) : [];
    return a.length === 16 ? new Float32Array(a) as Mat4 : identity();
  };
  let localPano: ImageField | null = null;      // set once the local scene is built
  let xformDirty = false;                        // a gizmo change is waiting for the next send tick

  // ---- LOCAL path (lazy): build the SAME scene on this GPU + the shared adaptive driver ----
  let localScene: SceneRenderer | null = null;
  let a3d: Adaptive3d | null = null;
  let loadingLocal = false;
  const ensureLocal = async (): Promise<boolean> => {
    if (a3d) return true;
    if (loadingLocal) return false;
    loadingLocal = true;
    status(`loading ${sceneName} locally…`);
    let mb = 0;
    const prog = (n: number) => { mb += n; status(`loading ${sceneName} locally… ${(mb / 1e6).toFixed(0)} MB`); };
    localScene = new SceneRenderer(gpu, srgb);
    if (demo === "multi") {
      // The same builder the server ran — this browser now holds both volumes itself. Everything
      // the view needs (framing, the gizmo's start centre) comes out of the data, not the server.
      const sc = await buildMultiVolume(gpu.device, prog);
      localPano = sc.pano.field;
      const c0 = sc.pano.field.worldCenter();          // centre at identity = the widget's pivot origin
      if (!widget) createWidget({ center: c0, m: [...identity()] });
      localPano.setWorldTransform(widget!.matrix());   // adopt the pose the gizmo is already in
      localScene.build([...sc.fields, widget!.field]);
      bootstrap({
        name: `${sc.cta.name} + ${sc.pano.name}`, sceneUrl: "",
        center: [(sc.cta.center[0] + sc.pano.center[0]) / 2, (sc.cta.center[1] + sc.pano.center[1]) / 2,
                 (sc.cta.center[2] + sc.pano.center[2]) / 2] as Vec3,
        radius: Math.max(sc.cta.radius, sc.pano.radius) * 1.35,
      });
    } else {
      const sv = await loadSceneVolumeField(gpu.device, sceneUrl || SINGLE_SCENE, prog);
      localScene.build([sv.field]);
      bootstrap({ name: sv.name, sceneUrl: sceneUrl || SINGLE_SCENE, center: sv.center, radius: sv.radius });
    }
    localScene.setBackground(0.05, 0.06, 0.09);
    a3d = mountAdaptive3d({
      scene: () => localScene,
      view: () => ctx.getCurrentTexture().createView({ format: srgb }),
      size: () => ({ w: canvas.width, h: canvas.height }),
      setCamera: (s, w, h) => s.setCamera(camera!.position, camera!.focalPoint, camera!.viewUp, camera!.viewAngle, w, h),
      gpu,
      onFrame: () => statusLine("local"),
    });
    loadingLocal = false;
    return true;
  };

  // Track the finger itself (capture phase, observation only): a pause mid-gesture must not look
  // like a release to the server, or it starts a heavyweight settle it will only have to preempt.
  // Finger state rides the camera message so the server knows a pause is mid-gesture (gizmo drags
  // send xform, not cam — without this the server would think the finger is up and settle too soon).
  canvas.addEventListener("pointerdown", () => { pdown = true; camDirty = true; noteInteract(); scheduleSend(); }, true);
  globalThis.addEventListener("pointerup", () => { pdown = false; camDirty = true; scheduleSend(); }, true);

  // ---- REMOTE path (optional, RECONNECTABLE) ----
  // The socket is dropped after the user's idle timeout so the remote GPU scales to zero and billing
  // stops; it reconnects on the next interaction. So `ws` is a mutable current-socket, recreated by
  // connect(), and all send helpers guard on its readyState.
  let ws: WebSocket | null = null;
  let lastSent = -1e12;
  let trailing: ReturnType<typeof setTimeout> | 0 = 0;
  const sendCam = () => {
    trailing = 0;
    if (!camera || ws?.readyState !== WebSocket.OPEN) return;
    lastSent = lastCamSentAt = performance.now();
    if (camDirty) {
      camDirty = false;
      ws.send(JSON.stringify({ type: "cam", w: canvas.width, h: canvas.height, p: [...camera.position], f: [...camera.focalPoint], u: [...camera.viewUp], a: camera.viewAngle, dn: pdown ? 1 : 0 }));
    }
    // A pending gizmo edit rides the same coalesced tick (latest-wins, like the camera).
    if (xformDirty && widget) {
      xformDirty = false;
      const active = widget.field.activeId;
      ws.send(JSON.stringify({ type: "xform", m: [...widget.matrix()], pivot: widget.pivotWorld(), active: active >= 0 ? active : null }));
    }
  };
  const scheduleSend = () => {
    if (!camera || ws?.readyState !== WebSocket.OPEN) return;
    const dt = performance.now() - lastSent;
    if (dt >= 15) sendCam();
    else if (!trailing) trailing = setTimeout(sendCam, 15 - dt);
  };

  const statusLine = (where: "remote" | "local", extra = "") =>
    status(`${sceneName} · ${where.toUpperCase()} · ${canvas.width}×${canvas.height} view · ${extra}${where === "remote" ? `~${[...rtt].sort((a, b) => a - b)[rtt.length >> 1] | 0} ms round-trip · ${(bytes / 1e6).toFixed(1)} MB` : "your GPU"}`);

  // Ask the active path for a new frame WITHOUT claiming the camera moved — a gizmo edit needs a
  // redraw, but re-sending the camera would invalidate the whole view and cost a full frame.
  const requestFrame = () => { if (mode === "remote") scheduleSend(); else a3d?.draw(); };
  // Any camera/view change → drive the ACTIVE path.
  const onCam = () => { camDirty = true; requestFrame(); };

  // A gizmo change always goes BOTH ways: queued for the server (tiny JSON) and applied to the
  // local field if this browser has loaded it. That keeps the two renderers in the same pose, so
  // the mode toggle stays a pure A/B of the SAME scene.
  const pushXform = () => {
    if (!widget) return;
    xformDirty = true;
    localPano?.setWorldTransform(widget.matrix());
    localScene?.syncUniforms();
    if (mode === "remote") scheduleSend();
  };

  /** The SAME widget the local demo mounts, against a target that reports the start centre and
   *  forwards each new matrix instead of owning a field. Needs no camera and no GPU — so it can be
   *  built from the server's hello OR from the locally loaded volume, whichever comes first. */
  const createWidget = (seed: { center: Vec3; m: number[] }) => {
    const target: XformTarget = {
      worldCenter: () => seed.center,
      setWorldTransform: () => {/* fan-out happens in pushXform (server + local field) */},
    };
    widget = makeXformWidget(target, 0, toMat4(seed.m));
  };

  /** Wire the widget to the pointer. Separate from createWidget because picking needs the camera. */
  let widgetAttached = false;
  const attachWidget = () => {
    if (!widget || !camera || widgetAttached) return;
    widgetAttached = true;
    const focalPx = () => (canvas.height / 2) / Math.tan((camera!.viewAngle * Math.PI) / 360);
    // Capture phase, so a grabbed handle never also orbits the camera.
    attachWidgetControls(canvas, camera!, {
      getHandles: (): Handle[] => widget!.handleList(widget!.scaleFor(camera!.position, focalPx())),
      getSize: () => ({ w: canvas.width, h: canvas.height }),
      onDragStart: (h) => { dbgStarts++; widget!.setActive(componentOf(h.data as XMeta)); widget!.beginDrag(); pushXform(); },
      onDrag: (h, world) => { dbgDrags++; widget!.drag(h.data as XMeta, h.world, world); pushXform(); },
      onDragEnd: () => { widget!.setActive(null); pushXform(); },
      onHover: (h) => { widget!.setActive(h ? componentOf(h.data as XMeta) : null); pushXform(); },
      onChange: () => requestFrame(),   // NOT onCam: the camera did not move
    });
  };

  /** Set up camera + interaction once the scene is known. First caller wins — the server's hello
   *  and a standalone local load produce the same framing, so either may go first. */
  const bootstrap = (c: { name: string; sceneUrl: string; center: Vec3; radius: number }) => {
    sceneName = c.name;
    if (c.sceneUrl) sceneUrl = c.sceneUrl;
    if (!camera) {
      camera = framedCamera(c.center, c.radius);
      attachCameraControls(canvas, camera, {
        onChange: onCam,
        // THREE-FINGER = move the picked volume (the touch-friendly alternative to grabbing a fine
        // gizmo handle). Same camera-plane translate the gizmo centre does, driven by the centroid.
        onVolumeDragStart: () => { if (widget) { widget.beginDrag(); pushXform(); } },
        onVolumeDrag: (dx, dy) => {
          if (!widget || !camera) return;
          const r = canvas.getBoundingClientRect();
          const pivot = widget.pivotWorld();
          const w0 = unprojectToCameraPlane(camera, canvas.width, canvas.height, r.width / 2, r.height / 2, r.width, r.height, pivot);
          const w1 = unprojectToCameraPlane(camera, canvas.width, canvas.height, r.width / 2 + dx, r.height / 2 + dy, r.width, r.height, pivot);
          widget.drag({ kind: "translate-cam" }, w0, w1);
          pushXform();
        },
        onVolumeDragEnd: () => { if (widget) pushXform(); },
      });
    }
    attachWidget();
  };
  /** Re-frame the existing camera onto a new scene's center/radius (scene switch). */
  const reframe = (center: Vec3, radius: number) => {
    if (!camera) return;
    const fresh = framedCamera(center, radius);
    camera.position = [...fresh.position] as Vec3;
    camera.focalPoint = [...fresh.focalPoint] as Vec3;
    camera.viewUp = [...fresh.viewUp] as Vec3;
    camDirty = true;
  };

  const gunzip = async (b: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await new Response(new Response(b).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  let applyChain: Promise<void> = Promise.resolve();

  // ---- cost meter + idle/sleep lifecycle -------------------------------------------------------
  let rate = 0.80;                 // $/hr for the remote GPU (server tells us in hello)
  let clientScene = "";            // which scene the server currently has loaded
  const sceneSel = document.getElementById("scene") as HTMLSelectElement | null;
  const creditEl = document.getElementById("credit");
  let sceneMenu: Array<{ name: string; credit?: string }> = [];
  const showCredit = (name: string) => {
    if (!creditEl) return;
    const c = sceneMenu.find((s) => s.name === name)?.credit;
    creditEl.textContent = c ? `Data: ${c}` : "";
  };
  if (sceneSel) sceneSel.onchange = () => {
    const name = sceneSel.value;
    if (!name || name === clientScene) return;
    if (mode !== "remote") { status("switch to REMOTE to load specimens", true); sceneSel.value = clientScene; return; }
    sceneSel.disabled = true;
    showOverlay("starting", "Loading " + (sceneSel.selectedOptions[0]?.textContent ?? name) + "…", "large volumes take a few seconds", true, []);
    if (ov) ov.classList.add("wake");
    ws?.send(JSON.stringify({ type: "scene", scene: name }));
  };
  let scaledownMs = 20_000;        // Modal's post-disconnect tail before the container dies
  let costTotal = 0;               // cumulative $ since this page first connected
  let lastBillTs = 0, containerDeadAt = Infinity, connectStartTs = 0;
  let coldEtaMs = 14_000;          // reconnect ETA, refined by each measured cold start
  // Per-operation scene-load progress (download from the bucket), separate from the wake timer.
  let loadActive = false, loadStartTs = 0, loadDone = 0, loadTotal = 0, loadLastTs = 0, loadLastDone = 0;
  let bucketBps = Number(localStorage.getItem("lr_bucket_bps")) || 60e6;  // bytes/s EMA, measured this + prior sessions
  let refining = false;                 // full-res streaming in behind the low-res proxy
  const refineEl = document.getElementById("refine");
  type Conn = "off" | "connecting" | "live" | "sleeping" | "error";
  let connState: Conn = serverUrl ? "connecting" : "off";
  const IDLE_OPTS: [string, number][] = [["5s", 5e3], ["15s", 15e3], ["30s", 30e3], ["1m", 60e3], ["2m", 120e3], ["5m", 300e3], ["10m", 600e3]];
  let idleMs = Number(localStorage.getItem("lr_idle") ?? 120e3);
  let lastInteract = performance.now();
  let idleClosed = false;
  let everLive = false;

  const el = (id: string) => document.getElementById(id);
  const setConn = (c: Conn) => { connState = c; };

  // ---- front-door overlay: startup feedback, spend cap, endpoint-unavailable ----
  const ov = el("overlay"), ovTitle = el("ovTitle"), ovMsg = el("ovMsg"), ovSub = el("ovSub"), ovBtns = el("ovBtns");
  type OvBtn = { label: string; ghost?: boolean; fn: () => void };
  let ovMode: "" | "starting" | "capped" | "dead" = "";
  const showOverlay = (mode: typeof ovMode, title: string, msg: string, spin: boolean, btns: OvBtn[]) => {
    ovMode = mode;
    if (!ov) return;
    ov.classList.add("show"); ov.classList.toggle("stop", !spin);
    if (ovTitle) ovTitle.textContent = title;
    if (ovMsg) ovMsg.textContent = msg;
    if (ovBtns) {
      ovBtns.innerHTML = "";
      for (const b of btns) { const el = document.createElement("button"); el.textContent = b.label; if (b.ghost) el.className = "ghost"; el.onclick = b.fn; ovBtns.appendChild(el); }
    }
  };
  const hideOverlay = () => { ovMode = ""; ov?.classList.remove("show"); };

  // Spend cap: a mock of a per-IP allowance (localStorage per browser; production enforces server-
  // side by IP). Lifetime spend across sessions is capped; "grant more" adds another allowance.
  const CAP_STEP = 0.10;
  let spendCap = Number(localStorage.getItem("lr_cap") ?? CAP_STEP);
  let lifeSpent = Number(localStorage.getItem("lr_life") ?? 0);
  let capped = false, lastLifeSave = 0;
  const grantMore = () => {
    spendCap += CAP_STEP; localStorage.setItem("lr_cap", String(spendCap));
    capped = false; hideOverlay();
    if (connState === "sleeping" || connState === "error") connect();
  };
  const enforceCap = () => {
    if (capped) return;
    capped = true;
    if (ws?.readyState === WebSocket.OPEN) { idleClosed = true; ws.close(1000, "cap"); }
    setConn("sleeping");
    showOverlay("capped", "Free GPU time used up",
      `You've used ${(lifeSpent * 100).toFixed(1)}¢ of this demo's free remote-GPU time. Grant yourself a little more, or explore on your own GPU.`,
      false,
      [{ label: "Grant 10¢ more", fn: grantMore }, { label: "Render on my GPU", ghost: true, fn: () => { hideOverlay(); setMode("local"); } }]);
  };
  const fmt$ = (v: number) => "$" + v.toFixed(2);
  // Cost so far shown in CENTS to ~3 significant figures (so sub-cent amounts stay legible), with
  // the cent sign in parens as the unit; plus the burn rate in ¢/min.
  const ratePerMin = () => `${(rate * 100 / 60).toFixed(1)} ¢/min`;

  const connect = () => {
    if (!serverUrl) return;
    idleClosed = false;
    connectStartTs = performance.now();
    containerDeadAt = Infinity;            // the container is alive (or spinning up)
    if (lastBillTs === 0) lastBillTs = performance.now();
    setConn("connecting");
    showOverlay("starting", everLive ? "Waking the remote GPU…" : "Starting the remote GPU…",
      everLive ? "It scaled to zero while idle — bringing it back takes a few seconds. Your view is preserved."
               : "The first frame spins up a dedicated L4 GPU on demand — this takes a few seconds. It sleeps when idle and only bills while awake.",
      true, []);
    if (ov) ov.classList.toggle("wake", everLive);   // lighter background on wake (stale image shows through)
    ws = new WebSocket(serverUrl);
    ws.binaryType = "arraybuffer";
    const sock = ws;
    sock.addEventListener("open", () => {
      // Advertise decode caps first; the server stays on gzip until this lands.
      sock.send(JSON.stringify({ type: "caps", av1: av1CanDecode }));
      status("connected — waiting for scene…");
    });
    sock.addEventListener("close", () => {
      // Whether we closed for idle or the link dropped, the container lives `scaledownMs` more.
      containerDeadAt = performance.now() + scaledownMs;
      if (idleClosed) { setConn("sleeping"); status("sleeping — touch to wake"); }
      else fallbackLocal("render server disconnected");
    });
    sock.addEventListener("error", () => {
      if (idleClosed || capped) return;
      setConn("error");
      if (!everLive) {
        // Never connected: the endpoint may be starting slowly, down, or over its monthly budget.
        showOverlay("dead", "Remote GPU unavailable",
          "Couldn't reach the remote renderer. It may be over this month's free budget, or briefly down. You can retry, or explore on your own GPU.", false,
          [{ label: "Retry", fn: () => { hideOverlay(); connect(); } }, { label: "Render on my GPU", ghost: true, fn: () => { hideOverlay(); setMode("local"); } }]);
      } else fallbackLocal("cannot reach the render server");
    });
    sock.addEventListener("message", (ev) => {
      if (sock !== ws) return;             // ignore a late message from a superseded socket
      if (typeof ev.data !== "string" && sock.readyState === WebSocket.OPEN) sock.send('{"type":"cack"}');
      applyChain = applyChain.then(() => applyMessage(ev)).catch((err) => {
        lastErr = String(err?.message ?? err);
        status("frame decode error: " + lastErr + " — try a hard reload", true);
        requestResync();
      });
    });
  };

  // Drop the socket after the idle timeout; wake on the next interaction.
  const goIdle = () => { if (ws?.readyState === WebSocket.OPEN) { idleClosed = true; ws.close(1000, "idle"); } };
  const wake = () => { if (serverUrl && (connState === "sleeping" || connState === "error")) connect(); };
  const noteInteract = () => { lastInteract = performance.now(); wake(); };

  const fallbackLocal = async (why: string) => {
    if (mode === "local") return;
    status(`${why} — rendering locally instead`, true);
    if (await ensureLocal()) await setMode("local");
  };
  const applyMessage = async (e: MessageEvent) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data as string);
      if (m.type === "refined") { refining = false; if (refineEl) refineEl.textContent = ""; return; }
      if (m.type === "loading") {
        loadActive = true; loadStartTs = performance.now(); loadDone = 0; loadTotal = 0;
        loadLastTs = loadStartTs; loadLastDone = 0;
        refining = false; if (refineEl) refineEl.textContent = "";
        showOverlay("starting", "Loading " + m.scene + " …", "", true, []);
        if (ov) ov.classList.add("wake");
        return;
      }
      if (m.type === "loadProgress") {
        loadTotal = m.total || 0; loadDone = m.done || 0;
        const now = performance.now(), dt = now - loadLastTs, db = loadDone - loadLastDone;
        if (dt > 0 && db > 0) {   // instantaneous rate -> EMA of bucket throughput
          bucketBps = 0.7 * bucketBps + 0.3 * (db / (dt / 1000));
          localStorage.setItem("lr_bucket_bps", String(Math.round(bucketBps)));
          loadLastTs = now; loadLastDone = loadDone;
        }
        if (ovMode !== "starting") {   // proxy is already on screen -> this is the background upgrade
          refining = true;
          if (refineEl) {
            const pct = loadTotal > 0 ? Math.floor((loadDone / loadTotal) * 100) : 0;
            const left = loadTotal > 0 ? Math.max(0, (loadTotal - loadDone) / Math.max(1, bucketBps)) : 0;
            refineEl.textContent = `refining ${pct}% · ~${Math.round(left)}s`;
          }
        }
        return;
      }
      if (m.type === "sceneError") {
        loadActive = false;
        status("could not load specimen: " + (m.message ?? "unknown"), true);
        if (sceneSel) { sceneSel.disabled = false; sceneSel.value = clientScene; }
        hideOverlay();
        return;
      }
      if (m.type === "hello") {
        if ((m.proto ?? 0) !== PROTO) {
          status(`page/server version mismatch (page ${PROTO}, server ${m.proto}) — reloading…`, true);
          ws?.close();
          if (!sessionStorage.getItem("lr_reloaded")) {
            sessionStorage.setItem("lr_reloaded", "1");
            location.reload();
          }
          return;
        }
        sessionStorage.removeItem("lr_reloaded");
        if (typeof m.rate === "number") rate = m.rate;
        if (typeof m.scaledownS === "number") scaledownMs = m.scaledownS * 1000;
        // first frame is here: this connect's wall time was a cold (or warm) start — remember it as
        // the ETA for the next wake, and go live.
        if (connectStartTs) coldEtaMs = Math.max(1500, Math.min(60_000, performance.now() - connectStartTs));
        containerDeadAt = Infinity;
        setConn("live"); everLive = true;
        loadActive = false;
        if (ovMode === "starting") hideOverlay();
        const reconnecting = !!camera;   // we already had a scene → this is a wake, not a first load
        demo = m.demo ?? "single";
        // Populate the specimen menu (once), and note which scene the server has loaded.
        if (Array.isArray(m.scenes)) sceneMenu = m.scenes;
        if (sceneSel && Array.isArray(m.scenes) && sceneSel.options.length === 0) {
          for (const sc of m.scenes) {
            const o = document.createElement("option");
            o.value = sc.name;
            const vram = sc.gib >= 0.5 ? ` · ${sc.gib} GB` : "";
            o.textContent = sc.fits ? `${sc.label} (${sc.dims}${vram})` : `${sc.label} — won't fit (${sc.gib} GB)`;
            o.disabled = !sc.fits;
            o.title = sc.fits ? `${sc.dims} · ~${sc.gib} GB GPU memory` : (sc.reason ?? "exceeds GPU memory");
            sceneSel.appendChild(o);
          }
        }
        sceneName = m.name ?? sceneName;
        const sceneChanged = typeof m.scene === "string" && m.scene !== clientScene && clientScene !== "";
        if (typeof m.scene === "string") { clientScene = m.scene; if (sceneSel) { sceneSel.value = m.scene; sceneSel.disabled = false; } showCredit(m.scene); }
        widgetSeed = m.widget ?? null;
        if (sceneChanged) {
          // A different specimen: drop the old gizmo, re-frame the camera, remount for the new one.
          widget = null; widgetAttached = false;
          reframe(m.center as Vec3, m.radius);
          if (widgetSeed) { createWidget(widgetSeed); attachWidget(); }
        } else {
          if (widgetSeed && !widget) createWidget(widgetSeed);
          bootstrap({ name: m.name ?? "scene", sceneUrl: m.sceneUrl ?? "", center: m.center as Vec3, radius: m.radius });
        }
        // The server resets its shared transform on connect; if we are WAKING with edits, restore
        // them (and re-frame with our preserved camera) so a sleep is invisible.
        if (reconnecting && widget) { xformDirty = true; }
        camDirty = true;
        sendCam();
        statusLine("remote", widget ? "drag a gizmo handle to move Panoramix · " : "drag to orbit · ");
      }
      return;
    }
    if (mode !== "remote") return;   // ignore stale remote frames while in Local mode
    const buf = e.data as ArrayBuffer;
    const head = new Uint16Array(buf, 0, 16);
    const sw = head[0], sh = head[1], settled = head[4], codec = head[5];   // codec: 0 raw · 1 gzip · 2 av1
    const chunk = head[6], chunks = head[7];
    // kind 1 = PATCH: these samples cover only the view rect (px,py,pw,ph)
    const kind = head[8], px = head[9], py = head[10], pw = head[11], ph = head[12];
    const srvSinceInput = head[13], srvRenderMs = head[14];   // the server's own timing split
    frameBytes += buf.byteLength;
    // Big frames arrive in pieces (a cloud ws proxy closes the socket on multi-MB messages) —
    // reassemble, and ack only when the last piece lands so the credit scheme still paces us.
    // Reassemble chunks first (a big frame is split for the WS proxy limit), THEN decode the WHOLE:
    // the server compresses/encodes the entire frame and chunks the RESULT, so a chunk is a slice
    // of the gzip/AV1 stream, never independently decodable. (Gunzipping per chunk silently worked
    // for single-chunk frames and looped forever on multi-chunk ones — the gzip-fallback settle bug.)
    let payload: Uint8Array;
    if (chunks > 1) {
      if (chunk === 0) parts.length = 0;
      parts.push(new Uint8Array(buf, 32));
      if (chunk < chunks - 1) return;
      payload = concat(parts);
    } else {
      payload = new Uint8Array(buf, 32);
    }
    if (codec === 1) payload = await gunzip(payload);
    // ---- APPLY RULES. WebSocket delivery is ordered, so these three rules keep the client's
    // surface exactly consistent with the server's model of it — or trigger a resync that resets
    // both sides to a full frame. A frame that fails a rule is DROPPED whole, never partially or
    // stretchily applied: better a moment of the old image than any amount of debris.
    const vw = head[2], vh = head[3];
    if (vw !== canvas.width || vh !== canvas.height) { requestResync(); return; }   // rendered for a view that no longer exists
    if (kind === 1 && (!surfaceValid || px + pw > viewW || py + ph > viewH)) { requestResync(); return; }
    const tp = performance.now();
    const dst = ensureViewTex().createView({ format: srgb });
    const rect = kind === 1 ? { x: px, y: py, w: pw, h: ph } : { x: 0, y: 0, w: viewW, h: viewH };
    if (codec === 2 && av1) {
      // AV1: decode to a VideoFrame, draw (already composited over bg) into the rect.
      let frame: VideoFrame;
      try { frame = await av1.decode(payload, sw, sh); }
      catch (err) { lastErr = "av1 decode: " + (err as Error).message; requestResync(); return; }
      av1.present(dst, frame, sw, sh, rect, srgb);
      frame.close();
    } else {
      // gzip / raw samples through the Reconstructor (Catmull-Rom upsample + composite over bg).
      recon.present(dst, payload, sw, sh, viewW, viewH, kind === 1 ? rect : undefined);
    }
    if (kind === 0) { surfaceValid = true; resyncSent = false; }
    blitToCanvas();
    dbgApplied++;
    dbgPresentMs += performance.now() - tp;
    ws!.send('{"type":"ack"}');      // ack-based credit: server sends the next frame once we present
    frames++; bytes += frameBytes;
    const kB = frameBytes / 1e3; frameBytes = 0;
    lastFrame = { kind, sw, sh, pw, ph, kB: Math.round(kB), settled, codec };
    const dt = performance.now() - lastCamSentAt; rtt.push(dt); if (rtt.length > 30) rtt.shift();
    statusLine("remote", `${kind === 1 ? `patch ${sw}×${sh}→${pw}×${ph}` : settled ? "samples native" : `samples ${sw}×${sh}`} · ${kB.toFixed(0)} kB ${["raw","gz","av1"][codec] ?? codec} · srv ${srvSinceInput}ms (render ${srvRenderMs}) · `);
  };

  // ---- RenderMode toggle ----
  const setMode = async (m: "remote" | "local") => {
    if (m === "local") { if (!await ensureLocal()) { status("cannot load local scene", true); return; } }
    if (m === "remote" && ws?.readyState !== WebSocket.OPEN) { status("no render server connected — staying local", true); return; }
    mode = m;
    if (modeBtn) {
      modeBtn.textContent = m === "remote"
        ? "Rendering on the REMOTE GPU — click to render locally"
        : "Rendering on YOUR GPU — click to render remotely";
    }
    if (m === "remote") sendCam(); else a3d?.draw();
  };
  modeBtn?.addEventListener("click", () => setMode(mode === "remote" ? "local" : "remote"));

  // ---- meter + state UI, idle/billing timers, settings popup ----
  const connEl = el("conn"), meterEl = el("meter"), gearEl = el("gear");
  const popup = el("idlePopup"), optsEl = el("idleOpts"), closeEl = el("idleClose");
  const idleLabel = () => IDLE_OPTS.find(([, v]) => v === idleMs)?.[0] ?? (idleMs / 1000 + "s");
  if (gearEl) gearEl.textContent = "⏱ " + idleLabel();
  const buildOpts = () => {
    if (!optsEl) return;
    optsEl.innerHTML = "";
    for (const [label, v] of IDLE_OPTS) {
      const b = document.createElement("button");
      b.textContent = label;
      if (v === idleMs) b.className = "sel";
      b.onclick = () => { idleMs = v; localStorage.setItem("lr_idle", String(v)); if (gearEl) gearEl.textContent = "⏱ " + label; buildOpts(); lastInteract = performance.now(); };
      optsEl.appendChild(b);
    }
  };
  buildOpts();
  gearEl?.addEventListener("click", () => popup?.classList.add("show"));
  closeEl?.addEventListener("click", () => popup?.classList.remove("show"));
  popup?.addEventListener("click", (e) => { if (e.target === popup) popup.classList.remove("show"); });
  connEl?.addEventListener("click", () => { if (connState === "sleeping" || connState === "error") { lastInteract = performance.now(); wake(); } });

  // Billing: accrue while the container is believed ALIVE — from connect-initiation (cold start
  // included), through the connected session, and through Modal's scaledown tail after a drop.
  const bill = () => {
    const now = performance.now();
    if (mode === "remote" && lastBillTs && now < containerDeadAt) {
      const d = rate * (now - lastBillTs) / 3.6e6;
      costTotal += d; lifeSpent += d;
      if (now - lastLifeSave > 3000) { localStorage.setItem("lr_life", String(lifeSpent)); lastLifeSave = now; }
      if (!capped && lifeSpent >= spendCap) enforceCap();
    }
    lastBillTs = now;
  };
  const paintMeter = () => {
    if (!connEl || !meterEl) return;
    if (mode === "local") { connEl.className = "pill"; connEl.textContent = "local GPU"; meterEl.textContent = fmt$(costTotal); return; }
    if (connState === "connecting") {
      // Honest feedback: show ELAPSED wake time counting up, alongside the ETA estimate — not a
      // countdown of a guess that may be wrong.
      const elapsed = Math.floor((performance.now() - connectStartTs) / 1000);
      const eta = Math.round(coldEtaMs / 1000);
      const verb = everLive ? "waking" : "starting remote GPU";
      connEl.className = "pill wake";
      connEl.textContent = elapsed <= eta ? `${verb}… ${elapsed}s / ~${eta}s` : `${verb}… ${elapsed}s (almost)`;
    } else if (connState === "live") {
      connEl.className = "pill"; connEl.textContent = "live";
    } else if (connState === "sleeping") {
      connEl.className = "pill sleep"; connEl.textContent = "asleep · tap to wake";
    } else if (connState === "error") {
      connEl.className = "pill err"; connEl.textContent = "offline · tap to retry";
    }
    meterEl.textContent = `${fmt$(costTotal)} · ${ratePerMin()}`;
    meterEl.title = `Remote L4 GPU: ${fmt$(costTotal)} since this page connected · ${fmt$(rate)}/hr (${ratePerMin()}) while awake`;
  };
  setInterval(() => {
    bill();
    if (connState === "live" && performance.now() - lastInteract > idleMs && ws?.readyState === WebSocket.OPEN) goIdle();
    if (ovMode === "starting" && ovSub) {
      if (loadActive) {
        const el = (performance.now() - loadStartTs) / 1000;
        // ETA from measured bucket throughput; use live bytes once known, else the size estimate.
        const remain = loadTotal > 0 ? Math.max(0, loadTotal - loadDone) : 0;
        const eta = loadTotal > 0 ? (loadTotal / Math.max(1, bucketBps)) : 0;
        const left = remain > 0 ? remain / Math.max(1, bucketBps) : Math.max(0, eta - el);
        const pct = loadTotal > 0 ? Math.min(99, Math.floor((loadDone / loadTotal) * 100)) : 0;
        const mb = loadTotal > 0 ? ` · ${(loadDone/1e6).toFixed(0)}/${(loadTotal/1e6).toFixed(0)} MB` : "";
        ovSub.textContent = loadTotal > 0
          ? `${pct}%${mb} · ${el.toFixed(0)}s elapsed · ~${Math.max(0, Math.round(left))}s left`
          : `${el.toFixed(0)}s elapsed…`;
      } else {
        const elapsed = Math.floor((performance.now() - connectStartTs) / 1000);
        ovSub.textContent = `elapsed ${elapsed}s · usually ~${Math.round(coldEtaMs / 1000)}s`;
      }
    }
    paintMeter();
  }, 500);

  // ---- start ----
  if (serverUrl) { lastBillTs = performance.now(); connect(); }
  else { status("no render server — rendering locally"); if (await ensureLocal()) await setMode("local"); paintMeter(); }

  (globalThis as unknown as { __remoteDbg: unknown }).__remoteDbg = {
    frames: () => frames, connected: () => ws?.readyState === WebSocket.OPEN, hasCam: () => !!camera,
    mode: () => mode, setMode: (m: "remote" | "local") => setMode(m),
    // Gizmo handles in CSS px, so a harness can aim a synthetic pointer at one (the remote twin of
    // selftest-browser's __xformDbg).
    handles: () => {
      if (!widget || !camera) return [];
      const r = canvas.getBoundingClientRect();
      const focalPx = (canvas.height / 2) / Math.tan((camera.viewAngle * Math.PI) / 360);
      return widget.handleList(widget.scaleFor(camera.position, focalPx)).map((h) => {
        const m = h.data as XMeta & { axis?: number };
        const s = projectToCanvasCss(camera!, canvas.width, canvas.height, h.world, r.width, r.height);
        return { id: h.id, kind: m.kind, axis: m.axis, x: s?.x ?? null, y: s?.y ?? null };
      });
    },
    matrix: () => widget ? [...widget.matrix()] : null,
    cam: () => camera ? { p: [...camera.position], f: [...camera.focalPoint], u: [...camera.viewUp], d: camera.distance } : null,
    diag: () => ({
      proto: PROTO, dpr: globalThis.devicePixelRatio,
      css: [canvas.clientWidth, canvas.clientHeight], buf: [canvas.width, canvas.height],
      tex: [viewW, viewH], surfaceValid, applied: dbgApplied, dropped: dbgDropped,
      resyncs: dbgResyncs, lastErr,
    }),
    last: () => lastFrame,
    drags: () => ({ starts: dbgStarts, drags: dbgDrags }),
    session: () => ({ conn: connState, cost: costTotal, rate, idleMs, coldEtaMs: Math.round(coldEtaMs), scaledownMs, lifeSpent, spendCap, capped, ovMode }),
    resetSpend: () => { lifeSpent = 0; spendCap = 0.10; capped = false; localStorage.setItem("lr_life", "0"); localStorage.setItem("lr_cap", "0.1"); },
    setLife: (v: number) => { lifeSpent = v; },
    setIdle: (ms: number) => { idleMs = ms; lastInteract = performance.now(); },
    forceIdle: () => goIdle(),
    wake: () => wake(),
    timing: () => { const r = { frames, presentMs: Math.round(dbgPresentMs), gunzipMs: Math.round(dbgGunzipMs), queued: dbgQueued }; dbgPresentMs = 0; dbgGunzipMs = 0; return r; },
  };
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
