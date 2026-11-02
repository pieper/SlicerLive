// T1: edge labels derived from a view basis. The three plane cases are pinned against the
// RADIOLOGICAL presets in slice-renderer.ts, so a change to either side fails here.
import { assertEquals } from "jsr:@std/assert@1";
import { edgeLabels, labelOf, OPPOSITE } from "./orientation-labels.ts";
import type { Vec3 } from "../render/mat4.ts";

Deno.test("a unit axis maps to its anatomical letter", () => {
  assertEquals(labelOf([1, 0, 0]), "R");
  assertEquals(labelOf([-1, 0, 0]), "L");
  assertEquals(labelOf([0, 1, 0]), "A");
  assertEquals(labelOf([0, -1, 0]), "P");
  assertEquals(labelOf([0, 0, 1]), "S");
  assertEquals(labelOf([0, 0, -1]), "I");
});

Deno.test("a mostly-axial direction still gets a letter", () => {
  assertEquals(labelOf([-0.97, 0.26, 0]), "L");
  assertEquals(labelOf([0.1, 0.2, -0.95]), "I");
});

Deno.test("a direction with no dominant axis is ambiguous, not guessed", () => {
  // Exactly 45 degrees between L and A: any single letter would be wrong.
  const r = Math.SQRT1_2;
  assertEquals(labelOf([-r, r, 0]), null);
  assertEquals(labelOf([0, 0, 0]), null);
});

Deno.test("labels follow slice-renderer's RADIOLOGICAL axial preset", () => {
  // axial: uDir [-1,0,0], vDir [0,1,0] -- patient left on screen right, anterior up.
  assertEquals(edgeLabels([-1, 0, 0], [0, 1, 0]), { right: "L", left: "R", top: "A", bottom: "P" });
});

Deno.test("labels follow the coronal preset", () => {
  assertEquals(edgeLabels([-1, 0, 0], [0, 0, 1]), { right: "L", left: "R", top: "S", bottom: "I" });
});

Deno.test("labels follow the sagittal preset", () => {
  // sagittal: uDir [0,-1,0] -- posterior on screen right.
  assertEquals(edgeLabels([0, -1, 0], [0, 0, 1]), { right: "P", left: "A", top: "S", bottom: "I" });
});

Deno.test("a rotating MIP relabels as it turns, instead of lying", () => {
  // The MIP basis: uDir = [-cos a, sin a, 0], vDir = +S, spinning about S-I.
  const uAt = (deg: number): Vec3 => {
    const a = (deg * Math.PI) / 180;
    return [-Math.cos(a), Math.sin(a), 0];
  };
  const v: Vec3 = [0, 0, 1];
  // Head-on AP view: patient left on screen right, as in the coronal preset.
  assertEquals(edgeLabels(uAt(0), v).right, "L");
  // A quarter turn later the view is down the A-P axis.
  assertEquals(edgeLabels(uAt(90), v).right, "A");
  assertEquals(edgeLabels(uAt(180), v).right, "R");
  assertEquals(edgeLabels(uAt(270), v).right, "P");
  // Halfway between, there is no honest single letter.
  assertEquals(edgeLabels(uAt(45), v).right, null);
  // Superior stays up through the whole revolution -- that is the point of spinning about S-I.
  for (const deg of [0, 45, 90, 137, 180, 270, 359]) {
    assertEquals(edgeLabels(uAt(deg), v).top, "S", `top at ${deg} deg`);
  }
});

Deno.test("opposites are involutive", () => {
  for (const k of ["R", "L", "A", "P", "S", "I"] as const) {
    assertEquals(OPPOSITE[OPPOSITE[k]], k);
  }
});
