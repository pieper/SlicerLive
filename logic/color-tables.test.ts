// T1 unit (W3): color-table catalog + LUT builder + shader-reference mapping.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { COLOR_TABLES, colorTableById, fusionLut, lut, sampleColor, tableEntries, tableNode } from "./color-tables.ts";

Deno.test("Grey ramp is the identity 0..255", () => {
  const g = lut("vtkMRMLColorTableNodeGrey");
  assertEquals([g[0], g[1], g[2]], [0, 0, 0]);
  assertEquals([g[255 * 4], g[255 * 4 + 1], g[255 * 4 + 2]], [255, 255, 255]);
  assertEquals([g[128 * 4], g[128 * 4 + 1]], [128, 128]);
});

Deno.test("InvertedGrey is Grey reversed", () => {
  const g = lut("vtkMRMLColorTableNodeGrey"), inv = lut("vtkMRMLColorTableNodeInvertedGrey");
  for (const i of [0, 64, 128, 200, 255]) assertEquals(inv[i * 4], 255 - g[i * 4]);
});

Deno.test("every catalog table has 256 opaque entries and endpoints in range", () => {
  for (const t of COLOR_TABLES) {
    const e = tableEntries(t);
    assertEquals(e.length, 256);
    for (const c of [e[0], e[128], e[255]]) { for (let k = 0; k < 3; k++) { assert(c[k] >= 0 && c[k] <= 1); } assertEquals(c[3], 1); }
  }
});

Deno.test("Rainbow low=blue-ish, high=red-ish", () => {
  const e = tableEntries("vtkMRMLColorTableNodeRainbow");
  assert(e[0][2] > e[0][0], "low end bluer than redder");
  assert(e[255][0] > e[255][2], "high end redder than bluer");
});

Deno.test("sampleColor maps W/L window to LUT ramp (Grey)", () => {
  const w = 200, l = 100;                       // window [0,200]
  assertEquals(sampleColor("vtkMRMLColorTableNodeGrey", 0, w, l), [0, 0, 0, 255]);
  assertEquals(sampleColor("vtkMRMLColorTableNodeGrey", 200, w, l), [255, 255, 255, 255]);
  const mid = sampleColor("vtkMRMLColorTableNodeGrey", 100, w, l);
  assert(Math.abs(mid[0] - 128) <= 1, `mid grey ~128, got ${mid[0]}`);
  // below/above the window clamp to the ends
  assertEquals(sampleColor("vtkMRMLColorTableNodeGrey", -50, w, l)[0], 0);
  assertEquals(sampleColor("vtkMRMLColorTableNodeGrey", 999, w, l)[0], 255);
});

Deno.test("threshold zeros alpha only, color unchanged", () => {
  const inRange = sampleColor("vtkMRMLColorTableNodeGrey", 150, 200, 100, [50, 180]);
  const outRange = sampleColor("vtkMRMLColorTableNodeGrey", 190, 200, 100, [50, 180]);
  assertEquals(inRange[3], 255);
  assertEquals(outRange[3], 0);
  // color at 190 is the same whether thresholded or not
  const noThresh = sampleColor("vtkMRMLColorTableNodeGrey", 190, 200, 100);
  assertEquals([outRange[0], outRange[1], outRange[2]], [noThresh[0], noThresh[1], noThresh[2]]);
});

Deno.test("tableNode emits a 256-entry colorTable node", () => {
  const n = tableNode("vtkMRMLColorTableNodeFire");
  assertEquals(n.type, "colorTable");
  assertEquals(n.id, "vtkMRMLColorTableNodeFire");
  assertEquals(n.entries.length, 256);
  assertEquals(colorTableById(n.id).name, "Fire");
});

