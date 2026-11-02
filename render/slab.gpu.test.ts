// T2 (GPU): thick-slab compositing — MIP / MinIP / mean over a slab, and the offsets the
// uniform block depends on. A slab that reads the wrong voxels is invisible in a screenshot but
// wrong in a measurement, so this pins the arithmetic rather than the appearance.
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { initDevice } from "./device.ts";
import { SliceRenderer } from "./slice-renderer.ts";
import { patientToTexture, volumeAABB } from "./mat4.ts";

const gpu = await initDevice().catch(() => null);

/** A volume whose value depends ONLY on k (slice index), so a slab along the axial normal has a
 *  known max / min / mean. 1 mm isotropic, so slab millimetres and slice counts agree. */
function rampVolume(d: number): Float32Array {
  const v = new Float32Array(d * d * d);
  for (let k = 0; k < d; k++) for (let j = 0; j < d; j++) for (let i = 0; i < d; i++) v[(k * d + j) * d + i] = k;
  return v;
}

/** Local r32float upload. textures.ts does the same thing, but importing it drags in a
 *  BufferSource lib-strictness complaint that CI deliberately excludes from `deno check`. */
function scalarTexture(dev: GPUDevice, data: Float32Array, d: number): GPUTexture {
  const tex = dev.createTexture({
    size: [d, d, d],
    dimension: "3d",
    format: "r32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  dev.queue.writeTexture({ texture: tex }, data.buffer as ArrayBuffer, { bytesPerRow: d * 4, rowsPerImage: d }, [d, d, d]);
  return tex;
}

function makeRenderer(d: number) {
  const dims: [number, number, number] = [d, d, d];
  const spacing: [number, number, number] = [1, 1, 1];
  const [lo, hi] = volumeAABB(dims, spacing);
  const sr = new SliceRenderer(gpu!);
  sr.setVolume(patientToTexture(dims, spacing), lo, hi);
  sr.setTextures(scalarTexture(gpu!.device, rampVolume(d), d));
  // Map the full value range onto [0,1] so a read-back grey level inverts to a scalar.
  sr.setWindowLevel(d - 1, (d - 1) / 2);
  return sr;
}

/** Grey level at the centre of the view, as a scalar in the volume's own units.
 *
 *  The shader writes srgb2physical(col) and renderToRGBA reads back through a non-sRGB surface,
 *  so the two cancel and the byte is LINEAR in the windowed value. (Verified against known
 *  single-sample, full-depth MIP and full-depth MinIP values before relying on it.) */
async function centreScalar(sr: SliceRenderer, d: number, size = 48): Promise<number> {
  const px = await sr.renderToRGBA(size, size);
  const o = ((size >> 1) * size + (size >> 1)) * 4;
  return (px[o] / 255) * (d - 1);
}

Deno.test({
  name: "slab: single sample reads the plane itself",
  ignore: !gpu,
  fn: async () => {
    const d = 32, sr = makeRenderer(d);
    sr.setSlab(0, "single");
    sr.setPlane("axial", 0.5);
    const v = await centreScalar(sr, d);
    assertAlmostEquals(v, (d - 1) * 0.5, 1.5, "mid-plane should read the mid value");
  },
});

Deno.test({
  name: "slab: MIP over the FULL depth reads the volume maximum everywhere",
  ignore: !gpu,
  fn: async () => {
    const d = 32, sr = makeRenderer(d);
    sr.setSlab(d * 2, "max");            // thicker than the volume: every ray spans it all
    for (const off of [0.2, 0.5, 0.8]) {
      sr.setPlane("axial", off);
      const v = await centreScalar(sr, d);
      assertAlmostEquals(v, d - 1, 1.5, `MIP at offset ${off} must be the global max`);
    }
  },
});

Deno.test({
  name: "slab: MinIP over the full depth reads the volume minimum",
  ignore: !gpu,
  fn: async () => {
    const d = 32, sr = makeRenderer(d);
    sr.setSlab(d * 2, "min");
    sr.setPlane("axial", 0.5);
    assertAlmostEquals(await centreScalar(sr, d), 0, 1.5);
  },
});

Deno.test({
  name: "slab: mean over the full depth reads the volume average",
  ignore: !gpu,
  fn: async () => {
    const d = 32, sr = makeRenderer(d);
    sr.setSlab(d * 2, "mean");
    sr.setPlane("axial", 0.5);
    assertAlmostEquals(await centreScalar(sr, d), (d - 1) / 2, 2);
  },
});

Deno.test({
  name: "slab is CENTRED on the plane, not started at it",
  ignore: !gpu,
  fn: async () => {
    // A 10 mm MIP centred at k=16 spans k=11..21, so its max is ~21 — not ~26 (if it started at
    // the plane) and not ~16 (if it ignored the slab).
    const d = 32, sr = makeRenderer(d);
    sr.setSlab(10, "max");
    sr.setPlane("axial", 0.5);
    const v = await centreScalar(sr, d);
    assert(v > 18 && v < 24, `expected ~21 for a centred 10 mm MIP, got ${v.toFixed(1)}`);
  },
});

Deno.test({
  name: "slab thickness is reported back, and 0 means single-slice",
  ignore: !gpu,
  fn: () => {
    const sr = makeRenderer(8);
    sr.setSlab(12, "max");
    assertAlmostEquals(sr.slabThicknessMm(), 12, 1e-6);
    sr.setSlab(0, "max");
    assertAlmostEquals(sr.slabThicknessMm(), 0, 1e-6);
    sr.setSlab(12, "single");
    assertAlmostEquals(sr.slabThicknessMm(), 0, 1e-6);
  },
});

Deno.test({
  name: "slab: the FOREGROUND layer is composited through the slab too, with its own mode",
  ignore: !gpu,
  fn: async () => {
    // Background flat at 0; foreground is the k-ramp. With the foreground fully opaque and a
    // full-depth slab, the displayed value IS the foreground projection — so max vs mean on the
    // foreground must differ, which only happens if the foreground is slabbed at all.
    const d = 32;
    const flat = new Float32Array(d * d * d);                     // all zero
    const dims: [number, number, number] = [d, d, d];
    const spacing: [number, number, number] = [1, 1, 1];
    const [lo, hi] = volumeAABB(dims, spacing);
    const sr = new SliceRenderer(gpu!);
    sr.setVolume(patientToTexture(dims, spacing), lo, hi);
    sr.setTextures(scalarTexture(gpu!.device, flat, d));
    sr.setWindowLevel(d - 1, (d - 1) / 2);
    sr.setForeground(scalarTexture(gpu!.device, rampVolume(d), d), patientToTexture(dims, spacing), d - 1, (d - 1) / 2, 1.0, 0);
    sr.setPlane("axial", 0.5);

    sr.setSlab(d * 2, "mean", undefined, "max");
    const withMax = await centreScalar(sr, d);
    sr.setSlab(d * 2, "mean", undefined, "mean");
    const withMean = await centreScalar(sr, d);

    assertAlmostEquals(withMax, d - 1, 2, "foreground MIP should reach the ramp maximum");
    assertAlmostEquals(withMean, (d - 1) / 2, 2.5, "foreground mean should reach the ramp average");
    assert(withMax - withMean > 8, "max and mean must differ, else the foreground is not slabbed");
  },
});
