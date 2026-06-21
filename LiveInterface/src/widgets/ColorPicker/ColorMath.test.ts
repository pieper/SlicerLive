import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rgbToHsv, hsvToRgb, rgbToHex, hexToRgba, rgbApproxEqual,
  type RGB,
} from './ColorMath.js';

const approxEq = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test('rgbToHsv: primaries', () => {
  assert.deepEqual(rgbToHsv([1, 0, 0]), [0, 1, 1]);
  const green = rgbToHsv([0, 1, 0]);
  assert.ok(approxEq(green[0], 1 / 3));
  const blue = rgbToHsv([0, 0, 1]);
  assert.ok(approxEq(blue[0], 2 / 3));
});

test('rgbToHsv: greyscale has S=0', () => {
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const [, s, val] = rgbToHsv([v, v, v]);
    assert.equal(s, 0);
    assert.equal(val, v);
  }
});

test('hsvToRgb round-trips RGB primaries and secondaries', () => {
  const cases: RGB[] = [
    [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [1, 1, 0], [0, 1, 1], [1, 0, 1],
    [0.3, 0.6, 0.9],
  ];
  for (const rgb of cases) {
    const back = hsvToRgb(rgbToHsv(rgb));
    assert.ok(rgbApproxEqual(rgb, back, 1e-6),
      `round-trip failed for ${rgb} → ${back}`);
  }
});

test('hsvToRgb round-trips for random HSV', () => {
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 200; i++) {
    const h = rand(), s = rand(), v = rand();
    const rgb = hsvToRgb([h, s, v]);
    const hsv2 = rgbToHsv(rgb);
    const rgb2 = hsvToRgb(hsv2);
    assert.ok(rgbApproxEqual(rgb, rgb2, 1e-5),
      `re-encode mismatch: ${rgb} → ${rgb2}`);
  }
});

test('rgbToHex / hexToRgba round-trip', () => {
  const samples = [
    { rgb: [0, 0, 0] as RGB, hex: '#000000' },
    { rgb: [1, 1, 1] as RGB, hex: '#ffffff' },
    { rgb: [1, 0, 0] as RGB, hex: '#ff0000' },
    { rgb: [136 / 255, 204 / 255, 1] as RGB, hex: '#88ccff' },
  ];
  for (const { rgb, hex } of samples) {
    assert.equal(rgbToHex(rgb), hex);
    const parsed = hexToRgba(hex);
    assert.ok(parsed);
    assert.ok(rgbApproxEqual(parsed!.rgb, rgb, 1 / 255));
    assert.equal(parsed!.alpha, 1);
  }
});

test('hexToRgba: 3- and 8-digit forms', () => {
  const a = hexToRgba('#abc');
  assert.ok(a);
  assert.deepEqual(a!.rgb, [0xaa / 255, 0xbb / 255, 0xcc / 255]);

  const b = hexToRgba('#11223380');
  assert.ok(b);
  assert.equal(b!.alpha, 0x80 / 255);
});

test('hexToRgba: rejects garbage', () => {
  assert.equal(hexToRgba(''), null);
  assert.equal(hexToRgba('#ggg'), null);
  assert.equal(hexToRgba('not a hex'), null);
});

test('rgbToHex: alpha encoding', () => {
  assert.equal(rgbToHex([1, 1, 1]), '#ffffff');
  assert.equal(rgbToHex([1, 1, 1], 1), '#ffffff');
  assert.equal(rgbToHex([1, 1, 1], 0.5), '#ffffff80');
});
