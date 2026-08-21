// Standard Slicer CT volume-rendering presets — the exact transfer functions OHIF/vtk.js
// derive their VR presets from (Slicer Modules/Loadable/VolumeRendering/Resources/presets.xml).
// A curated CT subset; each carries the color + scalar-opacity transfer functions (absolute HU)
// and lighting. presetLUT() bakes one into a 256-entry LUT + clim + shade for an ImageField,
// exactly like scene-volume.ts does for the SlicerMorph VPs.
import { lutFromTransferFunctions, type TF } from "./scene-volume.ts";

export interface CtVrPreset {
  name: string;        // Slicer preset id (e.g. "CT-Bone")
  label: string;       // short menu label
  colorTF: TF;         // [[HU, r, g, b], …] 0..1 colour
  opacityTF: TF;       // [[HU, a], …] scalar opacity
  shade: boolean;      // Phong shading on?
  light: [number, number, number, number]; // ambient, diffuse, specular, specularPower
}

export const CT_VR_PRESETS: CtVrPreset[] = [
  { name: "CT-AAA", label: "CT AAA (angio)", shade: true, light: [0.1, 0.9, 0.2, 10.0],
    colorTF: [[-3024.0, 0.0, 0.0, 0.0], [143.556, 0.6157, 0.3569, 0.1843], [166.222, 0.8824, 0.6039, 0.2902], [214.389, 1.0, 1.0, 1.0], [419.736, 1.0, 0.937, 0.9545], [3071.0, 0.8275, 0.6588, 1.0]],
    opacityTF: [[-3024.0, 0.0], [143.556, 0.0], [166.222, 0.6863], [214.389, 0.6961], [419.736, 0.8333], [3071.0, 0.8039]] },
  { name: "CT-Bone", label: "CT Bone", shade: true, light: [0.1, 0.9, 0.2, 10.0],
    colorTF: [[-3024.0, 0.0, 0.0, 0.0], [-16.446, 0.7294, 0.2549, 0.302], [641.385, 0.9059, 0.8157, 0.5529], [3071.0, 1.0, 1.0, 1.0]],
    opacityTF: [[-3024.0, 0.0], [-16.446, 0.0], [641.385, 0.7157], [3071.0, 0.7059]] },
  { name: "CT-Bones", label: "CT Bones", shade: true, light: [0.2, 1.0, 0.0, 1.0],
    colorTF: [[-1000.0, 0.3, 0.3, 1.0], [-488.0, 0.3, 1.0, 0.3], [463.28, 1.0, 0.0, 0.0], [659.15, 1.0, 0.9125, 0.0375], [953.0, 1.0, 0.3, 0.3]],
    opacityTF: [[-1000.0, 0.0], [152.19, 0.0], [278.93, 0.1905], [952.0, 0.2]] },
  { name: "CT-Cardiac", label: "CT Cardiac", shade: true, light: [0.1, 0.9, 0.2, 10.0],
    colorTF: [[-3024.0, 0.0, 0.0, 0.0], [-77.688, 0.549, 0.251, 0.149], [94.952, 0.8824, 0.6039, 0.2902], [179.052, 1.0, 0.937, 0.9545], [260.439, 0.6157, 0.0, 0.0], [3071.0, 0.8275, 0.6588, 1.0]],
    opacityTF: [[-3024.0, 0.0], [-77.688, 0.0], [94.952, 0.2857], [179.052, 0.5536], [260.439, 0.8482], [3071.0, 0.875]] },
  { name: "CT-Chest-Contrast-Enhanced", label: "CT Chest (contrast)", shade: true, light: [0.1, 0.9, 0.2, 10.0],
    colorTF: [[-3024.0, 0.0, 0.0, 0.0], [67.011, 0.549, 0.251, 0.149], [251.105, 0.8824, 0.6039, 0.2902], [439.291, 1.0, 0.937, 0.9545], [3071.0, 0.8275, 0.6588, 1.0]],
    opacityTF: [[-3024.0, 0.0], [67.011, 0.0], [251.105, 0.4464], [439.291, 0.625], [3071.0, 0.6161]] },
  { name: "CT-Coronary-Arteries", label: "CT Coronary", shade: false, light: [0.2, 1.0, 0.0, 1.0],
    colorTF: [[-2048.0, 0.0, 0.0, 0.0], [136.47, 0.0, 0.0, 0.0], [159.215, 0.1598, 0.1598, 0.1598], [318.43, 0.7647, 0.7647, 0.7647], [478.693, 1.0, 1.0, 1.0], [3661.0, 1.0, 1.0, 1.0]],
    opacityTF: [[-2048.0, 0.0], [136.47, 0.0], [159.215, 0.2589], [318.43, 0.5714], [478.693, 0.7768], [3661.0, 1.0]] },
  { name: "CT-Fat", label: "CT Fat", shade: false, light: [0.2, 1.0, 0.0, 1.0],
    colorTF: [[-1000.0, 0.3, 0.3, 1.0], [-497.5, 0.3, 1.0, 0.3], [-99.0, 0.0, 0.0, 1.0], [-76.946, 0.0, 1.0, 0.0], [-65.481, 0.8354, 0.8889, 0.0165], [83.89, 1.0, 0.0, 0.0], [463.28, 1.0, 0.0, 0.0], [659.15, 1.0, 0.9125, 0.0375], [2952.0, 1.0, 0.3003, 0.2999]],
    opacityTF: [[-1000.0, 0.0], [-100.0, 0.0], [-99.0, 0.15], [-60.0, 0.15], [-59.0, 0.0], [101.2, 0.0], [952.0, 0.0]] },
  { name: "CT-Lung", label: "CT Lung", shade: true, light: [0.2, 1.0, 0.0, 1.0],
    colorTF: [[-1000.0, 0.3, 0.3, 1.0], [-600.0, 0.0, 0.0, 1.0], [-530.0, 0.1347, 0.7817, 0.0725], [-460.0, 0.9292, 1.0, 0.1095], [-400.0, 0.8889, 0.2549, 0.024], [2952.0, 1.0, 0.3, 0.3]],
    opacityTF: [[-1000.0, 0.0], [-600.0, 0.0], [-599.0, 0.15], [-400.0, 0.15], [-399.0, 0.0], [2952.0, 0.0]] },
  { name: "CT-MIP", label: "CT MIP", shade: true, light: [0.1, 0.9, 0.2, 10.0],
    colorTF: [[-3024.0, 0.0, 0.0, 0.0], [-637.62, 1.0, 1.0, 1.0], [700.0, 1.0, 1.0, 1.0], [3071.0, 1.0, 1.0, 1.0]],
    opacityTF: [[-3024.0, 0.0], [-637.62, 0.0], [700.0, 1.0], [3071.0, 1.0]] },
  { name: "CT-Muscle", label: "CT Muscle", shade: true, light: [0.1, 0.9, 0.2, 10.0],
    colorTF: [[-3024.0, 0.0, 0.0, 0.0], [-155.407, 0.549, 0.251, 0.149], [217.641, 0.8824, 0.6039, 0.2902], [419.736, 1.0, 0.937, 0.9545], [3071.0, 0.8275, 0.6588, 1.0]],
    opacityTF: [[-3024.0, 0.0], [-155.407, 0.0], [217.641, 0.6765], [419.736, 0.8333], [3071.0, 0.8039]] },
  { name: "CT-Pulmonary-Arteries", label: "CT Pulmonary", shade: true, light: [0.2, 1.0, 0.0, 1.0],
    colorTF: [[-2048.0, 0.0, 0.0, 0.0], [-568.625, 0.0, 0.0, 0.0], [-364.081, 0.3961, 0.302, 0.1804], [-244.813, 0.6118, 0.3529, 0.0706], [18.277, 0.8431, 0.0157, 0.1569], [447.798, 0.7529, 0.7529, 0.7529], [3592.73, 1.0, 1.0, 1.0]],
    opacityTF: [[-2048.0, 0.0], [-568.625, 0.0], [-364.081, 0.0714], [-244.813, 0.4018], [18.277, 0.6071], [447.798, 0.8304], [3592.73, 0.8393]] },
  { name: "CT-Soft-Tissue", label: "CT Soft Tissue", shade: false, light: [0.2, 1.0, 0.0, 1.0],
    colorTF: [[-2048.0, 0.0, 0.0, 0.0], [-167.01, 0.0, 0.0, 0.0], [-160.0, 0.0556, 0.0556, 0.0556], [240.0, 1.0, 1.0, 1.0], [3661.0, 1.0, 1.0, 1.0]],
    opacityTF: [[-2048.0, 0.0], [-167.01, 0.0], [-160.0, 1.0], [240.0, 1.0], [3661.0, 1.0]] },
];

export interface PresetBake { lut: Uint8Array; clim: [number, number]; shade: [number, number, number, number] }

/** Bake a preset into a 256-entry LUT + clim + shade tuple for volumeField.setVolumePreset(). */
export function presetLUT(p: CtVrPreset): PresetBake {
  const lo = p.colorTF[0][0];
  const hi = p.colorTF[p.colorTF.length - 1][0];
  const clim: [number, number] = [lo, hi];
  const lut = lutFromTransferFunctions(p.colorTF, p.opacityTF, clim);
  // ImageField shade tuple = [ka, kd, ks, shininess]; unshaded presets emit flat emission.
  const shade: [number, number, number, number] = p.shade ? [p.light[0], p.light[1], p.light[2], p.light[3]] : [1, 0, 0, 1];
  return { lut, clim, shade };
}
