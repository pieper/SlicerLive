# worker/ — the index builder (design)

**Nothing here is implemented.** This is the design for step 1 of [`../PLAN.md`](../PLAN.md):
one script that turns a collection or cohort into the index JSON the dashboard and viewer both
read, using only the auth-free IDC v3 API.

## Why this is the first thing to build

It is the cheapest possible test of the whole v3 bet. If `POST /v3/sql` can reproduce
ReMINDer's index — 114 cases, 1346 series, 43.5 GB — then every later step rests on something
verified, and `examples/remind/worker/build_index.py` shrinks from a bespoke script to a query.

**Acceptance test:** regenerate the `remind` index from SQL alone and diff the case/series/byte
totals against the committed `examples/remind/remind-index.json`.

## The API

    https://api.imaging.datacommons.cancer.gov/v3/openapi.json

No authentication. No BigQuery. No `idc-index` install (that ~77 MB package is only needed for
downloads, DICOMweb, or pixel-level batch work — not for metadata).

| endpoint | use |
|---|---|
| `POST /v3/sql` | the engine — read-only DuckDB `SELECT`/`WITH` over the index |
| `POST /v3/cohort/counts` | cheap size check before committing to a cohort |
| `POST /v3/cohort/manifest` | structured-filter cohorts + a download payload |
| `GET /v3/stats` | archive-wide totals for the dashboard's context |
| `GET /v3/collections[/{id}]` | collection blurb, DOI, cancer type, subject count |
| `GET /v3/attributes[/{a}/values]` | the vocabulary a cohort-builder UI needs |
| `POST /v3/citations`, `POST /v3/licenses` | provenance, instead of hand-written strings |
| `GET /v3/viewer-url` | OHIF deep links |
| `GET /v3/clinical/tables/{t}/rows` | clinical joins — the axis both demos lack |

`/v3/sql` is sandboxed: one statement, no writes, no file or network access. Get table and
column names from `/v3/tables` and `/v3/tables/{table}` first.

## Tables worth knowing

Verified present — 17 in total. The ones that change how an index is built:

| table | why |
|---|---|
| `index` | the main table, one row per series, 31 columns |
| `seg_index` | one row per SEG series with **coded segmented anatomy** |
| `volume_geometry_index` | per-series geometry **QC flags** — obliquity, regular spacing |
| `mr_index` / `ct_index` / `pt_index` | acquisition parameters, for faceting |
| `clinical_index` | dictionary for the per-collection clinical tables |
| `collections_index`, `analysis_results_index` | collection- and analysis-level metadata |
| `rtstruct_index`, `sm_index`, `ann_index` | visible to a dashboard; out of scope for the viewer |

**The specialized tables have no `collection_id`.** They key on `SeriesInstanceUID` and must be
joined to `index` — filtering them directly fails with a binder error. Their columns:

    seg_index              SeriesInstanceUID, SegmentationType, total_segments, AlgorithmType,
                           AlgorithmName, segmented_SeriesInstanceUID,
                           SegmentedPropertyCategory_CodeMeanings,
                           SegmentedPropertyType_CodeMeanings, AnatomicRegion_CodeMeanings

    volume_geometry_index  SeriesInstanceUID, single_orientation, orthogonal_orientation,
                           unique_slice_positions, consistent_in_plane_row,
                           consistent_in_plane_col, consistent_pixel_spacing,
                           consistent_image_dimensions, uniform_slice_spacing,
                           obliquity_degrees, regularly_spaced_3d_volume

`index` columns:

    collection_id, analysis_result_id, PatientID, SeriesInstanceUID, StudyInstanceUID,
    source_DOI, PatientAge, PatientSex, StudyDate, StudyDescription, BodyPartExamined,
    Modality, SOPClassUID, sop_class_name, TransferSyntaxUID, transfer_syntax_name,
    PhotometricInterpretation, PixelRepresentation, Manufacturer, ManufacturerModelName,
    SeriesDate, SeriesDescription, SeriesNumber, instanceCount, license_short_name,
    series_init_idc_version, series_revised_idc_version, aws_bucket, crdc_series_uuid,
    series_aws_url, series_size_MB

## What the specialized tables actually give you

Both queries below were run against `remind` and the outputs are real. They are worth reading
together with what they *don't* deliver, because the difference is where a builder would
otherwise waste a day.

