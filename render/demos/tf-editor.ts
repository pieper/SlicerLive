// "Volume Rendering" panel + transfer-function editor (W3): enable VR on the active scalar volume, apply a
// Slicer CT VR preset, and edit the scalar-opacity curve on a canvas (drag handles, click to add, dbl-click
// to remove). Everything patches a `transferFunction` node (colorStops + scalarOpacity) and a
// `volumeRenderingDisplay` node through the LiveScene, so VolumeRenderingDisplayableManager.reLUT() rebuilds
// the LUT and the 3D view updates. One transferFunction/VR-display node per scene (the VR DM tracks one
// image), matching the current native single-volume VR path. Plain DOM, theme.css. RAS/geometry-free.
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";
import { CT_VR_PRESETS } from "../ct-vr-presets.ts";

export interface TfEditorOpts { live: LiveScene; onStatus?: (s: string) => void; }

interface ColorStop { value: number; rgba: [number, number, number]; }
interface OpacityStop { value: number; opacity: number; }

const VR_ID = "local-volumeRenderingDisplay-1";
const TF_ID = "local-transferFunction-1";

export function registerTfEditor(shell: AppShell, opts: TfEditorOpts): void {
  const { live } = opts;
  let activeId = "";

  const scalarVolumes = (): { imageId: string; name: string }[] => {
    const out: { imageId: string; name: string }[] = [];
    for (const n of live.nodes.values()) if (n.type === "image" && !n.labelmap) out.push({ imageId: n.id, name: (n.name as string) ?? n.id });
    return out;
  };
  const tfNode = () => live.nodes.get(TF_ID);
  const vrNode = () => live.nodes.get(VR_ID);
  const opacityStops = (): OpacityStop[] => (tfNode()?.scalarOpacity as OpacityStop[] | undefined)?.slice() ?? [];
  const colorStops = (): ColorStop[] => (tfNode()?.colorStops as ColorStop[] | undefined)?.slice() ?? [];

  const ensureTf = () => {
    if (!tfNode()) live.write({ op: "put", id: TF_ID, node: { type: "transferFunction", id: TF_ID, name: "VR transfer function", colorStops: [], scalarOpacity: [], source: { mrmlClass: "vtkMRMLVolumePropertyNode" }, origin: { local: true } } as unknown as MrsonNode });
  };
  const setVolumeRendering = (imageId: string, on: boolean) => {
    ensureTf();
    if (!vrNode()) live.write({ op: "put", id: VR_ID, node: { type: "volumeRenderingDisplay", id: VR_ID, name: "Volume rendering", visible: on, refs: { volume: [imageId], property: [TF_ID] }, source: { mrmlClass: "vtkMRMLGPURayCastVolumeMapper" }, origin: { local: true } } as unknown as MrsonNode });
    else { live.write({ op: "patch", id: VR_ID, path: "#/visible", value: on }); live.write({ op: "patch", id: VR_ID, path: "#/refs", value: { volume: [imageId], property: [TF_ID] } }); }
  };
  const applyPreset = (imageId: string, presetName: string) => {
    const p = CT_VR_PRESETS.find((x) => x.name === presetName); if (!p) return;
    ensureTf();
    const cs: ColorStop[] = p.colorTF.map((s) => ({ value: s[0], rgba: [s[1], s[2], s[3]] as [number, number, number] }));
    const os: OpacityStop[] = p.opacityTF.map((s) => ({ value: s[0], opacity: s[1] }));
    live.write({ op: "patch", id: TF_ID, path: "#/colorStops", value: cs });
    live.write({ op: "patch", id: TF_ID, path: "#/scalarOpacity", value: os });
    live.write({ op: "patch", id: TF_ID, path: "#/preset", value: presetName });
    setVolumeRendering(imageId, true);
  };
  const setOpacityStops = (stops: OpacityStop[]) => { ensureTf(); const s = stops.slice().sort((a, b) => a.value - b.value); live.write({ op: "patch", id: TF_ID, path: "#/scalarOpacity", value: s }); };
  /** Shift ALL transfer-function points (colour + opacity) by `delta` intensity units as a unit (Slicer's
   *  Volume Rendering "Shift" slider). */
  const shiftTf = (delta: number) => {
    if (!tfNode() || !delta) return;
    const cs = colorStops().map((c) => ({ ...c, value: c.value + delta }));
    const os = opacityStops().map((o) => ({ ...o, value: o.value + delta }));
    live.write({ op: "patch", id: TF_ID, path: "#/colorStops", value: cs });
    live.write({ op: "patch", id: TF_ID, path: "#/scalarOpacity", value: os });
  };

  Object.assign(globalThis, {
    __vrState: (imageId?: string) => { const vr = vrNode(), tf = tfNode(); return { visible: !!vr?.visible, volume: ((vr?.refs as Record<string, string[]> | undefined)?.volume ?? [])[0] ?? imageId, preset: tf?.preset as string | undefined, colorStops: colorStops(), scalarOpacity: opacityStops() }; },
    __setVolumeRendering: setVolumeRendering,
    __setVrPreset: applyPreset,
    __setOpacityStops: setOpacityStops,
    __shiftTf: shiftTf,
  });

  // ── UI ────────────────────────────────────────────────────────────────────
  let root: HTMLElement | null = null;
  let shiftLast = 0;   // last Shift-slider value applied (deltas move the whole TF as a unit)
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };
  const W = 260, H = 120, PAD = 6;

  function tfRange(): [number, number] {
    const os = opacityStops(), cs = colorStops();
    const vals = [...os.map((s) => s.value), ...cs.map((s) => s.value)];
    if (!vals.length) return [-1000, 1000];
    return [Math.min(...vals), Math.max(...vals)];
  }

  function drawCurve(cv: HTMLCanvasElement) {
    const g = cv.getContext("2d"); if (!g) return;
    const [lo, hi] = tfRange(), os = opacityStops();
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#12141c"; g.fillRect(0, 0, W, H);
    const X = (v: number) => PAD + ((v - lo) / Math.max(1e-6, hi - lo)) * (W - 2 * PAD);
    const Y = (a: number) => (H - PAD) - a * (H - 2 * PAD);
    // color swatches along the bottom
    const cs = colorStops();
    for (let i = 0; i < cs.length - 1; i++) {
      const c0 = cs[i], c1 = cs[i + 1];
      const grad = g.createLinearGradient(X(c0.value), 0, X(c1.value), 0);
      grad.addColorStop(0, `rgb(${c0.rgba.map((v) => Math.round(v * 255)).join(",")})`);
      grad.addColorStop(1, `rgb(${c1.rgba.map((v) => Math.round(v * 255)).join(",")})`);
      g.fillStyle = grad; g.fillRect(X(c0.value), H - 5, Math.max(1, X(c1.value) - X(c0.value)), 5);
    }
    // opacity polyline + handles
    g.strokeStyle = "#EDD54C"; g.lineWidth = 1.5; g.beginPath();
    os.forEach((s, i) => { const x = X(s.value), y = Y(s.opacity); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
    g.stroke();
    g.fillStyle = "#EDD54C";
    os.forEach((s) => { g.beginPath(); g.arc(X(s.value), Y(s.opacity), 3.5, 0, Math.PI * 2); g.fill(); });
  }

  function mountCanvasEditing(cv: HTMLCanvasElement) {
    let drag = -1;
    const toVal = (px: number) => { const [l, h] = tfRange(); return l + ((px - PAD) / (W - 2 * PAD)) * (h - l); };
    const toOpac = (py: number) => Math.max(0, Math.min(1, ((H - PAD) - py) / (H - 2 * PAD)));
    const near = (mx: number, my: number) => {
      const [l, h] = tfRange(), os = opacityStops();
      const X = (v: number) => PAD + ((v - l) / Math.max(1e-6, h - l)) * (W - 2 * PAD);
      const Y = (a: number) => (H - PAD) - a * (H - 2 * PAD);
      for (let i = 0; i < os.length; i++) if (Math.hypot(mx - X(os[i].value), my - Y(os[i].opacity)) < 7) return i;
      return -1;
    };
    const rel = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)] as const; };
    cv.addEventListener("mousedown", (e) => { const [mx, my] = rel(e); drag = near(mx, my); if (drag < 0) { const os = opacityStops(); os.push({ value: toVal(mx), opacity: toOpac(my) }); setOpacityStops(os); drawCurve(cv); } });
    globalThis.addEventListener("mousemove", (e) => { if (drag < 0) return; const [mx, my] = rel(e as MouseEvent); const os = opacityStops(); if (!os[drag]) { drag = -1; return; } os[drag] = { value: toVal(mx), opacity: toOpac(my) }; setOpacityStops(os); drawCurve(cv); });
    globalThis.addEventListener("mouseup", () => { drag = -1; });
    cv.addEventListener("dblclick", (e) => { const [mx, my] = rel(e); const i = near(mx, my); const os = opacityStops(); if (i >= 0 && os.length > 2) { os.splice(i, 1); setOpacityStops(os); drawCurve(cv); } });
  }

  function render() {
    if (!root) return;
    const vols = scalarVolumes();
    if (!activeId || !vols.some((v) => v.imageId === activeId)) activeId = vols[0]?.imageId ?? "";
    if (!activeId) { root.innerHTML = `<h2>Volume Rendering</h2><p class="sl-hint">No scalar volume loaded.</p>`; return; }
    const vr = vrNode(), tf = tfNode();
    const volOpts = vols.map((x) => `<option value="${x.imageId}"${x.imageId === activeId ? " selected" : ""}>${x.name}</option>`).join("");
    const presetOpts = CT_VR_PRESETS.map((p) => `<option value="${p.name}"${tf?.preset === p.name ? " selected" : ""}>${p.label}</option>`).join("");
    root.innerHTML = `
      <h2>Volume Rendering</h2>
      <div class="sl-row"><label>Volume</label><select class="sl-vr-active">${volOpts}</select></div>
      <div class="sl-row"><label><input type="checkbox" class="sl-vr-on"${vr?.visible ? " checked" : ""}> Show in 3D</label></div>
      <div class="sl-row"><label>Preset</label><select class="sl-vr-preset"><option value="">Choose…</option>${presetOpts}</select></div>
      <div class="sl-row"><label>Shift</label><input class="sl-vr-shift" type="range" min="-500" max="500" step="1" value="0"><span class="sl-vr-shiftv">0</span></div>
      <h3>Scalar opacity</h3>
      <canvas class="sl-tf-canvas" width="${W}" height="${H}" style="width:100%;border:1px solid var(--sl-border,#2a2f3a);border-radius:4px;cursor:crosshair"></canvas>
      <p class="sl-hint">Drag a handle to change opacity, click to add, double-click to remove.</p>`;
    const $ = <T extends HTMLElement>(s: string) => root!.querySelector(s) as T;
    $("select.sl-vr-active").addEventListener("change", (e) => { activeId = (e.target as HTMLSelectElement).value; render(); });
    $("input.sl-vr-on").addEventListener("change", (e) => { setVolumeRendering(activeId, (e.target as HTMLInputElement).checked); status((e.target as HTMLInputElement).checked ? "volume rendering on" : "volume rendering off"); });
    $("select.sl-vr-preset").addEventListener("change", (e) => { const nm = (e.target as HTMLSelectElement).value; if (nm) { applyPreset(activeId, nm); shiftLast = 0; render(); status(`VR preset ${nm}`); } });
    const shiftEl = $<HTMLInputElement>("input.sl-vr-shift");
    shiftEl.addEventListener("input", (e) => { const v = Number((e.target as HTMLInputElement).value); shiftTf(v - shiftLast); shiftLast = v; ($(".sl-vr-shiftv") as HTMLElement).textContent = String(v); });
    const cv = $<HTMLCanvasElement>("canvas.sl-tf-canvas"); drawCurve(cv); mountCanvasEditing(cv);
  }

  shell.registerPanel({ id: "vr", title: "Volume Rendering", order: 4, mount(el) { root = el; render(); } });
  live.subscribe((c) => { if (c.type === "image" || c.type === "transferFunction" || c.type === "volumeRenderingDisplay" || c.kind === "remove") { const cv = root?.querySelector("canvas.sl-tf-canvas") as HTMLCanvasElement | null; if (cv) drawCurve(cv); else render(); } });
}
