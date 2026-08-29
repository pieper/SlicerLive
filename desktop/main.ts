// SlicerLive gallery as a native desktop app: a local static server (Worker)
// plus a WKWebView window (webview_deno). WebGPU works in WKWebView on this
// platform (verified: adapter with shader-f16, 2GB maxBufferSize, device ok).
//
//   deno run -A --unstable-ffi desktop/main.ts [--gallery <dir>] [--port <n>] [--url <path>]
//
// The gallery is served from the first of: --gallery, $SLICERLIVE_GALLERY,
// <exe>/../Resources/gallery (bundled app), <exe>/../Resources/gallery-path.txt
// (thin app), ../../live relative to this source file.
//
// The preferred port is fixed (not ephemeral) on purpose: WebKit partitions its
// HTTP cache by top-level origin, so a stable localhost origin keeps the
// hundreds of MB of immutable JS2 blob data cached across launches.
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { dirname, join, fromFileUrl, toFileUrl } from "jsr:@std/path@1";
import { installMacMenu, showAlert } from "./macmenu.ts";
import { HELP_INIT_JS } from "./help-content.ts";

const exeDir = dirname(Deno.execPath());
const mac = Deno.build.os === "darwin";

// Step log for remote diagnosis: a --no-terminal Windows exe has no stdout, and
// a native crash leaves no trace, so every milestone is appended to
// SlicerLive.log beside the exe (Windows) or printed (elsewhere). The last line
// says how far startup got.
const logPath = Deno.build.os === "windows" ? join(exeDir, "SlicerLive.log") : null;
function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  if (logPath) {
    try { Deno.writeTextFileSync(logPath, line + "\r\n", { append: true }); } catch { /* read-only dir */ }
  } else console.log(line);
}
log(`start ${Deno.build.os}/${Deno.build.arch} deno ${Deno.version.deno} exe=${Deno.execPath()} cwd=${Deno.cwd()}`);
// A GUI-subsystem exe has no stdout; keep library chatter (plug's "Copying…")
// off it entirely.
if (logPath) console.log = (...a: unknown[]) => log(a.map(String).join(" "));
// The macOS bundle keeps its payload in Contents/Resources; the Windows folder
// build keeps it beside the exe.
const resources = mac ? join(exeDir, "..", "Resources") : exeDir;

// A bundled app ships the webview library in <resources>/lib; point the loader
// at it so a fresh machine needs no network. Must be set before the webview
// module loads. On Windows the loader also insists on ./WebView2Loader.dll in
// the *current directory*, so move there (the folder build ships it there).
const webviewLib = Deno.build.os === "windows"
  ? "webview.dll"
  : `libwebview.${Deno.build.arch}.${mac ? "dylib" : "so"}`;
try {
  Deno.statSync(join(resources, "lib", webviewLib));
  Deno.env.set("PLUGIN_URL", toFileUrl(join(resources, "lib")).href);
  log(`PLUGIN_URL=${Deno.env.get("PLUGIN_URL")}`);
} catch { log("no bundled webview lib; plug will download"); }
if (Deno.build.os === "windows") {
  try { Deno.chdir(exeDir); log(`chdir ${Deno.cwd()}`); } catch (e) { log(`chdir failed: ${e}`); }
}

function fatal(message: string): never {
  log(`FATAL ${message}`);
  console.error(message);
  showAlert("SlicerLive could not start", message);
  Deno.exit(1);
}

const args = parseArgs(Deno.args, {
  string: ["gallery", "port", "url"],
  boolean: ["help"],
});

if (args.help) {
  console.log(
    "SlicerLive desktop gallery\n" +
      "  --gallery <dir>  gallery checkout to serve (default: auto-detect)\n" +
      "  --port <n>       preferred port (default 4180; +1..+9 fallback)\n" +
      "  --url <path>     initial page, e.g. /webgpu/cardiac.html (default /)",
  );
  Deno.exit(0);
}

// Loaded after arg handling: importing this module dlopens the native
// webview library, which must not happen for --help.
log("loading webview module");
const { Webview, SizeHint } = await import("jsr:@webview/webview@0.9.0").catch((e) =>
  fatal(`The native window library failed to load.\n\n${e}`)
);
log("webview module loaded");

function isGalleryRoot(dir: string): boolean {
  try {
    Deno.statSync(join(dir, "index.html"));
    Deno.statSync(join(dir, "scenes", "index.json"));
    return true;
  } catch {
    return false;
  }
}

function findGalleryRoot(): string {
  const candidates: string[] = [];
  if (args.gallery) candidates.push(args.gallery);
  const env = Deno.env.get("SLICERLIVE_GALLERY");
  if (env) candidates.push(env);
  // Bundled app: Resources/gallery. Thin app: Resources/gallery-path.txt holds an absolute path.
  candidates.push(join(resources, "gallery"));
  try {
    const p = Deno.readTextFileSync(join(resources, "gallery-path.txt")).trim();
    if (p) candidates.push(p);
  } catch { /* not a thin bundle */ }
  try {
    candidates.push(join(dirname(dirname(fromFileUrl(import.meta.url))), "..", "live"));
  } catch { /* compiled binary: import.meta.url is not a real file */ }
  for (const c of candidates) if (isGalleryRoot(c)) return c;
  return fatal(
    "Could not find the gallery (index.html + scenes/index.json).\n\nTried:\n  " +
      candidates.join("\n  ") + "\n\nPass one with --gallery <dir> or $SLICERLIVE_GALLERY.",
  );
}

const root = findGalleryRoot();
log(`gallery root ${root}`);
const preferredPort = args.port ? Number(args.port) : 4180;

