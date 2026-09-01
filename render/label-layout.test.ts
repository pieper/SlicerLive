// Unit test (T1) for the force-directed label-card layout — pure, no GPU.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type CardBody, layoutStep, overlapArea, seedCards } from "./label-layout.ts";

const VP = { w: 1000, h: 700 };
const settle = (cards: CardBody[], anchors: { x: number; y: number }[], steps = 400) => {
  for (let i = 0; i < steps; i++) layoutStep(cards, anchors, VP, 1 / 60);
};

Deno.test("seedCards is deterministic and offset from anchors", () => {
  const anchors = [{ x: 500, y: 350 }, { x: 520, y: 360 }];
  const sizes = [{ w: 160, h: 80 }, { w: 160, h: 80 }];
  const a = seedCards(anchors, sizes), b = seedCards(anchors, sizes);
  assertEquals(a, b, "same inputs -> identical seed (no randomness)");
  assert(Math.hypot(a[0].x - anchors[0].x, a[0].y - anchors[0].y) > 50, "seeded off the anchor");
});

Deno.test("overlapping anchors resolve to non-overlapping cards near their anchors", () => {
  // three segments whose centroids project to almost the same point (e.g. kidney+tumor+cyst)
  const anchors = [{ x: 500, y: 350 }, { x: 508, y: 352 }, { x: 496, y: 346 }];
  const sizes = anchors.map(() => ({ w: 180, h: 70 }));
  const cards = seedCards(anchors, sizes);
  settle(cards, anchors);
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++)
      assertEquals(Math.round(overlapArea(cards[i], cards[j])), 0, `cards ${i},${j} do not overlap after settle`);
  // still tethered near their anchor (within a couple standoffs)
  for (let i = 0; i < cards.length; i++)
    assert(Math.hypot(cards[i].x - anchors[i].x, cards[i].y - anchors[i].y) < 300, `card ${i} stayed near its anchor`);
});

Deno.test("cards stay fully inside the viewport", () => {
  const anchors = [{ x: 20, y: 20 }, { x: 985, y: 690 }, { x: 10, y: 690 }];  // anchors near corners
  const sizes = anchors.map(() => ({ w: 200, h: 90 }));
  const cards = seedCards(anchors, sizes);
  settle(cards, anchors);
  for (const c of cards) {
    assert(c.x - c.w / 2 >= -1 && c.x + c.w / 2 <= VP.w + 1, "within horizontally");
    assert(c.y - c.h / 2 >= -1 && c.y + c.h / 2 <= VP.h + 1, "within vertically");
  }
});

Deno.test("deterministic: two runs from the same seed match exactly", () => {
  const anchors = [{ x: 300, y: 300 }, { x: 700, y: 300 }, { x: 500, y: 500 }];
  const sizes = anchors.map(() => ({ w: 170, h: 75 }));
  const a = seedCards(anchors, sizes), b = seedCards(anchors, sizes);
  settle(a, anchors, 120); settle(b, anchors, 120);
  assertEquals(a, b);
});

Deno.test("converges: total overlap decreases from the initial coincident state", () => {
  const anchors = Array.from({ length: 6 }, () => ({ x: 500, y: 350 }));  // all identical -> worst case
  const cards = anchors.map((a) => ({ x: a.x, y: a.y, vx: 0, vy: 0, w: 150, h: 60 }));  // stacked exactly
  const totalOverlap = () => { let s = 0; for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) s += overlapArea(cards[i], cards[j]); return s; };
  const before = totalOverlap();
  settle(cards, anchors, 500);
  const after = totalOverlap();
  assert(after < before * 0.02, `overlap collapsed ${before.toFixed(0)} -> ${after.toFixed(0)}`);
});

Deno.test("keep-out: each card hugs OUTSIDE its own segment and clears ALL segments", () => {
  const VP2 = { w: 1200, h: 800 };
  // three segment circles spread around the centre; card i belongs to keepOuts[i]
  const kos = [{ x: 500, y: 400, radius: 90 }, { x: 720, y: 400, radius: 70 }, { x: 610, y: 560, radius: 60 }];
  const anchors = kos.map((k) => ({ x: k.x, y: k.y }));
  const sizes = anchors.map(() => ({ w: 150, h: 66 }));
  const cards = seedCards(anchors, sizes);
  for (let i = 0; i < 600; i++) layoutStep(cards, anchors, VP2, 1 / 60, { keepOuts: kos });
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i], halfDiag = 0.5 * Math.hypot(c.w, c.h);
    // clears EVERY segment circle (never obscures a rendering)
    for (const k of kos) {
      const d = Math.hypot(c.x - k.x, c.y - k.y);
      assert(d >= k.radius + halfDiag - 3, `card ${i} clears segment @(${k.x},${k.y}) (d=${d.toFixed(0)} need>=${(k.radius + halfDiag).toFixed(0)})`);
    }
    // hugs its OWN segment: within a comfortable band just outside it
    const own = kos[i], dOwn = Math.hypot(c.x - own.x, c.y - own.y);
    assert(dOwn <= own.radius + halfDiag + 80, `card ${i} hugs its own segment (d=${dOwn.toFixed(0)})`);
  }
});
