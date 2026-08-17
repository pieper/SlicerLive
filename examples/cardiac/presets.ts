// Cardiac volume-rendering presets, transcribed verbatim from 3D Slicer and SlicerHeart.
//
//   CT-Cardiac3, CT-Coronary-Arteries-3, CT-Chest-Contrast-Enhanced, MR-Default
//     Slicer/Modules/Loadable/VolumeRendering/Resources/presets.xml
//   CT-EndoVascular
//     SlicerHeart/ValveAnnulusAnalysis/Resources/VrPresets/US-VrPresets.mrml
//
// Every one of these carries a FLAT gradient opacity ("4 0 1 255 1", a constant 1.0 no-op)
// in Slicer, so they port to SlicerLive's scalar-only LUT machinery byte-for-byte — no
// gradient-magnitude modulation needed. (Only CT-Bones/CT-Fat/CT-Lung/MR-T2-Brain/
// DTI-FA-Brain/US-Fetal/uCT-* use a real gradient curve, and none of those is cardiac.)
// See docs/CARDIAC-RENDERING-PLAN.md §2.
//
// CT-EndoVascular is the one that reproduces the JACC VSD paper's look: its scalar opacity
// ramps myocardium up across 95-290 HU and then drops to ZERO at 338 HU, so contrast-filled
// blood becomes invisible and the camera can sit inside the chamber looking at endocardium.

/** [scalar, r, g, b] and [scalar, alpha] control points — the shape lutFromTransferFunctions wants. */
export interface Preset {
  color: number[][];
  scalarOpacity: number[][];
  /** (ambient, diffuse, specular, specularPower) — the preset's OWN Phong coefficients.
   *  Verified by reading them out of a running Slicer 5.12 + SlicerHeart, not from the XML.
   *  Using generic values instead visibly changes the render: the CT presets are much less
   *  ambient (0.1 vs a typical 0.25) and much less specular (0.2 @ power 10 vs 0.5 @ 24). */
  shade: [number, number, number, number];
  /** Suggested window for the MPR views (not part of the VR preset). */
  windowLevel?: [number, number];
  blurb: string;
}

export const CARDIAC_PRESETS: Record<string, Preset> = {
  "CT-EndoVascular": {
    shade: [0.1, 0.9, 0.2, 10],
    blurb: "Myocardium opaque, contrast blood transparent above 338 HU — fly inside the chamber",
    windowLevel: [1400, 300],
    color: [
      [-3024, 0, 0, 0],
      [-77.6875, 0.54902, 0.25098, 0.14902],
      [94.9518, 0.882353, 0.603922, 0.290196],
      [179.052, 1, 0.937033, 0.954531],
      [260.439, 0.615686, 0, 0],
      [3071, 0.827451, 0.658824, 1],
    ],
    scalarOpacity: [
      [-3024, 0],
      [-140.4853515625, 0],
      [94.9518, 0.285714],
      [179.052, 0.553571],
      [260.439, 0.848214],
      [289.798675537109, 0.871428549289703],
      [338.101623535156, 0],            // <- contrast-opacified blood vanishes here
      [2784.18041992188, 0],
      [2930.0205078125, 0.899999976158142],
      [3071, 0.875],
    ],
  },
  "CT-Cardiac3": {
    shade: [0.1, 0.9, 0.2, 10],
    blurb: "Standard cardiac CT preset — contrast blood pool opaque",
    windowLevel: [1400, 300],
    color: [
      [-3024, 0, 0, 0],
      [-86.9767, 0, 0.25098, 1],
      [45.3791, 1, 0, 0],
      [139.919, 1, 0.894893, 0.894893],
      [347.907, 1, 1, 0.25098],
      [1224.16, 1, 1, 1],
      [3071, 0.827451, 0.658824, 1],
    ],
    scalarOpacity: [
      [-3024, 0],
      [-86.9767, 0],
      [45.3791, 0.169643],
      [139.919, 0.589286],
      [347.907, 0.607143],
      [1224.16, 0.607143],
      [3071, 0.616071],
    ],
  },
  "CT-Coronary-Arteries-3": {
    shade: [0.1, 0.9, 0.2, 10],
    blurb: "Coronary/vessel emphasis, dark below 129 HU",
    windowLevel: [1000, 300],
    color: [
      [-2048, 0, 0, 0],
      [128.643, 0, 0, 0],
      [129.982, 0.615686, 0, 0.0156863],
      [173.636, 0.909804, 0.454902, 0],
      [255.884, 0.886275, 0.886275, 0.886275],
      [584.878, 0.968627, 0.968627, 0.968627],
      [3661, 1, 1, 1],
    ],
    scalarOpacity: [
      [-2048, 0],
      [128.643, 0],
      [129.982, 0.0982143],
      [173.636, 0.669643],
      [255.884, 0.857143],
      [584.878, 0.866071],
      [3661, 1],
    ],
  },
  "CT-Chest-Contrast-Enhanced": {
    shade: [0.1, 0.9, 0.2, 10],
    blurb: "Contrast-enhanced chest — soft tissue and vessels together",
    windowLevel: [1400, 300],
    color: [
      [-3024, 0, 0, 0],
      [67.0106, 0.54902, 0.25098, 0.14902],
      [251.105, 0.882353, 0.603922, 0.290196],
      [439.291, 1, 0.937033, 0.954531],
      [3071, 0.827451, 0.658824, 1],
    ],
    scalarOpacity: [
      [-3024, 0],
      [67.0106, 0],
      [251.105, 0.446429],
      [439.291, 0.625],
      [3071, 0.616071],
    ],
  },
  "MR-Default": {
    shade: [0.2, 1.0, 0.0, 1],
    blurb: "Default MR preset (for the HVSMR-2.0 whole-heart MRI path)",
    windowLevel: [500, 250],
    color: [
      [0, 0, 0, 0],
      [20, 0.168627, 0, 0],
      [40, 0.403922, 0.145098, 0.0784314],
      [120, 0.780392, 0.607843, 0.380392],
      [220, 0.847059, 0.835294, 0.788235],
      [1024, 1, 1, 1],
    ],
    scalarOpacity: [
      [0, 0],
      [20, 0],
      [40, 0.15],
      [120, 0.3],
      [220, 0.375],
      [1024, 0.5],
    ],
  },
};

export const PRESET_NAMES = Object.keys(CARDIAC_PRESETS);
