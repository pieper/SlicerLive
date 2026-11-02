// T1: IDC v3 index client — geometry construction, UID validation, and the injected fetch.
// Hermetic: the network is a stub, so this runs offline.
import { assert, assertAlmostEquals, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  geometryOf,
  IdcClient,
  idcS3Base,
  isAttenuationCorrected,
  type SeriesRow,
  UID_RE,
} from "./sql.ts";

// A head-first axial series: IOP = [1,0,0, 0,1,0] (row along +x LPS, column along +y LPS).
const AXIAL_ROW = {
  g_regular: true,
  g_origin: [-250, -250, -600],
  g_iop: [1, 0, 0, 0, 1, 0],
  g_ps_row: 0.98,
  g_ps_col: 0.98,
  g_slice_mm: 2.5,
  g_rows: 512,
  g_cols: 512,
  instanceCount: 297,
};

Deno.test("geometryOf: axial LPS -> RAS, column order, origin", () => {
  const g = geometryOf(AXIAL_ROW)!;
  assert(g);
  assertEquals(g.dims, [512, 512, 297]);
  assertAlmostEquals(g.spacing, 2.5, 1e-12);
  // Row direction (+x LPS) scaled by COLUMN spacing, negated into RAS -> column 0 is -0.98 in R.
  assertAlmostEquals(g.ijkToRAS[0], -0.98, 1e-12);
  // Column direction (+y LPS) scaled by ROW spacing, negated -> column 1 is -0.98 in A.
  assertAlmostEquals(g.ijkToRAS[5], -0.98, 1e-12);
  // Plane normal is +z, which is the same sign in RAS, scaled by slice spacing.
  assertAlmostEquals(g.ijkToRAS[10], 2.5, 1e-12);
  // Origin LPS (-250,-250,-600) -> RAS (250, 250, -600).
  assertAlmostEquals(g.ijkToRAS[3], 250, 1e-12);
  assertAlmostEquals(g.ijkToRAS[7], 250, 1e-12);
  assertAlmostEquals(g.ijkToRAS[11], -600, 1e-12);
  assertEquals(g.ijkToRAS.slice(12), [0, 0, 0, 1]);
});

Deno.test("geometryOf: anisotropic in-plane spacing goes to the right axis", () => {
  // PixelSpacing is [row_mm, col_mm]; i advances along the ROW direction but by the COLUMN pitch.
  const g = geometryOf({ ...AXIAL_ROW, g_ps_row: 1.0, g_ps_col: 2.0 })!;
  assertAlmostEquals(g.ijkToRAS[0], -2.0, 1e-12);   // i step uses col spacing
  assertAlmostEquals(g.ijkToRAS[5], -1.0, 1e-12);   // j step uses row spacing
});

Deno.test("geometryOf: refuses irregular / incomplete rows rather than guessing", () => {
  assertEquals(geometryOf({ ...AXIAL_ROW, g_regular: false }), null);
  assertEquals(geometryOf({ ...AXIAL_ROW, g_origin: null }), null);
  assertEquals(geometryOf({ ...AXIAL_ROW, g_iop: [1, 0, 0] }), null);      // wrong length
  assertEquals(geometryOf({ ...AXIAL_ROW, g_slice_mm: 0 }), null);          // non-positive
  assertEquals(geometryOf({ ...AXIAL_ROW, instanceCount: 0 }), null);
  assertEquals(geometryOf(null), null);
});

Deno.test("UID_RE accepts UIDs and crdc uuids, rejects injection-ish text", () => {
  assert(UID_RE.test("1.3.6.1.4.1.14519.5.2.1.6919.4624.368281589441706814147998236429"));
  assert(UID_RE.test("30e8b31d-8f30-455e-b47f-2f39aefb966a"));
  assert(!UID_RE.test("1.2.3; DROP TABLE"));
  assert(!UID_RE.test("' OR 1=1 --"));
  assert(!UID_RE.test(""));
});

Deno.test("sql(): binds parameters and rejects a bad UID before any fetch", async () => {
  let called = 0;
  const client = new IdcClient({
    fetch: () => { called++; return Promise.resolve(new Response("{}")); },
  });
  await assertRejects(() => client.sql("SELECT 1 WHERE x = ?", ["'; DROP TABLE --"]), Error, "not a well-formed identifier");
  assertEquals(called, 0, "must not reach the network with a bad parameter");
});

Deno.test("sql(): posts {sql, params} and returns rows", async () => {
  let seen: { url: string; body: unknown } | null = null;
  const client = new IdcClient({
    fetch: (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return Promise.resolve(new Response(JSON.stringify({ rows: [{ a: 1 }] })));
    },
  });
  const rows = await client.sql("SELECT ?", ["1.2.3"]);
  assertEquals(rows, [{ a: 1 }]);
  assertEquals(seen!.url, "https://api.imaging.datacommons.cancer.gov/v3/sql");
  assertEquals(seen!.body, { sql: "SELECT ?", params: ["1.2.3"] });
});

Deno.test("sql(): surfaces an API-level error body rather than returning empty rows", async () => {
  const client = new IdcClient({
    fetch: () =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "Catalog Error: no such table" } }))),
  });
  await assertRejects(() => client.sql("SELECT 1"), Error, "Catalog Error");
});

Deno.test("sql(): surfaces a transport error with the status", async () => {
  const client = new IdcClient({
    fetch: () => Promise.resolve(new Response("nope", { status: 503 })),
  });
  await assertRejects(() => client.sql("SELECT 1"), Error, "503");
});

Deno.test("seriesOfStudy maps PET fields and geometry onto SeriesRow", async () => {
  const client = new IdcClient({
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({
          rows: [{
            StudyInstanceUID: "1.2.3",
            SeriesInstanceUID: "1.2.3.4",
            crdc_series_uuid: "30e8b31d-8f30-455e-b47f-2f39aefb966a",
            aws_bucket: "idc-open-data-two",
            Modality: "PT",
            SeriesNumber: 4,
            SeriesDescription: "PET WB",
            PatientID: "ACRIN-NSCLC-FDG-PET-131",
            collection_id: "acrin_nsclc_fdg_pet",
            license_short_name: "CC BY 3.0",
            source_DOI: null,
            pt_units: "BQML",
            pt_decay: "START",
            pt_corrected: ["RAN", "DTIM", "NORM", "ATTN", "SCAT", "DECY"],
            ...AXIAL_ROW,
            instanceCount: 186,          // after the spread: this series' own slice count
          }],
        })),
      ),
  });
  const rows = await client.seriesOfStudy("1.2.3");
  assertEquals(rows.length, 1);
  const r: SeriesRow = rows[0];
  assertEquals(r.Units, "BQML");
  assertEquals(r.DecayCorrection, "START");
  assert(isAttenuationCorrected(r));
  assert(r.geometry !== null);
  assertEquals(r.geometry!.dims[2], 186);     // geometry depth comes from instanceCount
});

Deno.test("isAttenuationCorrected distinguishes AC from NAC", () => {
  const base = { CorrectedImage: null } as unknown as SeriesRow;
  assertEquals(isAttenuationCorrected(base), false);
  assertEquals(isAttenuationCorrected({ ...base, CorrectedImage: ["RAN", "DTIM", "NORM", "DECY"] }), false);
  assertEquals(isAttenuationCorrected({ ...base, CorrectedImage: ["ATTN", "DECY"] }), true);
});

Deno.test("idcS3Base", () => {
  assertEquals(idcS3Base("idc-open-data-two"), "https://idc-open-data-two.s3.us-east-1.amazonaws.com/");
});
