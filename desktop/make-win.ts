// Cross-build the Windows (x64) gallery app from macOS:
//   deno run -A desktop/make-win.ts [--gallery <dir>]
// Produces desktop/build/SlicerLive-<ver>-win-x64.zip containing a folder:
//   SlicerLive.exe          deno compile --target x86_64-pc-windows-msvc, with .ico
//   WebView2Loader.dll      the webview loader requires this in the cwd (main.ts chdirs here)
//   lib/webview.dll         loaded via PLUGIN_URL, so no download on first run
//   gallery/                the pieper/live checkout minus .git
//   README.txt
// Needs the Evergreen WebView2 runtime on the target (present on Windows 10/11).
// NOTE: built but not runnable here — see README for what is unverified.
import { dirname, join, fromFileUrl, resolve } from "jsr:@std/path@1";
import { makeSquareLogo, resizeSet, writeIco } from "./icon.ts";

const VERSION = "0.1.0";
const WEBVIEW_RELEASE = "https://github.com/webview/webview_deno/releases/download/0.9.0";

const here = dirname(fromFileUrl(import.meta.url));
const repo = dirname(here);
const buildDir = join(here, "build");
const galleryArg = Deno.args.find((_, i, a) => a[i - 1] === "--gallery");
const gallery = resolve(galleryArg ?? join(dirname(repo), "live"));

try {
  Deno.statSync(join(gallery, "index.html"));
} catch {
  console.error(`No gallery at ${gallery} (want the pieper/live checkout); pass --gallery <dir>.`);
  Deno.exit(1);
}

async function run(cmd: string, args: string[], quiet = false) {
  const out = await new Deno.Command(cmd, { args, stdout: quiet ? "null" : "inherit", stderr: "inherit" }).output();
  if (!out.success) {
    console.error(`FAILED: ${cmd} ${args.join(" ")}`);
    Deno.exit(1);
  }
}

async function fetchTo(url: string, dest: string) {
  try {
    Deno.statSync(dest);
    return;
  } catch { /* download */ }
  const r = await fetch(url);
  if (!r.ok) { console.error(`download failed ${r.status}: ${url}`); Deno.exit(1); }
  await Deno.writeFile(dest, new Uint8Array(await r.arrayBuffer()));
}

const folderName = "SlicerLive";
const folder = join(buildDir, "win", folderName);
await Deno.remove(folder, { recursive: true }).catch(() => {});
await Deno.mkdir(join(folder, "lib"), { recursive: true });

console.log("building icon…");
const square = join(buildDir, "logo-square.png");
await makeSquareLogo(join(repo, "docs", "slicerlive-logo.png"), square);
const sizes = [16, 32, 48, 256];
const pngs = await resizeSet(square, join(buildDir, "ico"), sizes);
const ico = join(buildDir, "SlicerLive.ico");
await writeIco(sizes.map((size, i) => ({ size, path: pngs[i] })), ico);

// `deno compile --icon` (deno 2.9.3) corrupts the PE resource that holds the
// bundle: the exe dies with "Could not find standalone binary section". The
// icon patch rebuilds the resource tree after libsui has written the bundle
// into it. Opt in with --with-icon only after verifying a newer deno fixes it.
const withIcon = Deno.args.includes("--with-icon");
console.log(`cross-compiling for x86_64-pc-windows-msvc${withIcon ? " (with icon)" : ""}…`);
await run(Deno.execPath(), [
  "compile", "-A", "--unstable-ffi",
  "--target", "x86_64-pc-windows-msvc",
  "--no-terminal", // GUI subsystem: no console window beside the app
  ...(withIcon ? ["--icon", ico] : []),
  "--include", join(here, "server-worker.ts"),
  "-o", join(folder, "SlicerLive.exe"),
  join(here, "main.ts"),
]);

// Console-subsystem twin for diagnosis: run it from a terminal to see stderr
// (panics, FFI errors) that the GUI exe cannot show.
console.log("cross-compiling console variant…");
await run(Deno.execPath(), [
  "compile", "-A", "--unstable-ffi",
  "--target", "x86_64-pc-windows-msvc",
  "--include", join(here, "server-worker.ts"),
  "-o", join(folder, "SlicerLive-console.exe"),
  join(here, "main.ts"),
]);

console.log("fetching webview DLLs…");
await fetchTo(`${WEBVIEW_RELEASE}/webview.dll`, join(buildDir, "webview.dll"));
await fetchTo(`${WEBVIEW_RELEASE}/WebView2Loader.dll`, join(buildDir, "WebView2Loader.dll"));
await Deno.copyFile(join(buildDir, "webview.dll"), join(folder, "lib", "webview.dll"));
await Deno.copyFile(join(buildDir, "WebView2Loader.dll"), join(folder, "WebView2Loader.dll"));

// webview.dll links against the VC++ runtime, which a fresh Windows Server
// lacks (Deno.dlopen then fails with "The specified module could not be
// found"). Ship app-local copies beside the exe, plus the official installer
// as a fallback.
console.log("bundling VC++ runtime…");
for await (const f of Deno.readDir(join(here, "vendor", "vcruntime"))) {
  if (f.name.endsWith(".dll")) await Deno.copyFile(join(here, "vendor", "vcruntime", f.name), join(folder, f.name));
}
await fetchTo("https://aka.ms/vs/17/release/vc_redist.x64.exe", join(buildDir, "vc_redist.x64.exe"));
await Deno.copyFile(join(buildDir, "vc_redist.x64.exe"), join(folder, "vc_redist.x64.exe"));

console.log("bundling gallery (~400MB)…");
await run("rsync", ["-a", "--exclude", ".git", "--exclude", "publish.py", gallery + "/", join(folder, "gallery") + "/"]);

await Deno.writeTextFile(
  join(folder, "README.txt"),
  `SlicerLive ${VERSION} for Windows (x64)\r
\r
Unzip anywhere and run SlicerLive.exe. Keep the exe together with\r
WebView2Loader.dll, lib\\ and gallery\\ — it serves the gallery from beside itself.\r
\r
Needs the Microsoft Edge WebView2 runtime (preinstalled on Windows 10/11; on\r
Windows Server install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703)\r
and a GPU/driver with WebGPU support in Edge. The Visual C++ runtime DLLs are\r
included beside the exe; if startup still reports a missing module, run the\r
bundled vc_redist.x64.exe once. The exe is unsigned, so SmartScreen may show\r
"Windows protected your PC": click "More info", then "Run anyway".\r
\r
Demos stream imaging data from public cloud storage the first time they are\r
opened and are cached after that. F1 or the ? button opens help.\r
\r
If it does not start: SlicerLive.log (written next to the exe) records each\r
startup step - the last line says how far it got. SlicerLive-console.exe is the\r
same app built as a console program; run it from a Command Prompt to see any\r
error text the windowed version cannot show. Please send both when reporting.\r
`,
);

console.log("zipping…");
const zip = join(buildDir, `SlicerLive-${VERSION}-win-x64.zip`);
await Deno.remove(zip).catch(() => {});
await run("ditto", ["-c", "-k", "--norsrc", "--keepParent", folder, zip], true);
const size = (await Deno.stat(zip)).size / 1e6;
console.log(`\ndone: ${zip} (${size.toFixed(0)} MB)\nfolder: ${folder}`);
