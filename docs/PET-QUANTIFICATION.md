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
