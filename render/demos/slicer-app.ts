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
  const viewsEl = document.getElementById("views")!;
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
  registerSelfTest("scene: LiveScene has the view-state nodes", () => {
    const types = new Set([...views.live.nodes.values()].map((n) => n.type));
    for (const t of ["layout", "camera", "view"]) expect(types.has(t), `missing node type ${t}`);
  });
  registerSelfTest("views: every layout cell has a canvas", () => {
    expect(views.cells().length > 0, "no view cells");
    expect(document.querySelectorAll("#views canvas").length >= views.cells().length, "fewer canvases than cells");
  });
  // Sessions: ⌘Z/⌘⇧Z undo/redo, ⌘S export, ⌘B bookmark; ?session=opfs auto-opens browser storage
  const session = mountSessionUI(views.live, { onStatus: status, blobBase: () => views.live.blobBase() });
  if (p.get("session") === "opfs") void session.openOPFS();

  let menus: Menu[] = [];
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
