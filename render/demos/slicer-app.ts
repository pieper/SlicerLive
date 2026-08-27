// slicer-app — the stock 3D Slicer interface hosted by SlicerLive: the Qt chrome and module panels
// are streamed from a headless ModuleServer/AppServer (region PNGs + synthetic events, WS B), while
// the slice/3D views in the layout area are SlicerLive's own WebGPU views kept in sync over the
// mrson channel + LiveSync (WS A). Query params: ?host=, ?gui=ws://..., ?ws=ws://..., ?http=...,
// ?nativeMenus=1 (host provides menus; hide the streamed menubar).
import { initDevice } from "../device.ts";
import { LegacyGui, type Menu } from "../moduleserver/legacy-gui.ts";
import { mountLiveViews } from "../moduleserver/live-views.ts";

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

  let menus: Menu[] = [];
  const gui = new LegacyGui(document.getElementById("gui")!, guiUrl, {
    hideKinds: nativeMenus ? ["menubar"] : [],
    onViewport: (v) => {
      viewsEl.style.left = v.x + "px"; viewsEl.style.top = v.y + "px";
      viewsEl.style.width = v.w + "px"; viewsEl.style.height = v.h + "px";
      views.resize();
    },
    onMenus: (m) => { menus = m; (globalThis as unknown as { __menus?: unknown }).__menus = m; (globalThis as unknown as { slicerliveMenus?: (m: Menu[]) => void }).slicerliveMenus?.(m); },
    onTitle: (t) => { document.title = t; },
    onStatus: status,
  });
  gui.connect();
  // host hooks (the Deno shell drives native menus through these)
  Object.assign(globalThis, { __gui: gui, __views: views, __triggerAction: (id: string) => gui.triggerAction(id), __menuTree: () => menus });
}
main().catch((e) => status("error: " + (e as Error).message));
