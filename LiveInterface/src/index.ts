export { Widget, type WidgetOptions } from './core/Widget.js';
export { EventBus, type EventMap, type Unsubscribe } from './core/EventBus.js';
export { injectThemeStylesheet, themeCss } from './core/theme.js';

export {
  ColorPicker,
  type ColorPickerState,
  type ColorPickerEvents,
  type ColorPickerOptions,
} from './widgets/ColorPicker/ColorPicker.js';
export {
  rgbToHsv, hsvToRgb, rgbToHex, hexToRgba,
  type RGB, type HSV,
} from './widgets/ColorPicker/ColorMath.js';

export {
  Histogram,
  type HistogramState,
  type HistogramEvents,
  type HistogramOptions,
} from './widgets/Histogram/Histogram.js';
export {
  computeBins,
  type BinningResult,
  type ScalarArray,
} from './widgets/Histogram/HistogramBinning.js';

export {
  TransferFunctionEditor,
  type TFEditorState,
  type TFEditorEvents,
  type TFEditorOptions,
} from './widgets/TransferFunctionEditor/TransferFunctionEditor.js';

export {
  CombinedTransferFunctionEditor,
  type CombinedTFEditorState,
  type CombinedTFEditorEvents,
  type CombinedTFEditorOptions,
} from './widgets/CombinedTransferFunctionEditor/CombinedTransferFunctionEditor.js';

export {
  parsePiecewise, serializePiecewise, normalizePiecewise,
  parseColorTransfer, serializeColorTransfer,
  sampleOpacity, sampleColor, unifyTransferFunctions,
  sampleCombinedAt, compositeLayers,
  type PiecewisePoint, type ColorPoint, type CombinedTFPoint,
  type TFLayer, type LayerBlendMode,
} from './mrml/VolumeProperty.js';
export {
  guessModality,
  type Modality, type ModalityGuess,
} from './mrml/Modality.js';

export {
  WindowLevelEditor,
  type WindowLevelEditorState,
  type WindowLevelEditorEvents,
  type WindowLevelEditorOptions,
} from './widgets/WindowLevelEditor/WindowLevelEditor.js';

export {
  PhongShadingPanel,
  type PhongShadingState,
  type PhongShadingEvents,
  type PhongShadingOptions,
} from './widgets/PhongShadingPanel/PhongShadingPanel.js';

export {
  LightingPanel,
  type Light,
  type LightId,
  type LightingPanelState,
  type LightingPanelEvents,
  type LightingPanelOptions,
} from './widgets/LightingPanel/LightingPanel.js';

export {
  PresetPicker,
  type PresetSpec,
  type PresetPickerState,
  type PresetPickerEvents,
  type PresetPickerOptions,
} from './widgets/PresetPicker/PresetPicker.js';

// LiveInterface state-catalog — v0 agent-free snowflake input. See
// src/catalog/README.md for the design.
export * from './catalog/index.js';

export const VERSION = '0.0.1';
