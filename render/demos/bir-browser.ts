// bir-browser.ts — SlicerLive "Basic Image Review" gallery demo.
//
// Loads an arbitrary KiTS case (Kidney Tumor Segmentation challenge, IDC collection
// c4kc_kits) straight from the IDC public bucket with idc_tools, reconstructs the volume,
// and presents it in the general-purpose IHE Basic Image Review reader (demos/bir.ts) — the
// same reader chrome SlicerRad uses. The 3D volume-rendering + segmentation controls live
// under the SlicerLive badge (sl-chrome installChrome), separate from the BIR toolbar since
// they are beyond the BIR profile.
//
// Bundle for the gallery (idc-worker.js must sit next to the output):
//   deno run -A npm:esbuild@0.21.5 render/demos/bir-browser.ts --bundle --format=esm \
//     --outfile=live/webgpu/bir.js
//   cp render/vendor/idc_tools/idc-worker.js live/webgpu/idc-worker.js
//   cp render/demos/bir.html live/webgpu/bir.html
// then add a gallery tile linking webgpu/bir.html.
import { initDevice } from "../device.ts";
import { slicerDefaultOffset01 } from "../slice-renderer.ts";
import { offset01ToMm, SliceInteractor } from "../slice-interactor.ts";
import { buildSegrouletteScene, type SegrouletteScene } from "./segroulette-scene.ts";
import { type Crosshair4up, mountCrosshair } from "./crosshair.ts";
import { attachCameraControls, framedCamera } from "./camera-control.ts";
import { attachSliceControls } from "./slice-control.ts";
import { attachDoubleClick, attachViewGrid } from "./view-grid.ts";
import { attachWidgetControls } from "./widget-control.ts";
import type { Box, HandleMeta } from "./roi-widget.ts";
import { createMosaic } from "./mosaic.ts";
import { installChrome, type VizControl } from "./sl-chrome.ts";
import { loadSeries, loadThumbnail } from "../vendor/idc_tools/index.js";
import type { CTVolume, GeomCheck, SegLabelmap, SeriesGeometry } from "../vendor/idc_tools/types.js";
import { type BirApi, mountBir, type Plane, type StripItem } from "./bir.ts";
import { downloadStudyWithDialog, type SeriesRef, shareStudy } from "./idc-share.ts";
import { CT_VR_PRESETS, presetLUT } from "../ct-vr-presets.ts";
import { openVrPresetMenu, type VrPresetItem } from "./vr-preset-menu.ts";
import type { Vec3 } from "../mat4.ts";

// The demo case: an arbitrary KiTS kidney-tumour study (IDC c4kc_kits · KiTS-00051) — the
// noncontrast CT (95 slices) WITH its DICOM SEG (kidney + tumour). Which case loads is
// resolved from the URL (see resolveSource) — a drop-in for OHIF on the IDC portal:
//   OHIF / IDC-portal form:  ?StudyInstanceUIDs=<uid>[&SeriesInstanceUIDs=<uid[,uid]>]
//   IHE IID form:            ?requestType=STUDY&studyUID=<uid>[&seriesUID=<uid>]
//   Fast direct-S3 form:     ?series=<crdc_uuid>&bucket=<b>[&seg=<uuid>&segBucket=<b>]
//   (no params → the default KiTS-00051 CT+SEG demo)
const P = new URLSearchParams(location.search);

interface Source {
  c: string; // CT/MR/PET series S3 prefix (crdc uuid)
  cb: string; // its bucket
  s?: string; // optional SEG series prefix
  sb?: string; // SEG bucket
  m: string; // modality
  col: string; // collection
  st: string; // StudyInstanceUID
  sid?: string; // SeriesInstanceUID actually resolved (memo validation + panel highlight)
  sd: string; // patient · series label
  lic: string; // license/attribution
  /** Geometry from the IDC index, when the index says this is a regularly-spaced volume. Its
   *  presence is what enables the streaming load: allocate and position the volume now, fill
   *  it as slices arrive. Absent → the assemble-then-show path. */
  geom?: SeriesGeometry;
}

const KITS_DEFAULT: Source = {
  c: "e3e86cde-da96-44b0-9e3b-b0b7bdd5a675",
  cb: "idc-open-data",
  s: "04a800eb-2f06-4e29-a10d-934a6f5c7d47",
  sb: "idc-open-data",
  m: "CT",
  col: "c4kc_kits",
  st: "1.3.6.1.4.1.14519.5.2.1.6919.4624.368281589441706814147998236429",
  sd: "KiTS-00051 · noncontrast abdomen + kidney/tumour SEG",
  lic: "CC BY 3.0 · IDC c4kc_kits · doi:10.7937/tcia.2019.ix49e8nx",
};

// OHIF/IID UID resolution goes through the IDC v3 REST API (api.imaging.datacommons.cancer.gov),
// which serves the same idc-index this viewer used to carry a copy of. One POST returns every
// series of a study — 1.4–5 KB, ~200 ms — against the ~0.65 MB of ranged parquet reads plus a
// 67 KB sidecar and a 60 KB hyparquet import that the self-hosted slim index cost. It also
// tracks IDC releases on its own, which the hand-built copy did not: it sat at idc-index-data
// 22.0.2 while IDC shipped 25, and whole collections read as "study not found".
//
// Deliberately NOT the DICOMweb proxy, which could answer the same question: the proxy is the
// metered part of IDC's infrastructure and its policy reserves it for IDC's own viewers, while
// the index and the public buckets are free. Everything here stays on the free paths.
const IDC_API_BASE = ((globalThis as Record<string, unknown>).__IDC_API_BASE as string) ||
  P.get("apiBase") || "https://api.imaging.datacommons.cancer.gov/v3";
const splitList = (v: string | null): string[] => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// Identifiers that may come from the page URL: a DICOM UID is digits and dots (PS3.5 §9.1), a
// crdc_series_uuid is hex and hyphens. Checked before either reaches a statement — they bind as
// parameters anyway, but a mistyped URL should fail here with something readable rather than as
// an empty result.
const UID_RE = /^[0-9a-fA-F.-]{1,64}$/;

// Bump when resolveFromIndex's series choice changes, when the data behind it does (a newer IDC
// release can add series to a study, so a memoised pick may no longer be the right one), or when
// the memoised SHAPE changes — a cached entry from an older resolver is missing whatever was
// added since, which silently disables the feature that needs it. Retires every localStorage
// entry cached by an older resolver. v6 = prefers a series the index calls a regular volume.
const MEMO_V = "idc-rad:v6";

const SLIM_COLS = [
  "StudyInstanceUID", "SeriesInstanceUID", "crdc_series_uuid", "aws_bucket", "Modality",
  "instanceCount", "SeriesNumber", "SeriesDescription", "PatientID", "collection_id",
  "license_short_name", "source_DOI",
];

// Per-series geometry, in the SAME call as the series list. `Rows`/`Columns` and the in-plane
// spacing live in the modality indices; the origin, the orientation and the spacing BETWEEN
// slice planes come from volume_geometry_index, which also says whether the series is a
// regularly-spaced volume at all. With these the viewer can allocate the volume and put it in
// patient space before a single pixel arrives — no DICOMweb, no header pre-pass.
// (ImagingDataCommons/idc-index-data#182, in idc-index-data 25.0.3+.)
const GEOM_SELECT = `
  COALESCE(c.Rows, m.Rows, p.Rows) AS g_rows,
  COALESCE(c.Columns, m.Columns, p.Columns) AS g_cols,
  COALESCE(c.PixelSpacing_row_mm, m.PixelSpacing_row_mm, p.PixelSpacing_row_mm) AS g_ps_row,
  COALESCE(c.PixelSpacing_col_mm, m.PixelSpacing_col_mm, p.PixelSpacing_col_mm) AS g_ps_col,
  v.origin_patient AS g_origin,
  v.ImageOrientationPatient AS g_iop,
  v.slice_spacing_mm AS g_slice_mm,
  v.regularly_spaced_3d_volume AS g_regular`;
const GEOM_JOINS = `
  LEFT JOIN ct_index c ON c.SeriesInstanceUID = i.SeriesInstanceUID
  LEFT JOIN mr_index m ON m.SeriesInstanceUID = i.SeriesInstanceUID
  LEFT JOIN pt_index p ON p.SeriesInstanceUID = i.SeriesInstanceUID
  LEFT JOIN volume_geometry_index v ON v.SeriesInstanceUID = i.SeriesInstanceUID`;

/** The index->RAS matrix and the streaming geometry for a series row, or null when the index
 *  says this series is not a regularly-spaced volume (37% of CT — gantry tilt, variable
 *  spacing, duplicate positions) or simply has no geometry row. Those fall back to the
 *  assemble-then-show path, which reads every header itself and is always right. */
