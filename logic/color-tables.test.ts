// T1 unit (W3): color-table catalog + LUT builder + shader-reference mapping.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { COLOR_TABLES, colorTableById, lut, sampleColor, tableEntries, tableNode } from "./color-tables.ts";

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
