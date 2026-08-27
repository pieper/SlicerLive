// SlicerLive desktop POC: the stock 3D Slicer interface hosted by SlicerLive.
//   deno run -A --unstable-ffi desktop/slicer-demo.ts [--slicer /opt/sr] [--no-launch] [--port 4181]
// Launches a headless Qt6 Slicer as an AppServer+ModuleServer (ModuleServer/launch.ts, offscreen
// QPA, invisible), serves this repo, opens a WKWebView on render/demos/slicer-app.html — Qt chrome +
// module panels streamed as pixels, slice/3D views rendered by SlicerLive and kept in sync over
// mrson/LiveSync — and builds REAL macOS menus from the AppServer's menu tree (qtmenu.ts); menu
// picks are forwarded to Slicer as triggerAction. Separate entry point from main.ts on purpose.
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { installMacMenu } from "./macmenu.ts";
import { installQtMenus, type Menu } from "./qtmenu.ts";

const args = parseArgs(Deno.args, { string: ["slicer", "port", "url"], boolean: ["no-launch"], default: { slicer: "/opt/sr", port: "4181" } });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HOME = Deno.env.get("HOME") ?? ".";
const statePath = `${HOME}/.slicerlive/moduleserver/moduleserver-2132.json`;
const log = (m: string) => console.error(`slicer-demo: ${m}`);

// 1. ModuleServer (AppServer + ModuleServer roles) — unless one is already up
let child: Deno.ChildProcess | null = null;
async function readState(): Promise<{ ports: Record<string, number> } | null> { try { return JSON.parse(await Deno.readTextFile(statePath)); } catch { return null; } }
let state = await readState();
if (!state && !args["no-launch"]) {
  log(`launching ModuleServer from ${args.slicer}`);
  child = new Deno.Command(Deno.execPath(), { args: ["run", "--allow-run", "--allow-read", "--allow-write", "--allow-env", `${ROOT}/ModuleServer/launch.ts`, "--slicer", args.slicer!, "--roles", "app,module"], stdout: "null", stderr: "inherit" }).spawn();
  for (let i = 0; i < 120 && !state; i++) { await new Promise((r) => setTimeout(r, 2000)); state = await readState(); }
  if (!state) { log("ModuleServer did not become READY"); child.kill("SIGTERM"); Deno.exit(2); }
}
if (!state) { log("no ModuleServer running (state file missing) and --no-launch given"); Deno.exit(2); }
log(`ModuleServer ports ${JSON.stringify(state.ports)}`);

// 1b. the page bundle is gitignored (render/demos/*.js): build it if missing or older than its sources
const bundle = `${ROOT}/render/demos/slicer-app.js`;
async function mtime(p: string) { try { return (await Deno.stat(p)).mtime?.getTime() ?? 0; } catch { return 0; } }
const srcNewest = Math.max(...await Promise.all([`${ROOT}/render/demos/slicer-app.ts`, `${ROOT}/render/moduleserver/legacy-gui.ts`, `${ROOT}/render/moduleserver/live-views.ts`].map(mtime)));
if (await mtime(bundle) < srcNewest) {
  log("bundling render/demos/slicer-app.js");
  const r = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "npm:esbuild", `${ROOT}/render/demos/slicer-app.ts`, "--bundle", "--format=esm", `--outfile=${bundle}`, "--log-level=warning"] }).output();
  if (!r.success) { log("esbuild failed: " + new TextDecoder().decode(r.stderr)); Deno.exit(2); }
}

// 2. static server for this repo (the page + bundles), in a Worker (webview.run blocks the main loop)
const worker = new Worker(new URL("./server-worker.ts", import.meta.url), { type: "module" });
const port = await new Promise<number>((resolve) => { worker.onmessage = (e) => resolve(e.data.port); worker.postMessage({ root: ROOT, port: Number(args.port) }); });
const origin = `http://127.0.0.1:${port}`;

// 3. window + native menus
const { Webview, SizeHint } = await import("jsr:@webview/webview@0.9.0");
const webview = new Webview(false, { width: 1440, height: 900, hint: SizeHint.NONE });
webview.title = "3D Slicer — SlicerLive";
installMacMenu("SlicerLive", () => {});
webview.bind("slicerliveMenus", (menus: Menu[]) => {
  log(`menus: ${menus.map((m) => m.title.replace("&", "")).join(" ")}`);
  installQtMenus(menus, (id) => webview.eval(`window.__triggerAction && __triggerAction(${JSON.stringify(id)})`));
});
webview.bind("slicerliveStatus", (s: string) => log(`page: ${s}`));
webview.init(`addEventListener("DOMContentLoaded", () => { const o = document.getElementById("status"); if (o) new MutationObserver(() => window.slicerliveStatus(o.textContent)).observe(o, { childList: true, characterData: true, subtree: true }); });`);
const p = state.ports;
webview.navigate(args.url ?? `${origin}/render/demos/slicer-app.html?nativeMenus=1&gui=ws://localhost:${p.gui}/&ws=ws://localhost:${p.ws}/&http=http://localhost:${p.http}/mrson/`);
webview.run();
if (child) { log("stopping ModuleServer"); child.kill("SIGTERM"); }
Deno.exit(0);
