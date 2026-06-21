import { Widget, type WidgetOptions } from '../../core/Widget.js';
import { injectThemeStylesheet } from '../../core/theme.js';
import { sampleCombinedAt, type CombinedTFPoint, type TFLayer, compositeLayers } from '../../mrml/VolumeProperty.js';
import css from './PresetPicker.css';

export interface PreviewData {
  /** 2D MIP (or any projection) of the current volume. */
  mip: Float32Array;
  /** Pixel dimensions of `mip`: [width, height]. */
  dims: [number, number];
  /** Value range over which the projection lives (the TF domain). */
  range: [number, number];
}

export interface PresetSpec<TPayload = unknown> {
  id: string;
  name: string;
  description?: string;
  /** Fallback CSS background-image for the swatch strip when no preview is wired. */
  swatch: string;
  /**
   * One or more curves that the preset applies. When the picker has
   * `setPreviewData(...)` set, each card renders a thumbnail by applying
   * these layers to the projection — instead of just showing `swatch`.
   */
  tfLayers?: ReadonlyArray<{
    visible?: boolean;
    controlPoints: ReadonlyArray<CombinedTFPoint>;
  }>;
  /** Free-form data carried with the preset — caller decides shape (control points etc.). */
  payload?: TPayload;
  /** Tags for `setFilter()` to shortlist. e.g. ['CT', 'bone']. */
  tags?: readonly string[];
}

export interface PresetPickerState<TPayload = unknown> {
  presets: ReadonlyArray<PresetSpec<TPayload>>;
  activeId: string | null;
  filter: ReadonlyArray<string>;
  columns: number;
}

export interface PresetPickerEvents<TPayload = unknown> {
  change: { activeId: string; preset: PresetSpec<TPayload> };
  [key: string]: unknown;
}

export interface PresetPickerOptions<TPayload = unknown> extends WidgetOptions {
  presets?: ReadonlyArray<PresetSpec<TPayload>>;
  activeId?: string | null;
  filter?: ReadonlyArray<string>;
  columns?: number;
}

let cssInjected = false;
function ensureStylesheet() {
  if (cssInjected) return;
  const style = document.createElement('style');
  style.setAttribute('data-liveinterface-preset-picker', '');
  style.textContent = css;
  document.head.appendChild(style);
  cssInjected = true;
}

export class PresetPicker<TPayload = unknown>
  extends Widget<PresetPickerState<TPayload>, PresetPickerEvents<TPayload>>
{
  #previewData: PreviewData | null = null;
  #previewBg = '#1a1d22';

  constructor(host: HTMLElement, opts: PresetPickerOptions<TPayload> = {}) {
    const initial: PresetPickerState<TPayload> = {
      presets: opts.presets ?? [],
      activeId: opts.activeId ?? null,
      filter: opts.filter ?? [],
      columns: opts.columns ?? 2,
    };
    super(host, initial, { ...opts, className: opts.className ?? 'lw-preset-picker' });
    injectThemeStylesheet();
    ensureStylesheet();
    this.#updateColumns();
    this.#renderCards();
  }

  setPresets(presets: ReadonlyArray<PresetSpec<TPayload>>): void {
    this.state = { ...this.state, presets };
    this.#renderCards();
  }

  setFilter(filter: ReadonlyArray<string>): void {
    this.state = { ...this.state, filter };
    this.#renderCards();
  }

  setActive(id: string | null): void {
    if (this.state.activeId === id) return;
    this.state = { ...this.state, activeId: id };
    this.#renderCards();
    if (id) {
      const preset = this.state.presets.find((p) => p.id === id);
      if (preset) {
        (this as unknown as { emit(e: 'change', d: { activeId: string; preset: PresetSpec<TPayload> }): void })
          .emit('change', { activeId: id, preset });
      }
    }
  }

  setColumns(columns: number): void {
    this.state = { ...this.state, columns };
    this.#updateColumns();
  }

  /**
   * Hand the picker a 2D projection of the currently-loaded volume. Each
   * preset card that supplies `tfLayers` will replace its static swatch
   * strip with a thumbnail of that projection rendered through its own
   * transfer function — so the user is choosing on actual data, not on a
   * generic gradient.
   */
  setPreviewData(data: PreviewData | null): void {
    this.#previewData = data;
    this.#renderCards();
  }

  getActive(): PresetSpec<TPayload> | null {
    return this.state.activeId
      ? this.state.presets.find((p) => p.id === this.state.activeId) ?? null
      : null;
  }

  protected override render(): void {
    this.#updateColumns();
    this.#renderCards();
  }

  #updateColumns(): void {
    this.host.style.setProperty('--lw-pp-cols', String(this.state.columns));
  }

  /** Paint the projection into the card's thumb canvas, applying the preset's
   *  TF layers via `max` blend across visible layers. The mip is sampled at
   *  the canvas's native pixel resolution (pixelated rendering keeps the
   *  preview crisp at small sizes). */
  #paintThumb(canvas: HTMLCanvasElement, layers: TFLayer[]): void {
    if (!this.#previewData) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { mip, dims } = this.#previewData;
    const [W, H] = dims;
    const img = ctx.createImageData(W, H);
    // Background sRGB for over-composite. Match the card's bg pill.
    const bgR = 0.06, bgG = 0.07, bgB = 0.09;
    for (let i = 0; i < W * H; i++) {
      const v = mip[i];
      let maxOp = -1;
      let bestRgb: [number, number, number] = [0, 0, 0];
      for (const l of layers) {
        if (l.visible === false) continue;
        const s = sampleCombinedAt(l.controlPoints, v);
        if (s.opacity > maxOp) {
          maxOp = s.opacity;
          bestRgb = s.rgb;
        }
      }
      if (maxOp < 0) maxOp = 0;
      const o = i * 4;
      img.data[o + 0] = ((maxOp * bestRgb[0] + (1 - maxOp) * bgR) * 255) | 0;
      img.data[o + 1] = ((maxOp * bestRgb[1] + (1 - maxOp) * bgG) * 255) | 0;
      img.data[o + 2] = ((maxOp * bestRgb[2] + (1 - maxOp) * bgB) * 255) | 0;
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  #renderCards(): void {
    const matches = this.state.presets.filter((p) =>
      this.state.filter.length === 0 ||
      this.state.filter.every((f) => (p.tags ?? []).includes(f)));
    this.host.innerHTML = '';
    for (const p of matches) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lw-pp-card';
      if (p.id === this.state.activeId) btn.classList.add('active');
      btn.dataset.presetId = p.id;
      btn.setAttribute('aria-pressed', String(p.id === this.state.activeId));
      const name = document.createElement('div');
      name.className = 'lw-pp-name';
      name.textContent = p.name;
      let stripEl: HTMLElement;
      if (this.#previewData && p.tfLayers && p.tfLayers.length > 0) {
        const cv = document.createElement('canvas');
        cv.className = 'lw-pp-thumb';
        cv.width = this.#previewData.dims[0];
        cv.height = this.#previewData.dims[1];
        this.#paintThumb(cv, p.tfLayers as TFLayer[]);
        stripEl = cv;
      } else {
        stripEl = document.createElement('div');
        stripEl.className = 'lw-pp-strip';
        stripEl.style.setProperty('--lw-pp-gradient', p.swatch);
      }
      btn.append(name, stripEl);
      if (p.description) {
        const desc = document.createElement('div');
        desc.className = 'lw-pp-desc';
        desc.textContent = p.description;
        btn.append(desc);
      }
      btn.addEventListener('click', () => this.setActive(p.id));
      this.host.append(btn);
    }
  }
}
