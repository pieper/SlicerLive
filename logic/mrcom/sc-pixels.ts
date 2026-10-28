// Turning a captured frame into legal Secondary Capture pixel data.
//
// DOM-FREE on purpose (docs/MRCOM-PLAN.md section 5): the writer takes RAW PIXELS, never a canvas or
// a Blob, so SlicerAlbula's Deno server and any headless caller can produce a bundle. Grabbing the
// frame is the caller's job and lives in render/capture.ts, which is the only part that touches a
// GPU or a DOM.
//
// Uncompressed RGB rather than JPEG: the bytes are trivially verifiable with dcmdump or pydicom, and
// a bundle's value does not depend on squeezing its screenshot. docs/MRCOM-SCENE-BUNDLE.md section 1.

/** A captured frame, as the renderer hands it over. */
export interface CapturedFrame {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel - what a GPU or canvas readback gives. */
  rgba?: Uint8Array;
  /** RGB, 3 bytes per pixel - already packed. */
  rgb?: Uint8Array;
}

/** Pixel data plus the Image Pixel module values that describe it. */
export interface ScPixels {
  rows: number;
  columns: number;
  /** RGB, interleaved by pixel: PlanarConfiguration 0. */
  pixelData: Uint8Array;
  samplesPerPixel: 3;
  photometricInterpretation: "RGB";
  bitsAllocated: 8;
  bitsStored: 8;
  highBit: 7;
  pixelRepresentation: 0;
  planarConfiguration: 0;
}

/** Default long edge. A 1280 px capture is ~2-3 MB uncompressed, which keeps the carrier small. */
export const DEFAULT_MAX_EDGE = 1280;

const pixels = (rows: number, columns: number): ScPixels => ({
  rows,
  columns,
  pixelData: new Uint8Array(rows * columns * 3),
  samplesPerPixel: 3,
  photometricInterpretation: "RGB",
  bitsAllocated: 8,
  bitsStored: 8,
  highBit: 7,
  pixelRepresentation: 0,
  planarConfiguration: 0,
});

/**
 * Build Secondary Capture pixel data from a captured frame, downscaling to `maxEdge`.
 *
 * @param frame the captured frame, RGBA or RGB
 * @param options maxEdge caps the longer side; 0 or Infinity disables downscaling
 * @returns the pixel data and its Image Pixel module values
 */
export function framePixels(
  frame: CapturedFrame,
  options: { maxEdge?: number } = {},
): ScPixels {
  const { width, height } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`capture size must be positive integers, got ${width} x ${height}`);
  }
  const src = packRGB(frame);

  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
  const scale = maxEdge > 0 && Number.isFinite(maxEdge)
    ? Math.min(1, maxEdge / Math.max(width, height))
    : 1;
  if (scale >= 1) {
    const out = pixels(height, width);
    out.pixelData.set(src);
    return out;
  }

  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = pixels(outH, outW);
  boxDownscale(src, width, height, out.pixelData, outW, outH);
  return out;
}

/**
 * A flat placeholder, for when no capture is available.
 *
 * PixelData is type 1 on the Secondary Capture IOD, so it has to exist. A write must never fail
 * because a frame grab did not work - WebGPU readback in particular is only reliable in the same
 * task as the present (docs/MRCOM-PLAN.md section 8), and losing a scene to that would be absurd.
 *
 * @param options rows and columns default to a small banner
 * @returns pixel data filled with a mid-grey
 */
export function placeholderPixels(
  options: { rows?: number; columns?: number; grey?: number } = {},
): ScPixels {
  const rows = options.rows ?? 64;
  const columns = options.columns ?? 256;
  const grey = options.grey ?? 0x30;
  const out = pixels(rows, columns);
  out.pixelData.fill(grey);
  return out;
}

/** RGB bytes for a frame, validating the length against its declared size. */
function packRGB(frame: CapturedFrame): Uint8Array {
  const { width, height, rgba, rgb } = frame;
  const count = width * height;
  if (rgb) {
    if (rgb.length !== count * 3) {
      throw new Error(`rgb is ${rgb.length} bytes but ${width} x ${height} needs ${count * 3}`);
    }
    return rgb;
  }
  if (!rgba) throw new Error("a captured frame needs either rgba or rgb bytes");
  if (rgba.length !== count * 4) {
    throw new Error(`rgba is ${rgba.length} bytes but ${width} x ${height} needs ${count * 4}`);
  }
  // Drop alpha. A capture is composited against the view background already, so there is nothing
  // to blend against and premultiplying would darken it.
  const out = new Uint8Array(count * 3);
  for (let i = 0, j = 0; i < count; i++, j += 3) {
    const k = i * 4;
    out[j] = rgba[k];
    out[j + 1] = rgba[k + 1];
    out[j + 2] = rgba[k + 2];
  }
  return out;
}

/**
 * Box-filter downscale, averaging every source pixel that falls in a destination pixel.
 *
 * A box filter rather than nearest-neighbour because a screenshot is full of thin high-contrast
 * detail - one-pixel outlines, text, slice borders - and point sampling turns those into aliased
 * noise. Averaging is what makes a downscaled capture still readable.
 */
function boxDownscale(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dst: Uint8Array,
  dstW: number,
  dstH: number,
): void {
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor((y * srcH) / dstH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor((x * srcW) / dstW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / dstW));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let row = (sy * srcW + x0) * 3;
        for (let sx = x0; sx < x1; sx++, row += 3) {
          r += src[row];
          g += src[row + 1];
          b += src[row + 2];
          n++;
        }
      }
      const o = (y * dstW + x) * 3;
      dst[o] = Math.round(r / n);
      dst[o + 1] = Math.round(g / n);
      dst[o + 2] = Math.round(b / n);
    }
  }
}
