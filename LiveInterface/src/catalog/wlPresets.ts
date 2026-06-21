import type { CatalogEntry, WlPresetDelta, Source } from './types.js';

// Mined from Slicer source:
//   Modules/Loadable/Volumes/Resources/VolumeDisplayPresets.json
// Each entry there has a window/level pair and a modality-typed name.
// SlicerLive's renderer reads window/level from the active volume's
// `vtkMRMLScalarVolumeDisplayNode`; applying a W/L preset rewrites those
// attrs in mirror and triggers a slice re-render.

const WL_SOURCE: Source = {
  kind: 'slicer-source',
  path: 'Modules/Loadable/Volumes/Resources/VolumeDisplayPresets.json',
  note: 'Canonical W/L presets shipped with Slicer.',
};

function W(presetName: string, window: number, level: number): WlPresetDelta {
  return { kind: 'wl-preset', presetName, window, level };
}

export const wlPresetsCatalog: readonly CatalogEntry<WlPresetDelta>[] = [
  // ---- CT ---------------------------------------------------------------
  {
    category: 'wl-preset', id: 'wl-ct-bone', label: 'CT-Bone (W/L)',
    description: 'Window 1000, Level 400 — emphasize bone in a CT volume.',
    appliesWhen: { modality: 'CT' },
    delta: W('CT-Bone', 1000, 400),
    source: [WL_SOURCE],
  },
  {
    category: 'wl-preset', id: 'wl-ct-air', label: 'CT-Air (W/L)',
    description: 'Window 1000, Level -426 — emphasize air-filled structures.',
    appliesWhen: { modality: 'CT' },
    delta: W('CT-Air', 1000, -426),
    source: [WL_SOURCE],
  },
  {
    category: 'wl-preset', id: 'wl-ct-brain', label: 'CT-Brain (W/L)',
    description: 'Window 100, Level 50 — narrow window for brain tissue.',
    appliesWhen: { modality: 'CT' },
    delta: W('CT-Brain', 100, 50),
    source: [WL_SOURCE],
  },
  {
    category: 'wl-preset', id: 'wl-ct-abdomen', label: 'CT-Abdomen (W/L)',
    description: 'Window 350, Level 40 — abdominal soft tissue.',
    appliesWhen: { modality: 'CT' },
    delta: W('CT-Abdomen', 350, 40),
    source: [WL_SOURCE],
  },
  {
    category: 'wl-preset', id: 'wl-ct-lung', label: 'CT-Lung (W/L)',
    description: 'Window 1400, Level -500 — lung parenchyma window.',
    appliesWhen: { modality: 'CT' },
    delta: W('CT-Lung', 1400, -500),
    source: [WL_SOURCE],
  },

  // ---- PET --------------------------------------------------------------
  {
    category: 'wl-preset', id: 'wl-pet', label: 'PET (W/L)',
    description: 'Window 10000, Level 6000 — standard PET intensity range.',
    appliesWhen: { modality: 'PET' },
    delta: W('PET', 10000, 6000),
    source: [WL_SOURCE],
  },

  // ---- DTI --------------------------------------------------------------
  {
    category: 'wl-preset', id: 'wl-dti', label: 'DTI (W/L)',
    description: 'Window 1, Level 0.5 — DTI scalar volumes (e.g. FA).',
    appliesWhen: { modality: 'DTI' },
    delta: W('DTI', 1, 0.5),
    source: [WL_SOURCE],
  },
];
