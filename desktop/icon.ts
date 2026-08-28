// Icon helpers shared by the macOS and Windows builders.
// - makeSquareLogo: docs/slicerlive-logo.png is a vertical composition on a wide
//   dark field; padding it square left big empty bars. Find the artwork's
//   bounding box (pixels differing from the corner background) and cut the
//   tightest square framing it, so the mark fills the icon.
// - writeIco: build a Windows .ico whose entries are PNG-compressed (Vista+).
import { join } from "jsr:@std/path@1";

export async function makeSquareLogo(logo: string, out: string): Promise<void> {
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
  const cropped = new PNG({ width: side, height: side });
  PNG.bitblt(png, cropped, x0, y0, side, side, 0, 0);
  Deno.writeFileSync(out, PNG.sync.write(cropped));
  console.log(`icon crop: bbox ${maxX - minX + 1}x${maxY - minY + 1} → square ${side}px at (${x0},${y0})`);
}

/** Resize `square` PNG to each size with sips; returns the output paths. */
export async function resizeSet(square: string, dir: string, sizes: number[]): Promise<string[]> {
  await Deno.mkdir(dir, { recursive: true });
  const outs: string[] = [];
  for (const s of sizes) {
    const out = join(dir, `${s}.png`);
    const r = await new Deno.Command("sips", {
      args: ["-z", String(s), String(s), square, "--out", out],
      stdout: "null",
      stderr: "inherit",
    }).output();
    if (!r.success) throw new Error(`sips failed for ${s}px`);
    outs.push(out);
  }
  return outs;
}

export async function writeIco(pngs: { size: number; path: string }[], out: string): Promise<void> {
  const blobs = await Promise.all(pngs.map((p) => Deno.readFile(p.path)));
  const headerLen = 6 + 16 * pngs.length;
  const total = headerLen + blobs.reduce((n, b) => n + b.length, 0);
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0, true);            // reserved
  dv.setUint16(2, 1, true);            // type: icon
  dv.setUint16(4, pngs.length, true);  // count
  let offset = headerLen;
  pngs.forEach((p, i) => {
    const e = 6 + 16 * i;
    buf[e] = p.size >= 256 ? 0 : p.size;      // width  (0 means 256)
    buf[e + 1] = p.size >= 256 ? 0 : p.size;  // height
    buf[e + 2] = 0;                           // palette colors
    buf[e + 3] = 0;                           // reserved
    dv.setUint16(e + 4, 1, true);             // planes
    dv.setUint16(e + 6, 32, true);            // bits per pixel
    dv.setUint32(e + 8, blobs[i].length, true);
    dv.setUint32(e + 12, offset, true);
    buf.set(blobs[i], offset);
    offset += blobs[i].length;
  });
  await Deno.writeFile(out, buf);
}
