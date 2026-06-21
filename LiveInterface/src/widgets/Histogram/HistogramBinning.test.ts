import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBins } from './HistogramBinning.js';

test('uniform integer data fills bins evenly', () => {
  const data = new Float32Array(256);
  for (let i = 0; i < 256; i++) data[i] = i;
  const { bins, range, total } = computeBins(data, { bins: 256 });
  assert.equal(total, 256);
  assert.deepEqual(range, [0, 255]);
  // Every bin sees at least 1 value
  for (let i = 0; i < 256; i++) assert.ok(bins[i] >= 1);
});

test('out-of-range values clamp into edge bins', () => {
  // 0.5 with min=0,max=1,bins=4 hits bin 2 (boundary), not bin 0.
  const data = new Float32Array([-100, -100, 0.5, 1.5, 200, 200]);
  const { bins } = computeBins(data, { min: 0, max: 1, bins: 4 });
  assert.equal(bins[0], 2); // two -100 clamped to first bin
  assert.equal(bins[2], 1); // 0.5
  assert.equal(bins[3], 3); // 1.5 + two 200s clamped
});

test('auto-range when omitted', () => {
  const data = new Float32Array([10, 20, 30, 40]);
  const { range } = computeBins(data);
  assert.deepEqual(range, [10, 40]);
});

test('maxBin reflects the busiest bin', () => {
  const data = new Float32Array([0, 0, 0, 0, 5, 9]);
  const { bins, maxBin } = computeBins(data, { min: 0, max: 10, bins: 10 });
  assert.equal(bins[0], 4);
  assert.equal(maxBin, 4);
});

test('degenerate range (max <= min) is widened, not exploded', () => {
  const data = new Float32Array([5, 5, 5]);
  const { range, bins } = computeBins(data, { min: 5, max: 5, bins: 4 });
  assert.equal(range[0], 5);
  assert.equal(range[1], 6);
  assert.equal(bins[0], 3); // all clamp into the first bin
});

test('handles empty input without crashing', () => {
  const data = new Float32Array(0);
  const { bins, total, maxBin } = computeBins(data, { bins: 8 });
  assert.equal(bins.length, 8);
  assert.equal(total, 0);
  assert.equal(maxBin, 0);
});