// deno-lint-ignore no-explicit-any
function geometryOf(row: any): SeriesGeometry | null {
  if (!row?.g_regular || !row.g_origin || !row.g_iop) return null;
  const origin = (row.g_origin as unknown[]).map(Number) as [number, number, number];
  const iop = (row.g_iop as unknown[]).map(Number);
  const psRow = Number(row.g_ps_row), psCol = Number(row.g_ps_col), sliceMm = Number(row.g_slice_mm);
  const nx = Number(row.g_cols), ny = Number(row.g_rows), nz = Number(row.instanceCount);
  if (![psRow, psCol, sliceMm, nx, ny, nz].every((v) => Number.isFinite(v) && v > 0)) return null;
  if (origin.some((v) => !Number.isFinite(v)) || iop.length !== 6) return null;
  // Same construction the DICOM path uses (dicom-volume.js assembleSlices): i runs along the
  // row direction scaled by the column spacing, j along the column direction scaled by the row
  // spacing, k along the plane normal scaled by the slice spacing, origin at voxel (0,0,0).
  const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6);
  const n = [
    rowDir[1] * colDir[2] - rowDir[2] * colDir[1],
    rowDir[2] * colDir[0] - rowDir[0] * colDir[2],
    rowDir[0] * colDir[1] - rowDir[1] * colDir[0],
  ];
  const ras = (v: number[]) => [-v[0], -v[1], v[2]];   // LPS -> RAS
  const c0 = ras(rowDir.map((x) => x * psCol));
  const c1 = ras(colDir.map((x) => x * psRow));
  const c2 = ras(n.map((x) => x * sliceMm));
  const o = ras(origin);
  const ijkToRAS = [
    c0[0], c1[0], c2[0], o[0],
    c0[1], c1[1], c2[1], o[1],
    c0[2], c1[2], c2[2], o[2],
    0, 0, 0, 1,
  ];
  return { origin, iop, spacing: sliceMm, dims: [nx, ny, nz], ijkToRAS };
}

/** Run one read-only query against the IDC API.
 *
 *  `values` bind to the statement's `?` placeholders server-side, so a UID taken from the page
 *  URL never becomes statement text. The UID shape is still checked first, so a mistyped link
 *  fails here with something readable rather than as an empty result.
 */
// deno-lint-ignore no-explicit-any
async function idcSql(sql: string, values: string[] = []): Promise<any[]> {
  for (const v of values) if (!UID_RE.test(v)) throw new Error(`not a DICOM UID: ${v}`);
  const resp = await fetch(`${IDC_API_BASE}/sql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params: values }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`IDC API ${resp.status} at ${IDC_API_BASE}/sql — ${detail.slice(0, 300)}`);
  }
  return (await resp.json()).rows ?? [];
}

/** The IDC release the API is serving, for an error message. Best-effort: never throws. */
async function idcVersion(): Promise<string> {
  try {
    const v = await (await fetch(`${IDC_API_BASE}/version`)).json();
    return `${v.idc_version} / idc-index-data ${v.idc_index_data_version}`;
  } catch {
    return "unknown version";
  }
}

// Memo the per-study rows so building the series panel doesn't repeat the resolve's query.
// deno-lint-ignore no-explicit-any
const _studyRowsCache = new Map<string, any[]>();

/** Every series row of a study, in one API call. */
// deno-lint-ignore no-explicit-any
async function readStudyRows(studyUID: string, onStatus: (m: string) => void): Promise<any[]> {
  const memo = _studyRowsCache.get(studyUID);
  if (memo) return memo;
  onStatus("looking the study up in the IDC index…");
  let rows: any[]; // deno-lint-ignore-line no-explicit-any
  try {
    // Ordered in the query, not just in the panel: resolveFromIndex picks the first SEG of a
    // study by row order, and an unordered SELECT would let that pick change between loads.
    // SeriesNumber is text in idc-index, so it needs the cast — otherwise 16 sorts before 5.
    rows = await idcSql(
      `SELECT ${SLIM_COLS.map((c) => "i." + c).join(", ")},${GEOM_SELECT} ` +
        `FROM index i${GEOM_JOINS} WHERE i.StudyInstanceUID = ? ` +
        `ORDER BY TRY_CAST(i.SeriesNumber AS INTEGER) NULLS LAST, i.SeriesInstanceUID`,
      [studyUID],
    );
  } catch (e) {
    throw new Error(
      `couldn't reach the IDC index API at ${IDC_API_BASE} (${(e as Error).message}).`,
    );
  }
  if (!rows.length) {
    throw new Error(
      `StudyInstanceUID not found in the IDC index (${await idcVersion()}): ${studyUID}. ` +
        `It may be a non-radiology study, or newer than the release the API serves.`,
    );
  }
  _studyRowsCache.set(studyUID, rows);
  return rows;
}

/** Geometry for a series identified only by its crdc_series_uuid — the direct `?series=` form
 *  and the built-in demo. Without it those sources would fall back to assemble-then-show while
 *  every other route streams. Best-effort: a failure here just means the slower path. */
async function geometryForUuid(uuid: string): Promise<SeriesGeometry | undefined> {
  try {
    const rows = await idcSql(
      `SELECT i.instanceCount,${GEOM_SELECT} FROM index i${GEOM_JOINS} WHERE i.crdc_series_uuid = ?`,
      [uuid],
    );
    return (rows.length ? geometryOf(rows[0]) : null) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Decide which series to load from the URL: fast direct-S3, OHIF/IID UID (index lookup), or default. */
async function resolveSource(onStatus: (m: string) => void): Promise<Source> {
  const series = P.get("series");
  if (series) { // direct S3 prefix — the pixels need no index, the geometry still asks for one
    onStatus("looking the series up in the IDC index…");
    return {
      c: series, cb: P.get("bucket") || "idc-open-data",
      s: P.get("seg") || undefined, sb: P.get("segBucket") || "idc-open-data",
      m: (P.get("modality") || "CT").toUpperCase(), col: P.get("collection") || "IDC", st: "",
      sd: `${P.get("patient") || "IDC"} · ${series.slice(0, 8)}…`, lic: "NCI Imaging Data Commons",
      geom: await geometryForUuid(series),
    };
  }
  const studyUIDs = [...splitList(P.get("StudyInstanceUIDs")), ...splitList(P.get("studyUID"))];
  if (studyUIDs.length) {
    const want = [
      ...splitList(P.get("SeriesInstanceUIDs")),
      ...splitList(P.get("initialSeriesInstanceUID")),
      ...splitList(P.get("seriesUID")),
    ];
    return await resolveFromIndex(studyUIDs[0], want, onStatus);
  }
  onStatus("looking the demo case up in the IDC index…");
  return { ...KITS_DEFAULT, geom: await geometryForUuid(KITS_DEFAULT.c) };
}

/** Resolve a StudyInstanceUID (+ optional SeriesInstanceUIDs) to an S3 image series (+ SEG)
 *  via the SLIM idc-index — the OHIF/IDC-portal drop-in path. Reads only the 1–2 sorted row
 *  groups whose [min,max] span the study (~0.6 MB), never the whole parquet. */
async function resolveFromIndex(
  studyUID: string,
  wantSeries: string[],
  onStatus: (m: string) => void,
): Promise<Source> {
  // The memo is VERSIONED: an entry cached by an older resolver encodes that resolver's choices,
  // so bumping MEMO_V retires them all. (Before US joined the image filter, a US series resolved
  // to "largest image series" — the MR — and that wrong answer stuck in localStorage, so clicking
  // the US tile kept loading the MR.) Stale entries from earlier versions are pruned on the way.
  const memoKey = `${MEMO_V}:${studyUID}:${wantSeries.join(",")}`;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("idc-rad:") && !k.startsWith(`${MEMO_V}:`)) localStorage.removeItem(k);
    }
    const hit = localStorage.getItem(memoKey);
    if (hit) {
      const src = JSON.parse(hit) as Source;
      // Self-healing: if a specific series was asked for and the memo resolved to a DIFFERENT
      // one, don't trust it — re-resolve. (A requested SEG legitimately resolves to its image,
      // which just costs one index read.)
      if (!wantSeries.length || src.sid === wantSeries[0]) return src;
    }
  } catch { /* private mode / no storage */ }

  const inStudy = await readStudyRows(studyUID, onStatus);
  const want = new Set(wantSeries);
  // US included: ReMIND 3D ultrasound is a single enhanced/multi-frame instance, which the
  // idc_tools worker now reconstructs into a volume like any other series.
  const IMG = new Set(["CT", "MR", "PT", "PET", "NM", "US"]);
  const imgs = inStudy.filter((r) => IMG.has(String(r.Modality).toUpperCase()));
  const segs = inStudy.filter((r) => String(r.Modality).toUpperCase() === "SEG");
  // Prefer an explicitly-requested image series. Failing that, the largest series that the index
  // says IS a regularly-spaced volume, and only then the largest of what is left.
  //
  // Largest-wins alone picks badly in a real study: anti_pd_1_lung ...1624 has a 527-image series
  // that is two reconstructions interleaved — duplicate slice positions, non-uniform spacing —
  // next to a clean 127-slice lung volume. Stacking the 527 gives a volume with doubled slices,
  // and it cannot be streamed either. A viewer whose job is volumes should open the one that is
  // a volume; every other series is still one click away in the panel.
  const bySize = (a: { instanceCount: number }, b: { instanceCount: number }) =>
    Number(b.instanceCount) - Number(a.instanceCount);
  const regular = imgs.filter((r) => r.g_regular).sort(bySize);
  const chosen = imgs.find((r) => want.has(r.SeriesInstanceUID)) ?? regular[0] ??
    imgs.slice().sort(bySize)[0];
  if (!chosen) throw new Error("no CT/MR/PET/NM image series found in this study");
  // If a SEG was explicitly requested, honour it; else pick one whose SEG references the chosen
  // image (best-effort: just take the first SEG in the study).
  const seg = segs.find((r) => want.has(r.SeriesInstanceUID)) ?? segs[0];
  const mod = String(chosen.Modality).toUpperCase();
  const src: Source = {
    geom: geometryOf(chosen) ?? undefined,
    c: String(chosen.crdc_series_uuid), cb: String(chosen.aws_bucket),
    s: seg ? String(seg.crdc_series_uuid) : undefined, sb: seg ? String(seg.aws_bucket) : undefined,
    m: mod === "PET" ? "PT" : mod, col: String(chosen.collection_id), st: studyUID,
    sid: String(chosen.SeriesInstanceUID),
    sd: `${chosen.PatientID} · ${chosen.SeriesDescription || mod}`,
    lic: `${chosen.license_short_name || "IDC"} · ${chosen.collection_id}${chosen.source_DOI ? " · doi:" + chosen.source_DOI : ""}`,
  };
  try { localStorage.setItem(memoKey, JSON.stringify(src)); } catch { /* ignore */ }
  return src;
}

