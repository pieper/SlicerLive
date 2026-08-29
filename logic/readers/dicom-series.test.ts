// T1: DICOM series reconstruction geometry (no dcmjs — synthetic instances). Mirrors Slicer's
// DICOMScalarVolumePlugin: sort by IPP·normal, ijkToRAS from IOP/IPP/PixelSpacing (LPS->RAS), subseries split.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type DicomInstance, groupSeries, reconstructSeries } from "./dicom-series.ts";

function axialSlice(k: number, o: Partial<DicomInstance> = {}): DicomInstance {
  const nx = 4, ny = 3;
  const pixels = new Int16Array(nx * ny);
  for (let p = 0; p < nx * ny; p++) pixels[p] = k * 1000 + p;               // distinct per (slice, pixel)
  return {
    seriesInstanceUID: "1.2.3", rows: ny, columns: nx, pixelSpacing: [0.8, 0.5],   // [rowSpacing y, colSpacing x]
    imageOrientationPatient: [1, 0, 0, 0, 1, 0], imagePositionPatient: [-10, -20, 5 + k * 2],   // LPS, 2 mm spacing
    rescaleSlope: 1, rescaleIntercept: 0, pixelRepresentation: 1, modality: "CT", pixels, ...o,
  };
}

Deno.test("reconstructSeries: LPS->RAS ijkToRAS from IOP/IPP/PixelSpacing", () => {
  const v = reconstructSeries([axialSlice(0), axialSlice(1), axialSlice(2)]);
  assertEquals(v.dims, [4, 3, 3]);
  // i (columns/x) uses COLUMN spacing 0.5, negated x (LPS->RAS): -0.5; j (rows/y) uses ROW spacing 0.8, negated: -0.8
  assertEquals(v.ijkToRAS, [-0.5, 0, 0, 10, 0, -0.8, 0, 20, 0, 0, 2, 5, 0, 0, 0, 1]);
  assertEquals(v.dtype, "<i2");
});

Deno.test("reconstructSeries: shuffled slices sort by IPP·normal, voxel order preserved", () => {
  const v = reconstructSeries([axialSlice(2), axialSlice(0), axialSlice(1)]);
  // slice 0 lands first (smallest z), value at voxel 0 of slice 0 = 0
  assertEquals(v.data[0], 0);
  assertEquals(v.data[4 * 3], 1000);      // start of slice 1
  assertEquals(v.data[4 * 3 * 2], 2000);  // start of slice 2
});

Deno.test("reconstructSeries: per-slice rescale slope/intercept", () => {
  const v = reconstructSeries([axialSlice(0, { rescaleSlope: 2, rescaleIntercept: -1000 }), axialSlice(1, { rescaleSlope: 2, rescaleIntercept: -1000 })]);
  assertEquals(v.data[0], -1000);            // 0*2 - 1000
  assertEquals(v.data[1], -998);             // 1*2 - 1000
  assertEquals(v.data[4 * 3], 1000 * 2 - 1000);   // slice 1 pixel 0
});

Deno.test("reconstructSeries: single slice uses SliceThickness for k spacing", () => {
  const v = reconstructSeries([axialSlice(0, { sliceThickness: 3 })]);
  assertEquals(v.dims, [4, 3, 1]);
  assertEquals(v.ijkToRAS[10], 3);           // c2 z = normal.z * sliceThickness
});

Deno.test("groupSeries: split one series into subseries by orientation", () => {
  const axial = [axialSlice(0), axialSlice(1)];
  const sag: DicomInstance = axialSlice(0, { imageOrientationPatient: [0, 1, 0, 0, 0, -1], imagePositionPatient: [3, -20, 5] });
  const groups = groupSeries([...axial, sag]);
  assertEquals(groups.length, 2);
  assert(groups.every((g) => g.seriesInstanceUID.startsWith("1.2.3")));
  assertEquals(groups.map((g) => g.instances.length).sort(), [1, 2]);
});

Deno.test("groupSeries: distinct SeriesInstanceUIDs stay separate", () => {
  const a = axialSlice(0), b = axialSlice(0, { seriesInstanceUID: "9.9.9" });
  assertEquals(groupSeries([a, b]).length, 2);
});
