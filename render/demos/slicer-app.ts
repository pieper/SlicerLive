// slicer-app — the stock 3D Slicer interface hosted by SlicerLive: the Qt chrome and module panels
// are streamed from a headless ModuleServer/AppServer (region PNGs + synthetic events, WS B), while
// the slice/3D views in the layout area are SlicerLive's own WebGPU views kept in sync over the
// mrson channel + LiveSync (WS A). Query params: ?host=, ?gui=ws://..., ?ws=ws://..., ?http=...,
// ?nativeMenus=1 (host provides menus; hide the streamed menubar).
import { initDevice } from "../device.ts";
import { LegacyGui, type Menu } from "../moduleserver/legacy-gui.ts";
import { mountLiveViews } from "../moduleserver/live-views.ts";
import { mountSessionUI } from "../moduleserver/session-ui.ts";
import { installIntrospection, type SlicerLiveHook } from "../introspect.ts";
import { expect, registerSelfTest } from "../selftest.ts";
import { type AppShell, mountAppShell } from "./app-shell.ts";
import { cellsFor, DEFAULT_LAYOUT, layoutList } from "../../logic/layouts.ts";
import { registerLoadPanel } from "./load-panel.ts";
import { registerVolumesPanel } from "./volumes-panel.ts";
import { registerTfEditor } from "./tf-editor.ts";
import { registerMarkupsPanel } from "./markups-panel.ts";
import { registerSegEditorPanel } from "./seg-editor-panel.ts";
import { registerTransformsPanel } from "./transforms-panel.ts";
import { registerSavePanel } from "./save-panel.ts";
import { exportVolume, exportSegmentation, type ExportFormat } from "../../logic/export.ts";
import { worldMatrix, rowMul, hardenImageIjkToRAS, hardenPoints, withTranslation, IDENTITY4 } from "../../logic/transforms.ts";
import { createSegmentation, addSegment, applyEffect, computeStats } from "../../logic/segmentation-editor.ts";
import { LocalBlobStore, loadVolumeIntoScene } from "../../logic/ingest.ts";
import { parseNifti } from "../../logic/readers/nifti.ts";
import { makeNifti, SYNTHETIC_DIMS } from "../../logic/readers/synthetic.ts";

