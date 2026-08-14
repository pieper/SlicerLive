# examples/idc-explorer — PLACEHOLDER

> **Nothing here runs yet.** This directory holds a design, a roadmap, and two
> non-executing sketches. No file in it is imported, bundled or served. The working
> demonstrations of the idea are [`examples/remind`](../remind/) (ReMINDer) and
> [`examples/spine`](../spine/) — go there for code that does something.

## The idea

ReMINDer went from "find the ReMIND collection" to a deployed dashboard + drilldown viewer
with a passing test suite in about **45 minutes**. That number is the whole argument for this
project: the SlicerLive stack is now close enough to *"IDC collection → interactive study"*
that the remaining work is mostly **declaration**, not engineering.

ReMINDer and spine-review are two instances of one pattern, built independently:

| | `examples/spine` | `examples/remind` |
|---|---|---|
| a row is | a **method** — SPINEPS vs IDC reference | an **acquisition** — a surgical stage |
| volumes | ONE CT, two labelmaps over it | N volumes on N different grids |
| linking | normalized 0–1 slice offset | RAS focus + RAS field of view |
| dashboard | parallel coordinates of per-level 1−Dice | stat tiles + coverage grid + histograms |
| pixels | pre-baked zarr in a JS2 bucket | streamed from IDC, decoded in-browser |

**IDC Explorer** would generate both from a small declaration — and, more to the point, any
third collection or cohort in the Imaging Data Commons that nobody has built a viewer for yet.

## The model: frames / rows / parts

The obvious abstraction — *"one row per series"* — is wrong, and the two demos above show why.
The honest decomposition has three levels:

- **Frame** — one sampling grid: an image volume plus the labelmaps rasterised *onto that
  grid*. A frame owns its renderers, transfer function, window/level, residency and resolution
  ladder. Rasterising a SEG onto a grid is a physical fact, so overlays attach to **frames**,
  never to rows.
- **Row** — `(frame, layer-selection)`. What the viewer stacks vertically.
- **Part** — a named sub-case unit: a vertebral level, an anatomical structure, a surgical
  stage. Orderable, colour-carrying, optionally locatable in a loaded row (centroid + RAS
  bbox), optionally carrying a metric.

Two consequences make this worth the trouble:

1. **The one-volume/many-volume split disappears.** ReMINDer is N frames × 1 row each; spine
   is **one** frame × 2 rows selecting different layers. "Rows sharing a frame share a
   `SliceRenderer`" stops being a configuration flag and becomes a consequence of the model.
2. **Parts unify the two dashboards.** `case × part → value` is scalar for spine (1−Dice per
   level → parallel coordinates) and boolean for ReMINDer (stage present → coverage grid). One
   data shape, two renderings. The same parts are the dashboard's axis, the viewer's jump
   chips, and the deep-link unit.

Patient space (RAS focus + RAS field of view) is the *only* linking model — it is strictly more
general than a normalized slice offset and already correct for both demos.

## What changed under us: IDC v3 + the MCP server

IDC shipped a v3 API and a hosted MCP server after ReMINDer was built, and between them they
delete most of what ReMINDer's index builder does by hand.

- **Hosted MCP server** — `https://api.imaging.datacommons.cancer.gov/mcp`, streamable HTTP,
  no auth:

      claude mcp add --transport http idc https://api.imaging.datacommons.cancer.gov/mcp

- **REST v3** — `https://api.imaging.datacommons.cancer.gov/v3/openapi.json`, 22 endpoints
  (`/v3/stats`, `/v3/collections`, `/v3/attributes`, `/v3/cohort/counts`, `/v3/cohort/manifest`,
  `/v3/citations`, `/v3/licenses`, `/v3/viewer-url`, `/v3/clinical/tables/{t}/rows`, …).
- **`POST /v3/sql`** — read-only DuckDB `SELECT`/`WITH` over the IDC index. **No auth, no
  BigQuery, no 77 MB pip install.** Sandboxed: one statement, no writes, no file or network
  access.

**Division of labour:** the MCP server is the *authoring-time* surface — you or an agent
explores collections conversationally and drafts a profile. The generated app uses v3 REST +
`/v3/sql` at build time and runtime. A browser cannot speak MCP and should not try.

See [`worker/README.md`](worker/README.md) for the tables that matter, with **verified**
queries and — just as usefully — what those tables turn out *not* to give you. `seg_index`
replaces ReMINDer's description-parsing for structure names exactly, and does not replace it
for the reference-series link; `volume_geometry_index` carries geometry QC flags, not dims or
spacing, and skips multi-frame series entirely.

## Scope for v1

**In:** IDC-native data — images, DICOM SEG, and the metadata IDC itself publishes.

**Deferred:** joining *external* analysis results, which is spine's whole premise (SPINEPS
output computed elsewhere, compared against IDC reference segmentations). It needs a
`SeriesRef | ZarrRef` source union and a per-case metrics blob. Note before anyone tries:
`examples/spine/worker/build_cases.py` hardcodes a scratchpad path and is currently
**unreproducible** — re-derive it or freeze it as a historical artefact first.

**Out:** RTSTRUCT/RTDOSE (contours are not labelmaps; no browser rasteriser) and digital
pathology (no RAS, no MPR, no 3D). The clean line: the index/dashboard/drilldown layer is
modality-agnostic; **the viewer layer is 3D-volume-only.** A profile may name a different
drilldown page and still use everything above it.

## Directory

    README.md            this file
    PLAN.md              the roadmap, sequencing, and where the abstraction will leak
    profiles/            what a profile is, and the two existing demos sketched as profiles
    worker/              the v3 SQL index-builder design
    test/               how one generic driver would test any profile

## Status

Step 0 of [`PLAN.md`](PLAN.md) — placeholder only. Nothing is wired up, and `examples/spine`
and `examples/remind` are deliberately untouched: two data points do not define an
abstraction, so the shared core waits for a third collection to justify it.
