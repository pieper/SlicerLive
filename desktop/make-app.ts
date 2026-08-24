// Build a double-clickable macOS app for the gallery:
//   deno run -A desktop/make-app.ts [--gallery <dir>]
// Produces desktop/build/SlicerLive.app — a `deno compile`d binary in a bundle
// whose Resources/gallery-path.txt pins the gallery checkout to serve (the
// ~385MB of gallery content stays in the checkout; the app is a thin shell).
// Icon: docs/slicerlive-logo.png padded square → .icns via sips + iconutil.
import { dirname, join, fromFileUrl, resolve } from "jsr:@std/path@1";

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

async function run(cmd: string, args: string[], opts: { allowFail?: boolean } = {}) {
  const out = await new Deno.Command(cmd, { args, stdout: "inherit", stderr: "inherit" }).output();
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
await Deno.writeTextFile(join(res, "gallery-path.txt"), gallery + "\n");
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
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleIconFile</key><string>SlicerLive</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.medical</string>
</dict></plist>
`,
);

console.log("building icon…");
const logo = join(repo, "docs", "slicerlive-logo.png");
const iconset = join(buildDir, "SlicerLive.iconset");
await Deno.remove(iconset, { recursive: true }).catch(() => {});
await Deno.mkdir(iconset, { recursive: true });
const square = join(buildDir, "logo-square.png");
// The logo is a vertical composition on a wide dark field; padding it square
// left big empty bars. Instead find the artwork's bounding box (pixels that
// differ from the corner background color), then cut the largest square that
// tightly frames it — the mark fills the icon and macOS 26 rounds the corners.
let iconOk = true;
try {
  const { PNG } = await import("npm:pngjs@7");
  const { Buffer } = await import("node:buffer");
  const png = PNG.sync.read(Buffer.from(Deno.readFileSync(logo)));
  const { width: w, height: h, data } = png;
  const bg = [data[0], data[1], data[2]];
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("logo appears to be a solid color");
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // 3% breathing room, clamped to the image; never exceed the smaller dimension.
  const side = Math.min(Math.round(Math.max(maxX - minX, maxY - minY) * 1.03), Math.min(w, h));
  const x0 = Math.max(0, Math.min(w - side, Math.round(cx - side / 2)));
  const y0 = Math.max(0, Math.min(h - side, Math.round(cy - side / 2)));
  const out = new PNG({ width: side, height: side });
  PNG.bitblt(png, out, x0, y0, side, side, 0, 0);
  Deno.writeFileSync(square, PNG.sync.write(out));
  console.log(`icon crop: bbox ${maxX - minX + 1}x${maxY - minY + 1} → square ${side}px at (${x0},${y0})`);
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
    iconOk = iconOk && await run("sips", ["-z", String(size), String(size), square, "--out", join(iconset, name)], { allowFail: true });
  }
  iconOk = iconOk && await run("iconutil", ["-c", "icns", iconset, "-o", join(res, "SlicerLive.icns")], { allowFail: true });
}
if (!iconOk) console.warn("icon build failed — app will use the generic icon");

await run("codesign", ["--force", "--deep", "-s", "-", app], { allowFail: true });

console.log(`\ndone: ${app}\nserves: ${gallery}\n(open it, or: open '${app}')`);
