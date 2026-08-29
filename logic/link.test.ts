// T1 unit (W2): SliceLink broadcast rules == vtkMRMLSliceLinkLogic.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { broadcastSlice, isOrientationMatching, type LinkSliceState } from "./link.ts";

// canonical row-major sliceToRAS with a given normal-axis translation
const axial = (z = 0): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, z, 0, 0, 0, 1];
const sagittal = (x = 0): number[] => [0, 0, 1, x, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const coronal = (y = 0): number[] => [1, 0, 0, 0, 0, 0, 1, y, 0, 1, 0, 0, 0, 0, 0, 1];
const state = (name: string, m: number[], fov: [number, number, number] = [250, 250, 1], vg = 0): LinkSliceState => ({ name, sliceToRAS: m, fieldOfView: fov, viewGroup: vg });

Deno.test("isOrientationMatching: same orientation true, different false", () => {
  assert(isOrientationMatching(axial(0), axial(50)), "two axials match (offset ignored)");
  assert(!isOrientationMatching(axial(0), sagittal(0)), "axial vs sagittal differ");
  assert(!isOrientationMatching(axial(0), coronal(0)), "axial vs coronal differ");
});

Deno.test("offset (SliceToRAS) broadcasts only to same-orientation views", () => {
  const src = state("Red", axial(30));
  const others = [state("Red2", axial(0)), state("Yellow", sagittal(0)), state("Green", coronal(0))];
  const up = broadcastSlice(src, others, ["SliceToRAS"]);
  assertEquals(up.get("Red2")?.sliceToRAS, axial(30), "other axial follows");
  assert(!up.has("Yellow"), "sagittal unchanged");
  assert(!up.has("Green"), "coronal unchanged");
});

Deno.test("FieldOfView broadcasts to all, aspect-corrected to the target", () => {
  const src = state("Red", axial(0), [300, 300, 1]);
  const others = [state("Yellow", sagittal(0), [200, 400, 2])];   // target aspect 400/200 = 2
  const up = broadcastSlice(src, others, ["FieldOfView"]);
  const fov = up.get("Yellow")!.fieldOfView!;
  assertEquals(fov[0], 300, "x from source");
  assertEquals(fov[1], 300 * 400 / 200, "y aspect-corrected to target");
  assertEquals(fov[2], 2, "z kept");
});

Deno.test("Orientation change realigns all linked views regardless of match", () => {
  const src = state("Red", sagittal(10));   // Red just became sagittal
  const others = [state("Yellow", axial(0)), state("Green", coronal(0))];
  const up = broadcastSlice(src, others, ["Orientation"]);
  assertEquals(up.get("Yellow")?.sliceToRAS, sagittal(10), "Yellow realigns to sagittal");
  assertEquals(up.get("Green")?.sliceToRAS, sagittal(10), "Green realigns to sagittal");
});

Deno.test("view groups isolate broadcasts", () => {
  const src = state("Red", axial(20), [250, 250, 1], 0);
  const others = [state("RedB", axial(0), [250, 250, 1], 1)];   // different view group
  assertEquals(broadcastSlice(src, others, ["SliceToRAS"]).size, 0, "no cross-group broadcast");
});
