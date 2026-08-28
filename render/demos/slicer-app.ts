// slicer-app — the stock 3D Slicer interface hosted by SlicerLive: the Qt chrome and module panels
// are streamed from a headless ModuleServer/AppServer (region PNGs + synthetic events, WS B), while
// the slice/3D views in the layout area are SlicerLive's own WebGPU views kept in sync over the
// mrson channel + LiveSync (WS A). Query params: ?host=, ?gui=ws://..., ?ws=ws://..., ?http=...,
// ?nativeMenus=1 (host provides menus; hide the streamed menubar).
import { initDevice } from "../device.ts";
import { LegacyGui, type Menu } from "../moduleserver/legacy-gui.ts";
import { mountLiveViews } from "../moduleserver/live-views.ts";
import { mountSessionUI } from "../moduleserver/session-ui.ts";

const status = (m: string) => { const e = document.getElementById("status"); if (e) e.textContent = m; };

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available"); return; }
  const p = new URLSearchParams(location.search);
  const host = p.get("host") ?? "localhost";
  const guiUrl = p.get("gui") ?? `ws://${host}:2133/`;
  const wsUrl = p.get("ws") ?? `ws://${host}:2132/`;
  const httpBase = p.get("http") ?? `http://${host}:2131/mrson/`;
  const nativeMenus = p.has("nativeMenus");

  const gpu = await initDevice();
  const viewsEl = document.getElementById("views")!;
  const views = mountLiveViews(gpu, viewsEl, { httpBase, wsUrl, onStatus: status });
  // Sessions: ⌘Z/⌘⇧Z undo/redo, ⌘S export, ⌘B bookmark; ?session=opfs auto-opens browser storage
  const session = mountSessionUI(views.live, { onStatus: status, blobBase: () => views.live.blobBase() });
  if (p.get("session") === "opfs") void session.openOPFS();

  let menus: Menu[] = [];
  const gui = new LegacyGui(document.getElementById("gui")!, guiUrl, {
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
