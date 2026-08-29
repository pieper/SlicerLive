// T1: the layout catalog — every arrangement covers the view area with non-overlapping cells.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { cellsFor, DEFAULT_LAYOUT, layout, LAYOUTS, layoutList } from "./layouts.ts";

Deno.test("Slicer's layout ids resolve to the right names", () => {
  assertEquals(layout(3).name, "Four-Up");
  assertEquals(layout(6).name, "One-Up Red");
  assertEquals(layout(999).id, DEFAULT_LAYOUT);   // unknown -> default
});

Deno.test("every layout's cells cover the area exactly with no overlap", () => {
  for (const l of layoutList()) {
    let area = 0;
    for (let i = 0; i < l.cells.length; i++) {
      const a = l.cells[i];
      assert(a.w > 0 && a.h > 0 && a.x >= -1e-9 && a.y >= -1e-9 && a.x + a.w <= 1 + 1e-9 && a.y + a.h <= 1 + 1e-9, `${l.name} cell ${a.view} out of bounds`);
      area += a.w * a.h;
      for (let j = i + 1; j < l.cells.length; j++) {
        const b = l.cells[j];
        const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        assert(ox * oy < 1e-9, `${l.name}: ${a.view} overlaps ${b.view}`);
      }
    }
    assertAlmostEquals(area, 1, 1e-6, `${l.name} does not fill the area (covered ${area})`);
  }
});

Deno.test("cellsFor: fractional cells -> pixel rects", () => {
  const cells = cellsFor(3, 800, 600);
  assertEquals(cells.length, 4);
  const red = cells.find((c) => c.view === "Red")!;
  assertEquals(red.px, { x: 0, y: 0, w: 400, h: 300 });
  assertEquals(red.orientation, "Axial");
  assertEquals(LAYOUTS[3].cells.find((c) => c.view === "1")!.kind, "3d");
});
