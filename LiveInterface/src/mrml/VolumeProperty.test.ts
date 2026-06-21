import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePiecewise, serializePiecewise,
  parseColorTransfer, serializeColorTransfer,
  normalizePiecewise,
  sampleOpacity, sampleColor, unifyTransferFunctions,
  sampleCombinedAt, compositeLayers, type TFLayer,
} from './VolumeProperty.js';

test('parsePiecewise: basic — count is number of *values*', () => {
  // 8 values = 4 (x,y) points
  const p = parsePiecewise('8 0 0 100 0.5 200 0.8 300 1');
  assert.equal(p.length, 4);
  assert.deepEqual(p[0], { x: 0, y: 0 });
  assert.deepEqual(p[3], { x: 300, y: 1 });
});

test('parsePiecewise: empty + whitespace', () => {
  assert.deepEqual(parsePiecewise(''), []);
  assert.deepEqual(parsePiecewise('   '), []);
  assert.deepEqual(parsePiecewise('0'), []);
});

test('parsePiecewise: count mismatch throws', () => {
  assert.throws(() => parsePiecewise('3 0 0 1 1'));           // odd count
  assert.throws(() => parsePiecewise('not_a_number'));
  assert.throws(() => parsePiecewise('4 0 0 1'));             // count says 4 vals, only 3 follow
});

test('serializePiecewise: integer-vs-float formatting', () => {
  assert.equal(serializePiecewise([{ x: 0, y: 0 }, { x: 100, y: 0.5 }]),
               '4 0 0 100 0.5');
});

test('serializePiecewise: real-volRender.mrml shape (7 points → count=14)', () => {
  // From Modules/Loadable/VolumeRendering/Testing/Data/Input/volRender.mrml:
  //   scalarOpacity="14 -10001 1 -10000 0 0 1e-05 0.1 1 7 0.122 7.000000000001 1 10 1e-09"
  const raw = '14 -10001 1 -10000 0 0 1e-05 0.1 1 7 0.122 7.000000000001 1 10 1e-09';
  const points = parsePiecewise(raw);
  assert.equal(points.length, 7);
  assert.equal(points[0].x, -10001);
  assert.equal(points[0].y, 1);
  // Round-trip preserves all values (formatting may differ on dense floats)
  const reparsed = parsePiecewise(serializePiecewise(points));
  assert.equal(reparsed.length, 7);
  for (let i = 0; i < 7; i++) {
    assert.ok(Math.abs(reparsed[i].x - points[i].x) < 1e-6,
      `x[${i}] mismatch: ${reparsed[i].x} vs ${points[i].x}`);
    assert.ok(Math.abs(reparsed[i].y - points[i].y) < 1e-6);
  }
});

test('parseColorTransfer: basic (count=8 → 2 points)', () => {
  // "8 0 0 0 0 1024 1 1 1"
  const c = parseColorTransfer('8 0 0 0 0 1024 1 1 1');
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { x: 0, r: 0, g: 0, b: 0 });
  assert.deepEqual(c[1], { x: 1024, r: 1, g: 1, b: 1 });
});

test('serializeColorTransfer: round-trip (3 points → count=12)', () => {
  const raw = '12 0 0 0 0 512 0.5 0.5 0.5 1024 1 1 1';
  const c = parseColorTransfer(raw);
  assert.equal(serializeColorTransfer(c), raw);
});

test('sampleOpacity: linear interpolation + clamping', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 1 }];
  assert.equal(sampleOpacity(pts, -50), 0);
  assert.equal(sampleOpacity(pts, 0), 0);
  assert.equal(sampleOpacity(pts, 50), 0.5);
  assert.equal(sampleOpacity(pts, 100), 1);
  assert.equal(sampleOpacity(pts, 200), 1);
});

