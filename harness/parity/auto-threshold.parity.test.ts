// T4 (W5): Otsu auto-threshold matches ITK (itk::OtsuThresholdImageFilter, via SimpleITK) on the same volume.
// Slicer builds a small deterministic bimodal volume, runs SimpleITK Otsu, returns its threshold + the raw
// voxels; we run autoThreshold("otsu") on the same voxels and compare (within one histogram bin). Needs Slicer MCP.
import { assertAlmostEquals } from "jsr:@std/assert@1";
import { pyJson, slicerAvailable } from "../slicer.ts";
import { autoThreshold } from "../../algorithms/kernels/auto-threshold.ts";

const available = await slicerAvailable();

const ORACLE = `
import SimpleITK as sitk, numpy as np, json
# deterministic bimodal volume (no RNG): two blocks of different intensities + a little structured variation
N = 24
arr = np.zeros((N, N, N), dtype=np.int16)
for k in range(N):
  for j in range(N):
    for i in range(N):
      base = 40 if (i + j + k) % 3 == 0 else 190
      arr[k, j, i] = base + ((i * 7 + j * 5 + k * 3) % 11) - 5
img = sitk.GetImageFromArray(arr)
otsu = sitk.OtsuThresholdImageFilter(); otsu.SetInsideValue(1); otsu.SetOutsideValue(0)
otsu.Execute(img)
result = {'itkOtsu': float(otsu.GetThreshold()), 'data': arr.ravel(order='C').tolist(), 'dims': [N, N, N]}
`;

Deno.test({ name: "parity: autoThreshold(otsu) ~= itk::OtsuThreshold", ignore: !available, sanitizeResources: false, sanitizeOps: false, async fn() {
  const o = await pyJson<{ itkOtsu: number; data: number[]; dims: number[] }>("result", "import json\n" + ORACLE);
  const data = Int32Array.from(o.data);
  // ITK's OtsuThresholdImageFilter uses 128 bins by default
  const mine = autoThreshold("otsu", data, 128);
  const range = Math.max(...o.data) - Math.min(...o.data);
  const binWidth = range / 128;
  console.log(`  Otsu: mine ${mine.toFixed(2)} vs ITK ${o.itkOtsu.toFixed(2)} (binWidth ${binWidth.toFixed(2)})`);
  // agree within ~1.5 histogram bins (bin-center vs ITK's edge convention)
  assertAlmostEquals(mine, o.itkOtsu, binWidth * 1.5 + 1e-6, "Otsu threshold matches ITK");
} });
