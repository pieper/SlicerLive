// T3 (W1 DICOM): synthesize a small multi-slice CT series with dcmjs IN THE PAGE, feed the buffers to the
// DICOM loader, and verify the reconstructed geometry (dims, ijkToRAS) and that it lands as an image node.
// Uses the page's dcmjs (loaded by the DICOM reader) so no server is needed.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }

// Build N axial CT instances (4x3, 2mm spacing, IPP ascending) as DICOM Part-10 buffers, in-page via dcmjs.
const MAKE_SERIES = `
  const dcmjs = await window.__dcmjs();
  const nx = 4, ny = 3, N = 5, uid = "1.2.826.0.1.3680043.8.498." + Date.now();
  const bufs = [];
  for (let k = 0; k < N; k++) {
    const pixels = new Int16Array(nx * ny); for (let p = 0; p < nx*ny; p++) pixels[p] = k*1000 + p - 1024;
    const ds = {
      SOPClassUID: "1.2.840.10008.5.1.4.1.1.2", SOPInstanceUID: uid + "." + k, _meta: {},
      SeriesInstanceUID: uid, StudyInstanceUID: uid + ".study", Modality: "CT", SeriesDescription: "TestCT",
      Rows: ny, Columns: nx, BitsAllocated: 16, BitsStored: 16, HighBit: 15, PixelRepresentation: 1, SamplesPerPixel: 1,
      PhotometricInterpretation: "MONOCHROME2", PixelSpacing: [0.8, 0.5], SliceThickness: 2,
      ImageOrientationPatient: [1,0,0,0,1,0], ImagePositionPatient: [-10,-20, 5 + k*2],
      RescaleSlope: 1, RescaleIntercept: 0, InstanceNumber: k+1, PatientName: "Test^Patient",
      PixelData: pixels.buffer,
    };
    const meta = { TransferSyntaxUID: "1.2.840.10008.1.2.1", MediaStorageSOPClassUID: ds.SOPClassUID, MediaStorageSOPInstanceUID: ds.SOPInstanceUID };
    const dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset({ ...ds, _meta: dcmjs.data.DicomMetaDictionary.denaturalizeDataset(meta) });
    const dcm = new dcmjs.data.DicomDict(dcmjs.data.DicomMetaDictionary.denaturalizeDataset(meta));
    dcm.dict = dict; bufs.push(dcm.write());
  }
`;

Deno.test({ name: "dicom: 5-slice CT reconstructs (dims, ijkToRAS, subseries) and loads", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(`${BASE}slicer-app.html`);
  try {
    await waitReady(cdp, 60000);
    const r = await cdp.eval<{ series: { count: number; modality: string }[]; dims: number[]; ijkToRAS: number[] }>(`
      ${MAKE_SERIES}
      const res = await window.__loadDicomSeries(bufs, 0);
      const stats = await window.__volumeStats(res.imageId);
      return { series: res.series, dims: stats.dims, ijkToRAS: stats.ijkToRAS };`);
    assertEquals(r.series.length, 1);
    assertEquals(r.series[0].count, 5);
    assertEquals(r.series[0].modality, "CT");
    assertEquals(r.dims, [4, 3, 5]);
    assertEquals(r.ijkToRAS, [-0.5, 0, 0, 10, 0, -0.8, 0, 20, 0, 0, 2, 5, 0, 0, 0, 1]);
  } finally { await cdp.closeTab(); }
} });
