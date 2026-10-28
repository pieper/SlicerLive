// T1: the Secondary Capture pixel builder. DOM-free, so these run in plain Deno.
import { assert, assertEquals } from "../../mrson/assert.ts";
import { DEFAULT_MAX_EDGE, framePixels, placeholderPixels } from "./sc-pixels.ts";

/** An RGBA frame with a known pattern, plus an alpha that must be dropped. */
function rgbaFrame(width: number, height: number) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = i & 0xff;
    rgba[i * 4 + 1] = (i * 2) & 0xff;
    rgba[i * 4 + 2] = (i * 3) & 0xff;
    rgba[i * 4 + 3] = 0x80; // half alpha: must NOT affect the output
  }
  return { width, height, rgba };
}

Deno.test("an RGBA frame becomes RGB, dropping alpha without blending", () => {
  const out = framePixels(rgbaFrame(4, 3));
  assertEquals(out.rows, 3);
  assertEquals(out.columns, 4);
  assertEquals(out.pixelData.length, 4 * 3 * 3);
  // the first pixel's colour survives unchanged - a premultiply would have darkened it
  assertEquals([out.pixelData[0], out.pixelData[1], out.pixelData[2]], [0, 0, 0]);
  assertEquals([out.pixelData[3], out.pixelData[4], out.pixelData[5]], [1, 2, 3]);
});

Deno.test("the Image Pixel module values are the ones the IOD needs", () => {
  const out = framePixels(rgbaFrame(8, 8));
  assertEquals(out.samplesPerPixel, 3);
  assertEquals(out.photometricInterpretation, "RGB");
  assertEquals(out.bitsAllocated, 8);
  assertEquals(out.bitsStored, 8);
  assertEquals(out.highBit, 7);
  assertEquals(out.pixelRepresentation, 0);
  assertEquals(out.planarConfiguration, 0);
  // and the length is exactly rows x columns x 3, which is what a reader checks
  assertEquals(out.pixelData.length, out.rows * out.columns * 3);
});

Deno.test("an RGB frame passes through without repacking", () => {
  const rgb = new Uint8Array(4 * 3 * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = i & 0xff;
  const out = framePixels({ width: 4, height: 3, rgb });
  assertEquals(out.pixelData, rgb);
});

Deno.test("downscaling caps the long edge and keeps the aspect ratio", () => {
  const out = framePixels(rgbaFrame(3000, 1500));
  assertEquals(out.columns, DEFAULT_MAX_EDGE);
  assertEquals(out.rows, DEFAULT_MAX_EDGE / 2);
  assertEquals(out.pixelData.length, out.rows * out.columns * 3);

  // portrait: the long edge is the height
  const tall = framePixels(rgbaFrame(600, 2400));
  assertEquals(tall.rows, DEFAULT_MAX_EDGE);
  assertEquals(tall.columns, DEFAULT_MAX_EDGE / 4);
});

Deno.test("a frame already within the cap is not resampled", () => {
  const frame = rgbaFrame(100, 50);
  const out = framePixels(frame);
  assertEquals([out.columns, out.rows], [100, 50]);
  // byte-identical to the packed source, i.e. it took the no-scale path
  assertEquals(out.pixelData[3], 1);
  assertEquals(out.pixelData[4], 2);
});

Deno.test("downscaling averages rather than point-samples", () => {
  // A 2x1 checkerboard of black and white. Nearest-neighbour would give pure black or pure white;
  // a box filter gives grey. This is what keeps thin outlines and text legible when a capture is
  // shrunk, which is the whole reason for the filter.
  const rgb = new Uint8Array([0, 0, 0, 255, 255, 255]);
  const out = framePixels({ width: 2, height: 1, rgb }, { maxEdge: 1 });
  assertEquals([out.columns, out.rows], [1, 1]);
  assertEquals([out.pixelData[0], out.pixelData[1], out.pixelData[2]], [128, 128, 128]);
});

Deno.test("a uniform image survives downscaling exactly", () => {
  const rgb = new Uint8Array(40 * 40 * 3).fill(77);
  const out = framePixels({ width: 40, height: 40, rgb }, { maxEdge: 10 });
  assertEquals([out.columns, out.rows], [10, 10]);
  assert(out.pixelData.every((b) => b === 77), "averaging a constant must give the constant");
});

Deno.test("downscaling never produces a zero dimension", () => {
  const rgb = new Uint8Array(1000 * 2 * 3).fill(5);
  const out = framePixels({ width: 1000, height: 2, rgb }, { maxEdge: 10 });
  assert(out.rows >= 1 && out.columns >= 1, `got ${out.columns} x ${out.rows}`);
  assertEquals(out.pixelData.length, out.rows * out.columns * 3);
});

Deno.test("maxEdge of 0 or Infinity disables downscaling", () => {
  for (const maxEdge of [0, Infinity]) {
    const out = framePixels(rgbaFrame(2000, 100), { maxEdge });
    assertEquals(out.columns, 2000, `maxEdge ${maxEdge} should not scale`);
  }
});

Deno.test("a mismatched buffer length is rejected, not written as a malformed instance", () => {
  const cases: [string, () => unknown][] = [
    ["rgba too short", () => framePixels({ width: 4, height: 3, rgba: new Uint8Array(10) })],
    ["rgb too short", () => framePixels({ width: 4, height: 3, rgb: new Uint8Array(10) })],
    ["neither supplied", () => framePixels({ width: 4, height: 3 })],
    ["zero width", () => framePixels({ width: 0, height: 3, rgb: new Uint8Array(0) })],
    ["fractional size", () => framePixels({ width: 4.5, height: 3, rgb: new Uint8Array(40) })],
  ];
  for (const [name, fn] of cases) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    assert(threw, `${name} should throw`);
  }
});

Deno.test("the placeholder is legal pixel data, because PixelData is type 1", () => {
  // A write must never fail just because a frame grab did not work.
  const out = placeholderPixels();
  assertEquals(out.pixelData.length, out.rows * out.columns * 3);
  assert(out.rows > 0 && out.columns > 0);
  assert(out.pixelData.every((b) => b === 0x30));

  const sized = placeholderPixels({ rows: 8, columns: 8, grey: 0xff });
  assertEquals([sized.rows, sized.columns], [8, 8]);
  assert(sized.pixelData.every((b) => b === 0xff));
});
