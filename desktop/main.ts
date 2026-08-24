// SlicerLive gallery as a native desktop app: a local static server (Worker)
// plus a WKWebView window (webview_deno). WebGPU works in WKWebView on this
// platform (verified: adapter with shader-f16, 2GB maxBufferSize, device ok).
//
//   deno run -A --unstable-ffi desktop/main.ts [--gallery <dir>] [--port <n>] [--url <path>]
//
// The gallery is served from the first of: --gallery, $SLICERLIVE_GALLERY,
// <exe>/../Resources/gallery-path.txt (app bundle), <exe>/../Resources/gallery,
// ../../live relative to this source file.
//
// The preferred port is fixed (not ephemeral) on purpose: WebKit partitions its
// HTTP cache by top-level origin, so a stable localhost origin keeps the
// hundreds of MB of immutable JS2 blob data cached across launches.
import { Webview, SizeHint } from "jsr:@webview/webview@0.9.0";
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { dirname, join, fromFileUrl } from "jsr:@std/path@1";
import { installMacMenu } from "./macmenu.ts";
import { HELP_INIT_JS } from "./help-content.ts";

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
  const exeDir = dirname(Deno.execPath());
  const candidates: string[] = [];
  if (args.gallery) candidates.push(args.gallery);
  const env = Deno.env.get("SLICERLIVE_GALLERY");
  if (env) candidates.push(env);
  // App bundle: Contents/Resources/gallery-path.txt holds an absolute path.
  try {
    const p = Deno.readTextFileSync(join(exeDir, "..", "Resources", "gallery-path.txt")).trim();
    if (p) candidates.push(p);
  } catch { /* not a bundle */ }
  candidates.push(join(exeDir, "..", "Resources", "gallery"));
  try {
    candidates.push(join(dirname(dirname(fromFileUrl(import.meta.url))), "..", "live"));
  } catch { /* compiled binary: import.meta.url is not a real file */ }
  for (const c of candidates) if (isGalleryRoot(c)) return c;
  console.error(
    "Could not find a gallery checkout (index.html + scenes/index.json).\n" +
      "Tried:\n  " + candidates.join("\n  ") +
      "\nPass one with --gallery <dir> or $SLICERLIVE_GALLERY.",
  );
  Deno.exit(1);
}

const root = findGalleryRoot();
const preferredPort = args.port ? Number(args.port) : 4180;

const worker = new Worker(new URL("./server-worker.ts", import.meta.url), { type: "module" });
const port = await new Promise<number>((resolve) => {
  worker.onmessage = (e) => resolve(e.data.port);
  worker.postMessage({ root, port: preferredPort });
});
const origin = `http://127.0.0.1:${port}`;
console.log(`SlicerLive gallery: serving ${root} at ${origin}`);

const webview = new Webview(false, { width: 1440, height: 900, hint: SizeHint.NONE });
webview.title = "SlicerLive";

// External http(s) links open in the system browser.
webview.bind("slicerliveOpenExternal", (url: string) => {
  if (/^https?:\/\//.test(url)) new Deno.Command("open", { args: [url] }).spawn();
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
  addEventListener("keydown", (e) => {
    if (!e.metaKey) return;
    if (e.key === "[" || e.key === "ArrowLeft") {
      const t = e.target, tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (t && t.isContentEditable)) return;
      e.preventDefault(); history.back();
    }
  }, true);
` + HELP_INIT_JS + `
  addEventListener("DOMContentLoaded", () => {
    if (location.pathname === "/" || location.pathname === "/index.html") return;
    const b = document.createElement("div");
    b.textContent = "←";
    b.title = "Back to gallery (⌘[)";
    b.style.cssText = "position:fixed;top:10px;left:10px;z-index:2147483647;width:34px;height:34px;" +
      "border-radius:17px;background:rgba(20,20,28,.55);color:#d8d8e0;border:1px solid rgba(160,180,210,.35);" +
      "display:flex;align-items:center;justify-content:center;font:20px -apple-system,sans-serif;" +
      "cursor:pointer;opacity:.45;transition:opacity .15s;user-select:none;-webkit-user-select:none";
    b.onmouseenter = () => (b.style.opacity = "1");
    b.onmouseleave = () => (b.style.opacity = ".45");
    b.onclick = () => (history.length > 1 ? history.back() : (location.href = "/"));
    document.body.appendChild(b);
  });
})();
`);

webview.navigate(origin + (args.url ?? "/"));
webview.run(); // blocks until the window closes
Deno.exit(0);
