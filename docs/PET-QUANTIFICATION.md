# PET quantification

Three modules, each with the authority it follows named in its header:

| module | what |
|---|---|
| `logic/pet/suv.ts` | SUV scale factors from DICOM (QIBA vendor-neutral path) |
| `logic/pet/indices.ts` | MTV, TLG, SUVpeak, thresholds, ROI masks — the CPU **reference** |
| `algorithms/kernels/peak-sphere.ts` | the SUVpeak sphere search on WebGPU |

`logic/` is DOM-free and renderer-free, so the quantitative path can be lifted into another
application (OHIF, for the LNQ grant's Yunu delivery) without dragging a renderer behind it.

## SUVpeak is a convolution, and that is the point

EANM v2.0 asks for a "3D 1.2 cm diameter (and 1.0 mL volume) spherical VOI **positioned such that
the average value across all positions within the lesion is maximised**". PERCIST 1.0 describes the
same sphere "centering around the hottest point in the tumor foci", noting it "is **not necessarily
centered on** the maximal SUL pixel".

Done honestly that is a sphere convolution evaluated at every candidate centre. Other
implementations approximate it — cornerstone3D evaluates only the ten hottest voxels, against an
anisotropic ellipsoid in **index** space whose radius is inflated 10 %, which is neither 1 mL nor
"positioned such that the average is maximised". The unit tests pin why this matters: on a broad
warm plateau beside an isolated hot spike, the spike wins SUVmax but the **plateau** wins SUVpeak,
and a search seeded only from the hottest voxels can never find it.

### Measured cost

Tap count scales as (r/spacing)³, so the honest search is cheap on a coarse PET grid and
catastrophic on a fine one — unless it runs on the GPU. Measured on an AMD RDNA-1 adapter,
whole-volume search, CPU reference vs. `peakSphereGPU`:

| grid | taps | work | CPU | GPU | speedup |
|---|---:|---:|---:|---:|---:|
| whole-body PET 168×168×186 @ 4 mm | 27 | 142 M | 974 ms | 211 ms | 4.6× |
| fine PET 256×256×300 @ 2 mm | 203 | 4.0 G | 26.3 s | 850 ms | **31×** |
| CT grid 256×256×200 @ 1 mm | 1285 | 16.8 G | **109 s** | 924 ms | **118×** |

Peak values agree in all three. So the conformant algorithm is not merely affordable on a GPU —
at native CT sampling it is the only way to have it at all interactively.

Callers pick the device by workload (`GPU_WORK_THRESHOLD` in the LNQ viewer's `measure.ts`): a
lesion-sized ROI is far below it and stays on the CPU, where there is no dispatch overhead to
amortise.

## Parity

`algorithms/kernels/peak-sphere.gpu.test.ts` asserts the GPU agrees with the CPU reference on a
noisy field, under `interiorOnly`, and under a restricted bounding box — same peak, same winning
centre, same candidate count.

Agreement is to a **relative tolerance**, not bit-exact: the weighted sum accumulates in a
different order on the GPU and f32 addition is not associative. (The histogram kernel *is*
byte-identical to its reference, because it reduces integers.)

### Two traps worth not re-discovering

* **Float sentinels do not survive the WGSL/JS boundary by equality.** The shader writes
  `-3.402823e38` for "not a candidate"; read back as f32 that is `-3.4028230607370965e+38`, which
  is not `===` the JS double of the same literal. Test the sentinel by range.
* **Backticks inside a WGSL template literal terminate the string.** A doc comment mentioning a
  symbol in backticks inside `/* wgsl */ \`...\`` turns the rest of the shader into TypeScript, and
  the error points at whatever word happened to parse.

## Units

Thresholds are converted into the volume's **raw** units rather than scaling the volume into SUV:
scaling millions of voxels to compare against one number is slower and lossier. Percentage
thresholds are scale-invariant and pass through untouched.

Measurement always runs on the native grid. EANM is explicit that a maximum must be read with "no
additional rebinning, resampling, smoothing or any other manipulation", and a display raster is all
three.

## Verified: AIMI DICOM SEG against an independent decode

The browser path (`idc_tools` SEG decode → resample onto the PET grid → `regionStats` / `suvPeak` /
`bidimensionalAxes`) was checked against a separate pydicom decode of the same object, on
`ACRIN-NSCLC-FDG-PET-131`, study 1960-06-08, series
`759e24e6-d2da-4938-b28f-dd29eeb18575` ("AIMI lung and FDG tumor **radiologist 1 corrected**").

The object is written on the **PET** grid — 168 × 168 × 74 frames at 4.0627 / 4.0627 / 4.0 mm,
sharing the PET's `ImagePositionPatient` and `ImageOrientationPatient` exactly — so a direct 1:1
index comparison is possible with no resampling at all. Both the 1:1 reading and a general
patient-coordinate mapping agree, and both agree with the browser:

| segment | voxels | MTV | SUVmean | SUVmax | CT HU mean | voxels < −500 HU |
|---|---:|---:|---:|---:|---:|---:|
| 1 `Lung` | 37 121 | 2450.8 mL | 0.66 | 2.34 | −661 | 82.3 % |
| 2 `FDG-Avid Tumor` | 3 583 | 236.6 mL | 2.12 | **3.57** | −168 | 12.3 % |

**The lung HU is the alignment proof.** A correctly placed lung mask has to read air density; −661 HU
with 82 % of voxels below −500 is parenchyma, and a mask shifted or flipped into chest wall and
mediastinum could not produce it. So this object is **not** row-flipped, unlike the NLST
TotalSegmentator SEG documented in `examples/colorize/README.md` — the flip is per-object, and
asserting it either way without checking is how a quantification pipeline reports confident
nonsense.

**Two traps that cost real time here**, both in reading the SEG's own geometry:

* `ImageOrientationPatient` is *(direction of increasing **column**, direction of increasing
  **row**)* — the first triplet is not the "row direction" its usual name suggests. Swapping them
  transposes the in-plane axes, which no combination of row/column flips can repair: every
  orientation then looks equally wrong, which is itself the diagnostic.
* `PixelSpacing` is *(row spacing, column spacing)* — spacing **between** rows first, i.e. the
  y step. See `docs/` on PS3.3 10.7.1.3 for the ITK/DCMTK hazard when `(0018,0088)` is absent.

**SUVmax 3.57 is correct, not a bug.** It looks low for something labelled "FDG-Avid Tumor", but
this is the post-treatment follow-up, and the whole-body distribution for this series has
p99.9 = 4.38 — so 3.57 sits near the top of it. The segment is also large and confluent
(236 mL, 13.7 cm long axis), which is exactly the "bulky confluent nodal mass" case LNQ2023 scored
worst on: a single label spanning what a reader would call several lesions.
