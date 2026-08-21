// Offline builder for the SLIM IDC index that the BIR demo's OHIF/IID UID resolution uses.
//
// The public idc-index parquet is ~69 MB, a SINGLE row group of 965k series across 24 columns,
// and — crucially — is NOT served with CORS from any public host, so a browser on the gallery
// origin can't range-read it. This tool produces a CORS-hostable slim copy plus a tiny sidecar
// directory that makes cross-origin study lookups cost ~0.6 MB instead of a full download:
//
//   idc-rad-slim.parquet — radiology-only series (drops SM/pathology, SR, ANN, PR, KO, REG,
//                          RTPLAN, …), only the columns resolution needs, the S3 location kept
//                          as crdc_series_uuid + aws_bucket (prefix = s3://<bucket>/<uuid>/),
//                          SORTED by StudyInstanceUID and written in 2000-row groups so a study
//                          maps to one row group.
//   idc-rad-groups.json  — {rowGroupSize,total,groups:[{min,max}]} the FULL (untruncated) min/max
//                          StudyInstanceUID per row group. The client binary-searches this (~43 KB)
//                          to learn which row range to range-read; it does NOT rely on parquet's
//                          own statistics, which the writer/reader truncate to ~16 chars and which
//                          collapse for IDC's shared "1.3.6.1.4.1.14519.5.2.1…" UID prefixes.
//
// Upload BOTH files to a CORS-enabled bucket (the js2 bucket) and point the demo at it via
// ?indexBase=<url>/ or globalThis.__IDC_INDEX_BASE. Re-run when IDC publishes a new index.
//
//   deno run -A render/demos/build-idc-slim.ts [--out DIR] [--index URL]
//
import { asyncBufferFromUrl, parquetReadObjects } from "npm:hyparquet";
import { parquetWriteBuffer } from "npm:hyparquet-writer";

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) args.set(Deno.args[i].replace(/^--/, ""), Deno.args[i + 1]);
const OUT = args.get("out") ?? ".";
// idc-index-data mirror (server-side reads are fine — the CORS gap only bites browsers).
const INDEX_URL = args.get("index") ??
  "https://storage.googleapis.com/idc-index-data-mirror/idc_index-v22.0.2.parquet";
const VERSION = args.get("version") ?? INDEX_URL.replace(/^.*idc_index-?/, "").replace(/\.parquet$/, "") || "idc";
const ROW_GROUP_SIZE = 2000;

// Modalities this viewer can render (volumes) or overlay (SEG). Everything else — SR, ANN, PR,
// KO, REG, RTPLAN, SM (pathology, the biggest single drop) — is not shown, so it is excluded.
const KEEP = new Set(["CT", "MR", "PT", "NM", "US", "XA", "CR", "DX", "MG", "RF", "SEG", "RTSTRUCT", "RTDOSE"]);

// Columns the client resolver needs. series_aws_url is replaced by crdc_series_uuid + aws_bucket
// (the prefix is s3://<aws_bucket>/<crdc_series_uuid>/*), which compresses far better.
const COLS = [
  "StudyInstanceUID", "SeriesInstanceUID", "crdc_series_uuid", "aws_bucket", "Modality",
  "instanceCount", "SeriesDescription", "PatientID", "collection_id", "license_short_name", "source_DOI",
];

console.log(`reading ${INDEX_URL} …`);
const file = await asyncBufferFromUrl({ url: INDEX_URL });
// deno-lint-ignore no-explicit-any
const rows: any[] = await parquetReadObjects({ file, columns: COLS });
const kept = rows.filter((r) => KEEP.has(String(r.Modality)));
kept.sort((a, b) => (a.StudyInstanceUID < b.StudyInstanceUID ? -1 : a.StudyInstanceUID > b.StudyInstanceUID ? 1 : 0));
console.log(`kept ${kept.length} of ${rows.length} series (radiology only)`);

const columnData = COLS.map((name) => ({
  name,
  data: kept.map((r) => (r[name] == null ? null : name === "instanceCount" ? Number(r[name]) : String(r[name]))),
}));
const buf = parquetWriteBuffer({ columnData, rowGroupSize: ROW_GROUP_SIZE, compressed: true, statistics: true });
await Deno.writeFile(`${OUT}/idc-rad-slim.parquet`, new Uint8Array(buf));

const groups: { min: string; max: string }[] = [];
for (let s = 0; s < kept.length; s += ROW_GROUP_SIZE) {
  const e = Math.min(s + ROW_GROUP_SIZE, kept.length);
  groups.push({ min: kept[s].StudyInstanceUID, max: kept[e - 1].StudyInstanceUID });
}
await Deno.writeTextFile(
  `${OUT}/idc-rad-groups.json`,
  JSON.stringify({ version: `idc-rad-${VERSION}`, rowGroupSize: ROW_GROUP_SIZE, total: kept.length, groups }),
);

const mb = (n: number) => (n / 1e6).toFixed(1);
console.log(`wrote ${OUT}/idc-rad-slim.parquet  (${mb(buf.byteLength)} MB, ${groups.length} row groups)`);
console.log(`wrote ${OUT}/idc-rad-groups.json   (${((await Deno.stat(`${OUT}/idc-rad-groups.json`)).size / 1024).toFixed(0)} KB)`);
console.log(`\nUpload both to your CORS bucket, then launch with ?indexBase=<bucket-url>/`);
