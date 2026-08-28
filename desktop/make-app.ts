// Build a double-clickable macOS app for the gallery, and a shareable DMG:
//   deno run -A desktop/make-app.ts [--gallery <dir>] [--thin]
// Default = self-contained: the gallery checkout (minus .git) and the webview
// dylib are copied into Contents/Resources, LSMinimumSystemVersion is set to
// 26.0 (WebGPU in WKWebView), and desktop/build/SlicerLive-<ver>-arm64.dmg is
// produced with a drag-to-Applications layout. --thin instead pins the gallery
// path in Resources/gallery-path.txt (70MB app that serves the checkout in
// place; this machine only) and skips the DMG.
// Icon: docs/slicerlive-logo.png, bbox-trimmed to a tight square → .icns.
import { dirname, join, fromFileUrl, resolve } from "jsr:@std/path@1";
import { makeSquareLogo } from "./icon.ts";

const VERSION = "0.1.0";
const WEBVIEW_RELEASE = "https://github.com/webview/webview_deno/releases/download/0.9.0";

const here = dirname(fromFileUrl(import.meta.url));
const repo = dirname(here);
const buildDir = join(here, "build");
const galleryArg = Deno.args.find((_, i, a) => a[i - 1] === "--gallery");
const gallery = resolve(galleryArg ?? join(dirname(repo), "live"));
const thin = Deno.args.includes("--thin");
const arch = Deno.build.arch === "aarch64" ? "arm64" : Deno.build.arch;

try {
  Deno.statSync(join(gallery, "index.html"));
} catch {
  console.error(`No gallery at ${gallery} (want the pieper/live checkout); pass --gallery <dir>.`);
  Deno.exit(1);
}

async function run(cmd: string, args: string[], opts: { allowFail?: boolean; quiet?: boolean } = {}) {
  const out = await new Deno.Command(cmd, {
    args,
    stdout: opts.quiet ? "null" : "inherit",
    stderr: "inherit",
  }).output();
  if (!out.success && !opts.allowFail) {
    console.error(`FAILED: ${cmd} ${args.join(" ")}`);
    Deno.exit(1);
  }
  return out.success;
}

await Deno.mkdir(buildDir, { recursive: true });

console.log("compiling…");
const bin = join(buildDir, "slicerlive-gallery");
await run(Deno.execPath(), [
  "compile", "-A", "--unstable-ffi",
  "--include", join(here, "server-worker.ts"),
  "-o", bin,
  join(here, "main.ts"),
]);

console.log("assembling SlicerLive.app…");
const app = join(buildDir, "SlicerLive.app");
await Deno.remove(app, { recursive: true }).catch(() => {});
const macos = join(app, "Contents", "MacOS");
const res = join(app, "Contents", "Resources");
await Deno.mkdir(macos, { recursive: true });
await Deno.mkdir(res, { recursive: true });
await Deno.copyFile(bin, join(macos, "SlicerLive"));
await Deno.writeTextFile(
  join(app, "Contents", "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>SlicerLive</string>
  <key>CFBundleIdentifier</key><string>org.slicer.SlicerLiveGallery</string>
  <key>CFBundleName</key><string>SlicerLive</string>
  <key>CFBundleDisplayName</key><string>SlicerLive</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleIconFile</key><string>SlicerLive</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.medical</string>
</dict></plist>
`,
);

if (thin) {
  await Deno.writeTextFile(join(res, "gallery-path.txt"), gallery + "\n");
} else {
  console.log("bundling gallery (this is the ~400MB part)…");
  await Deno.mkdir(join(res, "gallery"), { recursive: true });
  await run("rsync", ["-a", "--exclude", ".git", "--exclude", "publish.py", gallery + "/", join(res, "gallery") + "/"]);

  console.log("bundling libwebview…");
  const dylibName = `libwebview.${Deno.build.arch}.dylib`;
  const cached = join(buildDir, dylibName);
  try {
    Deno.statSync(cached);
  } catch {
    const r = await fetch(`${WEBVIEW_RELEASE}/${dylibName}`);
    if (!r.ok) { console.error(`dylib download failed: ${r.status}`); Deno.exit(1); }
    await Deno.writeFile(cached, new Uint8Array(await r.arrayBuffer()));
  }
  await Deno.mkdir(join(res, "lib"), { recursive: true });
  await Deno.copyFile(cached, join(res, "lib", dylibName));
}

console.log("building icon…");
const logo = join(repo, "docs", "slicerlive-logo.png");
const iconset = join(buildDir, "SlicerLive.iconset");
await Deno.remove(iconset, { recursive: true }).catch(() => {});
await Deno.mkdir(iconset, { recursive: true });
const square = join(buildDir, "logo-square.png");
let iconOk = true;
try {
  await makeSquareLogo(logo, square);
} catch (e) {
  console.warn(`bbox crop failed (${e}) — falling back to padded logo`);
  iconOk = await run("sips", ["-p", "1200", "1200", "--padColor", "14141C", logo, "--out", square], { allowFail: true });
}
if (iconOk) {
  for (const [size, name] of [
    [16, "icon_16x16.png"], [32, "icon_16x16@2x.png"], [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"], [128, "icon_128x128.png"], [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"], [512, "icon_256x256@2x.png"], [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ] as [number, string][]) {
    iconOk = iconOk && await run("sips", ["-z", String(size), String(size), square, "--out", join(iconset, name)], { allowFail: true, quiet: true });
  }
  iconOk = iconOk && await run("iconutil", ["-c", "icns", iconset, "-o", join(res, "SlicerLive.icns")], { allowFail: true });
}
if (!iconOk) console.warn("icon build failed — app will use the generic icon");

await run("codesign", ["--force", "--deep", "-s", "-", app], { allowFail: true });

if (thin) {
  console.log(`\ndone: ${app}\nserves: ${gallery} (thin — this machine only)`);
  Deno.exit(0);
}

console.log("building DMG…");
const dmg = join(buildDir, `SlicerLive-${VERSION}-${arch}.dmg`);
const staging = join(buildDir, "dmg-staging");
await Deno.remove(staging, { recursive: true }).catch(() => {});
await Deno.mkdir(staging, { recursive: true });
await run("cp", ["-R", app, staging]);
await Deno.symlink("/Applications", join(staging, "Applications"));
await Deno.writeTextFile(
  join(staging, "README.txt"),
  `SlicerLive ${VERSION} (Apple Silicon, macOS 26 or newer)

Drag SlicerLive to Applications, then open it.

This build is not notarized. If macOS says it "could not verify" the app, open
System Settings > Privacy & Security, scroll down, and click "Open Anyway"
(once). Demos stream imaging data from public cloud storage the first time they
are opened and are cached after that.
`,
);
await Deno.remove(dmg).catch(() => {});
await run("hdiutil", ["create", "-volname", "SlicerLive", "-srcfolder", staging, "-ov", "-format", "UDZO", dmg], { quiet: true });
await Deno.remove(staging, { recursive: true });

const size = (await Deno.stat(dmg)).size / 1e6;
console.log(`\ndone: ${app}\ndmg:  ${dmg} (${size.toFixed(0)} MB)`);
