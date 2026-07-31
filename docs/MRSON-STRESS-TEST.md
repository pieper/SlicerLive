# mrson — Pre-implementation Stress Test

Status: **evidence review, 2026-07-29.** Nothing built. This is the "stress-test these ideas
before we implement anything" pass requested before standing up `pieper/mrson`. It pressure-tests the
four load-bearing bets — (1) JSON Schema as the substrate, (2) JSON vs a "mryaml" vs binary, (3) an
`mr.md` authoring language, (4) one data layer spanning IGT-realtime → population-health → cellular —
against what has actually happened to comparable efforts. Companion to
[`MRSON-LIVESCENE.md`](MRSON-LIVESCENE.md) (the architecture) and
[`UNIFIED-RENDERING-PLAN.md`](UNIFIED-RENDERING-PLAN.md).

Method: ~12 parallel web-research passes against primary sources (specs, IETF RFCs, peer-reviewed
papers, project post-mortems), each briefed to hunt for *failure modes*, not features. Sources are
inline throughout.

---

## 0. Verdict up front

| Idea | Verdict | One-line why |
|---|---|---|
| **mrson as a new format** | **GO — but only as a thin scene/interaction layer over borrowed containers** | It owns the scene graph + transform tree + live channel that no existing format owns; it must *not* own arrays, DICOM, or a universal domain model. |
| **JSON + JSON Schema substrate** | **GO — heavily restricted subset** | Right ecosystem gravity (Ajv/Fastify/VS Code/OpenAPI 3.1/MCP), but every large success won by *banning* most of the spec. |
| **"mryaml" as a format** | **NO** | YAML's implicit-typing + parser-fragmentation + DoS/RCE surface are disqualifying for lossless DICOM carriage. |
| **YAML for hand-authoring** | **CONDITIONAL** | Only a KYAML-style strict, quoted, flow-style, schema-validated profile that canonicalizes to JSON at the edge. |
| **Binary twin** | **GO — CBOR** | RFC 8949 / STD 94 is rigorously "binary JSON," self-describing, streamable; reserve FlatBuffers/Cap'n Proto for narrow hot-path packets. |
| **`mr.md` authoring language** | **GO — CommonMark-first** | Frontmatter + `mrson:` links + fenced `mr-scene` op-blocks; MyST's model, Markdoc's validation, *not* MDX. |
| **JSON-native web stack (Fastify)** | **GO** | Schema-as-single-source-of-truth (validate + fast-serialize + document) is proven; mind that serialization ≠ validation. |
| **Tri-scale in ONE model** | **NO — scope down** | "One big model" is the RIM/caBIG/VPH failure. Do a narrow-waist neutral core + per-domain profiles. |
| **`mrcom` DICOM binding** | **GO** (unchanged) | Boundary adapter, not runtime; see [`MRSON-LIVESCENE.md §1b`](MRSON-LIVESCENE.md). |

**The one sentence:** *mrson survives as an **OpenUSD-shaped narrow waist for medical reality** —
a small, semantics-free core (identity, typed references, provenance, a runtime typing mechanism, and
abstract handles for spatial frames + bulk payloads) with pluggable per-domain profiles — expressed as
a restricted JSON-Schema'd JSON document with a CBOR binary twin, authored via mr.md, and bounded by
adapters to DICOM, OME-Zarr, FHIR, and ROS/OpenIGTLink. It dies if it tries to be a universal domain
model — and its real risk is profile **governance**, not core minimalism.*

---

## 1. JSON Schema as the substrate — GO, but restrict hard

