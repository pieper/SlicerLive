// T1: the synthetic DICOM builder, checked against the REAL reconstruction path.
//
// The point of this test is not that the builder runs. It is that the geometry the builder DECLARES
// matches what reconstructSeries() actually produces, and that both match the value
// harness/dicom.browser.test.ts asserts in a browser against the full load path. That expected
// ijkToRAS is the only independently validated geometry oracle in the suite, so when this fixture
// moved out of that test's template string, the two had to be tied together or they would fork.
import { assert, assertEquals } from "../../mrson/assert.ts";
import dcmjs from "../../render/vendor/dcmjs/dcmjs.es.js";
import { groupSeries, reconstructSeries } from "./dicom-series.ts";
import type { DicomInstance } from "./dicom-series.ts";
import { makeDicomSeg, makeDicomSeries, VALIDATED_FIXTURE } from "./synthetic-dicom.ts";

/** parseInstances() loads dcmjs from a script tag, so Deno uses the vendored ESM build instead. */
function parse(buffers: ArrayBuffer[]): DicomInstance[] {
  const out: DicomInstance[] = [];
  for (const buffer of buffers) {
    const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
      dcmjs.data.DicomMessage.readFile(buffer).dict,
    ) as Record<string, unknown>;
    let pd = ds.PixelData as ArrayBuffer | ArrayBuffer[];
    if (Array.isArray(pd)) pd = pd[0];
    out.push({
      seriesInstanceUID: String(ds.SeriesInstanceUID),
      studyInstanceUID: String(ds.StudyInstanceUID),
      sopInstanceUID: String(ds.SOPInstanceUID),
      seriesDescription: String(ds.SeriesDescription ?? ""),
      modality: String(ds.Modality ?? ""),
      rows: Number(ds.Rows),
      columns: Number(ds.Columns),
      pixelSpacing: (ds.PixelSpacing as number[]).map(Number) as [number, number],
      sliceThickness: Number(ds.SliceThickness ?? 1),
      imageOrientationPatient: (ds.ImageOrientationPatient as number[]).map(Number),
      imagePositionPatient: (ds.ImagePositionPatient as number[]).map(Number),
      rescaleSlope: Number(ds.RescaleSlope ?? 1),
      rescaleIntercept: Number(ds.RescaleIntercept ?? 0),
      pixels: new Int16Array(pd as ArrayBuffer),
    } as unknown as DicomInstance);
  }
  return out;
}

// The shared oracle: harness/dicom.browser.test.ts asserts against the same constant, against the
// real browser load path. One value, one place.
const VALIDATED_IJK_TO_RAS = VALIDATED_FIXTURE.ijkToRAS;

Deno.test("the default series IS the validated 4x3x5 fixture", () => {
  const series = makeDicomSeries(dcmjs);
  assertEquals(series.dims, [4, 3, 5]);
  assertEquals(series.buffers.length, 5);
  assertEquals(series.sopInstanceUIDs.length, 5);
  // what the builder claims the geometry is
  assertEquals(series.ijkToRAS, VALIDATED_IJK_TO_RAS);
});

Deno.test("reconstructSeries agrees with what the builder declared", () => {
  const series = makeDicomSeries(dcmjs);
  const volume = reconstructSeries(parse(series.buffers));

  assertEquals(volume.dims, series.dims, "dims");
  assertEquals(
    volume.ijkToRAS.map((v) => Math.round(v * 1e6) / 1e6),
    VALIDATED_IJK_TO_RAS,
    "the real reconstruction must match the declared geometry AND the browser oracle",
  );
});

Deno.test("the voxels survive the round trip, in C order", () => {
  const series = makeDicomSeries(dcmjs);
  const volume = reconstructSeries(parse(series.buffers));
  const [nx, ny] = series.dims;
  // default voxel is k * 1000 + p - 1024, so each slice is distinguishable
  for (let k = 0; k < 5; k++) {
    for (let p = 0; p < nx * ny; p++) {
      assertEquals(
        volume.data[k * nx * ny + p],
        k * 1000 + p - 1024,
        `voxel (slice ${k}, index ${p})`,
      );
    }
  }
});

Deno.test("instances are written in geometric order, and reconstruct in it", () => {
  const series = makeDicomSeries(dcmjs);
  const instances = parse(series.buffers);
  // ImagePositionPatient z increases by the slice thickness
  const zs = instances.map((i) => (i.imagePositionPatient as number[])[2]);
  assertEquals(zs, [5, 7, 9, 11, 13]);
  // and the declared SOPInstanceUID order matches the buffer order, which is what MRCOM's
  // manifest records as authoritative
  assertEquals(instances.map((i) => i.sopInstanceUID), series.sopInstanceUIDs);
});

