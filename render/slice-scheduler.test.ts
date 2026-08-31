// Unit test (T1) for the coalesced adaptive slice scheduler — drives it with an injectable clock and
// frame scheduler so the moving/settled/coalesce/dormancy logic is verified without a GPU.
import { assertEquals } from "jsr:@std/assert@1";
import { mountSliceScheduler } from "./slice-scheduler.ts";

function harness(idleGapMs = 120) {
  let clock = 1000;
  const queue: (() => void)[] = [];
  const sliceCalls: { cell: string; moving: boolean }[] = [];
  const overlayCalls: string[] = [];
  const s = mountSliceScheduler({
    listCells: () => ["Red", "Yellow", "Green"],
    drawSlice: (cell, moving) => sliceCalls.push({ cell, moving }),
    drawOverlay: (cell) => overlayCalls.push(cell),
    idleGapMs,
    now: () => clock,
    schedule: (fn) => queue.push(fn),
  });
  // Run one scheduled frame (FIFO). Returns false when nothing was queued (dormant).
  const frame = () => { const fn = queue.shift(); if (!fn) return false; fn(); return true; };
  const drain = (max = 100) => { let n = 0; while (queue.length && n < max) { frame(); n++; } return n; };
  return { s, sliceCalls, overlayCalls, frame, drain, advance: (ms: number) => { clock += ms; }, pending: () => queue.length };
}

Deno.test("coalesces repeated marks of one cell into a single render per frame", () => {
  const h = harness();
  h.s.markSlice("Red"); h.s.markSlice("Red"); h.s.markSlice("Red");
  assertEquals(h.pending(), 1, "one frame scheduled despite three marks");
  h.frame();
  assertEquals(h.sliceCalls.length, 1, "Red rendered once");
  assertEquals(h.sliceCalls[0].cell, "Red");
});

Deno.test("goes dormant when nothing is dirty (settles then stops scheduling)", () => {
  const h = harness();
  h.s.markSlice("Red");
  h.frame();                                  // moving render (interacting, lastMark==now)
  assertEquals(h.sliceCalls[0].moving, true);
  h.advance(200);                             // past idleGap
  h.drain();                                  // settle pass + wind-down
  const before = h.sliceCalls.length;
  h.drain();
  assertEquals(h.sliceCalls.length, before, "no further renders once settled");
  assertEquals(h.pending(), 0, "dormant: no frame scheduled");
});

Deno.test("moving frame while interacting, then a native settle once idle", () => {
  const h = harness();
  h.s.markSlice("Red");
  h.frame();                                  // interacting → moving
  assertEquals(h.sliceCalls.at(-1), { cell: "Red", moving: true });
  h.advance(200);                             // stop interacting
  h.drain();
  const settle = h.sliceCalls.filter((c) => c.cell === "Red" && !c.moving);
  assertEquals(settle.length, 1, "exactly one native settle for the moved cell");
});

Deno.test("render() nudge forces native (crisp) rendering even mid-interaction", () => {
  const h = harness();
  h.s.markSlice("Red");                       // interacting
  h.s.render();                               // idle() nudge
  h.drain();
  // every slice call from the nudge must be native (moving:false) — the settle point must be crisp
  assertEquals(h.sliceCalls.some((c) => c.moving), false, "no moving frames from render()");
  assertEquals(new Set(h.sliceCalls.map((c) => c.cell)).size, 3, "all three cells rendered");
});

Deno.test("overlay-only mark redraws the overlay, not the reslice", () => {
  const h = harness();
  h.s.markOverlay("Yellow");
  h.drain();
  assertEquals(h.overlayCalls, ["Yellow"]);
  assertEquals(h.sliceCalls.length, 0, "no reslice for an overlay-only change");
});

Deno.test("a slice render subsumes a pending overlay mark for the same cell", () => {
  const h = harness();
  h.s.markOverlay("Green");
  h.s.markSlice("Green");
  h.frame();
  assertEquals(h.sliceCalls.length, 1, "Green resliced once");
  assertEquals(h.overlayCalls.length, 0, "overlay not redrawn separately (slice already did)");
});