// --- PET procedural colour nodes ----------------------------------------------------------------
// Control points are transcribed from Slicer's vtkMRMLPETProceduralColorNode.cxx; these assert the
// ramp actually passes through them, which is the thing a transcription gets wrong.
Deno.test("PET-Heat hits its Slicer control points", () => {
  const t = colorTableById("vtkMRMLPETProceduralColorNodePET-Heat");
  const at = (i: number) => t.ramp(i / 255).map((v) => Math.round(v * 1000) / 1000);
  assertEquals(at(0), [0, 0, 0]);
  assertEquals(at(35), [0.36, 0, 0]);
  assertEquals(at(38), [0.5, 0, 0]);
  assertEquals(at(50), [0.7, 0.1, 0]);
  assertEquals(at(70), [0.7, 0.5, 0]);
  assertEquals(at(87), [1, 1, 0]);
  assertEquals(at(255), [1, 1, 1]);
});

Deno.test("PET-Heat stays black below the first control point, unlike an evenly spaced ramp", () => {
  const t = colorTableById("vtkMRMLPETProceduralColorNodePET-Heat");
  // Index 17 is halfway to the first stop: red must still be climbing from 0, not already at 0.36.
  const mid = t.ramp(17 / 255);
  assert(mid[0] > 0 && mid[0] < 0.36, `expected a partial red ramp, got ${mid[0]}`);
  assertEquals(t.ramp(0), [0, 0, 0]);
});

Deno.test("PET-MIP is the inverse linear scale EANM asks for in response reading", () => {
  const t = colorTableById("vtkMRMLPETProceduralColorNodePET-MIP");
  assertEquals(t.ramp(0), [1, 1, 1]);     // SUV 0 -> white
  assertEquals(t.ramp(1), [0, 0, 0]);     // high SUV -> black
  const mid = t.ramp(0.5);
  assert(Math.abs(mid[0] - 0.5) < 0.01);
});

Deno.test("PET-HotMetalBlue passes through its blue shoulder", () => {
  const t = colorTableById("vtkMRMLPETProceduralColorNodePET-HotMetalBlue");
  const at85 = t.ramp(85 / 255).map((v) => Math.round(v * 1e9) / 1e9);
  assertEquals(at85, [0, 0, 0.654901961]);
});

Deno.test("every PET table yields a well-formed 256-entry LUT", () => {
  for (const id of [
    "vtkMRMLPETProceduralColorNodePET-Heat",
    "vtkMRMLPETProceduralColorNodePET-Rainbow",
    "vtkMRMLPETProceduralColorNodePET-Rainbow2",
    "vtkMRMLPETProceduralColorNodePET-DICOM",
    "vtkMRMLPETProceduralColorNodePET-HotMetalBlue",
    "vtkMRMLPETProceduralColorNodePET-MIP",
  ]) {
    const l = lut(id);
    assertEquals(l.length, 256 * 4, id);
    for (let i = 0; i < 256; i++) assertEquals(l[i * 4 + 3], 255, `${id} alpha at ${i}`);
  }
});

Deno.test("fusionLut carries an opacity ramp in alpha, leaving RGB untouched", () => {
  const plain = lut("vtkMRMLPETProceduralColorNodePET-Heat");
  const fused = fusionLut("vtkMRMLPETProceduralColorNodePET-Heat");
  for (let i = 0; i < 256; i++) {
    for (let c = 0; c < 3; c++) assertEquals(fused[i * 4 + c], plain[i * 4 + c], `rgb at ${i}`);
  }
  assertEquals(fused[3], 0, "fully transparent at the bottom of the window");
  // t = 0.1 -> alpha 0.8 (OHIF's default ramp); index 25.5 rounds to 25/26.
  assert(Math.abs(fused[25 * 4 + 3] / 255 - 0.8) < 0.03);
  assert(Math.abs(fused[255 * 4 + 3] / 255 - 0.9) < 0.01, "near-opaque at the top");
  // Monotone non-decreasing, which is what makes low uptake recede rather than darken the CT.
  for (let i = 1; i < 256; i++) assert(fused[i * 4 + 3] >= fused[(i - 1) * 4 + 3], `alpha dips at ${i}`);
});

Deno.test("fusionLut accepts a custom ramp", () => {
  const f = fusionLut("vtkMRMLColorTableNodeGrey", [[0, 0], [1, 1]]);
  assertEquals(f[3], 0);
  assertEquals(f[255 * 4 + 3], 255);
  assert(Math.abs(f[128 * 4 + 3] - 128) <= 1);
});