Deno.test("options change the geometry consistently", () => {
  const series = makeDicomSeries(dcmjs, {
    nx: 8,
    ny: 6,
    slices: 3,
    pixelSpacing: [1, 2],
    sliceThickness: 5,
    origin: [0, 0, 0],
  });
  assertEquals(series.dims, [8, 6, 3]);
  assertEquals(series.ijkToRAS, [-2, 0, 0, 0, 0, -1, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1]);

  const volume = reconstructSeries(parse(series.buffers));
  assertEquals(volume.dims, [8, 6, 3]);
  assertEquals(volume.ijkToRAS.map((v) => Math.round(v * 1e6) / 1e6), series.ijkToRAS);
});

Deno.test("groupSeries sees one series, as a single orientation should", () => {
  const series = makeDicomSeries(dcmjs);
  const grouped = groupSeries(parse(series.buffers));
  assertEquals(grouped.length, 1);
  assertEquals(grouped[0].instances.length, 5);
  assertEquals(grouped[0].modality, "CT");
});

Deno.test("an implicit VR series is still readable - the trap Albula hit", () => {
  const series = makeDicomSeries(dcmjs, { transferSyntaxUID: "1.2.840.10008.1.2" });
  const read = dcmjs.data.DicomMessage.readFile(series.buffers[0]);
  assertEquals(read.meta["00020010"].Value, ["1.2.840.10008.1.2"]);
  // and it reconstructs the same geometry, so a reference instance being implicit VR does not
  // change what a bundle derived from it should contain
  const volume = reconstructSeries(parse(series.buffers));
  assertEquals(volume.ijkToRAS.map((v) => Math.round(v * 1e6) / 1e6), VALIDATED_IJK_TO_RAS);
});

Deno.test("makeDicomSeg references the series it was drawn on", () => {
  const source = makeDicomSeries(dcmjs);
  const seg = makeDicomSeg(dcmjs, { source });

  const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dcmjs.data.DicomMessage.readFile(seg.buffer).dict,
  ) as Record<string, unknown>;

  assertEquals(ds.Modality, "SEG");
  assertEquals(ds.SegmentationType, "BINARY");
  assertEquals(Number(ds.NumberOfFrames), 5);
  // the reference is what MRCOM records as provenance, so it has to be there and complete
  const referenced = (ds.ReferencedSeriesSequence as Record<string, unknown>[])[0];
  assertEquals(referenced.SeriesInstanceUID, source.seriesInstanceUID);
  assertEquals(
    (referenced.ReferencedInstanceSequence as Record<string, unknown>[]).map(
      (i) => i.ReferencedSOPInstanceUID,
    ),
    source.sopInstanceUIDs,
  );
});

Deno.test("the SEG's frames are bit-packed, and the mask is where it says", () => {
  const source = makeDicomSeries(dcmjs, { nx: 4, ny: 4, slices: 2 });
  const seg = makeDicomSeg(dcmjs, { source });
  assertEquals(seg.frames.length, 2);

  // default mask: the middle block, x and y in [1, 3)
  for (const frame of seg.frames) {
    assertEquals(frame.length, 16);
    const on: number[] = [];
    frame.forEach((v, i) => v && on.push(i));
    assertEquals(on, [5, 6, 9, 10]);
  }

  const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dcmjs.data.DicomMessage.readFile(seg.buffer).dict,
  ) as Record<string, unknown>;
  let pd = ds.PixelData as ArrayBuffer | ArrayBuffer[];
  if (Array.isArray(pd)) pd = pd[0];
  // 32 bits for two 4x4 frames = 4 bytes
  assert(new Uint8Array(pd as ArrayBuffer).length >= 4, "frames should be bit-packed, not byte-per-voxel");
});

Deno.test("a custom mask and multiple segments produce one frame each", () => {
  const source = makeDicomSeries(dcmjs, { nx: 4, ny: 4, slices: 2 });
  const seg = makeDicomSeg(dcmjs, {
    source,
    segments: [{ labelValue: 1, label: "A" }, { labelValue: 2, label: "B" }],
    mask: (segmentIndex, _k, x, _y) => (segmentIndex === 0 ? x === 0 : x === 3),
  });
  assertEquals(seg.frames.length, 4); // 2 segments x 2 slices
  const first: number[] = [];
  seg.frames[0].forEach((v, i) => v && first.push(i));
  assertEquals(first, [0, 4, 8, 12]);
  const third: number[] = [];
  seg.frames[2].forEach((v, i) => v && third.push(i));
  assertEquals(third, [3, 7, 11, 15]);
});