const worker = new Worker(new URL("./server-worker.ts", import.meta.url), { type: "module" });
const port = await new Promise<number>((resolve) => {
  worker.onmessage = (e) => resolve(e.data.port);
  worker.onerror = (e) => fatal(`The local gallery server could not start.\n\n${e.message}`);
  worker.postMessage({ root, port: preferredPort });
});
const origin = `http://127.0.0.1:${port}`;
log(`SlicerLive gallery: serving ${root} at ${origin}`);

log("creating webview window");
const webview = new Webview(false, { width: 1440, height: 900, hint: SizeHint.NONE });
log("webview created");
webview.title = "SlicerLive";

// External http(s) links open in the system browser.
webview.bind("slicerliveOpenExternal", (url: string) => {
  if (!/^https?:\/\//.test(url)) return;
  const [cmd, ...cmdArgs] = Deno.build.os === "windows"
    ? ["rundll32", "url.dll,FileProtocolHandler", url]
    : mac ? ["open", url] : ["xdg-open", url];
  new Deno.Command(cmd, { args: cmdArgs }).spawn();
});
// Native menu bar: App menu with Quit ⌘Q, Edit (clipboard), Window, and a Help
// menu whose "SlicerLive Help" opens the documentation dialog in the page.
installMacMenu("SlicerLive", () => webview.eval("window.__sllShowHelp && __sllShowHelp()"));

// Runs before page scripts on every navigation. The gallery opens demos with
// target=_blank, which a bare WKWebView silently ignores — retarget same-origin
// links into this window and send foreign ones to the system browser. Add a
// small back button on non-index pages plus Cmd-[/Cmd-Left (back); quit/close/
// minimize come from the native menu.
webview.init(`
(() => {
  const sameOrigin = (href) => { try { return new URL(href, location.href).origin === location.origin; } catch { return false; } };
  const goto = (href) => {
    if (sameOrigin(href)) location.href = href;
    else window.slicerliveOpenExternal(new URL(href, location.href).href);
  };
  window.open = (href) => { if (href) goto(href); return null; };
  addEventListener("click", (e) => {
    const a = e.target && e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    if (a.target === "_blank" || !sameOrigin(a.href)) { e.preventDefault(); goto(a.getAttribute("href")); }
  }, true);
  const MOD = ${mac ? '"metaKey"' : '"ctrlKey"'};
  addEventListener("keydown", (e) => {
    if (e.key === "F1") { e.preventDefault(); window.__sllShowHelp && __sllShowHelp(); return; }
    if (!e[MOD]) return;
    if (e.key === "[" || e.key === "ArrowLeft") {
      const t = e.target, tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (t && t.isContentEditable)) return;
      e.preventDefault(); history.back();
    }
  }, true);
` + HELP_INIT_JS + `
  // Floating buttons: ← on demo pages; ? too where there is no native Help menu.
  const button = (text, title, left, onclick) => {
    const b = document.createElement("div");
    b.textContent = text; b.title = title;
    b.style.cssText = "position:fixed;top:10px;left:" + left + "px;z-index:2147483647;width:34px;height:34px;" +
      "border-radius:17px;background:rgba(20,20,28,.55);color:#d8d8e0;border:1px solid rgba(160,180,210,.35);" +
      "display:flex;align-items:center;justify-content:center;font:20px -apple-system,system-ui,sans-serif;" +
      "cursor:pointer;opacity:.45;transition:opacity .15s;user-select:none;-webkit-user-select:none";
    b.onmouseenter = () => (b.style.opacity = "1");
    b.onmouseleave = () => (b.style.opacity = ".45");
    b.onclick = onclick;
    document.body.appendChild(b);
  };
  // No WebGPU adapter = every demo silently stays black. Say so in the page.
  const checkGpu = async () => {
    let reason = "";
    if (!navigator.gpu) reason = "navigator.gpu is not available in this WebView.";
    else {
      try {
        const a = await navigator.gpu.requestAdapter();
        if (!a) reason = "navigator.gpu.requestAdapter() returned no adapter — this machine has no GPU/driver the browser engine will use.";
      } catch (e) { reason = "requestAdapter failed: " + e; }
    }
    if (!reason) return;
    const b = document.createElement("div");
    b.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483646;padding:12px 18px;background:#5a1e1e;" +
      "color:#ffe3e3;font:13px/1.45 -apple-system,system-ui,sans-serif;border-top:1px solid #a33;box-shadow:0 -6px 20px rgba(0,0,0,.4)";
    b.innerHTML = "<b>WebGPU is not available, so the demos cannot render.</b> " + reason +
      " SlicerLive renders on your GPU through WebGPU (Chrome/Edge 113+, Safari 26+, WebView2 with a GPU driver)." +
      "${mac ? "" : " Without a GPU you can try SlicerLive-softgpu.cmd for a slow software fallback."}" +
      "<span style='float:right;cursor:pointer;opacity:.7' title='dismiss'>✕</span>";
    b.querySelector("span").onclick = () => b.remove();
    document.body.appendChild(b);
  };
  addEventListener("DOMContentLoaded", () => {
    checkGpu();
    const home = location.pathname === "/" || location.pathname === "/index.html";
    let left = 10;
    if (!home) {
      button("←", "Back to gallery (${mac ? "⌘[" : "Ctrl+["})", left,
        () => (history.length > 1 ? history.back() : (location.href = "/")));
      left += 42;
    }
    if (!${mac}) button("?", "Help (F1)", left, () => __sllShowHelp());
  });
})();
`);

webview.navigate(origin + (args.url ?? "/"));
log("entering run loop");
webview.run(); // blocks until the window closes
log("run loop exited");
Deno.exit(0);