// Set by main() as soon as the overlay exists, so the failure path can turn it into a real
// error state instead of leaving its last progress message up.
let _mosaic: { fail(title: string, detail: string, hint?: string): void } | null = null;

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = msg;
    el.style.color = err ? "#ff6b74" : "#9fb3d0";
    el.classList.toggle("err", err);   // lets the host style wrap an error that carries a UID
  }
};
const cvEl = (id: string) => document.getElementById(id) as HTMLCanvasElement;

const PLANES: Plane[] = ["axial", "coronal", "sagittal"];

/** A volume with the real geometry and stand-in voxels: a 10 cm checkerboard in PATIENT space,
 *  so it reads as obviously-not-data in every plane and at every zoom, and so the extent and
 *  orientation of what is coming are visible while it downloads. Each arriving slice overwrites
 *  its own plane, so the checkerboard recedes as the data lands.
 *
 *  The two greys are the middle slice's 33rd and 66th percentile, so the placeholder sits in the
 *  same intensity range as the data under the same window — it reads as a stand-in for THIS
 *  study rather than as a bright test pattern. Before any slice has been seen they fall back to
 *  quarter-window greys for the modality. */
function placeholderVolume(
  g: SeriesGeometry,
  modality: string,
  voi?: { win: number; lev: number; p33: number; p66: number },
): CTVolume {
  const [nx, ny, nz] = g.dims;
  const vol = new Float32Array(nx * ny * nz);
  const dflt = DEFAULT_VOI[modality.toUpperCase()] ?? DEFAULT_VOI.CT;
  const win = voi?.win || dflt[0], lev = voi?.win ? voi.lev : dflt[1];
  const lo = voi ? voi.p33 : lev - win / 4;
  const hi = voi ? voi.p66 : lev + win / 4;
  const M = g.ijkToRAS;
  const CM = 100;                                     // 10 cm squares, in millimetres
  // This runs before the first frame, so it is on the critical path: ~100M voxels for a chest
  // CT. The mapping is affine, so stepping along i is three adds; the +32768 mm bias lets the
  // cell index be a truncation (|0) instead of Math.floor, which has to handle negatives.
  const BIAS = 32768, inv = 1 / CM;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let x = M[1] * j + M[2] * k + M[3] + BIAS;
      let y = M[5] * j + M[6] * k + M[7] + BIAS;
      let z = M[9] * j + M[10] * k + M[11] + BIAS;
      let o = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++, o++, x += M[0], y += M[4], z += M[8]) {
        vol[o] = (((x * inv) | 0) + ((y * inv) | 0) + ((z * inv) | 0)) & 1 ? hi : lo;
      }
    }
  }
  return { vol, dims: g.dims, ijkToRAS: g.ijkToRAS, win, lev, dtype: "float32", modality };
}

/** A banner across the top of the reader for what the series' own geometry says — above the
 *  views, not in the status line, because it changes how what is on screen should be read.
 *
 *  Two cases: a STACK (not one regular volume — reformats, 3D and the segmentation overlay are
 *  withheld), and a volume that simply left some instances out (a scout, a second image size).
 *  Dismissible, since it is a statement about the data rather than a pending action. */
function geometryNotice(g: GeomCheck, hadSeg: boolean): void {
  // Goes directly under the toolbar, as the next child of #viewer's flex column. NOT "before
  // #grid": once the series strip is up, the grid lives inside a horizontal row with it, and
  // the banner would land beside the thumbnails.
  const viewer = document.getElementById("viewer");
  const bar0 = document.getElementById("bir-bar");
  if (!viewer || !bar0 || bar0.parentElement !== viewer) return;
  const bar = document.createElement("div");
  bar.id = "geom-notice";
  const warn = g.stack;
  bar.style.cssText = "flex:0 0 auto;display:flex;align-items:flex-start;gap:10px;padding:7px 12px;" +
    `background:${warn ? "rgba(255,196,84,.13)" : "rgba(110,160,255,.11)"};` +
    `border-bottom:1px solid ${warn ? "rgba(255,196,84,.35)" : "rgba(110,160,255,.3)"};` +
    `color:${warn ? "#ffc454" : "#9fc0ff"};font:500 12px -apple-system,system-ui,sans-serif;line-height:1.45;`;
  const text = document.createElement("div");
  text.style.cssText = "flex:1 1 auto;min-width:0;";
  const why = (warn ? g.reasons : g.notes).map((r) => `<li>${r}</li>`).join("");
  text.innerHTML = warn
    ? `<b>${g.kept} images shown as a stack — this series is not a single volume.</b>` +
      `<ul style="margin:3px 0 0;padding-left:18px">${why}</ul>` +
      `<div style="margin-top:3px">The images and their in-plane measurements are real; the ` +
      `reformats, the 3D rendering${hadSeg ? " and the segmentation overlay" : ""} are not shown ` +
      `because this series has no trustworthy third dimension. Other series in the study may be ` +
      `volumes — pick one from the series strip.</div>`
    : `<b>Showing ${g.kept} of ${g.total} instances as the volume.</b>` +
      `<ul style="margin:3px 0 0;padding-left:18px">${why}</ul>`;
  const x = document.createElement("button");
  x.textContent = "\u00d7";
  x.title = "Dismiss";
  x.style.cssText = "flex:0 0 auto;background:none;border:0;color:inherit;font:700 16px/1 system-ui;" +
    "cursor:pointer;opacity:.7;padding:0 2px;";
  x.addEventListener("click", () => {
    bar.remove();
    globalThis.dispatchEvent(new Event("resize"));   // the views just got the space back
  });
  bar.appendChild(text);
  bar.appendChild(x);
  bar0.insertAdjacentElement("afterend", bar);
}

