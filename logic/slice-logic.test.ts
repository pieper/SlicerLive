// T1: fit + offset-range math vs the live-Slicer fixture (harness/fixtures/slicer-startup.json = MRHead).
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { fitFovToVolume, offsetRangeResolution } from "./slice-logic.ts";
import { fixture } from "../harness/fixtures.ts";

interface Startup { volume: { dims: number[]; ijkToRAS: number[]; rasLo: number[]; rasHi: number[] }; slices: Record<string, { fieldOfView: number[]; dimensions: number[] }> }
const ORIENT: Record<string, "axial" | "coronal" | "sagittal"> = { axial: "axial", coronal: "coronal", sagittal: "sagittal" };

Deno.test("fitFovToVolume matches Slicer's FitSliceToVolumes for MRHead (all 3 orientations)", async () => {
  const s = await fixture<Startup>("slicer-startup.json");
  const { ijkToRAS, rasLo, rasHi } = s.volume;
  for (const [key, sl] of Object.entries(s.slices)) {
    const [w, h] = sl.dimensions;
    const fov = fitFovToVolume(ORIENT[key], rasLo as [number, number, number], rasHi as [number, number, number], ijkToRAS, w, h);
    assertAlmostEquals(fov[0], sl.fieldOfView[0], 0.5, `${key} fovX`);
    assertAlmostEquals(fov[1], sl.fieldOfView[1], 0.5, `${key} fovY`);
    assertAlmostEquals(fov[2], sl.fieldOfView[2], 0.01, `${key} slab`);
  }
});

Deno.test("offsetRangeResolution: bounds along the normal, step = spacing", async () => {
  const s = await fixture<Startup>("slicer-startup.json");
  const { ijkToRAS, rasLo, rasHi } = s.volume;
  const ax = offsetRangeResolution("axial", ijkToRAS, rasLo as [number, number, number], rasHi as [number, number, number]);
  assertAlmostEquals(ax.step, 1.0, 1e-3);                       // MRHead axial spacing
  assert(ax.max - ax.min > 250, "axial range spans the S extent (~256)");
  const sag = offsetRangeResolution("sagittal", ijkToRAS, rasLo as [number, number, number], rasHi as [number, number, number]);
  assertAlmostEquals(sag.step, 1.3, 0.01);                      // sagittal normal is R; spacing 1.3
});
