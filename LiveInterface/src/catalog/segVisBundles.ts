import type { CatalogEntry, SegmentVisDelta, Source } from './types.js';

// Coarse segment-visibility bundles for v0. The richer "skeleton-only / soft-
// tissue-only / highlight-this-organ" bundles need semantic segment labels
// (which the current scene capabilities don't carry yet); these four work
// for any segmentation by raw segment number.

const SEG_SOURCE: Source = {
  kind: 'authored',
  note: 'Coarse visibility bundles for any segmentation; semantic bundles are a follow-up.',
};

function S(mode: SegmentVisDelta['mode']): SegmentVisDelta {
  return { kind: 'segment-vis', mode };
}

export const segVisBundlesCatalog: readonly CatalogEntry<SegmentVisDelta>[] = [
  {
    category: 'segment-vis', id: 'seg-all-on', label: 'All segments on',
    description: 'Show every segment at full opacity.',
    appliesWhen: { hasSegmentation: true, minSegments: 1 },
    delta: S('all-on'),
    source: [SEG_SOURCE],
  },
  {
    category: 'segment-vis', id: 'seg-all-off', label: 'All segments off',
    description: 'Hide every segment (show only the background volume).',
    appliesWhen: { hasSegmentation: true, minSegments: 1 },
    delta: S('all-off'),
    source: [SEG_SOURCE],
  },
  {
    category: 'segment-vis', id: 'seg-solo-first', label: 'Solo first segment',
    description: 'Show only the first segment; hide the rest.',
    appliesWhen: { hasSegmentation: true, minSegments: 2 },
    delta: S('solo-first'),
    source: [SEG_SOURCE],
  },
  {
    category: 'segment-vis', id: 'seg-fade-others', label: 'Fade other segments',
    description: 'First segment full opacity; others dimmed (good for highlighting context).',
    appliesWhen: { hasSegmentation: true, minSegments: 2 },
    delta: S('fade-others'),
    source: [SEG_SOURCE],
  },
];
