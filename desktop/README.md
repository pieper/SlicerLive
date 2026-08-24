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

## Build the app

```bash
deno run -A desktop/make-app.ts        # → desktop/build/SlicerLive.app
```

`deno compile` + Info.plist + icon (docs/slicerlive-logo.png → .icns) + ad-hoc codesign.
The app is a thin shell: it serves the gallery checkout in place (path pinned in
`Contents/Resources/gallery-path.txt`), so `git pull` in the gallery repo updates the app's
content. First run on a *new machine* downloads `libwebview.aarch64.dylib` from GitHub
(plug cache); after that it works offline apart from the JS2 blob data.

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
