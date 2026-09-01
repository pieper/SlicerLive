// Unit test (T1) for the CPU half of SDF text: pure layoutText (word-wrap/advance/bounds) + sdfFromMask
// (signed distance sanity). The canvas atlas raster (buildFontAtlas) is browser-only, exercised by the
// GPU/browser tiers.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type FontAtlas, type GlyphMetric, layoutText, sdfFromMask } from "./sdf-text.ts";

// A synthetic fixed-metric "font": every glyph advances 10px, inked box 8x14 at offset (-1,-14).
function synthFont(): FontAtlas {
  const glyphs = new Map<string, GlyphMetric>();
  const chars = [..."abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  chars.forEach((ch, i) => {
    if (ch === " ") { glyphs.set(ch, { advance: 6, ax: 0, ay: 0, aw: 0, ah: 0, offX: 0, offY: 0 }); return; }
    glyphs.set(ch, { advance: 10, ax: (i % 16) * 20, ay: Math.floor(i / 16) * 20, aw: 8, ah: 14, offX: -1, offY: -14 });
  });
  return { sizePx: 16, spread: 4, atlasW: 320, atlasH: 80, data: new Uint8Array(320 * 80), glyphs, ascent: 14, descent: 3, lineHeight: 17 };
}

Deno.test("layoutText: single line advance + bounds", () => {
  const f = synthFont();
  const t = layoutText(f, "abc");   // 3 glyphs * advance 10
  assertEquals(t.quads.length, 3);
  assertEquals(t.lines, 1);
  assert(Math.abs(t.width - 30) < 1e-6, `width ${t.width}`);
  assertEquals(Math.round(t.height), 17);
  assert(t.quads[1].x > t.quads[0].x, "glyphs advance left→right");
});

Deno.test("layoutText: spaces do not emit quads but advance the pen", () => {
  const f = synthFont();
  const t = layoutText(f, "a b");
  assertEquals(t.quads.length, 2, "only 'a' and 'b' produce quads");
  assert(Math.abs((t.quads[1].x - t.quads[0].x) - 16) < 1e-6, `second glyph advanced by advance+space (${t.quads[1].x - t.quads[0].x})`);
});

Deno.test("layoutText: word-wrap at maxWidthPx creates a second line", () => {
  const f = synthFont();
  const one = layoutText(f, "alpha beta");
  const two = layoutText(f, "alpha beta", { maxWidthPx: 55 });   // 'alpha'=50; 'beta' wraps
  assertEquals(one.lines, 1);
  assertEquals(two.lines, 2, "wrapped to two lines");
  // second word starts at x≈0 on the new line
  const betaFirst = two.quads[5];   // after 'alpha' (5 glyphs)
  assert(betaFirst.x < 5, `wrapped word restarts at left (x=${betaFirst.x})`);
  assert(betaFirst.y > two.quads[0].y, "wrapped word is on a lower line");
});

Deno.test("layoutText: explicit newline", () => {
  const f = synthFont();
  const t = layoutText(f, "a\nb");
  assertEquals(t.lines, 2);
  assertEquals(t.quads.length, 2);
  assert(t.quads[1].y > t.quads[0].y);
});

Deno.test("layoutText: pxSize scales geometry", () => {
  const f = synthFont();
  const base = layoutText(f, "abc");
  const big = layoutText(f, "abc", { pxSize: 32 });   // 2x
  assert(Math.abs(big.width - base.width * 2) < 1e-6, "width scales 2x");
  assert(Math.abs(big.quads[0].w - base.quads[0].w * 2) < 1e-6, "quad size scales 2x");
});

Deno.test("layoutText: atlas UVs are within [0,1]", () => {
  const f = synthFont();
  for (const q of layoutText(f, "Quick Brown Fox").quads) {
    assert(q.u0 >= 0 && q.u1 <= 1 && q.v0 >= 0 && q.v1 <= 1, "uv in range");
    assert(q.u1 > q.u0 && q.v1 > q.v0, "uv non-degenerate");
  }
});

Deno.test("sdfFromMask: filled square is inside>0.5, outside<0.5, edge≈0.5, monotone", () => {
  const W = 40, H = 40, m = new Uint8Array(W * H);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) m[y * W + x] = 255;   // 20x20 block
  const sdf = sdfFromMask(m, W, H, 6);
  const at = (x: number, y: number) => sdf[y * W + x];
  assert(at(20, 20) > 200, `deep inside high (${at(20, 20)})`);
  assert(at(0, 0) < 40, `far outside low (${at(0, 0)})`);
  assert(Math.abs(at(10, 20) - 128) < 40, `left edge near 0.5 (${at(10, 20)})`);
  // monotone increasing as we move from outside → inside along a scanline
  assert(at(5, 20) < at(9, 20) && at(9, 20) < at(15, 20), "increases toward inside");
});