**JSON Schema is still not a ratified standard.** There is no RFC; the project left the IETF
Internet-Draft track to run its own release process ([json-schema.org "Moving Toward a Stable
Spec"](https://json-schema.org/blog/posts/stable-json-schema)), while a separate 2026 IETF
`jsonschema` WG charter and a *competing* replacement draft
([JSON Structure, draft-vasters-json-structure-core](https://datatracker.ietf.org/doc/draft-vasters-json-structure-core/00/))
both exist. The foundation is live but politically unsettled.

**The ecosystem is effectively stuck on draft-07 even though 2020-12 is "correct."** VS Code — the
most-deployed consumer on earth — has only *limited* 2019-09/2020-12 support
([code.visualstudio.com](https://code.visualstudio.com/docs/languages/json)); `typescript-json-schema`
emits draft-07; MCP had to generate draft-07 and *post-patch* `$schema` to 2020-12
([MCP SEP-1613](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1613)). OpenAPI 3.1
did reconcile — it is a true superset of JSON Schema 2020-12
([apisyouwonthate](https://apisyouwonthate.com/blog/openapi-json-schema-divergence/)) — which is the
strongest reason to *declare* 2020-12, but adoption still lags 3.0 five years on.

**The traps to design around from day one:**
1. **`allOf` + `additionalProperties:false` silently rejects valid documents** — each subschema is
   evaluated in isolation, so inherited properties read as "additional." The fix
   (`unevaluatedProperties`) *doesn't exist in draft-07*. So closed content + composition is
   fundamentally incompatible with the draft-07 tools above. **Decide the composition strategy before
   writing node 1: use a discriminated tagged union (`type` enum → one closed branch), not `allOf`
   inheritance** ([json-schema.org object ref](https://json-schema.org/understanding-json-schema/reference/object)).
2. **`$dynamicRef`/`$recursiveRef` — avoid entirely.** Inconsistently implemented (Ajv restricts
   them), formally hard, and there's an
   [active proposal to replace them](https://github.com/orgs/json-schema-org/discussions/789). Use
   plain named `$ref` into local `$defs` for the recursive scene tree.
3. **Schema ≠ semantics ≠ UI ≠ codegen.** A valid schema does not guarantee an agent or UI can
   round-trip it; the community had to invent parallel `uiSchema`
   ([discussion #70](https://github.com/orgs/json-schema-org/discussions/70)). Keep rendering/agent
   hints in a *separate* annotation layer (reserved `x-` keys), never in validation keywords.

**What the winners did — the K8s lesson.** Kubernetes CRD **structural schemas** deliberately *ban*
`oneOf`/`anyOf`/`allOf`/`not`/`$ref`/`patternProperties` at the general level and require a mandatory,
single, non-empty `type` — because only a statically-knowable structure lets the server do pruning
(a security fix — unknown fields were persisted to etcd), defaulting, and server-side apply
([Kubernetes blog](https://kubernetes.io/blog/2019/06/20/crd-structural-schema/)). **Fastify** compiles
schemas once at startup for both Ajv validation and `fast-json-stringify` (2–5× faster than
`JSON.stringify`, and it whitelists output) — but note **serialization does not validate**, so a
schema-written mrson file needs an explicit validate-after-write step
([Fastify docs](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)).

**Decision:** declare `2020-12`, pin `$schema` explicitly, but **restrict to a K8s-style structural
subset** (mandatory single `type`; `properties`/`items`/`additionalProperties`/`enum`/`const`/
`required` + leaf constraints; plain `$ref` to local `$defs` only; tagged unions over `allOf`;
`unevaluatedProperties:false` for closure with documented draft-07 degradation). Add CI that validates
every schema under *both* an Ajv-2020-12 and a draft-07 validator to catch divergence early. Security:
schemas compile via `new Function()` — never validate against an untrusted schema.

---

## 2. Encoding — JSON canonical, CBOR binary twin, YAML only as strict authoring sugar

**Do not build "mryaml."** YAML's footguns are spec-level and still shipping:
- **Implicit typing / the "Norway problem":** unquoted `NO`→`false`, `9.3`==`9.30`, `04:30`→sexagesimal
  int, leading-zero→octal; 8-char all-digit git SHAs mistype at ~2%
  ([StrictYAML rationale](https://hitchdev.com/strictyaml/why/implicit-typing-removed/),
  [noyaml.com](https://noyaml.com/)). For a format that must carry DICOM UIDs/accession numbers
  losslessly, this is disqualifying.
- **1.1 vs 1.2 doesn't save you:** YAML 1.2 narrows booleans and drops sexagesimal, but **PyYAML still
  defaults to 1.1** ([yaml.org/spec/1.2.2 changelog](https://yaml.org/spec/1.2.2/ext/changes/)), and
  **"JSON is a YAML subset" is false in the strict sense** — `1e2` is a *string* under YAML 1.1
  ([Millikin](https://john-millikin.com/json-is-not-a-yaml-subset)).
- **DoS + RCE:** billion-laughs alias expansion is live (Symfony
  [CVE-2026-45304](https://symfony.com/blog/cve-2026-45304-yaml-parser-exponential-memory-allocation-via-recursive-collection-alias-expansion-billion-laughs));
  `yaml.load()` executed arbitrary code ([CVE-2017-18342](https://www.cvedetails.com/cve/CVE-2017-18342/),
  recurring downstream e.g. CVE-2026-24009). JSON has no analog.

**The infra world's verdict is explicit:** Kubernetes shipped **KYAML** in v1.34 (Aug 2025) — a
strict, always-double-quoted, flow-style (`{}`/`[]`, whitespace-insensitive) YAML *subset* — precisely
because plain YAML was too dangerous ([KEP-5295](https://github.com/kubernetes/enhancements/blob/master/keps/sig-cli/5295-kyaml/README.md)).
The fix for YAML's footguns is "look like JSON-with-comments." So: **canonical form = JSON + JSON
Schema; any hand-authoring is a KYAML-style strict profile that lints-and-converts to JSON at the
edge, never the trust boundary for untrusted input.**

**Binary twin = CBOR** ([RFC 8949 / STD 94](https://www.rfc-editor.org/rfc/rfc8949.html)) — the only
format that is *rigorously* binary-JSON ("an extended version of the JSON data model"), self-describing
(no mandatory IDL), streamable (indefinite-length), and tag-extensible, at the **highest IETF maturity
tier**. MessagePack is similar but weaker governance; the rigid-IDL family (Protobuf/Avro/Cap'n
Proto/FlatBuffers) fights an open, evolving research schema. **Reserve a zero-copy IDL
(FlatBuffers/Cap'n Proto) only for narrow, versioned hot-path packets** (traced render samples, IGT/
robot telemetry) nested *inside* the self-describing envelope — matching the existing node-state/blob
channel split.

**Semantics = opt-in JSON-LD `@context`, not mandatory RDF.** JSON-LD's own co-creator deliberately
buried RDF to get adoption ("JSON-LD and Why I Hate the Semantic Web"
[Sporny](https://asynchronous.org/blog/archives/2018/04/14/json-ld-and-why-i-hate-the-semantic-web));
full RDF/OWL is the boil-the-ocean trap. Borrow only the cheap subset: stable IRIs for identity and
for code-scheme references (DICOM/SNOMED/RadLex are already IRI-shaped), and an *optional* `@context`
so a document is *promotable* to RDF without forcing anyone through quad stores.

---

## 3. "Don't reinvent it" — what mrson must adopt, map-to, or genuinely own

Every mature scientific format converged on the **same shape: chunked binary arrays + JSON/YAML
metadata + a governed extension mechanism.** Nobody puts bulk voxels in a JSON document.

- **The strongest "just use X" challenge is OME-NGFF/Zarr,** not FHIR. It is *literally* chunked Zarr
  + JSON metadata with multiscale pyramids and named axes, and **SpatialData** already extends it to
  the cellular/spatial-omics scale ([ngff.openmicroscopy.org](https://ngff.openmicroscopy.org/),
  [SpatialData](https://spatialdata.scverse.org/en/stable/design_doc.html)). **The honest rebuttal:**
  NGFF is a *pixel/array* model with **no scene graph, no transform tree across objects, no realtime
  channel, no lossless DICOM contract.** → **Adopt OME-Zarr as the volume-blob substrate; mrson is the
  scene/interaction/realtime layer above it that NGFF, FHIR, and DICOM all lack.** This also defuses
  the "you're reinventing HDF5/Zarr" critique — you aren't; you're using Zarr.
- **LINDI** (Neurodata's "Linked Data Interface") is the closest existing thing to what mrson wants to
  be: a **JSON manifest** holding hierarchy + attributes + small values inline while *referencing
  large binary chunks externally* (kerchunk-style) — explicitly *not* a container for the arrays
  ([LINDI](https://github.com/NeurodataWithoutBorders/lindi)). Copy this pattern rather than inventing
  a "JSON + external blobs" convention.
- **HDMF/NWB** teach the load-bearing separation: **data model ↔ storage backend ↔ interaction API**,
  which let NWB add a Zarr backend without touching the schema
  ([HDMF PMC8500680](https://pmc.ncbi.nlm.nih.gov/articles/PMC8500680/)). This directly ratifies the
  existing LiveScene "three roles" (export / network sync / shared-memory) as *three serializations of
  one model.* NWB also proves **namespaced, cataloged extensions (NDX)** are mandatory or vendors fork
  the format.
- **SpatialData had to *extend* NGFF's weak scale+translation transforms** to intrinsic/extrinsic named
  frames + full affine — exactly the RAS-affine discipline mrson already requires. The real
  coordinate-frame machinery (named frames, affine/rotation/displacement, frames as input→output
  edges) is in **NGFF RFC-5**, still *unratified* — a genuine opening for mrson, but a moving target
  ([RFC-5](https://ngff.openmicroscopy.org/rfc/5/)).
- **FHIR** is a map-to for *context*, not the container: its imaging resources deliberately *reference*
  DICOM (WADO-RS) rather than carry pixels, and it has no scene graph or high-rate transport. Provide
  an mrson↔FHIR `ImagingStudy`/`Patient` mapping so scenes locate in a clinical record; don't embed
  FHIR ([hl7.org/fhir](https://hl7.org/fhir/)).

**Four non-negotiable adapters for credibility (day one):** (1) **lossless DICOM** via the
[DICOM JSON model + DICOMweb](https://dicom.nema.org/medical/dicom/current/output/html/part18.html)
(BulkDataURI for pixels, never inline voxels); (2) **OME-Zarr volume blobs**; (3) a **coordinate-frame
model that maps to both DICOM-LPS and [ROS REP-103](https://www.ros.org/reps/rep-0103.html)**
(right-handed, SI, quaternion-first) with an explicit RAS↔LPS↔ROS convention published, since silent
axis mismatch is *the* classic integration bug; (4) a **binary realtime channel that maps to
OpenIGTLink / ROS tf2** — not JSON (see §4).

---

## 4. The tri-scale ambition — NO as one model; YES as a narrow waist + profiles

The request was one data layer for IGT-realtime + population-health + cellular. **As "one coherent
object model" this is the exact hubris that has failed repeatedly. But a weaker, honest version is
credible and worth building.**

### The cautionary canon (post these on the wall)
- **HL7 v3 / RIM** — "everything is an Act/Entity/Role" ballooned to ~130 classes / 980 attributes; the
  originator's own verdict was "the complexity wasn't gone, just hidden," and it produced *inconsistent*
  implementations — resurrecting the very problem it set out to solve
  ([Smith & Ceusters, "An Incoherent Standard"](http://ontology.buffalo.edu/HL7/doublestandards.pdf),
  ["The Fall of the RIM"](http://hl7-watch.blogspot.com/2011/04/fall-of-rim.html)).
- **caBIG** — universality with no ruthless prioritization → a 70+-app "software enterprise," used by
  <a dozen centers, ~$350M spent, a recommended development *moratorium*
  ([InformationWeek](https://www.informationweek.com/it-infrastructure/report-blasts-problem-plagued-cancer-research-grid)).
- **Virtual Physiological Human / Physiome** — the direct precedent for *cross-scale* ambition (9 orders
  of magnitude in space, 17 in time). Two decades on, the grand integral never shipped; the **composable
  pieces did** (SBML, CellML, repositories) ([EMBO](https://www.embopress.org/doi/full/10.1038/msb.2009.51)).
- **Semantic Web / RDF-OWL** and **WS-*/SOAP** — comprehensive committee-driven "boil-the-ocean"
  standards that lost to simpler bottom-up alternatives (REST+JSON; schema.org+JSON-LD)
  ([Bray "On REST"](https://www.tbray.org/ongoing/When/200x/2008/08/18/On-REST),
  [Doctorow "Metacrap"](https://craphound.com/articles/2001/08/07/metacrap-setting-the-torch-to-the-seven-straw-men-of-the-meta-utopia/)).
  Named anti-patterns: **inner-platform effect**, **god object**, **speculative generality**
  ([Daily WTF](https://thedailywtf.com/articles/The_Inner-Platform_Effect)).

### The narrow-waist successes (the template to copy)
- **Internet hourglass.** The waist stays *minimal, general, resource-limited on purpose*: a spanning
  layer is "the **weakest specification still sufficient** for the necessary applications" — every
  requirement removed from it enlarges the set of technologies that can carry it, while the uniform
  interface lets applications above evolve freely (Beck's **Deployment Scalability Tradeoff**,
  [CACM 2019](https://cacm.acm.org/research/on-the-hourglass-model/); Deering's own rationale: "assumes
  least common network functionality to maximize number of usable networks"). The **god-model failure
  mode is a *fat* waist** (ATM's funnel) — pinning capabilities into the core multiplies interfaces and
  shrinks what can implement it.
- **OpenUSD** — the single best template, and it already spans film → robotics → CAD → industrial
  digital twins *without a god-schema*, because "**USD's core scenegraph and composition engine are
  agnostic of any particular domain**" ([openusd.org/intro](https://openusd.org/release/intro.html)).
  A thin composition core (prims, typed properties, layers, LIVRPS composition arcs, transformable
  frames) is fixed; **all domain meaning lives in pluggable typed schemas** (including *codeless*
  schemas registered as pure data). New industry = new schema, never a core edit.
- **Zarr/OME-NGFF** — "chunked N-D array + minimal JSON metadata," domain meaning attaches purely as
  *attribute conventions*; the same core spans microscopy, astronomy, geoscience, genomics
  ([Zarr v3 spec](https://zarr-specs.readthedocs.io/en/latest/v3/core/index.html)).
- **ROS 2 / DDS** — standardize the **contract shape, not the domain**: anonymous pub/sub of composable
  typed messages over named topics, with a ~13-scalar primitive set; the transport (DDS vendor, Zenoh)
  is a swappable detail behind RMW ([design.ros2.org](https://design.ros2.org/articles/ros_on_dds.html)).
- **FHIR** — the *governance* template: an **80/20** concrete core + formal profiles/extensions for the
  long tail. "You don't need the RIM"; one `Patient` resource instead of ten CMETs; "no context is
  conducted — everything is explicit"; and the litmus test — *"if software developers couldn't make it
  work in a weekend, we knew we'd made it too complicated"*
  ([fire.ly](https://fire.ly/blog/the-early-days-of-fhir/),
  [comparison-v3](http://hl7.org/fhir/comparison-v3.html)).

### The decisive finding: the three scales do NOT share a "scene"
Independent probes of each scale found the shared primitives are a *short list* — and **no primitive is
shared by all three except identity, references, and provenance:**

- **Realtime IGT/robotics is a transport concern, not a document concern.** OpenIGTLink is a 58-byte
  header (identity + timestamp + length + CRC) + binary body, *no scene model by design*
  ([openigtlink.org](http://openigtlink.org/protocols/v2_header.html)). The clinching evidence:
  **DICOM-RTV** — when DICOM (a document/object standard) needed realtime, it *refused to stream through
  its object model* and bolted on an RTP/SMPTE-2110/PTP transport, **demoting its persistent document
  fields to a 1 Hz heartbeat** while pose/pixels ride the frame clock
  ([PS3.22](https://dicom.nema.org/medical/dicom/current/output/html/part22.html)). **Nobody puts the
  pose stream inside the document.**
- **Population health (OMOP CDM, Flat FHIR, i2b2) is (identity × concept × time) fact rows.** There is
  *no coordinate frame shared across patients* — patients are independent; even geospatial epidemiology
  enters as another categorical dimension to group by, not a rendered frame
  ([OMOP CDM](https://ohdsi.github.io/CommonDataModel/), [i2b2](https://community.i2b2.org/wiki/display/ServerSideDesign/OBSERVATION_FACT+Table)).
  A "scene" abstraction has **zero purchase** here.
- **Cellular is array + named-coordinate-frame heavy** (OME-NGFF/SpatialData) — which *does* unify with
  IGT's spatial/array/streaming nature. But **SBML/CellML "cellular processes" is off-axis**: a
  MathML graph-of-reactions/ODEs with no space
  ([SBML](https://academic.oup.com/bioinformatics/article/19/4/524/218599)) — reference it, don't
  absorb it.

### Recommendation
Build mrson as an **OpenUSD-shaped narrow waist for medical reality**. A per-primitive test of *what is
actually shared across the three scales* (not what feels unifiable) draws the core boundary sharply —
and it is smaller than first instinct:

| Primitive | IGT | Population | Cellular | In neutral core? |
|---|---|---|---|---|
| Identity / content-address | ✓ | ✓ | ✓ | **Core** — copy FHIR's logical-`id` vs business-`identifier` split |
| References / relationships | ✓ | ✓ | ✓ | **Core** — first-class typed pointers; copy FHIR literal-vs-logical |
| Provenance | ✓ | ✓ | ✓ | **Core** — external, W3C-PROV-aligned resource, *not* embedded |
| Typed attributes | ✓ | ✓ | ✓ | **Core = the typing *mechanism* only**; the types themselves are per-domain (no cross-scale type ontology — that's the god-schema trap) |
| Coordinate frames / transforms | ✓ | ✗ | ✓ | **Profile, NOT core** — useless to population health; applied spatial schema (USD `Xformable`), frame convention in document metadata |
| Bulk blobs / arrays | ✓ | marginal | ✓ | **Core = a content-addressed handle + codec descriptor**; the payload format is a profile choice (OME-Zarr for arrays, Arrow for tables) |
| Change / update channel | ✓ low-latency | ✓ bulk+sub | ✓ chunk-writes | **Share the op *vocabulary*, not the transport** (these are legitimately different wires) |

So the genuinely-shared **neutral CORE (small, frozen, semantically empty)** is just: **identity ·
typed references · provenance · a runtime typing mechanism · abstract handles for spatial frames and
bulk payloads** · plus **one change *vocabulary* with two transport bindings** — a *document/layer
edit* binding for scene state and a *streaming* binding (OpenIGTLink/DDS-style typed messages) for
realtime. **Streaming is a separate binding on the same core, never document mutation.** Note the
correction to earlier drafts: **coordinate frames do not live in the core** — they are a spatial
profile that IGT and imaging opt into (RAS discipline generalized), which is exactly how USD keeps
`Xformable` out of the prim core and puts `upAxis`/`metersPerUnit` in stage metadata.

**Per-domain PROFILES (all semantics live here, minimal-and-extensible FHIR-style, not maximal
openEHR-style):** `spatial` (frames + affine/nonlinear transforms — expect this to be genuinely *hard*
and partly unstandardized; NGFF is still RFC-ing it) · `igt` (devices, tools, tracking streams, therapy
plans, robot kinematics — and decide tree-vs-graph *deliberately*, since URDF's tree can't express the
closed-loop Stewart platforms common in needle robots, which is why SDF went to a graph) · `micro`
(NGFF pyramids, spatial-omics; SBML referenced) · `population` (**map-to/adjacent only** — wraps/points
at OMOP/FHIR-Bulk, carries *no* coordinate frame; do not claim mrson "covers population health").

**Copy, in one line: OpenUSD's architecture, FHIR's governance, Zarr/NGFF's array plumbing** (and
Arrow, not Zarr, for any tabular payload). The existing scene JSON (node-state + blob channels) is
*already this shape* — formalize it, don't replace it with a bigger schema.

### Governance is the real risk — not minimalism
Every minimal-core-plus-profiles ecosystem trades the schema-bloat problem for a **profile-governance**
problem, and the evidence says *that* is the one that actually bites. FHIR's documented
**"profiliferation"** — redundant, overlapping profiles instead of reuse — was measured across
[1,300 FHIR packages](https://fire.ly/blog/interoperability-insights-from-1300-fhir-packages/); a
minimal core did not prevent fragmentation, it *relocated* it into the profile layer. OpenUSD openly
[admits schema *versioning* is unsolved](https://openusd.org/release/wp_schema_versioning.html)
("which version is this prim?" is ill-defined once composition swirls specs together) — it deferred the
decision and now can't retrofit one. Design the governance in from commit one:
- **Decide the schema-versioning story up front** (per-type version + stability grade), since it can't
  be retrofitted cleanly.
- **Steal a better ignore-safety design than Zarr's** per-field `must_understand` boolean: use
  [glTF's asset-level `extensionsRequired`/`extensionsUsed`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
  split (a reader knows *immediately* if it can load the file at all) **plus** FHIR's
  [modifierExtension distinction](https://hl7.org/fhir/extensibility.html) ("changes meaning → you may
  not ignore it" vs "extra info you may").
- **Governance-as-tooling** is the antidote to profiliferation:
  [OpenTelemetry's Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/)
  pair explicit **stability levels** with a central **attribute registry** and code-gen/validation
  tooling (Weaver). A reuse registry with generated validators — not an elegant core — is what keeps
  the profile layer coherent.

### Anti-patterns to design against
god-schema (RIM) · inner-platform effect / over-generalization · boil-the-ocean (caBIG, Semantic Web) ·
maximal profiles (openEHR "maximum dataset" archetypes) · **profiliferation / ungoverned profile
sprawl** (FHIR) · **deferring schema-versioning** (USD) · forced cross-scale integration (VPH) ·
document-izing the stream · coordinate-frame creep into non-spatial data. **Tripwire:** if the "neutral
core" ever grows a domain concept (a `therapy` type, a `cohort` type, *or a coordinate frame*), stop —
that belongs in a profile.

---

## 5. mr.md — CommonMark-first, MyST model, Markdoc validation

**Precedent verdict:** clone **MyST's** document model (the scientific-document lineage: directives,
reference-by-stable-label, typed JSON AST) *conceptually*, borrow **Markdoc's schema/validation** API
(Stripe chose it over MDX for content/code separation, no code execution, typed-attribute validation —
[stripe.com/blog/markdoc](https://stripe.com/blog/markdoc)), and **reject MDX** (it stops being
Markdown, needs a JSX/bundler toolchain, executes arbitrary JS, won't render in a plain viewer, has no
prop schema — [mdxjs troubleshooting](https://mdxjs.com/docs/troubleshooting-mdx/)). Keep the two
load-bearing constructs **pure CommonMark** so a story renders in GitHub/Obsidian/pandoc today:

- **Doc-level binding — YAML frontmatter** (Astro/Quarto/MyST precedent), pinning the scene by hash:
  ```
  ---
  mr: 1
  scene: ./heart.mrson.json
  sceneHash: sha256-…
  title: The Mitral Valve
  ---
  ```
- **Inline object reference — a standard Markdown link with an `mrson:` scheme:**
  `The [myocardium](mrson:seg.myocardium) thins toward the [apex](mrson:markup.apex).`
  Renders as a plain link everywhere; the LiveStory renderer resolves the scheme to a
  highlight/focus. (MyST's reference-by-label idea in 100%-CommonMark syntax.)
- **Structured scene op + narration timing — a fenced code block whose body is literally mrson ops:**
  ````
  ```mr-scene at=0:03 hold=4s camera=cardiac-4ch
  { "ops": [
      { "op": "patch", "id": "seg.myocardium", "path": "/attrs/opacity", "value": 0.6 },
      { "op": "cmd",   "id": "view1", "cmd": "flyTo", "args": { "target": "markup.apex" } }
  ] }
  ```
  ````
  The `ops` array is exactly the mrson op model; timing rides the info string and maps onto the
  existing `.story.json` page structure. Renders as a clean code block in any viewer, nothing executes.
  (Optional secondary sugar: MyST colon-fences `:::{mr-page}` where prose should stay readable.)

**Validation = two layers:** (1) an mr.md structural schema (legal frontmatter keys, legal info-string
directives + typed attributes), Markdoc-style; (2) each `mr-scene` payload validated against the
**mrson JSON Schema (P1)** — *including a cross-reference check that every `mrson:` link and op `id`
resolves to a node in the bound scene* (dangling id = error). Parse with remark/markdown-it or reuse
mystmd's typed AST.

**Top traps:** (1) never make a non-CommonMark construct the primary carrier — `{% %}`, MyST roles,
and MDX `<Comp/>` all leak literal noise in plain viewers; keep refs as links and payloads in fenced
blocks. (2) Keep mr.md **declarative data, never code** (MDX/Observable's regret) — so a phone or a
third party can safely render someone else's story. (3) **One id space, always validated,
version-pinned** — mrson ids are the *only* id namespace; pin the binding (`scene` + `sceneHash`) so a
story can't silently apply against a mutated scene (the universal reference-by-id failure: stale
SOP-UIDs, broken `{ref}` labels).

Maps onto existing files: [`LiveStory/LiveStoryLib/story.py`](../LiveStory/LiveStoryLib/story.py)
(the `.story.json` page model mr.md authors), the mrson op model in
[`MRSON-LIVESCENE.md`](MRSON-LIVESCENE.md), and the LiveStory web renderer that resolves `mrson:`
links and applies `mr-scene` ops.

---

## 6. Fastify / JSON-native web stack — GO

The instinct is sound: a JSON-Schema-driven service (endpoints declared as schemas → validate + fast
serialize + self-document from one artifact) is a proven foundation that *both people and agents can
reason about* — it's how Fastify, OpenAPI 3.1, and MCP all work. Two caveats carried from §1: compile
schemas once at startup (amortized), and remember **`fast-json-stringify` shapes output but does not
validate it** — a schema-written mrson file still needs an explicit validation pass. This dovetails
with declaring the mrson JSON Schema the single source of truth for the P1 milestone.

---

## 7. Net recommendation & the zero-risk on-ramp

**Proceed to `pieper/mrson` as an alpha, framed narrowly:** *a platform-neutral, schema'd JSON
scene/interaction format for medical reality — a narrow-waist core + domain profiles — that adopts
OME-Zarr for arrays and binds to DICOM/FHIR/ROS/OpenIGTLink at the edges.* Explicitly **not** a
universal medical domain model, **not** a population-health model, **not** an array container.

Suggested first commits (all zero-risk, no runtime change):
1. **Write the core JSON Schema (2020-12, K8s-structural subset)** for the existing node-state record +
   the handful of neutral core types, and **validate it against every scene already in the gallery.**
   This is the P1 step and it surfaces the real gaps (blobs-as-list-vs-map, inlined zarr vs
   content-addressed) against real data.
2. **A one-page `mrson-core` spec** — the shared core (identity, references, provenance, typing
   mechanism, spatial/blob handles, change vocabulary) + the profile-extension mechanism, and from day
   one its **governance rules**: per-type versioning + stability grades, and a glTF-style
   `extensionsRequired`/`extensionsUsed` + FHIR-modifierExtension ignore-safety model. Plus a
   **`profiles/` skeleton** (`spatial`, `igt`, `micro`; `population` documented as map-to).
3. **The `mr.md` grammar note** (frontmatter + `mrson:` links + `mr-scene` fenced blocks) with 2–3
   example stories that validate against #1.
4. **Adapter stubs + conformance fixtures** for the four non-negotiables (DICOM-JSON, OME-Zarr,
   REP-103 frame mapping, OpenIGTLink message mapping) — even as round-trip test vectors before code.

Sequenced this way, every step produces something checkable against artifacts that already exist, and
nothing commits the runtime until the schema has proven itself against real scenes.

---

## 8. Extension models compared — MRML C++ subclasses vs glTF / FHIR / USD

Added 2026-07-29 (deeper dive on FHIR/FHIRcast + OpenUSD requested). The question that decides mrson's
whole extensibility design: *how does each system let a third party add a genuinely new node/object
type?* MRML is categorically different from the three data formats, and that difference is exactly why
"neither FHIR nor USD has ever come close to capturing what MRML does" — and why MRML can't itself be a
neutral wire format.

### How MRML actually does it (from the Slicer source)
`vtkMRMLNode` is an **abstract C++ superclass**; every node type is a real subclass, and the extension
contract is a set of **virtual methods** the subclass overrides — the type carries *behavior*, not just
data:
- [`virtual vtkMRMLNode* CreateNodeInstance() = 0`](../../slicer-skill/slicer-source/Libs/MRML/Core/vtkMRMLNode.h#L246)
  — a pure-virtual "virtual constructor" (prototype clone); `GetNodeTagName()` — the XML tag;
- `ReadXMLAttributes` / `WriteXML` / `WriteNodeBodyXML` (serialization), `Copy` / `CopyContent` /
  `HasCopyContent` (deep/shallow copy), and lifecycle/behavior hooks `ProcessChildNode`, `UpdateScene`,
  `OnNodeAddedToScene`, `UpdateReferences`, `ProcessMRMLEvents` (the node *reacts* to the scene event bus);
- typed, observed, role-keyed **node references** (`vtkSetReferenceStringMacro` → `AddReferencedNodeID`,
  node-reference roles) with automatic scene bookkeeping.

Registration is a **runtime prototype-clone factory**:
[`vtkMRMLScene::RegisterNodeClass(node, tag)`](../../slicer-skill/slicer-source/Libs/MRML/Core/vtkMRMLScene.cxx#L545)
stores a prototype instance keyed by XML tag; the loader looks up the tag, calls `CreateNodeInstance()`
to clone the correct C++ subclass, then `ReadXMLAttributes` populates it. Re-registering a tag
**replaces** the class — the source comment: *"It allows plugins to MRML to override default behavior
when instantiating nodes via XML tags."* So a new node type is a **first-class citizen with zero
special-casing in the core, fully polymorphic, and can even override a built-in type's behavior.**

### The four models side by side

| Axis | **MRML** | **glTF** | **FHIR** | **OpenUSD** |
|---|---|---|---|---|
| Unit of extension | C++ subclass (behavior+data) | data-only JSON object in `extensions{}`, keyed by registered prefix | `extension` = `url`+`value[x]` bolt-on; or a *profile* (constraint) | typed **IsA schema** (new type) + applied **API schema** (mix-in) |
| Add a genuinely new first-class TYPE? | **Yes** — register a subclass | **No** — fixed top-level types; you only *decorate* them | **No** — custom resources are *non-conformant*; forced into `Basic`+extensions | **Yes** — a concrete IsA schema has its own `typeName` |
| Behavior travels with the type? | **Yes** — virtual methods | No — consumer app must contain the code | No — server/client code external | No — schema is passive data; behavior is external (Hydra adapters, scene-index, PhysX) |
| Registration | runtime prototype-clone factory, keyed by tag | none — compile-time consumer support | fixed ~150 base resources + `StructureDefinition` | runtime **schema registry** (`plugInfo.json` + `generatedSchema.usda`); **codeless** = no recompile |
| Real inheritance / polymorphism | **Full** C++ single-inheritance class tree + virtual dispatch | none | none (only choice `[x]`, `Reference(Any)`, claim-based `meta.profile`) | real **IsA** single-inheritance type identity (`IsA<T>()` via TfType), but data-only; API schemas are **flat** (no inheritance) |
| Override a built-in's behavior? | **Yes** — re-register the tag | No | No | Partial — composition/opinion strength overrides *data*, not methods |
| Ignore-safety for unknown extensions | (imperative, in code) | asset-level `extensionsUsed` / `extensionsRequired` | `extension` (ignorable) vs `modifierExtension` (must-understand-or-refuse) | codeless registry + `fallbackTypes` (render as nearest known ancestor) |
| Versioning / migration | imperative, inside each node's `ReadXML` (messy, but *has a home*) | extension `url` versioning | extension `url` + `meta.profile` | version **in the typeName** (`SphereLight_2`; v0 unsuffixed); auto-migration *explicitly unsolved* |

### Why glTF and FHIR structurally can't capture MRML
- **glTF** extends by *decoration*: an unknown extension is a data blob a consumer either has code for or
  ignores (unless in `extensionsRequired`, then the file is rejected). There is no way to introduce a new
  *type* with behavior — the top-level object set is closed.
- **FHIR** extends by *constraint + bolt-on*: the spec is explicit that "**Profiles cannot change the
  name of elements... or add new elements**," resources are **not subclassable** (no "Observation
  subtype"), and inventing a first-class type is **non-conformant** — you must use the `Basic` resource +
  extensions. Its one genuinely good idea, worth stealing, is `modifierExtension` ("changes meaning → a
  reader that doesn't understand it must refuse," FHIR's must-understand bit). And its cautionary tale is
  **profiliferation**: a permissionless, un-curated extension mechanism ("no stigma") produced 1,300+
  redundant, overlapping dialects — `Observation` and `Extension` the most over-profiled.

### USD is the real structural parallel — but it's data, not behavior
USD *does* let third parties add typed node types at industrial scale (film→robotics→CAD) via a
registry, without forking the core — validating the mrson thesis. Two USD ideas are worth **adopting**:
1. **The two-axis split**: `IsA` = a new node *type*; applied `API` = a capability *mix-in* onto an
   existing type (`HasAPI<T>()`). This is a *better* factoring than MRML's single-axis "everything is a
   subclass," where "displayable"/"storable" become entangled base classes (`vtkMRMLDisplayableNode`,
   `vtkMRMLStorableNode`) instead of orthogonal mix-ins.
2. **Codeless / registry-driven runtime registration**: ship a schema as *data* and every host recognizes
   the type at runtime with no recompile — precisely the neutral extensibility MRML lacks, and the analog
   of the `extensionsRequired` gate.

But USD deliberately **externalizes behavior** ("schemas dictate how data is structured, they do not
define how the runtime interprets this data" — AOUSD; behavior lives in Hydra adapters / scene-index /
PhysX), and it **openly admits schema versioning/migration is unsolved** ("not a problem amenable to
automatically code-generated solutions"). USD has no medical/PACS presence and no medical member in
AOUSD — it's a *design precedent and possible surgical-sim export target*, not an in-domain competitor.

### The synthesis for mrson — split what MRML fuses
MRML's power is that a node type is *behavior-bearing, polymorphic C++ registered at runtime* — which is
exactly why it's Slicer/VTK-bound and can't be a neutral format. mrson must **split the two things MRML
fuses**:
- **Type + data declaration → a portable schema** (USD IsA-style typed node type + orthogonal capability
  mix-ins; glTF-style `used`/`required` gating; FHIR-style `modifierExtension` must-understand
  semantics). This is the neutral wire — data, language-neutral, validatable.
- **Behavior → a per-host binding keyed by `type`** (Slicer C++, SlicerLive TS, Deno). USD's model
  (behavior external, dispatched off type via plugin adapters) is exactly this — **and SlicerLive's scene
  loader already does it**: it reads the node `class` and dispatches to TS code per class. MRML's
  runtime prototype-clone factory (`RegisterNodeClass` tag → `CreateNodeInstance`) becomes, in mrson, a
  **type registry: `type` string → per-host constructor + behavior binding.** Same pattern, minus the
  shared C++.
- **Two corrections to USD's silence, informed by MRML:** (1) make the **behavior-binding contract
  explicit and discoverable** (which host subsystem serializes/renders/computes a given type) rather than
  USD's implicit "the app figures it out," or N hosts will diverge; (2) give **versioning + migration a
  first-class home from day one** — MRML at least has somewhere to put migration code (`ReadXML`), USD's
  data-only schemas have *nowhere*, which is why it punted. mrson should carry `schemaVersion` per type
  and locate hand-written migrations in each host's type registry.

**Net:** USD is the right *structural* template (composition/registry core + pluggable typed-data
schemas); MRML's instinct that "a node type is also behavior" is a real requirement in this domain that
USD externalizes and FHIR/glTF can't express at all. mrson's distinctive job is to **bridge them** —
keep USD's language-neutral runtime extensibility, but give behavior and migration an explicit,
specified home. FHIRcast is a **complement, not a competitor** (see below).

### FHIRcast — a complement one layer above mrson
FHIRcast (HL7 STU v3.0.0; IHE **IRA** profile, Trial-Implementation; shipping in Sectra/Epic/Nuance
PowerScribe radiology reporting) is a WebSub **hub + WSS + JSON** protocol that syncs **clinical
context** across separately-launched workstation apps — the CCOW successor. Events are
`[Resource]-[open|close|update|select]` (`Patient-open`, `ImagingStudy-open`, `DiagnosticReport-update`);
context is **whole-state replacement, not deltas**; its newer **content-sharing** layer syncs actual
clinical content (measurements/annotations as `Observation`/`ImagingSelection` in a `Bundle` with CRUD
verbs) but still at **resource granularity, user-action rate** — there is no resource for a camera pose,
reslice matrix, transfer function, or segmentation voxel delta, and you can't conformantly invent one.
So FHIRcast = *"which case is on screen"*; mrson/LiveScene = *"the live 3D scene of that case."* The
productive interop: **let FHIRcast establish the anchor context (patient/study/report) across the
workstation; mrson carries the scene (nodes, transforms, camera, segmentation deltas) at frame rate over
its own channel; bridge only *finalized* clinical results (a measurement, an ROI) up into FHIRcast's
`DiagnosticReport-update`.** Borrow its transport pattern (hub/WSS/subscribe) for LiveScene, but build
mrson's own *delta* channel — FHIRcast explicitly disclaims deltas and frame-rate sync.

---

## 9. Resolved decisions (2026-07-29)

**MRUSD is a bridge, not a foundation** (peer to MRCOM). mrson/LiveScene is the runtime foundation;
USD is an *edge*. Rationale: (a) USD's composition core is layer-file/path-centric (LIVRPS), an
impedance mismatch with LiveScene's node-state + content-addressed-blob + Lamport-LWW op model — the
`Ar` resolver can virtualize paths but the *semantics* stay layer-file-oriented; (b) USD's realtime
multi-user sync is **NVIDIA-proprietary** (Omniverse Nucleus + `.live`), and that live-delta collab is
exactly mrson's crown jewel — built openly; (c) **USD has no production browser runtime**, and mrson
lives in browser/Deno/WebGPU — the tooling (usdview/Hydra/Omniverse) is all native-desktop/NVIDIA, i.e.
unreachable from mrson's stack; (d) USD's array/volume story is OpenVDB/Field3D, *not* Zarr/DICOM/RAS.
We lose little: the USD capabilities worth having (IsA typed-type + capability mix-in + codeless runtime
registration) are already in mrson's own extension design (§8); what we skip (LIVRPS/variants/DCC/`.usdc`)
is unneeded or served by our op model + the bridge. One idea to consciously *borrow* (not adopt):
non-destructive layered overrides (maps to the role-priority/lease model). **MRUSD shape:** MRCOM-style
graceful degradation — export the declarative *renderable snapshot* (meshes→UsdGeom, transforms→Xformable
with explicit RAS↔USD convention, camera→UsdGeomCamera, TF→UsdShade, volumes→UsdVol), primarily as an
**export** target for Isaac/Omniverse/usdview/artists; the live op stream, DICOM provenance,
content-addressed blobs, RAS discipline, and interaction/lease state stay in mrson.

**The four-boundary architecture (locked):** one runtime, boundaries at the edges.
- **mrson / LiveScene** — the foundation (web-native, live, RAS, content-addressed).
- **MRCOM** → DICOM boundary (clinical archive/interop: VNA/DIMSE/dicomWeb).
- **MRUSD** → USD boundary (graphics/sim/DCC interop: Isaac/Omniverse/usdview).
- **FHIRcast** → clinical-context *coexistence* ("which case"; mrson drives the scene).
MRCOM, MRUSD, and FHIRcast are all edges — none reaches into the runtime (the same discipline already
set for DICOM: import/export/archival boundary, not a runtime constraint).

**Schema language: JSON Structure (proposed, leaning yes — pending final confirmation).** Verified
against the current spec (core **draft-04**, 2026-06-08; validation **draft-03**; meta-schema still
`v0`; https://json-structure.github.io/core/). It is a **type-definition system**, not a
validation-constraint language, so it fits MRML's *type hierarchy* natively and fixes JSON Schema's
`allOf` trap and codegen weakness. MRML→JSON-Structure fit:
- class hierarchy (`vtkMRMLNode → Storable → Displayable → …`) → `abstract:true` + `$extends` (real
  single **and** multiple inheritance — the multiple form cleanly models the Storable/Displayable
  *capability* bases as mix-ins, echoing USD's IsA+API two-axis);
- scene node union → the **`choice`** type with a `selector` discriminator (first-class tagged/discriminated
  unions keyed by `type` — exactly the recommended "tagged union, not allOf-inheritance");
- rich primitives (`int64`, `decimal`, `uuid`, `datetime`, `binary`, fixed-size arrays for
  matrices/vectors) — upgrades MRML's stringly-typed XML to a real type system and drives per-host
  codegen (Structurize/Avrotize → TS/C++/Python);
- validation constraints live in a **separate companion spec** (`$uses`/`$offers`), keeping the core a
  clean type model.
**Two honest caveats (both on things specifically wanted):** (1) **Enumerated event types are JSON
Structure's weak spot** — `enum`/`const` are inline-primitive-only; there is no clearly-reusable *named*
enum/int-constant type, so a shared "granular event codes" vocabulary is awkward (reuse via a `$ref`'d
primitive definition may work but is spec-ambiguous — **spot-check before committing**). (2) The official
JSON-Structure→JSON-Schema-2020-12 down-projection (`structurize s2j`) is **one-way and lossy** (rich
primitives collapse to string+format/number+bounds) and **`$extends`/`tuple` projection is unverified** —
so it is *not* a load-bearing hedge. Mitigant: JSON Structure now ships **native validators in 12
languages + a `jstruct` CLI**, so validation doesn't depend on the JSON Schema projection — treat the
projection as optional third-party interop only. **Bounded downside (key point):** choosing JSON
Structure is *not* deep lock-in — mrson *documents* are plain JSON and the type model is portable, so if
JSON Structure stalls (single-maintainer/Vasters-Microsoft, `v0`, no IETF standing) the type model can be
re-expressed elsewhere and the data + codegen'd bindings survive. **Before writing real schemas:**
spot-check (a) reusable named enums (the event-code case) and (b) `$extends` fidelity through Structurize
codegen to TS (the output that actually matters, more than the JSON Schema projection). Pin core draft-04
+ validation draft-03 explicitly; treat `v0`→`v1` meta-schema as a known migration point. Fallback
unchanged: restricted JSON Schema now, designed liftable to JSON Structure later.

**SPOT-CHECK RESULTS (ran 2026-07-29; `structurize` 3.9.0 + `json-structure` SDK 0.8.0, on a
`vtkMRMLModelNode`-shaped 4-level hierarchy).** The *type model + validation* — the source-of-truth
semantics — **work correctly**; the *codegen tooling* is **broken in the shipped release**.
- ✅ **`$extends` + `choice` + `map` + rich primitives all validate.** A scene with a 4-level chain
  (`MRMLNode→StorableNode→DisplayableNode→ModelNode`) + a sibling `ScalarVolumeNode`, a `choice`
  node-union keyed by class, `map` for `nodes`/`attributes`, and a `double[16]` matrix **validated
  cleanly** — the SDK merges inherited properties and enforces required/types across the whole chain.
  So JSON Structure is sound as a *definition + validation* language for mrson.
- ✅ **Inline enums are enforced** (`meshType: 9` → rejected, "not in enum [0,1,2]").
- ❌ **Reusable `$ref`'d enums are NOT enforced** (as feared). A named `MRMLEventCode` enum referenced
  via `{"type":{"$ref":"#/definitions/MRMLEventCode"}}` accepted the bogus value `99999` — **both** as
  array items and as a scalar property. The DRY "define an event vocabulary once, `$ref` it everywhere"
  pattern does not carry the constraint. **Mitigation:** inline the enum where enforcement matters, or
  own the event vocabulary as generated constants; don't rely on `$ref`'d-enum enforcement.
- ⚠️ **`int64` must be string-encoded** ("Expected int64 as string ... got int") — the safe-64-bit
  design. Concrete mrson rule: 64-bit fields (voxel counts, large timestamps) serialize as JSON strings.
- ❌ **`s2j` JSON-Schema projection dropped the entire `$root`+`definitions` hierarchy** (emitted only a
  `$schema`+`$id` stub) — confirms the JSON-Schema hedge is unreliable for our shape; keep it
  non-load-bearing.
- ❌ **Codegen is broken across the board in 3.9.0:** `s2ts`/`s2py`/`s2js`/`s2go`/`s2rust` all fail on
  missing bundled `.jinja` templates; `s2java`/`s2cs` fail on a missing bundled JDK; `s2cpp` "runs" but
  emits **non-compilable** C++ (invalid `namespace mrml.struct`, `enum class { 0, 1, 2 }`) and doesn't
  emit the node classes at all. **So `$extends`→inheritance was verifiable only at the SDK/validation
  level, not in generated code** — the "drive per-host codegen from JSON Structure" benefit is *not*
  deliverable via the official tool today.

**Net effect on the plan:** JSON Structure is a good **definition + validation** substrate for mrson
(that part is solid and genuinely better than JSON Schema for MRML's hierarchy) — use the SDK validators
as canonical. But **treat codegen as DIY**: hand-write or generate the per-host TS/C++/Python bindings
yourself (which the "behavior = per-host binding" architecture already required), and do **not** depend
on `structurize` codegen or the `s2j` JSON-Schema projection until upstream fixes packaging. Neither
finding is a dealbreaker, but they mean the immediate value is *schema-as-validated-type-model*, not
*schema-as-codegen-source*.

**EVENT MODEL — RESOLVED: typed event *classes* as a `choice` union, NOT an enum of codes**
(empirically verified 2026-07-29). The reusable-`$ref`'d-enum weakness above pushed us to a better
design, DOM-`Event`-style: an abstract `LiveEvent` base (`sourceId`, logical time `t`) + concrete
event types via `$extends`, unified as an `AnyEvent` `choice`. Events carry a *typed payload when it's
light and useful and stay payload-less when the state is heavy* — the carry-or-not decision is expressed
in the type design, not a runtime convention:
- **payload-less** (`ModifiedEvent`, `TransformModifiedEvent`) → "re-read the source" (the MRML pull
  model; grid transforms / image data stay in the node-state + blob channel, never on the event);
- **payload-carrying** (`CameraModifiedEvent` → position/focalPoint/viewUp/viewAngle;
  `MarkupPointModifiedEvent` → pointIndex/position; `NodeAddedEvent` → nodeId/nodeClass) → the light
  delta rides inline (like `CustomEvent.detail`).

Validation results (`structurize validate`, SDK 0.8.0) — all as designed:
- ✅ payload-less and payload-carrying events both validate;
- ✅ **unknown event type is REJECTED** — `{"FooBarEvent":…}` → *"Property 'FooBarEvent' not one of
  choices [ModifiedEvent, TransformModifiedEvent, …]"*. This is the **closed-set enforcement the
  `$ref`'d enum failed to give** — so events-as-a-`choice`-union is strictly better than events-as-enum;
- ✅ per-event **required payload fields enforced** (missing `focalPoint`/`viewUp` → rejected);
- ✅ **payload field types enforced** (`pointIndex:"two"` → "Expected int32, got str");
- ✅ **base-class required fields enforced through `$extends`** (missing `sourceId` → rejected).

**Consequence:** mrson uses **no enums for the event vocabulary** — event types are a discriminated union
of typed records, which JSON Structure enforces fully. This also unifies with the mrson op model
(`put`/`patch`/`del`/`cmd`): events and ops are both `choice`+`$extends` unions of typed records — a
payload-carrying `CameraModifiedEvent` is essentially a `patch`-op notification; a payload-less
`TransformModifiedEvent` is a "re-read" notification. One machinery, two channels.

---

### Provenance
Synthesized 2026-07-29 from parallel primary-source research passes (JSON Schema tooling & K8s/Fastify;
YAML/CBOR/binary/JSON-LD; FHIR/DICOM/OME-NGFF/NWB/LINDI/SpatialData/AnnData/OMOP/openEHR/ROS; HL7 v3 RIM
& FHIR history; IP hourglass & OpenUSD & Zarr & ROS/DDS narrow-waist templates; MDX/Markdoc/MyST/Quarto/
Observable for mr.md). Sources cited inline. Two sourcing caveats logged upstream: several
`ngff.openmicroscopy.org` and Grahame Grieve WordPress pages render via JS / served bio-shells, so a few
NGFF-clause and Grieve quotes rest on RFC/paper/secondary corroboration rather than raw spec HTML.
