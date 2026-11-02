// T2 (GPU): the reslice is ISOTROPIC in millimetres at every viewport aspect ratio.
//
// A slice view that stretches with the window is a clinical defect, not a cosmetic one: a reader
// judges shape (round node vs. spiculated mass, short axis vs. long axis) directly off the screen,
// and RECIST short/long axis is measured on it. SliceRenderer letterboxes to keep millimetres
// square; this proves it, across square, wide, tall and extreme viewports, and with ANISOTROPIC
// voxels where the volume's own grid is not square.
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { initDevice } from "./device.ts";
import { SliceRenderer } from "./slice-renderer.ts";
import { patientToTextureFromIjkToRAS, volumeAABBFromIjkToRAS } from "./mat4.ts";

const gpu = await initDevice().catch(() => null);

function scalarTexture(dev: GPUDevice, data: Float32Array, dims: [number, number, number]): GPUTexture {
  const [dx, dy, dz] = dims;
  const tex = dev.createTexture({
    size: [dx, dy, dz], dimension: "3d", format: "r32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  dev.queue.writeTexture({ texture: tex }, data.buffer as ArrayBuffer, { bytesPerRow: dx * 4, rowsPerImage: dy }, [dx, dy, dz]);
  return tex;
}

/** A solid sphere of `radiusMm`, on a grid with the given (possibly anisotropic) spacing. */
function sphereVolume(dims: [number, number, number], spacing: [number, number, number], radiusMm: number) {
  const [nx, ny, nz] = dims;
  const data = new Float32Array(nx * ny * nz);
  const cx = (nx - 1) / 2, cy = (ny - 1) / 2, cz = (nz - 1) / 2;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = (i - cx) * spacing[0], y = (j - cy) * spacing[1], z = (k - cz) * spacing[2];
        data[(k * ny + j) * nx + i] = x * x + y * y + z * z <= radiusMm * radiusMm ? 1 : 0;
      }
    }
  }
  // Axis-aligned ijkToRAS (row-major), no rotation, with the requested spacing.
  const ijkToRAS = [
    spacing[0], 0, 0, -cx * spacing[0],
    0, spacing[1], 0, -cy * spacing[1],
    0, 0, spacing[2], -cz * spacing[2],
    0, 0, 0, 1,
  ];
  return { data, dims, ijkToRAS };
}

/** Bounding box of lit pixels, in pixels. */
function litBounds(px: Uint8Array, w: number, h: number) {
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4] > 127) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { wPx: x1 - x0 + 1, hPx: y1 - y0 + 1, found: x1 >= 0 };
}

async function aspectRatioOfSphere(
  dims: [number, number, number],
  spacing: [number, number, number],
  radiusMm: number,
  w: number,
  h: number,
  orient: "axial" | "coronal" | "sagittal",
): Promise<number> {
  const v = sphereVolume(dims, spacing, radiusMm);
  const [lo, hi] = volumeAABBFromIjkToRAS(v.ijkToRAS, dims);
  const sr = new SliceRenderer(gpu!);
  sr.setVolume(patientToTextureFromIjkToRAS(v.ijkToRAS, dims), lo, hi);
  sr.setTextures(scalarTexture(gpu!.device, v.data, dims));
  sr.setWindowLevel(1, 0.5);
  sr.setPlane(orient, 0.5);                       // through the centre: a great circle
  const px = await sr.renderToRGBA(w, h);
  const b = litBounds(px, w, h);
  assert(b.found, `nothing rendered at ${w}x${h}`);
  // The sphere's great circle is round in millimetres, so a correct isotropic view renders it with
  // equal pixel extents. Any deviation IS the distortion.
  return b.wPx / b.hPx;
}

Deno.test({
  name: "aspect: an isotropic sphere stays round at every viewport aspect ratio",
  ignore: !gpu,
  fn: async () => {
    const dims: [number, number, number] = [64, 64, 64];
    const spacing: [number, number, number] = [2, 2, 2];
    for (const [w, h] of [[256, 256], [512, 256], [256, 512], [600, 200], [200, 600], [333, 257]]) {
      const r = await aspectRatioOfSphere(dims, spacing, 40, w, h, "axial");
      assertAlmostEquals(r, 1, 0.04, `viewport ${w}x${h} rendered the circle at ${r.toFixed(3)}:1`);
    }
  },
});

Deno.test({
  name: "aspect: ANISOTROPIC voxels still render round, in every plane",
  ignore: !gpu,
  fn: async () => {
    // 1 x 1 x 4 mm is the shape of a real PET or a thick-slice CT: the grid is not square, so a
    // renderer that works in VOXELS rather than millimetres shows an ellipse here.
    const dims: [number, number, number] = [96, 96, 32];
    const spacing: [number, number, number] = [1, 1, 4];
    for (const orient of ["axial", "coronal", "sagittal"] as const) {
      for (const [w, h] of [[256, 256], [512, 220]]) {
        const r = await aspectRatioOfSphere(dims, spacing, 36, w, h, orient);
        assertAlmostEquals(r, 1, 0.06, `${orient} at ${w}x${h} rendered ${r.toFixed(3)}:1`);
      }
    }
  },
});

Deno.test({
  name: "aspect: the view shows MORE along the long axis, never a stretched image",
  ignore: !gpu,
  fn: async () => {
    // Letterboxing means a wide viewport reveals more millimetres horizontally at the same scale;
    // it must not magnify the object horizontally. So the sphere's PIXEL size is governed by the
    // smaller dimension and is identical between a square and a wide viewport of the same height.
    const dims: [number, number, number] = [64, 64, 64];
    const spacing: [number, number, number] = [2, 2, 2];
    const v = sphereVolume(dims, spacing, 30);
    const [lo, hi] = volumeAABBFromIjkToRAS(v.ijkToRAS, dims);
    const sr = new SliceRenderer(gpu!);
    sr.setVolume(patientToTextureFromIjkToRAS(v.ijkToRAS, dims), lo, hi);
    sr.setTextures(scalarTexture(gpu!.device, v.data, dims));
    sr.setWindowLevel(1, 0.5);
    sr.setPlane("axial", 0.5);

    const square = litBounds(await sr.renderToRGBA(300, 300), 300, 300);
    const wide = litBounds(await sr.renderToRGBA(900, 300), 900, 300);
    assertAlmostEquals(wide.hPx, square.hPx, 3, "height must not change when the view widens");
    assertAlmostEquals(wide.wPx, square.wPx, 3, "width must not change either — it letterboxes");
  },
});
