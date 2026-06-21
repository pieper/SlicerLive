import type { CatalogEntry, CameraDelta, Source } from './types.js';

// Standard radiological camera orientations.
//
// RAS convention: +X = Right of patient, +Y = Anterior, +Z = Superior.
// Each preset places the camera on a unit direction from the focal point and
// specifies a view-up. The host (`applyCameraDelta`) multiplies the unit
// direction by the current camera→focal distance so zoom is preserved across
// switches; only orientation changes.

const CAM_SOURCE: Source = {
  kind: 'authored',
  note: 'Standard radiological camera orientations (A/P/S/I/L/R + isometrics).',
};

function C(position: [number, number, number], viewUp: [number, number, number], symbol: string): CameraDelta {
  // Normalize position to unit vector (host scales by distance).
  const m = Math.hypot(...position) || 1;
  return { kind: 'camera', position: [position[0]/m, position[1]/m, position[2]/m], viewUp, symbol };
}

export const cameraPresetsCatalog: readonly CatalogEntry<CameraDelta>[] = [
  {
    category: 'camera', id: 'cam-anterior', label: 'Anterior view',
    description: 'Camera looking from the front of the patient (along −Y).',
    delta: C([0, 1, 0], [0, 0, 1], 'A'),
    source: [CAM_SOURCE],
  },
  {
    category: 'camera', id: 'cam-posterior', label: 'Posterior view',
    description: 'Camera looking from behind the patient (along +Y).',
    delta: C([0, -1, 0], [0, 0, 1], 'P'),
    source: [CAM_SOURCE],
  },
  {
    category: 'camera', id: 'cam-superior', label: 'Superior view',
    description: 'Camera looking down from above (along −Z).',
    delta: C([0, 0, 1], [0, 1, 0], 'S'),
    source: [CAM_SOURCE],
  },
  {
    category: 'camera', id: 'cam-inferior', label: 'Inferior view',
    description: 'Camera looking up from below (along +Z).',
    delta: C([0, 0, -1], [0, -1, 0], 'I'),
    source: [CAM_SOURCE],
  },
  {
    category: 'camera', id: 'cam-right', label: 'Right view',
    description: 'Camera on the patient\'s right side (along −X).',
    delta: C([1, 0, 0], [0, 0, 1], 'R'),
    source: [CAM_SOURCE],
  },
  {
    category: 'camera', id: 'cam-left', label: 'Left view',
    description: 'Camera on the patient\'s left side (along +X).',
    delta: C([-1, 0, 0], [0, 0, 1], 'L'),
    source: [CAM_SOURCE],
  },
  {
    category: 'camera', id: 'cam-iso-as', label: 'Iso (A+S)',
    description: 'Isometric from upper-anterior (+Y +Z).',
    delta: C([0, 1, 1], [0, 0, 1], 'AS'),
    source: [CAM_SOURCE],
  },
  {
    category: 'camera', id: 'cam-iso-ras', label: 'Iso (R+A+S)',
    description: 'Isometric from upper-anterior-right (+X +Y +Z).',
    delta: C([1, 1, 1], [0, 0, 1], 'RAS'),
    source: [CAM_SOURCE],
  },
];