/** Window/level to start from, per modality, until the first real slice says otherwise. */
const DEFAULT_VOI: Record<string, [number, number]> = {
  CT: [400, 40],
  MR: [1000, 500],
  PT: [10, 5],
  PET: [10, 5],
  NM: [1000, 500],
  US: [255, 128],
};
const SEG_FILL = 0.5; // 2D MPR segmentation-overlay alpha at 100% (buildSegrouletteScene default)
const CT_WL_PRESETS = [
  { name: "Soft Tissue", win: 400, lev: 40 },
  { name: "Lung", win: 1500, lev: -600 },
  { name: "Bone", win: 1800, lev: 400 },
  { name: "Brain", win: 80, lev: 40 },
  { name: "Abdomen", win: 350, lev: 50 },
];

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) {
    throw new LoadError(
      "This browser can't render the images",
      "The reader draws with WebGPU, which this browser does not expose.",
      "Chrome or Edge 113+, Safari 18+, or Firefox with WebGPU enabled will work.",
    );
  }
  status("loading from the NCI Imaging Data Commons…");   // which study isn't resolved yet
  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;

  const names = ["axial", "threeD", "coronal", "sagittal"] as const;
  const cv: Record<string, HTMLCanvasElement> = {}, cx: Record<string, GPUCanvasContext> = {};
  for (const n of names) {
    cv[n] = cvEl("c-" + n);
    cx[n] = cv[n].getContext("webgpu") as GPUCanvasContext;
    cx[n].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  }

  // Download-progress mosaic (the SEGRoulette loading visual): the series' slice thumbnails
  // tile in as the DICOM streams from S3 — informative + a little fun instead of a blank wait.
  // Which case? Resolve the URL — OHIF/IID StudyInstanceUID (via the IDC index), direct S3
  // prefix, or the default demo. This is what makes it a drop-in for OHIF on the IDC portal.
  // deno-lint-ignore prefer-const
  let mosaic: ReturnType<typeof createMosaic> | undefined;
  const setLoad = (m: string) => {
    status(m);
    mosaic?.status(m);
  };
  status("contacting the NCI Imaging Data Commons…");
  const source = await resolveSource(setLoad);

  // ---- the volume, before its data ---------------------------------------------------------
  // The index gives the geometry — origin, orientation, spacing, extent — so the volume can be
  // allocated and placed in patient space before any pixels exist, filled with a placeholder,
  // and the whole reader built on it. The worker then decodes the series in bucket order and
  // each instance's own ImagePositionPatient says which plane it is, so slices replace the
  // placeholder where they land; the MPR planes and the 3D render read the same texture, so
  // both fill in as the download runs and every control is live throughout. The first slice to
  // decode also carries the greys and the window the placeholder is built from, so the stand-in
  // matches this study rather than a modality default.
  const streaming = !!source.geom;
  // Streaming: the views are usable from the first frame, so the progress display is PACKED at
  // the bottom of the layout rather than covering them. Without geometry there is nothing to
  // look at until the end, so it stays an overlay.
  mosaic = createMosaic(document.getElementById("viewer")!, { strip: streaming });
  _mosaic = mosaic;
  mosaic.status("contacting the NCI Imaging Data Commons…");

  // The index geometry, plus what only a real slice can say: the greys for the placeholder and
  // the window to start at.
  type GeomMsg = SeriesGeometry & { p33: number; p66: number; win: number; lev: number };
  let firstSlice: GeomMsg | undefined;
  let onSliceReady: ((k: number, px: Float32Array) => void) | null = null;
  const earlySlices: [number, Float32Array][] = [];      // arrive while the scene is being built
  let onLabelmapReady: ((seg: SegLabelmap) => void) | null = null;
  let earlySeg: SegLabelmap | null = null;
  let streamStats = { placed: 0, expected: 0, dropped: 0, outside: 0 };
  let filledPlanes: Uint8Array | null = null;
  /** The assemble-then-show path's verdict on the series' real geometry. Set before onCT, so
   *  it is known by the time the scene is built. */
  let geomCheck: GeomCheck | null = null;

  const handlers = {
    onProgress: (p: { msg: string; frac?: number }) => setLoad(`${p.msg}${p.frac ? ` — ${Math.round(p.frac * 100)}%` : ""}`),
    onSliceCount: (n: number) => mosaic!.setCount(n),
    onThumb: (n: number, w: number, h: number, rgba: ArrayBuffer) => mosaic!.thumb(n, w, h, rgba),
    onPreview: (w: number, h: number, rgba: ArrayBuffer) => mosaic!.preview(w, h, rgba),
    onSlice: (k: number, px: Float32Array) => {
      if (onSliceReady) onSliceReady(k, px);
      else earlySlices.push([k, px]);
    },
    onLabelmap: (sg: SegLabelmap) => {
      if (onLabelmapReady) onLabelmapReady(sg);
      else earlySeg = sg;
    },
    onVolumeDone: (placed: number, expected: number, dropped: number, outside: number) => {
      streamStats = { placed, expected, dropped, outside };
    },
    onGeomCheck: (g: GeomCheck) => (geomCheck = g),
  };

  // Start the load now; in streaming mode the scene is built as soon as the FIRST slice has
  // decoded — that one slice is what the placeholder's greys and window come from.
  let geomResolve: (g: GeomMsg) => void = () => {};
  const geomReady = new Promise<GeomMsg>((r) => (geomResolve = r));
  const loadDone = streaming
    ? loadSeries(source, { ...handlers, onGeometry: (g: GeomMsg) => { firstSlice = g; geomResolve(g); } }, {
      geometry: source.geom,
    })
    : loadSeries(source, handlers);

  const res: { ct: CTVolume; seg?: SegLabelmap } = streaming
    ? { ct: placeholderVolume(await geomReady, source.m, firstSlice) }
    : await loadDone;
  // STACK mode: the series' own headers say its instances are not one regular volume (duplicate
  // slice positions, uneven spacing, cross-plane drift). The images are real and the in-plane
  // geometry is real; the third dimension is not. So the reader shows the stack — one viewport,
  // images paged by number — and withholds everything that would be a fabrication: the coronal
  // and sagittal reformats, the 3D render, and the segmentation, which is drawn on the true
  // slice positions and so cannot be registered to a stack that has none. The warning says so.
  const stack = !!geomCheck?.stack;
  const sc: SegrouletteScene = buildSegrouletteScene(gpu, srgb, res.ct, stack ? undefined : res.seg);
  // Which viewport IS the stack? The acquired images lie along the volume's k axis, so the
  // single viewport has to be the view nearest that axis — for a coronal or sagittal
  // acquisition "axial" would be a reformat, exactly the thing a stack must not show. BIR's
  // selected (and, in single layout, only) viewport is planes[0].
  const kAxis = [sc.ijkToRAS[2], sc.ijkToRAS[6], sc.ijkToRAS[10]].map(Math.abs);
  const stackPlane: Plane = kAxis[2] >= kAxis[1] && kAxis[2] >= kAxis[0]
    ? "axial"
    : kAxis[1] >= kAxis[0]
    ? "coronal"
    : "sagittal";
  const planeOrder: Plane[] = stack ? [stackPlane, ...PLANES.filter((p) => p !== stackPlane)] : PLANES;
  // Sampled scalar range: drives the W/L drag gain (Slicer's vtkMRMLWindowLevelWidget scales by
  // the scalar range) and the VR shift-slider span. While streaming it grows with the data.
  let vmin = Infinity, vmax = -Infinity;
  const sampleRange = (v: ArrayLike<number>) => {
    const stride = Math.max(1, Math.floor(v.length / 200_000));
    for (let i = 0; i < v.length; i += stride) { const x = v[i]; if (x < vmin) vmin = x; if (x > vmax) vmax = x; }
  };
  if (!streaming) sampleRange(res.ct.vol);
  const dataRange = (): [number, number] => [vmin, vmax];
  sc.setVolumeOpacity(0.5); // 3D volume rendering starts semi-transparent (composites with SEG)
  sc.setSegOpacity(0.5);    // and the segmentation fill starts at half, so it tints rather than hides

  // ---- take delivery of slices IMMEDIATELY ---------------------------------------------------
  // The moment the scene exists its texture can be written, and that is the whole point of the
  // streaming load. Building the rest of the reader below takes long enough that parking slices
  // until it is done would mean the views stayed on the placeholder until the download finished
  // — which is exactly what they used to do. So the handlers go in here, and the parts that need
  // the finished UI (a redraw, the segmentation controls) are filled in later.
  /** The real middle slice, kept for the series-panel tile (the placeholder's is a checkerboard). */
  let midSlice: Float32Array | null = null;
  /** The segmentation the scene is showing — res.seg on the assemble-then-show path, or the one
   *  that streamed in afterwards. The debug hooks read this, not res.seg, which is empty while
   *  streaming. */
  let shownSeg: SegLabelmap | null = res.seg ?? null;
  let scheduleRedraw: () => void = () => {};   // replaced once there are views to redraw
  let segAttached = false;
  let segRefreshUi: () => void = () => {};     // replaced once the chrome/annotations exist
  if (streaming) filledPlanes = new Uint8Array(sc.dims[2]);
  const takeSlice = (k: number, px: Float32Array) => {
    if (k === Math.floor(sc.dims[2] / 2)) midSlice = px.slice();
    sc.writeSlice(k, px);
    if (filledPlanes) filledPlanes[k] = 1;
    sampleRange(px);
    scheduleRedraw();
  };
  const takeSeg = (sg: SegLabelmap) => {
    // Decoded alongside the image slices, so it usually lands before the last one.
    shownSeg = sg;
    sc.attachSegmentation(sg);
    segAttached = true;
    segRefreshUi();
    scheduleRedraw();
  };
  // Only in streaming mode: the assemble-then-show path hands the whole volume AND its
  // segmentation to buildSegrouletteScene above, so taking delivery again here would build the
  // segmentation's distance field a second time — minutes of work on a large SEG, for nothing.
  if (streaming) {
    for (const [k, px] of earlySlices) takeSlice(k, px);
    onSliceReady = takeSlice;
    if (earlySeg) takeSeg(earlySeg);
    onLabelmapReady = takeSeg;
  }
  earlySlices.length = 0;
  earlySeg = null;

  // SlicerLive display state (toggled from the badge popup, below).
  // The 2D segmentation draws as a translucent FILL plus a crisp OUTLINE, and the two are
  // independent: the "Segmentation" opacity sets the fill (and 0% leaves the contours alone),
  // while the outline's own control sets its width in pixels with 0 = no contour. That is what
  // makes every combination reachable — fill only, outline only (SlicerRAD-IDC#6), both, or
  // neither (SlicerRAD-IDC#1) — from two controls that each have an off state.
  let outlineWidth = 2;     // contour width, screen pixels; 0 = no outline
  /** Both 2D overlay opacities, from the ONE master "Segmentation" opacity and the outline
   *  switch. The outline has to be gated by the master too: at 0% with the switch on, the
   *  segmentation was still drawing its contours, so there was no way to turn it off — which
   *  is the state SlicerRAD-IDC#1 was reported in. */
  const applySegOverlay = () => {
    sc.slice.setOverlayOpacity(sc.segOpacity() * SEG_FILL);   // fill: the Segmentation opacity
    sc.slice.setOutlineOpacity(outlineWidth > 0 ? 1 : 0);     // outline: its own control, full strength
    sc.slice.setOutlineWidth(Math.max(1, outlineWidth));
  };
  let roiEnabled = false, roiVisible = false, roiFirstEnable = true; // 3D volume-render crop box
  let annOn = true; // DICOM corner annotations (IHE BIR §4.16.4.2.2.5.8 "official radiology look")

  // ---- corner annotations (IHE BIR §4.16.4.2.2.5.8) ---------------------------------------
  // The profile mandates overlaid corner text: patient identity (TL), institution/study (TR),
  // series/technique (BR); the slice position/number sits bottom-left with the readout. IDC
  // public data is de-identified, so we show what's present (ID, collection, modality, series,
  // geometry, live W/L). Sourced from the loaded metadata — real deployments read full tags.
  const annEls: Record<string, { br: HTMLElement }> = {};
  const buildAnnotations = () => {
    for (const p of PLANES) {
      const cell = document.querySelector(`[data-cell="${p}"]`) as HTMLElement;
      if (!cell) continue;
      // Rebuilt when the study changes under them (a SEG arriving mid-stream adds "· SEG"), so
      // clear first — appending a second set just overprints the first.
      for (const old of cell.querySelectorAll(".ann")) old.remove();
      const mk = (cls: string, html: string) => {
        const e = document.createElement("div");
        e.className = "ann " + cls;
        e.innerHTML = html;
        e.style.cssText = "position:absolute;z-index:2;font:600 10px ui-monospace,Menlo,monospace;" +
          "color:#cfe0f5;text-shadow:0 0 3px #000,0 0 3px #000;pointer-events:none;line-height:1.35;max-width:46%;" +
          (cls === "tl" ? "top:22px;left:7px;" : cls === "tr" ? "top:22px;right:7px;text-align:right;" : "bottom:22px;right:7px;text-align:right;");
        cell.appendChild(e);
        return e;
      };
      const pid = (source.sd.split("·")[0] || "").trim() || source.col;
      mk("tl", `${pid}<br>${source.col} · ${res.ct.modality}`);
      mk(
        "tr",
        `${res.ct.modality} · ${sc.dims[2]} ${stack ? "images (stack)" : "slices"}` +
          `${sc.hasSeg ? " · SEG" : ""}<br>${sc.dims[0]}×${sc.dims[1]}`,
      );
      annEls[p] = { br: mk("br", "") };
    }
    updateAnnWL();
  };
  const updateAnnWL = () => {
    for (const p of PLANES) {
      if (annEls[p]) annEls[p].br.innerHTML = `W ${Math.round(wl.win)} / L ${Math.round(wl.lev)}`;
    }
  };
  const applyAnn = () => {
    for (const e of document.querySelectorAll(".ann")) (e as HTMLElement).style.display = annOn ? "" : "none";
  };

  const off: Record<Plane, number> = {
    axial: slicerDefaultOffset01("axial", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
    coronal: slicerDefaultOffset01("coronal", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
    sagittal: slicerDefaultOffset01("sagittal", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
  };
  const sliceIx = new SliceInteractor({ ijkToRAS: sc.ijkToRAS, rasLo: sc.rasLo, rasHi: sc.rasHi });
  const camera = framedCamera(sc.center, sc.radius);
  const wl = { win: sc.win, lev: sc.lev };
  let bir: BirApi | null = null;
  let xhair: Crosshair4up | null = null;

  const drawSlice = (p: Plane) => {
    bir?.drawOverlay(p);
    if (!cv[p].width) return;
    sc.slice.setPlane(p, off[p]);
    sc.slice.renderToView(cx[p].getCurrentTexture().createView({ format: srgb }), cv[p].width, cv[p].height);
    updateReadout(p);
  };
  const draw3d = () => {
    if (!cv.threeD.width) return;
    sc.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, cv.threeD.width, cv.threeD.height);
    sc.scene.renderToView(cx.threeD.getCurrentTexture().createView({ format: srgb }), cv.threeD.width, cv.threeD.height);
  };
  const drawAll = () => {
    for (const p of PLANES) drawSlice(p);
    draw3d();
    xhair?.redraw();
  };
  /** Slice number and count for a plane — one definition, used by the corner readout and by
   *  the slice scrollbars so the two can never disagree. */
  const sliceIndexOf = (p: Plane) => {
    const [lo, hi] = sliceIx.bounds(p);
    const sp = sliceIx.spacing(p);
    const mm = offset01ToMm(p, off[p], sc.rasLo, sc.rasHi);
    return { index: Math.round((mm - lo) / sp + 0.5), count: Math.round((hi - lo) / sp), mm };
  };
  const updateReadout = (p: Plane) => {
    const el = document.getElementById("sr-" + p);
    if (!el) return;
    const { index, count, mm } = sliceIndexOf(p);
    // A stack has no true slice position, so it gets the image number alone — printing a
    // millimetre offset computed from a median spacing would be inventing a coordinate.
    el.textContent = stack ? `image ${index}/${count}` : `${index}/${count} · ${mm.toFixed(1)} mm`;
  };

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const n of names) {
      cv[n].width = Math.max(1, Math.round(cv[n].clientWidth * dpr));
      cv[n].height = Math.max(1, Math.round(cv[n].clientHeight * dpr));
    }
    bir?.resize();
    drawAll();
  };
  globalThis.addEventListener("resize", resize);
  for (const n of names) new ResizeObserver(() => resize()).observe(cv[n]);

  const viewGrid = attachViewGrid(document.getElementById("grid")!, [...names], resize);
  attachDoubleClick(cv.threeD, () => viewGrid.toggleMax("threeD"));

  // The streaming load starts from a modality default and adopts the first slice's own VOI when
  // it arrives — but only while nobody has set a window themselves.
  let wlUserSet = false;
  const setWL = (win: number, lev: number) => {
    wl.win = win;
    wl.lev = lev;
    sc.slice.setWindowLevel(win, lev);
    // The grayscale volume rendering maps the SAME window as the slices — so the 3D view reads
    // like the 2D views do, and a window change (a preset, a W/L drag) carries into it. A VR
    // preset overrides this with its own transfer function until it is cleared.
    sc.setVolumeWindow(lev - win / 2, lev + win / 2);
    for (const p of PLANES) drawSlice(p);
    xhair?.redraw();
    syncWl();
    updateAnnWL(); // live W/L in the corner annotation
  };
  // Hidden preset <select> the BIR "Presets" button drives (mountBir wants a presetsEl).
  const presets = document.getElementById("wl-readout") as HTMLSelectElement;
  const syncWl = () => {
    presets.innerHTML = "";
    presets.add(new Option(`W ${Math.round(wl.win)} / L ${Math.round(wl.lev)}`, "current", true, true));
    presets.add(new Option(`Auto (${Math.round(sc.win)}/${Math.round(sc.lev)})`, "auto"));
    for (const q of CT_WL_PRESETS) presets.add(new Option(`${q.name} (${q.win}/${q.lev})`, q.name));
  };
  presets.addEventListener("change", () => {
    wlUserSet = true;   // picking a preset is choosing a window
    if (presets.value === "auto") setWL(sc.win, sc.lev);
    else {
      const q = CT_WL_PRESETS.find((x) => x.name === presets.value);
      if (q) setWL(q.win, q.lev);
    }
  });
  syncWl();

  const nAxisOf: Record<Plane, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 };
  const jumpAll = (ras: Vec3) => {
    for (const p of PLANES) {
      const a = nAxisOf[p];
      off[p] = Math.max(0, Math.min(1, (ras[a] - sc.rasLo[a]) / (sc.rasHi[a] - sc.rasLo[a])));
    }
    drawAll();
  };

  // The IHE Basic Image Review reader chrome (shared demos/bir.ts).
  const sliceControls: { resetView(): void }[] = [];
  // Whole-study download: re-read the study's every (radiology) series from the slim index. Only
  // available when we came in by StudyInstanceUID; the direct-S3 path downloads the loaded pair.
  const listAllStudySeries = source.st
    ? async (): Promise<SeriesRef[]> => {
      const rows = await readStudyRows(source.st, () => {});
      return rows.map((r) => ({
        prefix: String(r.crdc_series_uuid),
        bucket: String(r.aws_bucket),
        modality: String(r.Modality).toUpperCase(),
        seriesUID: String(r.SeriesInstanceUID),
        seriesDescription: r.SeriesDescription ? String(r.SeriesDescription) : undefined,
      }));
    }
    : undefined;

  // ---- OHIF-style series panel (left thumbnail strip) -------------------------------------
  // SlicerRAD-IDC "study-level IDC mode": no patient/study browser to return to, and no
  // annotation persistence. Driven by window.__SLICERRAD_IDC (SlicerRAD-IDC sets it); the
  // gallery leaves it off.
  const IDC_MODE = !!(globalThis as Record<string, unknown>).__SLICERRAD_IDC;
  const noMeasure = IDC_MODE || !!(globalThis as Record<string, unknown>).__BIR_NO_MEASURE || P.get("measure") === "off";

  // Small-canvas thumbnail rendering + a concurrency gate so N series don't spawn N decode
  // workers at once.
  const IMG_MODS = new Set(["CT", "MR", "PT", "PET", "NM", "US", "XA", "CR", "DX", "MG", "RF", "SC", "XC", "OT"]);
  const THUMB = 128;
  let active = 0;
  const waiters: (() => void)[] = [];
  const acquire = () => active < 3 ? (active++, Promise.resolve()) : new Promise<void>((r) => waiters.push(() => (active++, r())));
  const release = () => { active--; waiters.shift()?.(); };
  const sliceToThumb = (t: { vol: Int16Array | Float32Array; dims: [number, number, number]; win: number; lev: number }): Promise<Blob | null> => {
    const [w, h] = t.dims, lo = t.lev - t.win / 2, inv = 255 / Math.max(1, t.win);
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { let g = (t.vol[i] - lo) * inv; g = g < 0 ? 0 : g > 255 ? 255 : g; px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = g; px[i * 4 + 3] = 255; }
    const c0 = document.createElement("canvas"); c0.width = w; c0.height = h;
    c0.getContext("2d")!.putImageData(new ImageData(px, w, h), 0, 0);
    const c = document.createElement("canvas"); c.width = THUMB; c.height = THUMB;
    const cx = c.getContext("2d")!; cx.fillStyle = "#000"; cx.fillRect(0, 0, THUMB, THUMB);
    const s = Math.min(THUMB / w, THUMB / h); cx.drawImage(c0, (THUMB - w * s) / 2, (THUMB - h * s) / 2, w * s, h * s);
    return new Promise((res) => c.toBlob(res, "image/png"));
  };
  const currentSeriesThumb = (): Promise<Blob | null> => {
    const { dims, win, lev } = res.ct as { dims: [number, number, number]; win: number; lev: number };
    const [w, h, d] = dims, z = Math.floor(d / 2);
    // Streaming: the placeholder's middle plane is a checkerboard, so the tile uses the real
    // middle slice once it has arrived (kept aside for exactly this).
    const mid = midSlice ?? (res.ct.vol as Float32Array).subarray(z * w * h, (z + 1) * w * h);
    return sliceToThumb({ vol: mid as Float32Array, dims: [w, h, 1], win, lev });
  };
  const navigateToSeries = (seriesUID: string) => {
    const u = new URL(location.href);
    u.searchParams.set("StudyInstanceUIDs", source.st);
    u.searchParams.set("SeriesInstanceUIDs", seriesUID);
    for (const k of ["series", "seg", "bucket", "segBucket", "modality", "initialSeriesInstanceUID", "seriesUID"]) u.searchParams.delete(k);
    location.href = u.toString();
  };

  // Build the strip from the study's every series (image stacks + SEG + SR/PR/…), OHIF-ordered
  // by SeriesNumber. Free when we arrived by StudyInstanceUID (readStudyRows is memoized); the
  // default demo pays one small index read.
  let seriesStrip: StripItem[] | undefined;
  if (source.st) {
    try {
      // deno-lint-ignore no-explicit-any
      const rows: any[] = await readStudyRows(source.st, setLoad);
      // SeriesNumber 0 is a NUMBER, not a missing value: `parseInt("0") || 1e9` sent every
      // series numbered 0 — which is what IDC's CT in nsclc_radiomics ...27873 is — to the
      // bottom of the panel, under eleven reports.
      // deno-lint-ignore no-explicit-any
      const seriesNo = (r: any) => { const n = parseInt(r.SeriesNumber); return Number.isFinite(n) ? n : 1e9; };
      rows.sort((a, b) => (seriesNo(a) - seriesNo(b)) || (Number(b.instanceCount) - Number(a.instanceCount)));
      seriesStrip = rows.map((r) => {
        const mod = String(r.Modality).toUpperCase();
        const isCurrent = String(r.crdc_series_uuid) === source.c;
        const desc = String(r.SeriesDescription ?? "").trim();
        return {
          seriesUID: String(r.SeriesInstanceUID),
          modality: mod,
          lines: [...(desc ? [desc] : []), `${Number(r.instanceCount) || 0} img`],
          current: isCurrent,
          // null = no picture: the row collapses to its text instead of showing a square that
          // says "SR". Reports, segmentation objects and presentation states are most of a
          // study's series list, and squares of placeholder crowd out the images.
          thumb: async (): Promise<Blob | null> => {
            if (isCurrent) return currentSeriesThumb();
            if (!IMG_MODS.has(mod) || !r.crdc_series_uuid) return null;
            await acquire();
            try {
              const t = await loadThumbnail(String(r.crdc_series_uuid), String(r.aws_bucket), mod);
              return t ? sliceToThumb(t) : null;
            } catch {
              return null;
            } finally {
              release();
            }
          },
          open: () => navigateToSeries(String(r.SeriesInstanceUID)),
        };
      });
    } catch { /* no study rows → no strip (e.g. direct ?series= with no study) */ }
  }

  bir = mountBir({
    overlay: document.getElementById("viewer")!,
    bar: document.getElementById("bir-bar")!,
    grid: document.getElementById("grid")!,
    planes: planeOrder,
    canvases: cv,
    cellOf: (name) => document.querySelector(`[data-cell="${name}"]`),
    slice: () => sc.slice,
    off01: (p) => off[p],
    setOff01: (p, v) => (off[p] = Math.max(0, Math.min(1, v))),
    offsetMm: (p) => offset01ToMm(p, off[p], sc.rasLo, sc.rasHi),
    spacing: (p) => sliceIx.spacing(p),
    sliceIndex: (p) => sliceIndexOf(p),
    step: (p, fwd) => (off[p] = sliceIx.wheel(p, off[p], fwd)),
    redraw: (p) => {
      drawSlice(p);
      xhair?.redraw();
    },
    redrawAll: drawAll,
    rasLo: sc.rasLo,
    rasHi: sc.rasHi,
    wl: { get: () => [wl.win, wl.lev], set: (w: number, l: number) => { wlUserSet = true; setWL(w, l); }, auto: [sc.win, sc.lev] },
    presetsEl: presets,
    resetViews: () => sliceControls.forEach((c) => c.resetView()),
    close: () => status("This is the SlicerLive Basic Image Review demo — reload to restart."),
    jumpAll,
    modality: res.ct.modality,
    strip: seriesStrip,
    // Study-level IDC deployments (SlicerRAD-IDC) turn off the measurement tools (no annotation
    // persistence yet) and hide the patient/study browser links (nothing to return to — the
    // series strip is the navigation). Set window.__SLICERRAD_IDC / __BIR_NO_MEASURE, or ?measure=off.
    disableMeasurements: noMeasure,
    hidePatientBrowser: IDC_MODE,
    // Not a volume → no reformats and no 3D to lay out: BIR basic, one stack viewport.
    stackOnly: stack,
    initialLayout: stack ? "single" : undefined,
    extraTools: [
      {
        id: "idc-share",
        icon: "share",
        title: "Share — copy a link that reopens this study here (or in the IDC OHIF portal)",
        run: () => shareStudy(source),
      },
      {
        id: "idc-download",
        icon: "download",
        title: "Download this study's DICOM to a local folder (streamed, parallel)",
        run: () => downloadStudyWithDialog(source, listAllStudySeries),
      },
    ],
  });
  (globalThis as Record<string, unknown>).__birDbg = {
    ready: () => !!bir,
    dims: () => sc.dims,
    tool: () => bir?.tool(),
    cellOrder: () => [...document.querySelectorAll("#grid .cell")].map((c) => (c as HTMLElement).dataset.cell),
    // test hooks
    setRoi: (en: boolean, vis: boolean) => {
      roiEnabled = en;
      roiVisible = vis;
      if (en) roiFirstEnable = false;
      sc.setRoiEnabled(en);
      sc.setRoiVisible(vis);
      draw3d();
    },
    roiState: () => ({ visible: sc.roiVisible(), handles: sc.roi.handleList().length }),
    // Segmentation introspection for the harnesses: what decoded, how it was layered, and where
    // a given segment is (so a test can put a view on it).
    rawSeg: () => shownSeg,
    segInfo: () => ({
      layers: 1 + (shownSeg?.extra?.length ?? 0),
      overlap: sc.segOverlap,
      segments: sc.segments.map((x) => ({ num: x.num, name: x.name, voxels: x.voxels })),
    }),
    segCentroid: (num: number): Vec3 | null => {
      const stack = [shownSeg?.lab, ...(shownSeg?.extra ?? [])].filter(Boolean) as Uint8Array[];
      const [nx, ny] = sc.dims;
      let n = 0, si = 0, sj = 0, sk = 0;
      for (const lay of stack) {
        for (let o = 0; o < lay.length; o++) {
          if (lay[o] !== num) continue;
          const k = (o / (nx * ny)) | 0, j = ((o - k * nx * ny) / nx) | 0, i = o - k * nx * ny - j * nx;
          si += i; sj += j; sk += k; n++;
        }
      }
      if (!n) return null;
      const M = sc.ijkToRAS, i = si / n, j = sj / n, k = sk / n;
      return [
        M[0] * i + M[1] * j + M[2] * k + M[3],
        M[4] * i + M[5] * j + M[6] * k + M[7],
        M[8] * i + M[9] * j + M[10] * k + M[11],
      ];
    },
    jumpTo: (ras: Vec3) => jumpAll(ras),
    rasToAxialView: (ras: Vec3, aspectWH: number) => sc.slice.rasToView("axial", off.axial, ras, aspectWH),
    ijkToRAS: () => sc.ijkToRAS,
    setSegOpacity: (o: number) => {
      sc.setSegOpacity(o);
      applySegOverlay();
      drawAll();
    },
  };

  for (const p of PLANES) {
    const hooks = bir.hooks(p);
    sliceControls.push(attachSliceControls(cv[p], {
      orient: p,
      getSlice: () => sc.slice,
      step: (fwd) => (off[p] = sliceIx.wheel(p, off[p], fwd)),
      redraw: () => {
        drawSlice(p);
        xhair?.redraw();
      },
      wl: {
        enabled: () => bir!.tool() === "wl",
        get: () => [wl.win, wl.lev],
        set: (w: number, l: number) => { wlUserSet = true; setWL(w, l); },
        range: dataRange,
        reset: () => setWL(sc.win, sc.lev),
      },
      leftMode: () => bir!.leftMode(),
      hooks: {
        onLeftGrab: hooks.onLeftGrab,
        onDoubleClick: () => {
          viewGrid.toggleMax(p);
          return true;
        },
      },
    }));
  }
  attachCameraControls(cv.threeD, camera, { onChange: () => { draw3d(); xhair?.redraw(); } });

  // 3D ROI-crop widget: grab a face/corner/centre handle to resize/move the crop box; the
  // cursor changes over a handle while the box is visible. Capture-phase, so grabbing a
  // handle doesn't reach the camera; empty space bubbles through to orbit.
  let roiBox0: Box | null = null;
  attachWidgetControls(cv.threeD, camera, {
    getHandles: () =>
      sc.roiVisible()
        ? sc.roi.handleList().map((h) => ({ id: h.id, world: h.world, data: h.data, cursor: h.cursor }))
        : [],
    getSize: () => ({ w: cv.threeD.width, h: cv.threeD.height }),
    onDragStart: () => {
      roiBox0 = sc.roi.snapshot();
    },
    onDrag: (h, world) => {
      if (!roiBox0) return;
      const d: Vec3 = [world[0] - h.world[0], world[1] - h.world[1], world[2] - h.world[2]];
      sc.roi.applyDrag(h.data as HandleMeta, roiBox0, d);
      sc.reclip(); // re-crop + upload box/handle/clip in one syncUniforms
      draw3d();
      xhair?.redraw();
    },
    onHover: (h) => {
      sc.roi.setHover(h ? h.id : null);
      sc.scene.syncUniforms();
      draw3d();
    },
    onChange: () => draw3d(),
  });

  xhair = mountCrosshair({
    cells: { axial: cv.axial, coronal: cv.coronal, sagittal: cv.sagittal, threeD: cv.threeD },
    getScene: () => sc.scene,
    getSlice: () => sc.slice,
    getCamera: () => camera,
    getOffset: (o) => off[o as Plane],
    onJump: jumpAll,
  });

  // ---- 3D volume-rendering preset + shift (Slicer/OHIF CT presets) ------------------------
  // vrPreset = active preset id (null = grayscale W/L VR). vrShift = Slicer's VR "Shift" (offset
  // the whole transfer function along the scalar axis). Shift range derives from the actual data
  // range (sampled), like Slicer's shift slider spanning the scalar range.
  let vrPreset: string | null = null;
  let vrShift = 0;
  // Slicer's VR shift spans the volume's scalar range. A streaming load has NO range when the
  // controls are built — vmin/vmax are still ±Infinity — so this has to be read live, or the
  // slider is frozen at the ±200 HU floor on every streamed study (which is all of them).
  const shiftStep = () => {
    const half = (vmax - vmin) / 2;
    return Math.max(1, Math.round((Number.isFinite(half) && half > 200 ? half : 200) / 200));
  };
  // Snapped to a whole number of steps, so the slider's grid lands exactly on 0 — an <input
  // type=range> quantizes from its min, and an unaligned span parks "no shift" at 1.5 HU.
  const shiftRange = () => {
    const half = (vmax - vmin) / 2;
    const span = Number.isFinite(half) && half > 200 ? half : 200;
    const step = shiftStep();
    return step * Math.round(span / step);
  };
  const bakeOf = (name: string | null) => name ? presetLUT(CT_VR_PRESETS.find((p) => p.name === name)!) : null;
  const presetLabel = () => vrPreset ? (CT_VR_PRESETS.find((p) => p.name === vrPreset)?.label ?? vrPreset) : "Default (W/L)";
  const applyVrPreset = (name: string | null) => {
    vrPreset = name;
    sc.setVolumePreset(bakeOf(name));
    if (sc.volumeOpacity() <= 0) sc.setVolumeOpacity(1); // reveal the VR so the preset is visible
    draw3d();
    xhair?.redraw();
  };
  const applyVrShift = (hu: number) => { vrShift = hu; sc.setVolumeShift(hu); draw3d(); xhair?.redraw(); };

  // On-the-fly thumbnails: render THIS volume at the CURRENT camera with each preset into a small
  // WebGPU canvas. Full opacity, no shift, segmentation hidden for a clean preview; live state is
  // restored afterward.
  const renderPresetThumbnails = (): VrPresetItem[] => {
    const THUMB = 116;
    const savedOp = sc.volumeOpacity(), savedShift = sc.volumeShift(), savedSeg = sc.segOpacity();
    sc.setVolumeShift(0);
    if (savedSeg > 0) sc.setSegOpacity(0);
    if (savedOp < 1) sc.setVolumeOpacity(1);
    const entries: { name: string | null; label: string }[] = [
      { name: null, label: "Default (W/L)" },
      ...CT_VR_PRESETS.map((p) => ({ name: p.name, label: p.label })),
    ];
    const items: VrPresetItem[] = [];
    for (const e of entries) {
      const c = document.createElement("canvas");
      c.width = THUMB; c.height = THUMB;
      const cxt = c.getContext("webgpu") as GPUCanvasContext;
      cxt.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
      sc.setVolumePreset(bakeOf(e.name));
      sc.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, THUMB, THUMB);
      sc.scene.renderToView(cxt.getCurrentTexture().createView({ format: srgb }), THUMB, THUMB);
      items.push({ name: e.name, label: e.label, canvas: c });
    }
    // restore live VR state
    sc.setVolumePreset(bakeOf(vrPreset));
    sc.setVolumeShift(savedShift);
    if (savedSeg > 0) sc.setSegOpacity(savedSeg);
    if (savedOp < 1) sc.setVolumeOpacity(savedOp);
    draw3d();
    return items;
  };
  Object.assign((globalThis as Record<string, unknown>).__birDbg as object, {
    presets: () => CT_VR_PRESETS.map((p) => p.name),
    setPreset: (name: string | null) => applyVrPreset(name),
    setShift: (hu: number) => applyVrShift(hu),
    vrState: () => ({ preset: vrPreset, shift: vrShift, shiftRange: shiftRange(), dataRange: [vmin, vmax] }),
    thumbCount: () => renderPresetThumbnails().length,
  });

  // SlicerLive badge popup: 3D volume-rendering + segmentation controls (NON-BIR), anchored
  // to the 3D cell — the SlicerLive-native version of the reader's "Live" controls.
  const controls: VizControl[] = [
    {
      label: "Volume render",
      getOpacity: () => sc.volumeOpacity(),
      setOpacity: (o) => {
        sc.setVolumeOpacity(o);
        draw3d();
        xhair?.redraw();
      },
      color: [0.75, 0.78, 0.85],
    },
    // Slicer's VR "Shift" — a plain slider directly below the opacity control.
    {
      label: "Shift",
      slider: {
        min: () => -shiftRange(),
        max: () => shiftRange(),
        step: () => shiftStep(),
        get: () => vrShift,
        set: (v) => applyVrShift(v),
        format: (v) => (v > 0 ? "+" : "") + Math.round(v),
      },
      disabled: () => sc.volumeOpacity() <= 0,
    },
    // Volume-rendering preset — opens the on-the-fly thumbnail menu (Slicer/OHIF CT presets).
    {
      label: "Preset",
      button: { text: () => presetLabel(), run: () => openVrPresetMenu({ items: renderPresetThumbnails(), current: vrPreset, onPick: applyVrPreset }) },
    },
    {
      label: "Segmentation",
      getOpacity: () => sc.segOpacity(),
      setOpacity: (o) => {
        sc.setSegOpacity(o); // 3D surface global opacity
        applySegOverlay(); // AND the 2D MPR overlay (fill + outline)
        drawAll();
      },
      disabled: () => !sc.hasSeg,
      color: [0.62, 0.9, 1.0],
    },
    // Outline width on the MPR planes, 0-4 px: click the chip to step up (4 wraps back to off),
    // or drag it sideways. Independent of the Segmentation opacity above, which is the FILL —
    // so the contours stay crisp over a dialled-down fill, or stand alone at 0%.
    {
      label: "Segmentation outline",
      steps: {
        max: 4,
        get: () => outlineWidth,
        set: (v) => {
          outlineWidth = v;
          applySegOverlay();
          for (const p of PLANES) drawSlice(p);
          xhair?.redraw();
        },
        format: (v) => (v ? `${v} px` : "off"),
      },
      disabled: () => !sc.hasSeg,
    },
    // 3D volume-render crop: enabling it reveals the ROI box the first time (Slicer behaviour).
    {
      label: "Crop volume (3D)",
      get: () => roiEnabled,
      set: (on) => {
        roiEnabled = on;
        if (on && roiFirstEnable) {
          roiVisible = true;
          roiFirstEnable = false;
        }
        sc.setRoiEnabled(roiEnabled);
        sc.setRoiVisible(roiVisible);
        draw3d();
        xhair?.redraw();
      },
      disabled: () => sc.volumeOpacity() <= 0,
    },
    {
      label: "Show ROI box",
      get: () => roiVisible,
      set: (on) => {
        roiVisible = on;
        sc.setRoiVisible(on);
        draw3d();
        xhair?.redraw();
      },
    },
    // DICOM corner annotations (IHE BIR) — the "official radiology look".
    {
      label: "Corner annotations",
      get: () => annOn,
      set: (on) => {
        annOn = on;
        applyAnn();
      },
    },
  ];
  const chrome = installChrome({
    // A stack has no 3D view, so the volume-rendering and crop controls would act on nothing:
    // only the annotation toggle (and the segmentation section, which explains its own absence)
    // are meaningful.
    controls: stack ? controls.filter((c) => c.label === "Corner annotations") : controls,
    // The BIR toolbar has its own Help button — suppress sl-chrome's fixed top-left "?" so it
    // doesn't overlap the toolbar (reported obscuring the Select-Patient / nav icons).
    help: false,
    anchor: cv.threeD.parentElement ?? undefined,
    segments: {
      list: () => sc.segments.map((s) => ({ num: s.num, name: s.name, color: s.color })),
      get: (num) => sc.segmentOpacity(num),
      set: (num, o) => {
        sc.setSegmentOpacity(num, o);
        drawAll();
      },
      enabled: () => sc.hasSeg,
      // A DICOM SEG may define overlapping segments. They are decoded into separate label
      // layers and composited, so the shared region reads as the blend of its segments and
      // comes out more opaque than either alone — but a reader should still be told that the
      // region belongs to two segments rather than inferring one odd-coloured one.
      note: () => {
        if (stack) {
          return res.seg || source.s
            ? "⚠ Segmentation hidden — this series is a stack of images, not a volume, so a " +
              "segmentation drawn on the slice positions cannot be registered to it."
            : null;
        }
        const ov = sc.segOverlap;
        if (!ov) return null;
        const nameOf = (n: number) => sc.segments.find((s) => s.num === n)?.name ?? `Segment ${n}`;
        const pairs = ov.pairs.slice(0, 3).map(([a, b]) => `${nameOf(a)} / ${nameOf(b)}`).join(", ");
        const more = ov.pairs.length > 3 ? ` and ${ov.pairs.length - 3} more` : "";
        const crowded = ov.crowded
          ? ` ${ov.crowded} segment(s) overlap more deeply than the four layers drawn; there the topmost wins.`
          : "";
        return `⚠ Segments overlap — the shared regions are blended and drawn more opaque. ` +
          `${ov.voxels.toLocaleString()} voxels are claimed by more than one segment ` +
          `(${pairs}${more}).${crowded}`;
      },
    },
  });

  buildAnnotations();
  applyAnn();
  applySegOverlay();   // outline-by-default: the scene is built with the fill showing
  // What the headers said about the geometry, before anyone reads the images.
  if (geomCheck && (geomCheck.stack || geomCheck.notes.length)) {
    geometryNotice(geomCheck, !!(res.seg || source.s));
  }
  const info = document.getElementById("info");
  if (info) info.textContent = `${source.sd} · ${res.ct.modality} ${sc.dims.join("×")} · ${source.lic}`;
  resize();

  // The loaded case, not a hardcoded one: this reader opens whatever the URL resolves to.
  const READY = stack
    ? `${source.sd} — image stack: scroll to page images, pick a tool from the toolbar`
    : `${source.sd} — scroll to page slices, pick a tool from the toolbar, drag 3D to orbit`;
  if (!streaming) {
    await mosaic!.done();   // the whole volume was already there when the scene was built
    status(READY);
    return;
  }

  // ---- streaming: the reader is live, now fill the volume underneath it ---------------------
  // Redraws are coalesced onto one frame: slices land faster than the views can re-render, and
  // a redraw per slice would spend the whole budget on frames nobody sees.
  let dirty = false;
  const redrawSoon = () => {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(() => { dirty = false; drawAll(); });
  };
  // The reader exists now: redraws can happen, and a segmentation that has already attached can
  // have its controls and annotations caught up.
  scheduleRedraw = redrawSoon;
  segRefreshUi = () => {
    applySegOverlay();
    chrome.refresh();     // the segmentation controls were disabled while there was no SEG
    buildAnnotations();   // the corner annotation gains "· SEG"
    applyAnn();
  };
  if (segAttached) segRefreshUi();
  redrawSoon();
  if (firstSlice && !wlUserSet && firstSlice.win > 0) {
    sc.win = firstSlice.win;
    sc.lev = firstSlice.lev;
    setWL(firstSlice.win, firstSlice.lev);
  }

  await loadDone;

  if (!streamStats.placed) throw new Error("no image slices could be placed in the volume");
  // What the index's instance count promised but the data did not deliver: a series that also
  // carries a report or a scout is allocated one plane too deep, and that plane would otherwise
  // keep its checkerboard. Clear whatever never arrived rather than leave a stand-in in a volume
  // the reader is now treating as real.
  let unfilled = 0;
  if (filledPlanes) {
    const blank = new Float32Array(sc.dims[0] * sc.dims[1]).fill(vmin);
    for (let k = 0; k < filledPlanes.length; k++) {
      if (!filledPlanes[k]) { sc.writeSlice(k, blank); unfilled++; }
    }
  }
  if (streamStats.dropped) {
    console.info(`[bir] ${streamStats.dropped} instance(s) in this series are not image slices and were skipped`);
  }
  if (streamStats.outside) {
    console.warn(`[bir] ${streamStats.outside} slice(s) fell outside the volume the index describes`);
  }
  if (unfilled) console.warn(`[bir] ${unfilled} plane(s) of ${sc.dims[2]} never received data`);
  bir?.refreshStrip();   // the open series' tile was drawn from the placeholder volume
  // The real scalar range is known now: the W/L drag gain (dataRange) and the VR shift span are
  // both read from it, so the shift slider has to be rebuilt — it was created over a volume that
  // had no data in it yet.
  chrome.refresh();
  drawAll();
  await mosaic!.done();   // packs the progress strip away, once no gesture is in flight
  resize();
  status(READY);
}

