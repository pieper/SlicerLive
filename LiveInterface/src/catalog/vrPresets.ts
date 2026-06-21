import type { CatalogEntry, VrPresetDelta, Source } from './types.js';

// Mined from Slicer source: Modules/Loadable/VolumeRendering/Resources/presets.xml.
// Each preset is a named <VolumeProperty> element in that file; the catalog
// references it by name so the actual transfer-function XML lives once at
// runtime, not duplicated per entry. The LiveInterface renderer resolves
// `presetName` → a vtkMRMLVolumePropertyNode applied to the active volume's
// display node.

const PRESETS_XML_SOURCE: Source = {
  kind: 'slicer-source',
  path: 'Modules/Loadable/VolumeRendering/Resources/presets.xml',
  note: 'Canonical named VolumeProperty presets shipped with Slicer.',
};

const VR_DOCS_SOURCE: Source = {
  kind: 'slicer-docs',
  path: 'Docs/user_guide/modules/volumerendering.md',
  note: 'Volume Rendering module documentation — preset usage and selection.',
};

function P(presetName: string): VrPresetDelta {
  return { kind: 'vr-preset', presetName };
}

export const vrPresetsCatalog: readonly CatalogEntry<VrPresetDelta>[] = [
  // ---- CT — vasculature / AAA --------------------------------------------
  {
    category: 'vr-preset',
    id: 'ct-aaa',
    label: 'CT-AAA',
    description: 'Abdominal aortic aneurysm — emphasizes aorta and adjacent vasculature against a translucent soft-tissue context.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-AAA'),
    source: [PRESETS_XML_SOURCE, VR_DOCS_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-aaa2',
    label: 'CT-AAA2',
    description: 'AAA variant — alternative opacity ramp emphasizing the lumen.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-AAA2'),
    source: [PRESETS_XML_SOURCE],
  },

  // ---- CT — bone ----------------------------------------------------------
  {
    category: 'vr-preset',
    id: 'ct-bone',
    label: 'CT-Bone',
    description: 'Classic skeleton view — bone opaque, soft tissue translucent. The most common starting preset.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Bone'),
    source: [PRESETS_XML_SOURCE, VR_DOCS_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-bones',
    label: 'CT-Bones',
    description: 'Bone preset variant — slightly different opacity transition.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Bones'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-cropped-volume-bone',
    label: 'CT-Cropped-Volume-Bone',
    description: 'Bone preset tuned for cropped sub-volumes (e.g. a single vertebra or extremity).',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Cropped-Volume-Bone'),
    source: [PRESETS_XML_SOURCE],
  },

  // ---- CT — cardiac -------------------------------------------------------
  {
    category: 'vr-preset',
    id: 'ct-cardiac',
    label: 'CT-Cardiac',
    description: 'Cardiac CT — emphasizes heart chambers and myocardium.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Cardiac'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-cardiac2',
    label: 'CT-Cardiac2',
    description: 'Cardiac variant — alternative contrast emphasis.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Cardiac2'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-cardiac3',
    label: 'CT-Cardiac3',
    description: 'Cardiac variant — third tuning of the heart-emphasizing transfer function.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Cardiac3'),
    source: [PRESETS_XML_SOURCE],
  },

  // ---- CT — chest / pulmonary --------------------------------------------
  {
    category: 'vr-preset',
    id: 'ct-chest-contrast-enhanced',
    label: 'CT-Chest-Contrast-Enhanced',
    description: 'Contrast-enhanced chest CT — the default for IV-contrast thoracic studies.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Chest-Contrast-Enhanced'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-chest-vessels',
    label: 'CT-Chest-Vessels',
    description: 'Chest vessels — emphasizes mediastinal and pulmonary vasculature.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Chest-Vessels'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-pulmonary-arteries',
    label: 'CT-Pulmonary-Arteries',
    description: 'Pulmonary artery emphasis — useful for PE workups.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Pulmonary-Arteries'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-lung',
    label: 'CT-Lung',
    description: 'Lung parenchyma view — air-filled regions visible, soft tissue suppressed.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Lung'),
    source: [PRESETS_XML_SOURCE],
  },

  // ---- CT — coronary ------------------------------------------------------
  {
    category: 'vr-preset',
    id: 'ct-coronary-arteries',
    label: 'CT-Coronary-Arteries',
    description: 'Coronary arteries against myocardium and bone.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Coronary-Arteries'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-coronary-arteries-2',
    label: 'CT-Coronary-Arteries-2',
    description: 'Coronary variant — alternative contrast tuning.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Coronary-Arteries-2'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-coronary-arteries-3',
    label: 'CT-Coronary-Arteries-3',
    description: 'Coronary variant — third tuning of the artery-emphasizing transfer function.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Coronary-Arteries-3'),
    source: [PRESETS_XML_SOURCE],
  },

  // ---- CT — abdominal / soft tissue --------------------------------------
  {
    category: 'vr-preset',
    id: 'ct-liver-vasculature',
    label: 'CT-Liver-Vasculature',
    description: 'Liver vessels — emphasizes portal and hepatic venous systems.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Liver-Vasculature'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-soft-tissue',
    label: 'CT-Soft-Tissue',
    description: 'General soft-tissue emphasis — broad opacity across organ densities.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Soft-Tissue'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-muscle',
    label: 'CT-Muscle',
    description: 'Muscle emphasis — useful for musculoskeletal review.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Muscle'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-fat',
    label: 'CT-Fat',
    description: 'Fat emphasis — adipose tissue rendered prominent.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Fat'),
    source: [PRESETS_XML_SOURCE],
  },

  // ---- CT — special-purpose ----------------------------------------------
  {
    category: 'vr-preset',
    id: 'ct-air',
    label: 'CT-Air',
    description: 'Air-emphasis preset — useful for airway tree visualization.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-Air'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-mip',
    label: 'CT-MIP',
    description: 'Maximum intensity projection — flattens depth, useful for vessel/bone surveys.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-MIP'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'ct-x-ray',
    label: 'CT-X-ray',
    description: 'Simulates a conventional planar X-ray appearance from the CT volume.',
    appliesWhen: { modality: 'CT' },
    delta: P('CT-X-ray'),
    source: [PRESETS_XML_SOURCE],
  },

  // ---- MR -----------------------------------------------------------------
  {
    category: 'vr-preset',
    id: 'mr-default',
    label: 'MR-Default',
    description: 'Generic MR transfer function — broad gray-scale ramp.',
    appliesWhen: { modality: 'MR' },
    delta: P('MR-Default'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'mr-angio',
    label: 'MR-Angio',
    description: 'MR angiography — emphasizes contrast-enhanced vasculature.',
    appliesWhen: { modality: 'MR' },
    delta: P('MR-Angio'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'mr-mip',
    label: 'MR-MIP',
    description: 'MR maximum intensity projection.',
    appliesWhen: { modality: 'MR' },
    delta: P('MR-MIP'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'mr-t2-brain',
    label: 'MR-T2-Brain',
    description: 'T2-weighted brain MR — tuned for white/gray matter contrast and CSF visibility.',
    appliesWhen: { modality: 'MR' },
    delta: P('MR-T2-Brain'),
    source: [PRESETS_XML_SOURCE],
  },

  // ---- DTI / US -----------------------------------------------------------
  {
    category: 'vr-preset',
    id: 'dti-fa-brain',
    label: 'DTI-FA-Brain',
    description: 'Diffusion tensor fractional anisotropy — white-matter tract emphasis on a scalar FA volume.',
    appliesWhen: { modality: 'DTI' },
    delta: P('DTI-FA-Brain'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'us-fetal',
    label: 'US-Fetal',
    description: 'Fetal ultrasound — soft-tissue emphasis tuned for prenatal volumes.',
    appliesWhen: { modality: 'US' },
    delta: P('US-Fetal'),
    source: [PRESETS_XML_SOURCE],
  },

  // ---- Micro-CT -----------------------------------------------------------
  {
    category: 'vr-preset',
    id: 'uct-bone-8bit',
    label: 'µCT-Bone (8-bit)',
    description: 'Micro-CT bone preset for 8-bit scalar volumes (e.g. small-animal imaging).',
    appliesWhen: { modality: 'uCT' },
    delta: P('uCT-Bone-8bit'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'uct-bone-16bit',
    label: 'µCT-Bone (16-bit)',
    description: 'Micro-CT bone preset for 16-bit scalar volumes.',
    appliesWhen: { modality: 'uCT' },
    delta: P('uCT-Bone-16bit'),
    source: [PRESETS_XML_SOURCE],
  },
  {
    category: 'vr-preset',
    id: 'uct-skull',
    label: 'µCT-Skull',
    description: 'Micro-CT skull-emphasis preset.',
    appliesWhen: { modality: 'uCT' },
    delta: P('uCT-Skull'),
    source: [PRESETS_XML_SOURCE],
  },
];