**Segmented anatomy — coded, not parsed.** ReMINDer matches
`"^(.*?) seg - MR ref: (.*)$"` against each SEG's `SeriesDescription` — collection-specific
string surgery that would not survive contact with a second collection. `seg_index` has it as
standard coded meanings, plus manual/automatic provenance:

```sql
SELECT s.SegmentedPropertyType_CodeMeanings AS structure, s.AlgorithmType, COUNT(*) AS n
FROM seg_index s JOIN index i ON i.SeriesInstanceUID = s.SeriesInstanceUID
WHERE i.collection_id = 'remind' GROUP BY 1, 2 ORDER BY n DESC
```

    ['Glioma']              MANUAL      132
    ['Brain']               AUTOMATIC    89
    ['Residual tumor']      MANUAL       60
    ['Brain ventricle']     AUTOMATIC    54
    ['Excision of brain']   MANUAL       21   -> 356 total

That agrees **exactly** with ReMINDer's regex-derived counts (tumor 129 + tumor_target 3 = 132
Glioma; cerebrum 89; tumor_residual 60; ventricles 54; previous_resection_cavity 21) — good
evidence the coded path is a faithful replacement, and it arrives with a MANUAL/AUTOMATIC
facet the descriptions never carried.

**But it does not replace the reference link.** `segmented_SeriesInstanceUID` — the series a
SEG overlays — is **NULL for all 356 ReMIND SEGs**. That is the one thing ReMINDer's regex was
really buying, so per-collection logic still has to answer "which image does this segmentation
belong to" when the column is empty. Check it, don't assume it.

**Geometry: QC flags, not dimensions.** `volume_geometry_index` is a *quality* table — is the
series single-orientation, orthogonal, regularly spaced, and how oblique:

```sql
SELECT i.SeriesDescription, ROUND(g.obliquity_degrees, 1) AS oblique,
       g.regularly_spaced_3d_volume AS regular
FROM volume_geometry_index g JOIN index i ON i.SeriesInstanceUID = g.SeriesInstanceUID
WHERE i.collection_id = 'remind' AND i.PatientID = 'ReMIND-001'
```

    3D_AX_T1_postcontrast     6.6   True
    2D_AX_T2_BLADE            9.1   True
    2D_COR_T2_BLADE          38.1   True
    3D_SAG_T2_SPACE          41.2   True

Useful — 41° of obliquity is exactly why a rotated volume's axis-aligned bounding box dwarfs
its side lengths, which is a trap worth flagging in a UI. **Two caveats:** it carries no dims
or voxel spacing (so "this arrives as 223×172×209 at 0.47 mm" still needs a decode), and it
covers only single-frame CT/MR/PT — **every ReMIND ultrasound series is absent**, being
multi-frame. For "what will this cost me", `index.series_size_MB` and `instanceCount` remain
the honest answer.

## The shape of the builder

One query per collection, joining `index` + `volume_geometry_index` + `seg_index` (plus
`mr_index` or a clinical table when a profile wants them), then a small amount of
collection-specific Python to group series into cases and parts.

Verified working — this returns `MR 670 / SEG 356 / US 320, 114 patients`, exactly reproducing
what ReMINDer derived through the older v2 manifest API:

```sql
SELECT Modality, COUNT(DISTINCT SeriesInstanceUID) AS series,
       COUNT(DISTINCT PatientID) AS patients
FROM index WHERE collection_id = 'remind' GROUP BY Modality
```

The generic half — HTTP with retry, paging, `/v3/stats` and `/v3/citations`, the summary
block, the warnings channel — comes from `examples/remind/worker/build_index.py`, which
already has all of it. What stays per-collection is the grouping logic: for ReMIND, *"the study
containing ultrasound is the intra-operative one"* (true for 114/114 patients) and the
stage names carried in the US series descriptions.

**Keep the warnings channel.** ReMINDer's builder reports rather than guesses when a SEG's
reference is ambiguous, and that discipline is what made its index trustworthy enough to build
a viewer on.

## The MCP server is for authoring, not for the app

    claude mcp add --transport http idc https://api.imaging.datacommons.cancer.gov/mcp

Use it to explore a collection conversationally and draft the grouping logic — *"what
modalities does this collection have, how many studies per patient, what do the SEGs
segment"* — then write the query it taught you into the builder. The generated app talks to
`/v3/sql` and the REST endpoints. A browser cannot speak MCP and should not try.