/** A failure the reader can describe to the person looking at it. */
class LoadError extends Error {
  constructor(readonly title: string, readonly detail: string, readonly hint?: string) {
    super(`${title} — ${detail}`);
  }
}

const DIRECT_FORM =
  "A series can always be opened without the index: ?series=<crdc_series_uuid>&bucket=idc-open-data";

/** Turn whatever went wrong into something a reader can act on. The thrown message is the
 *  detail; the title says which stage failed, because "not in the index" and "the index is
 *  unreachable" need different reactions from the person and we know which one happened. */
function classify(e: unknown): LoadError {
  if (e instanceof LoadError) return e;
  const msg = (e as Error)?.message ?? String(e);
  if (/not found in the IDC index/i.test(msg)) {
    return new LoadError("This study isn't in the IDC index", msg, DIRECT_FORM);
  }
  if (/couldn't reach the IDC index API|IDC API \d+/i.test(msg)) {
    return new LoadError("Couldn't reach the IDC index", msg, DIRECT_FORM);
  }
  if (/no CT\/MR\/PET\/NM image series/i.test(msg)) {
    return new LoadError(
      "Nothing in this study can be displayed",
      msg,
      "The study resolved, but it holds no image series this reader can reconstruct — " +
        "a segmentation or report without its images, for example.",
    );
  }
  if (/idc_tools|worker|DICOM|no DICOM under/i.test(msg)) {
    return new LoadError("The images didn't decode", msg, "The series resolved and downloaded, but could not be reconstructed.");
  }
  return new LoadError("Couldn't open this study", msg);
}

main().catch((e) => {
  const err = classify(e);
  status(`${err.title}: ${err.detail}`, true);
  _mosaic?.fail(err.title, err.detail, err.hint);
  console.error(e);
});