const status = (m: string) => { const e = document.getElementById("status"); if (e) e.textContent = m; };

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available"); return; }
  const p = new URLSearchParams(location.search);
  const host = p.get("host") ?? "localhost";
  // Remote servers (S13): ?host=… picks ws/http, ?secure (or an https page) picks wss/https; ?token=… is
  // appended to both WebSockets; ?gui/?ws/?http override the URLs entirely (proxied paths, tunnels).
  const secure = p.has("secure") || location.protocol === "https:";
  const withToken = (u: string) => (p.get("token") ? u + (u.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(p.get("token")!) : u);
  const guiUrl = withToken(p.get("gui") ?? `${secure ? "wss" : "ws"}://${host}:2133/`);
  const wsUrl = withToken(p.get("ws") ?? `${secure ? "wss" : "ws"}://${host}:2132/`);
  const httpBase = p.get("http") ?? `${secure ? "https" : "http"}://${host}:2131/mrson/`;
  const nativeMenus = p.has("nativeMenus");

  const gpu = await initDevice();
  // Two modes. Default = the NATIVE shell (SlicerLive is the app; a ModuleServer, if any, is just a peer).
  // ?legacy = the streamed stock-Slicer chrome hosting SlicerLive views (backwards compatibility).
  const legacy = p.has("legacy");
  const appEl = document.getElementById("app")!;
  let shell: AppShell | null = null;
  let viewsEl: HTMLElement;
  if (legacy) {
    document.body.classList.add("legacy");
    appEl.innerHTML = '<div id="gui"></div><div id="views"></div>';
    viewsEl = document.getElementById("views")!;
  } else {
    shell = mountAppShell(appEl, { title: "SlicerLive" });
    viewsEl = document.createElement("div"); viewsEl.id = "views"; viewsEl.style.cssText = "position:absolute;inset:0";
    shell.main.appendChild(viewsEl);
  }
  const peers = (p.get("peers") ?? "").split(",").map((x) => x.trim()).filter(Boolean);   // extra ModuleServers (ws urls)
  let hook: SlicerLiveHook | null = null;
  const views = mountLiveViews(gpu, viewsEl, { httpBase, wsUrl, peers, onStatus: status, onFrame: () => hook?.frameRendered() });
  // window.__slicerlive: numeric state + settle detection + in-page self-tests (tiers T3/T5, docs/HARNESS.md)
  hook = installIntrospection({
    getCamera: () => { const c = views.camera(); return { azimuth: 0, elevation: 0, distance: Math.hypot(c.position[0] - c.focalPoint[0], c.position[1] - c.focalPoint[1], c.position[2] - c.focalPoint[2]), ...c }; },
    setCamera: () => { /* camera edits go through LiveScene ops (setCameraPose) */ },
    render: () => views.resize(),
    extra: () => ({ nodes: views.live.nodes.size, cells: views.cells(), syncOpen: views.sync.transport.isOpen }),
  });
  registerSelfTest("scene: LiveScene has the view-state nodes (when a peer is connected)", async () => {
    // the snapshot streams in after connect; give it a moment, and don't fail a standalone page with no peer
    const has = () => { const types = new Set([...views.live.nodes.values()].map((n) => n.type)); return ["layout", "camera", "view"].every((t) => types.has(t)); };
    for (let i = 0; i < 25 && !has(); i++) await new Promise((r) => setTimeout(r, 200));
    if (!views.sync.transport.isOpen && views.live.nodes.size === 0) return;   // standalone, nothing to check
    expect(has(), `missing view-state node types; have ${[...new Set([...views.live.nodes.values()].map((n) => n.type))].join(",")}`);
  });
  registerSelfTest("views: every layout cell has a canvas", () => {
    expect(views.cells().length > 0, "no view cells");
    expect(document.querySelectorAll("#views canvas").length >= views.cells().length, "fewer canvases than cells");
  });
  if (shell) {
    const sh = shell;
    // W2 layout picker: Slicer's catalog (logic/layouts.ts) drives the view cells. The picker sits in the
    // toolbar; re-laid out on resize. (When a Slicer peer streams a layout it also calls setCells; the last
    // one wins — a native picker and a peer layout are the same setCells path.)
    let layoutId = DEFAULT_LAYOUT;
    const relayout = (r: DOMRect) => views.setCells(cellsFor(layoutId, r.width, r.height, r.left, r.top).map((c) => ({ id: c.view, kind: c.kind, name: c.view, view: c.px })));
    const sel = document.createElement("select"); sel.className = "sl-module-select"; sel.title = "Layout";
    for (const l of layoutList()) { const o = document.createElement("option"); o.value = String(l.id); o.textContent = l.name; sel.appendChild(o); }
    sel.value = String(layoutId);
    sel.addEventListener("change", () => { layoutId = Number(sel.value); relayout(sh.main.getBoundingClientRect()); (globalThis as unknown as { __layoutId?: number }).__layoutId = layoutId; });
    sh.toolbar.appendChild(sel);
    (globalThis as unknown as { __setLayout?: (id: number) => void; __layoutId?: number }).__setLayout = (id: number) => { layoutId = id; sel.value = String(id); relayout(sh.main.getBoundingClientRect()); (globalThis as unknown as { __layoutId?: number }).__layoutId = id; };
    (globalThis as unknown as { __layoutId?: number }).__layoutId = layoutId;
    sh.onMainResize((r) => relayout(r));
    sh.registerPanel({ id: "welcome", title: "Welcome", order: 0, mount(el) {
      el.innerHTML = `<h2>Welcome to SlicerLive</h2>
        <p>The native application shell. Modules appear in the selector above as they are ported (data loading,
        layouts &amp; view controllers, volumes, markups, segment editor, transforms &amp; models, save/export).</p>
        <h3>Views</h3><p>Red / Yellow / Green slice views and one 3D view, rendered in WebGPU. Wheel to scroll,
        drag to orbit, shift-move for the crosshair.</p>
        <h3>Compatibility</h3><p class="sl-callout">A headless Slicer ModuleServer, when running, appears as a peer:
        its scene streams into these views. The streamed stock-Slicer chrome is available at
        <a href="?legacy">?legacy</a>.</p>`;
    } });
    // W1: local data — chunks from files are served to the DisplayableManagers like any other blob
    const store = new LocalBlobStore();
    registerLoadPanel(sh, { live: views.live, store, onStatus: status, onLoaded: (i) => { views.fitVolume(i.rasLo, i.rasHi, i.ijkToRAS); (globalThis as unknown as { __lastLoad?: unknown }).__lastLoad = i; } });
    registerVolumesPanel(sh, { live: views.live, onStatus: status });
    registerTfEditor(sh, { live: views.live, onStatus: status });
    registerMarkupsPanel(sh, { live: views.live, onStatus: status });
    registerSegEditorPanel(sh, { live: views.live, store, onStatus: status });
    registerTransformsPanel(sh, { live: views.live, onStatus: status });
    registerSavePanel(sh, { live: views.live, onStatus: status });
    Object.assign(globalThis, {
      __savableNodes: () => [...views.live.nodes.values()].filter((n) => (n.type === "image" || n.type === "segmentation") && n.zarr).map((n) => ({ id: n.id, name: n.name as string, type: n.type })),
      __exportNode: async (id: string, format: string) => {
        const n = views.live.nodes.get(id);
        const r = n?.type === "segmentation" ? await exportSegmentation(views.live, id, format === "nrrd-gz" ? "nrrd-gz" : "nrrd") : await exportVolume(views.live, id, format as ExportFormat);
        try { const blob = new Blob([r.bytes], { type: r.mime }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); } catch { /* headless / no DOM download */ }
        return { filename: r.filename, size: r.bytes.byteLength };
      },
    });
    {
      let tfSeq = 0;
      const L = views.live;
      const nodeTransform = (nodeId: string): string | null => ((L.nodes.get(nodeId)?.refs as Record<string, string[]> | undefined)?.transform ?? [])[0] ?? null;
      Object.assign(globalThis, {
        __createTransform: () => { const id = `local-transform-${++tfSeq}`; L.write({ op: "put", id, node: { type: "transform", id, name: `Transform ${tfSeq}`, matrix: IDENTITY4.slice(), refs: {}, source: { mrmlClass: "vtkMRMLLinearTransformNode" }, origin: { local: true } } }); return id; },
        __applyTransformTo: (nodeId: string, transformId: string) => { const n = L.nodes.get(nodeId); if (!n) return; L.write({ op: "patch", id: nodeId, path: "#/refs", value: { ...(n.refs as Record<string, unknown> ?? {}), transform: [transformId] } }); },
        __translateTransform: (transformId: string, dx: number, dy: number, dz: number) => { const t = L.nodes.get(transformId); if (!t) return; L.write({ op: "patch", id: transformId, path: "#/matrix", value: withTranslation(t.matrix as number[], [dx, dy, dz]) }); },
        __identityTransform: (transformId: string) => L.write({ op: "patch", id: transformId, path: "#/matrix", value: IDENTITY4.slice() }),
        __transforms: () => [...L.nodes.values()].filter((n) => n.type === "transform").map((n) => ({ id: n.id, name: n.name, matrix: n.matrix as number[] })),
        __nodeTransform: nodeTransform,
        __nodeWorldMatrix: (nodeId: string) => worldMatrix(nodeTransform(nodeId) ?? undefined, L.nodes),
        __hardenTransform: (nodeId: string) => {
          const n = L.nodes.get(nodeId); const tid = nodeTransform(nodeId); if (!n || !tid) return;
          const world = worldMatrix(tid, L.nodes);
          if (n.type === "image") L.write({ op: "patch", id: nodeId, path: "#/ijkToRAS", value: hardenImageIjkToRAS(n.ijkToRAS as number[], world) });
          else if (n.type === "markup") { const cps = ((n.controlPoints as { position: [number, number, number] }[]) ?? []); const moved = hardenPoints(cps.map((c) => c.position), world); L.write({ op: "patch", id: nodeId, path: "#/controlPoints", value: cps.map((c, i) => ({ ...c, position: moved[i] })) }); }
          const refs = { ...(n.refs as Record<string, unknown> ?? {}) }; delete (refs as Record<string, unknown>).transform; L.write({ op: "patch", id: nodeId, path: "#/refs", value: refs });
        },
      });
    }
    Object.assign(globalThis, {
      __createSegmentation: (srcId: string) => createSegmentation(views.live, store, srcId),
      __addSegment: (segId: string) => addSegment(views.live, segId),
      __applyEffect: (segId: string, effect: string, params: Record<string, unknown>) => applyEffect(views.live, store, segId, effect as Parameters<typeof applyEffect>[3], params as Parameters<typeof applyEffect>[4]),
      __segmentations: () => [...views.live.nodes.values()].filter((n) => n.type === "segmentation").map((n) => ({ segId: n.id, name: n.name, segments: (n.segments ?? []) })),
      __setSegmentProp: (segId: string, labelValue: number, prop: string, value: unknown) => { const n = views.live.nodes.get(segId); if (!n) return; const segs = ((n.segments as { labelValue: number }[]) ?? []).map((s) => s.labelValue === labelValue ? { ...s, [prop]: value } : s); views.live.write({ op: "patch", id: segId, path: "#/segments", value: segs }); },
      __segmentStats: (segId: string) => computeStats(views.live, segId),
    });
    registerSelfTest("volumes: auto W/L gives window>0 and level in range; presets + threshold + color table apply", async () => {
      const vol = await parseNifti(makeNifti({ sform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] }), "wl-selftest");
      const r = await loadVolumeIntoScene(views.live, store, vol, { name: "wl-selftest" });
      const g = globalThis as unknown as { __volumeDisplay: (id: string) => { window: number; level: number; autoWindowLevel: boolean; applyThreshold: boolean; threshold: [number, number]; colorTableId: string } | null; __wlPreset: (id: string, n: string) => void; __setThreshold: (id: string, on: boolean, lo?: number, hi?: number) => void; __setColorTable: (id: string, t: string) => void };
      const d0 = g.__volumeDisplay(r.imageId); expect(!!d0 && d0.window > 0 && d0.autoWindowLevel, "auto W/L: window>0 and autoWindowLevel");
      g.__wlPreset(r.imageId, "CT Bone"); const dp = g.__volumeDisplay(r.imageId); expect(!!dp && dp.window === 1800 && dp.level === 400 && dp.autoWindowLevel === false, "CT Bone preset -> 1800/400, auto off");
      g.__setThreshold(r.imageId, true, 10, 90); const dt = g.__volumeDisplay(r.imageId); expect(!!dt && dt.applyThreshold && dt.threshold[0] === 10 && dt.threshold[1] === 90, "threshold applied");
      g.__setColorTable(r.imageId, "vtkMRMLColorTableNodeRainbow"); const dc = g.__volumeDisplay(r.imageId); expect(!!dc && dc.colorTableId === "vtkMRMLColorTableNodeRainbow" && views.live.nodes.has("vtkMRMLColorTableNodeRainbow"), "color table attached");
      // leave the scene as found
      const comps = [...views.live.nodes.values()].filter((n) => n.type === "sliceComposite");
      const others = [...views.live.nodes.values()].filter((n) => n.type === "image" && n.id !== r.imageId);
      for (const c of comps) views.live.write(others.length ? { op: "patch", id: c.id, path: "#/refs/background", value: [others[others.length - 1].id] } : { op: "del", id: c.id });
      for (const n of r.nodes) views.live.write({ op: "del", id: n.id });
    });
    registerSelfTest("ingest: a synthetic NIfTI becomes an image node the slices can show", async () => {
      const vol = await parseNifti(makeNifti({ sform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] }), "selftest");
      const before = views.live.nodes.size;
      const r = await loadVolumeIntoScene(views.live, store, vol, { name: "selftest" });
      const img = views.live.nodes.get(r.imageId);
      expect(!!img && JSON.stringify(img.dims) === JSON.stringify(SYNTHETIC_DIMS), "image node missing or wrong dims");
      expect(views.live.nodes.size > before, "no nodes added");
      const comps = [...views.live.nodes.values()].filter((n) => n.type === "sliceComposite");
      expect(comps.length >= 3 && comps.every((c) => (c.refs as { background?: string[] }).background?.[0] === r.imageId), "composites do not point at the new volume");
      // put the previous background back so a mirrored scene is left as found
      const others = [...views.live.nodes.values()].filter((n) => n.type === "image" && n.id !== r.imageId);
      for (const c of comps) views.live.write(others.length ? { op: "patch", id: c.id, path: "#/refs/background", value: [others[others.length - 1].id] } : { op: "del", id: c.id });
      for (const n of r.nodes) views.live.write({ op: "del", id: n.id });
    });
    sh.setStatus("SlicerLive — native shell");
    // theme self-tests: the dark theme keeps readable contrast and Slicer's view colours
    const rgb = (c: string) => { const m = c.match(/\d+(\.\d+)?/g) ?? []; return [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0]; };
    const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const contrast = (a: string, b: string) => { const la = lum(rgb(a)), lb = lum(rgb(b)); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
    const token = (name: string) => { const probe = document.createElement("span"); probe.style.color = `var(${name})`; document.body.appendChild(probe); const v = getComputedStyle(probe).color; probe.remove(); return v; };
    registerSelfTest("theme: text on surfaces meets WCAG AA (4.5:1)", () => {
      for (const [fg, bg] of [["--sl-fg", "--sl-surface"], ["--sl-fg", "--sl-surface-2"], ["--sl-fg", "--sl-bg"], ["--sl-accent-fg", "--sl-accent"]]) {
        const c = contrast(token(fg), token(bg)); expect(c >= 4.5, `${fg} on ${bg}: ${c.toFixed(2)}:1`);
      }
      expect(contrast(token("--sl-fg-muted"), token("--sl-surface")) >= 3, "muted text below 3:1");
    });
    registerSelfTest("theme: slice cells carry Slicer's view colours", () => {
      for (const [cell, tok] of [["Red", "--sl-view-red"], ["Yellow", "--sl-view-yellow"], ["Green", "--sl-view-green"]]) {
        const el = document.querySelector(`.lv-cell[data-cell="${cell}"]`) as HTMLElement | null;
        expect(!!el, `no ${cell} cell`);
        if (el!.style.display === "none") continue;            // not in the current layout
        const bar = getComputedStyle(el!, "::before").backgroundColor;
        expect(bar === token(tok), `${cell} bar ${bar} ≠ ${tok} ${token(tok)}`);
      }
    });
  }
  // Sessions: ⌘Z/⌘⇧Z undo/redo, ⌘S export, ⌘B bookmark; ?session=opfs auto-opens browser storage
  const session = mountSessionUI(views.live, { onStatus: status, blobBase: () => views.live.blobBase() });
  if (p.get("session") === "opfs") void session.openOPFS();

  let menus: Menu[] = [];
  if (!legacy) {
    Object.assign(globalThis, { __views: views, __session: session, __shell: shell });
    return;
  }
  const gui = new LegacyGui(document.getElementById("gui")!, guiUrl, {
    onStats: (st) => { const el = document.getElementById("link"); if (el) el.textContent = `${st.rttMs} ms · ${(st.bytesPerS / 1024).toFixed(0)} KB/s · ${st.codec}${st.codec === "png" ? "" : " q" + st.quality}`; },
    hideKinds: nativeMenus ? ["menubar"] : [],
    onViewport: (v) => {
      // the views container spans the whole window so cells can be placed in window coordinates
      viewsEl.style.left = "0px"; viewsEl.style.top = "0px"; viewsEl.style.width = "100%"; viewsEl.style.height = "100%";
      viewsEl.style.pointerEvents = "none";
      void v;
    },
    onCells: (cells) => { views.setCells(cells); for (const el of viewsEl.querySelectorAll<HTMLElement>(".lv-cell")) el.style.pointerEvents = "auto"; },
    onBlocked: (info) => { let b = document.getElementById("blocked"); if (!b) { b = document.createElement("div"); b.id = "blocked"; b.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2000;background:#ffd27a;color:#432;padding:6px 14px;border-radius:8px;font:13px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.25)"; document.body.appendChild(b); } b.hidden = !info; if (info) b.textContent = `Slicer is waiting on a dialog: ${info.title || info.className}`; },
    onMenus: (m) => { menus = m; (globalThis as unknown as { __menus?: unknown }).__menus = m; (globalThis as unknown as { slicerliveMenus?: (m: Menu[]) => void }).slicerliveMenus?.(m); },
    onTitle: (t) => { document.title = t; },
    onStatus: status,
  });
  gui.connect();
  // host hooks (the Deno shell drives native menus through these)
  Object.assign(globalThis, { __gui: gui, __views: views, __session: session, __triggerAction: (id: string) => gui.triggerAction(id), __menuTree: () => menus });
}
main().catch((e) => status("error: " + (e as Error).message));
