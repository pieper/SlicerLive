import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessModality } from './Modality.js';
import { computeBins } from '../widgets/Histogram/HistogramBinning.js';

function syntheticCT(n = 32 * 32 * 32): Float32Array {
  const out = new Float32Array(n);
  let s = 12345;
  const rand = () => ((s = (s * 1664525 + 1013904223) | 0) >>> 0) / 4294967296;
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.5)      out[i] = -1000 + (rand() * 2 - 1) * 30; // air
    else if (r < 0.9) out[i] =    50 + (rand() * 2 - 1) * 60; // soft
    else              out[i] =   700 + (rand() * 2 - 1) * 250; // bone
  }
  return out;
}

function syntheticMR(n = 32 * 32 * 32): Float32Array {
  const out = new Float32Array(n);
  let s = 7;
  const rand = () => ((s = (s * 1664525 + 1013904223) | 0) >>> 0) / 4294967296;
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.4)      out[i] = (rand() * 2 - 1) * 20 + 10;    // background-ish
    else              out[i] = 200 + (rand() * 2 - 1) * 100;  // tissue
  }
  return out;
}

function syntheticPET(n = 32 * 32 * 32): Float32Array {
  const out = new Float32Array(n);
  let s = 99;
  const rand = () => ((s = (s * 1664525 + 1013904223) | 0) >>> 0) / 4294967296;
  for (let i = 0; i < n; i++) out[i] = rand() * 8;
  return out;
}

test('guessModality: synthetic CT → CT, confidence > 0.7', () => {
  const data = syntheticCT();
  const { bins, range } = computeBins(data, { bins: 256 });
  const g = guessModality(bins, range);
  assert.equal(g.modality, 'CT');
  assert.equal(g.units, 'HU');
  assert.ok(g.confidence > 0.7, `confidence ${g.confidence} too low`);
});

test('guessModality: synthetic MR (positive intensity) → MR', () => {
  const data = syntheticMR();
  const { bins, range } = computeBins(data, { bins: 256 });
  const g = guessModality(bins, range);
  assert.equal(g.modality, 'MR');
  assert.equal(g.units, 'intensity');
});

test('guessModality: synthetic PET (SUV-like) → PT', () => {
  const data = syntheticPET();
  const { bins, range } = computeBins(data, { bins: 256 });
  const g = guessModality(bins, range);
  assert.equal(g.modality, 'PT');
  assert.equal(g.units, 'SUV');
});

test('guessModality: invalid range → unknown, confidence 0', () => {
  const bins = new Uint32Array(8);
  const g = guessModality(bins, [5, 5]);
  assert.equal(g.modality, 'unknown');
  assert.equal(g.confidence, 0);
});