test('sampleColor: linear interpolation in RGB', () => {
  const pts = [
    { x: 0, r: 0, g: 0, b: 0 },
    { x: 100, r: 1, g: 0.5, b: 0 },
  ];
  const c = sampleColor(pts, 50);
  assert.ok(Math.abs(c[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(c[1] - 0.25) < 1e-6);
  assert.equal(c[2], 0);
});

test('unifyTransferFunctions: same xs round-trip cleanly', () => {
  const o = [{ x: 0, y: 0 }, { x: 100, y: 1 }];
  const c = [{ x: 0, r: 0, g: 0, b: 0 }, { x: 100, r: 1, g: 1, b: 1 }];
  const u = unifyTransferFunctions(o, c);
  assert.equal(u.length, 2);
  assert.equal(u[0].x, 0);
  assert.equal(u[1].opacity, 1);
  assert.deepEqual(u[1].rgb, [1, 1, 1]);
});

test('unifyTransferFunctions: different xs are unioned and sampled', () => {
  const o = [{ x: 0, y: 0 }, { x: 100, y: 1 }];
  const c = [{ x: 50, r: 1, g: 0, b: 0 }];  // only one color point
  const u = unifyTransferFunctions(o, c);
  // Union of xs: {0, 50, 100} → 3 points
  assert.equal(u.length, 3);
  assert.equal(u[0].x, 0);
  assert.equal(u[1].x, 50);
  assert.equal(u[2].x, 100);
  // Color clamped to its single defined point
  assert.deepEqual(u[0].rgb, [1, 0, 0]);
  assert.deepEqual(u[2].rgb, [1, 0, 0]);
  // Opacity interpolated normally
  assert.equal(u[1].opacity, 0.5);
});

test('sampleCombinedAt: returns both opacity and rgb interpolated', () => {
  const pts = [
    { x: 0, opacity: 0, rgb: [0, 0, 0] as [number, number, number] },
    { x: 100, opacity: 1, rgb: [1, 1, 1] as [number, number, number] },
  ];
  const s = sampleCombinedAt(pts, 25);
  assert.equal(s.opacity, 0.25);
  assert.ok(Math.abs(s.rgb[0] - 0.25) < 1e-9);
});

test('compositeLayers: single layer round-trips its own xs', () => {
  const layers: TFLayer[] = [{
    id: 'a', name: 'L', visible: true,
    controlPoints: [
      { x: 0, opacity: 0, rgb: [0, 0, 0] },
      { x: 100, opacity: 1, rgb: [1, 0, 0] },
    ],
  }];
  const { opacity, color } = compositeLayers(layers);
  assert.equal(opacity.length, 2);
  assert.equal(color.length, 2);
  assert.equal(opacity[1].y, 1);
  assert.deepEqual([color[1].r, color[1].g, color[1].b], [1, 0, 0]);
});

test('compositeLayers max: higher-opacity layer wins at each x', () => {
  const layers: TFLayer[] = [
    {
      id: 'lo', name: 'lo', visible: true,
      controlPoints: [
        { x: 0, opacity: 0.2, rgb: [1, 0, 0] },
        { x: 100, opacity: 0.2, rgb: [1, 0, 0] },
      ],
    },
    {
      id: 'hi', name: 'hi', visible: true,
      controlPoints: [
        { x: 0, opacity: 0.8, rgb: [0, 1, 0] },
        { x: 100, opacity: 0.8, rgb: [0, 1, 0] },
      ],
    },
  ];
  const { opacity, color } = compositeLayers(layers, 'max');
  // Union has just {0, 100}; at both, the green layer wins
  assert.equal(opacity.length, 2);
  for (const p of opacity) assert.equal(p.y, 0.8);
  for (const c of color) assert.deepEqual([c.r, c.g, c.b], [0, 1, 0]);
});

test('compositeLayers respects visible=false', () => {
  const layers: TFLayer[] = [
    {
      id: 'a', name: 'a', visible: false,
      controlPoints: [
        { x: 0, opacity: 1, rgb: [1, 0, 0] },
        { x: 100, opacity: 1, rgb: [1, 0, 0] },
      ],
    },
    {
      id: 'b', name: 'b', visible: true,
      controlPoints: [
        { x: 0, opacity: 0.3, rgb: [0, 1, 0] },
        { x: 100, opacity: 0.3, rgb: [0, 1, 0] },
      ],
    },
  ];
  const { opacity, color } = compositeLayers(layers, 'max');
  for (const p of opacity) assert.equal(p.y, 0.3);
  for (const c of color) assert.deepEqual([c.r, c.g, c.b], [0, 1, 0]);
});

test('compositeLayers add: opacities sum and color is weighted', () => {
  const layers: TFLayer[] = [
    {
      id: 'r', name: 'r', visible: true,
      controlPoints: [
        { x: 0, opacity: 0.3, rgb: [1, 0, 0] },
        { x: 100, opacity: 0.3, rgb: [1, 0, 0] },
      ],
    },
    {
      id: 'b', name: 'b', visible: true,
      controlPoints: [
        { x: 0, opacity: 0.3, rgb: [0, 0, 1] },
        { x: 100, opacity: 0.3, rgb: [0, 0, 1] },
      ],
    },
  ];
  const { opacity, color } = compositeLayers(layers, 'add');
  // Σ = 0.6, color = (0.5R, 0, 0.5B)
  for (const p of opacity) assert.ok(Math.abs(p.y - 0.6) < 1e-9);
  for (const c of color) {
    assert.ok(Math.abs(c.r - 0.5) < 1e-9);
    assert.equal(c.g, 0);
    assert.ok(Math.abs(c.b - 0.5) < 1e-9);
  }
});

test('normalizePiecewise: sorts by x and merges duplicates', () => {
  const out = normalizePiecewise([
    { x: 100, y: 0.5 },
    { x: 0, y: 0 },
    { x: 100, y: 0.8 },   // duplicate x — keep latest y
    { x: 200, y: 1 },
  ]);
  assert.deepEqual(out, [
    { x: 0, y: 0 },
    { x: 100, y: 0.8 },
    { x: 200, y: 1 },
  ]);
});
