# desktop/ — the live gallery as a native macOS app

A Deno desktop shell for the [pieper/live](https://github.com/pieper/live) gallery checkout
(`../../live`): a local static server (in a Worker, because the webview's native run loop
blocks the main event loop) plus a WKWebView window via `jsr:@webview/webview`.

**WebGPU works in WKWebView on macOS 26** — verified here: adapter with `shader-f16`,
2 GB `maxBufferSize`, `maxTextureDimension3D` 2048 (same as Chrome), and the cardiac and
four-up demos render (smoke-tested by pixel count, not eyeball).

## Run (dev)

```bash
deno run -A --unstable-ffi desktop/main.ts            # serves ../../live, opens the window
deno run -A --unstable-ffi desktop/main.ts --gallery <dir> --port 4180 --url /webgpu/cardiac.html
```

## Build the app + a shareable DMG

```bash
deno run -A desktop/make-app.ts          # → build/SlicerLive.app + build/SlicerLive-<ver>-arm64.dmg
deno run -A desktop/make-app.ts --thin   # → 70MB app that serves ../../live in place (this machine only)
```

`deno compile` + Info.plist + icon (docs/slicerlive-logo.png, bbox-trimmed → .icns) + ad-hoc
codesign. The default build is **self-contained** (~400 MB): the gallery checkout (minus `.git`)
goes in `Contents/Resources/gallery` and `libwebview.aarch64.dylib` in `Contents/Resources/lib`
(`main.ts` points the loader at it via `PLUGIN_URL`, so a fresh machine needs no network to
start). The DMG has the app, an `Applications` symlink, and a README. Verified by mounting the
DMG, hiding this machine's plug cache, and running the app from the volume: it copies the dylib
from the bundle and serves `…/SlicerLive.app/Contents/Resources/gallery`.

Sharing caveats, stated in the DMG's README.txt:
- **Apple Silicon + macOS 26 only** (`LSMinimumSystemVersion` 26.0 — WebGPU in WKWebView
  is on by default from Safari 26; an Intel build needs `deno compile --target x86_64-apple-darwin`
  and the x86_64 dylib).
- **Not notarized.** Copied by scp/USB it opens directly; arriving via AirDrop/browser/mail it is
  quarantined and the recipient must use System Settings → Privacy & Security → *Open Anyway* once.
- Fatal startup errors (no gallery, server port, dylib) show a native `NSAlert` instead of dying
  silently under Finder.

The `--thin` app serves the checkout in place, so `git pull` in the gallery repo updates its
content; its dylib comes from plug's download cache.

## Windows build (cross-compiled from macOS)

```bash
deno run -A desktop/make-win.ts        # → build/SlicerLive-<ver>-win-x64.zip
```

`deno compile --target x86_64-pc-windows-msvc --no-terminal` (GUI subsystem so no console
window appears; fatal errors go to a `MessageBoxW` via `user32.dll` FFI instead) into a folder: `SlicerLive.exe`,
`WebView2Loader.dll` (the webview loader requires it **in the cwd**, so `main.ts` `chdir`s to
the exe's folder on Windows), `lib/webview.dll` (via `PLUGIN_URL`), `gallery/`, `README.txt`.
Platform differences live in `main.ts`: payload beside the exe instead of `Contents/Resources`,
Ctrl instead of ⌘, F1 + a floating `?` button instead of the native Help menu, `rundll32` to
open external links. `macmenu.ts` loads libobjc lazily so importing it is harmless off macOS.

**No custom icon on Windows, deliberately.** `deno compile --icon` (deno 2.9.3 and 2.9.5) makes
an exe that dies on launch with *"Could not find standalone binary section"*: the bundle is a
PE resource (libsui) and the icon patch rewrites the resource tree after it, leaving stray
bytes past the bundle's end marker (bytes after the `d3n0l4nd` magic: 8 in a plain build, 98
with `--icon`). `make-win.ts --with-icon` re-enables it for testing a fixed deno; `icon.ts`
still writes the `.ico`.

**Windows findings (2026-08-27, debugged on a Vultr Windows Server 2022 VM):**
- **Deno 2.9.3's compiled runtime crashes (0xC0000005) on startup for this program** — before the
  first log line, natively compiled or cross-compiled, while a hello-world compiles fine. **Deno
  2.9.6 works.** Build with ≥ 2.9.6.
- **`webview.dll` needs the Visual C++ runtime** (`vcruntime140.dll`, `vcruntime140_1.dll`,
  `msvcp140.dll`). Fresh Windows Server lacks it and `Deno.dlopen` fails with *"The specified
  module could not be found"*. `make-win.ts` ships app-local copies from `vendor/vcruntime/`
  beside the exe and the official `vc_redist.x64.exe` as a fallback.
- Windows Server has no WebView2 runtime; Windows 10/11 do. Vultr does not run startup scripts on
  Windows images, and a fatal `MessageBoxW` blocks forever when launched from an SSH (session 0)
  shell — launch GUI tests through a scheduled task with an interactive logon so they appear in
  the RDP desktop.

**Diagnostics.** On Windows `main.ts` appends every startup milestone to `SlicerLive.log`
beside the exe (and routes `console.log` there, since a GUI-subsystem process has no stdout);
the zip also carries `SlicerLive-console.exe`, the same program without `--no-terminal`, to run
from a Command Prompt for panic/FFI error text. First Windows report (2026-08-25): a crash
("seg fault") after the binary-section fix — the log build exists to locate it.

**Unverified** — there is no Windows machine here, so this build has never been run. What is
established: the exe is a valid PE32+ x64 image, the DLLs are the official 0.9.0 release
binaries, and the same TypeScript runs on macOS. What is not: WebView2's DLL discovery in
practice, WebGPU being enabled by default in the installed WebView2 runtime (Chromium-based, so
expected), SmartScreen behaviour for the unsigned exe (expect "More info → Run anyway"). First
run on a real Windows box should check the exe starts, the gallery loads, and one demo renders.

## Design notes

- **Fixed port 4180** (with +1..+9 fallback), not ephemeral: WebKit partitions its HTTP
  cache by top-level origin, so a stable localhost origin keeps the immutable JS2 blob
  data cached across launches.
- The gallery opens demos with `target="_blank"`, which a bare WKWebView silently ignores.
  An injected init script retargets same-origin links into the window, sends foreign links
  to the system browser (`open`), and adds a ← back button on demo pages plus ⌘[ / ⌘Left (back).
- **Native menu bar** (`macmenu.ts`, ObjC runtime FFI against `libobjc` — webview_deno
  creates the NSApplication but no main menu): App menu (About / Hide / Quit ⌘Q), Edit
  (required for ⌘C/⌘V to reach WKWebView text fields; AppKit auto-appends Writing Tools /
  Dictation / Emoji once it sees a real Edit menu), Window (Minimize ⌘M / Zoom / Close ⌘W),
  and Help. "SlicerLive Help" (⌘?) fires an `NSObject` subclass action whose IMP is a Deno
  `UnsafeCallback` — it re-enters JS while `webview.run()` blocks, same path as `bind()` —
  and opens the documentation dialog (`help-content.ts`): a mac-style modal over the current
  page with mouse/keyboard controls and a demo list built live from `/scenes/index.json`.

## Smoke test

```bash
deno run -A --unstable-ffi desktop/smoke-test.ts --url /webgpu/cardiac.html
```

Opens the demo in the webview, blits the WebGPU canvas into a 2d canvas inside
`requestAnimationFrame`, and passes if >2% of pixels differ from the background within 60 s.
Prints one `SMOKE: {...}` JSON line; exit code 0/1.
