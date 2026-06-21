import { Widget, type WidgetOptions } from '../../core/Widget.js';
import { injectThemeStylesheet } from '../../core/theme.js';
import css from './PhongShadingPanel.css';

export interface PhongShadingState {
  ambient: number;
  diffuse: number;
  specular: number;
  shininess: number;
  /** Surface color used by the preview sphere. RGB in [0, 1]^3. */
  materialColor: [number, number, number];
}

export interface PhongShadingEvents {
  change: PhongShadingState;
  [key: string]: unknown;
}

export interface PhongShadingOptions extends WidgetOptions {
  initial?: Partial<PhongShadingState>;
  showPreview?: boolean;
  previewSize?: number;
}

let cssInjected = false;
function ensureStylesheet() {
  if (cssInjected) return;
  const style = document.createElement('style');
  style.setAttribute('data-liveinterface-phong', '');
  style.textContent = css;
  document.head.appendChild(style);
  cssInjected = true;
}

const DEFAULTS: PhongShadingState = {
  ambient: 0.4,
  diffuse: 0.7,
  specular: 0.2,
  shininess: 10,
  materialColor: [0.95, 0.78, 0.65],
};

const SLIDERS: Array<{
  key: keyof Omit<PhongShadingState, 'materialColor'>;
  label: string; min: number; max: number; step: number;
  fmt: (v: number) => string;
}> = [
  { key: 'ambient',   label: 'Ambient',   min: 0, max: 1,  step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'diffuse',   label: 'Diffuse',   min: 0, max: 1,  step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'specular',  label: 'Specular',  min: 0, max: 1,  step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'shininess', label: 'Shininess', min: 1, max: 128, step: 1,   fmt: (v) => v.toFixed(0) },
];

export class PhongShadingPanel
  extends Widget<PhongShadingState, PhongShadingEvents>
{
  #canvas: HTMLCanvasElement | null = null;
  #ctx: CanvasRenderingContext2D | null = null;
  #sliderInputs = new Map<keyof PhongShadingState, HTMLInputElement>();
  #valueLabels = new Map<keyof PhongShadingState, HTMLSpanElement>();
  #showPreview: boolean;
  #previewSize: number;

  constructor(host: HTMLElement, opts: PhongShadingOptions = {}) {
    const initial: PhongShadingState = {
      ambient:       opts.initial?.ambient       ?? DEFAULTS.ambient,
      diffuse:       opts.initial?.diffuse       ?? DEFAULTS.diffuse,
      specular:      opts.initial?.specular      ?? DEFAULTS.specular,
      shininess:     opts.initial?.shininess     ?? DEFAULTS.shininess,
      materialColor: opts.initial?.materialColor ?? DEFAULTS.materialColor,
    };
    super(host, initial, { ...opts, className: opts.className ?? 'lw-phong' });
    this.#showPreview = opts.showPreview ?? true;
    this.#previewSize = opts.previewSize ?? 64;
    injectThemeStylesheet();
    ensureStylesheet();
    this.#buildDom();
    this.#renderPreview();
  }

  setMaterialColor(rgb: [number, number, number]): void {
    this.state = { ...this.state, materialColor: rgb };
    this.#renderPreview();
  }

  protected override render(): void {
    this.#syncSliders();
    this.#renderPreview();
  }

  #buildDom(): void {
    this.host.innerHTML = '';
    if (this.#showPreview) {
      this.#canvas = document.createElement('canvas');
      this.#canvas.className = 'lw-phong-preview';
      this.#canvas.width = this.#previewSize;
      this.#canvas.height = this.#previewSize;
      this.host.append(this.#canvas);
      this.#ctx = this.#canvas.getContext('2d');
    }
    const sliders = document.createElement('div');
    sliders.className = 'lw-phong-sliders';
    for (const s of SLIDERS) {
      const row = document.createElement('div');
      row.className = 'lw-phong-row';
      const label = document.createElement('label');
      label.textContent = s.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(s.min); input.max = String(s.max); input.step = String(s.step);
      input.value = String(this.state[s.key]);
      input.setAttribute('aria-label', s.label);
      const val = document.createElement('span');
      val.className = 'value';
      val.textContent = s.fmt(this.state[s.key]);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        this.state = { ...this.state, [s.key]: v } as PhongShadingState;
        val.textContent = s.fmt(v);
        this.#renderPreview();
        this.#emitChange();
      });
      row.append(label, input, val);
      sliders.append(row);
      this.#sliderInputs.set(s.key, input);
      this.#valueLabels.set(s.key, val);
    }
    this.host.append(sliders);
  }

  #syncSliders(): void {
    for (const s of SLIDERS) {
      const input = this.#sliderInputs.get(s.key);
      const val = this.#valueLabels.get(s.key);
      if (!input || !val) continue;
      const v = this.state[s.key] as number;
      input.value = String(v);
      val.textContent = s.fmt(v);
    }
  }

  // Phong-shaded sphere preview, drawn into a Canvas2D ImageData buffer.
  // Light direction is fixed (upper-left), view direction is camera-forward.
  // Material color is modulated by ambient + diffuse(N·L) + specular(R·V)^n.
  #renderPreview(): void {
    if (!this.#ctx || !this.#canvas) return;
    const ctx = this.#ctx;
    const W = this.#canvas.width;
    const H = this.#canvas.height;
    const img = ctx.createImageData(W, H);
    const cx = W * 0.5, cy = H * 0.5;
    const r = Math.min(W, H) * 0.5 - 1.5;
    const r2 = r * r;
    // Normalised light (upper-left, toward viewer)
    const lx = -0.55, ly = -0.55, lz = 0.65;
    const ln = Math.hypot(lx, ly, lz);
    const Lx = lx / ln, Ly = ly / ln, Lz = lz / ln;
    const [mr, mg, mb] = this.state.materialColor;
    const { ambient, diffuse, specular, shininess } = this.state;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        const o = (y * W + x) * 4;
        if (d2 > r2) {
          img.data[o + 3] = 0;
          continue;
        }
        const nx = dx / r;
        const ny = dy / r;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        // N·L (light), N·V = nz (view vector is +z)
        const ndl = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
        // Half-vector specular: H = normalize(L + V) where V = (0,0,1)
        const hx = Lx, hy = Ly, hz = Lz + 1;
        const hn = Math.hypot(hx, hy, hz);
        const ndh = Math.max(0, (nx * hx + ny * hy + nz * hz) / hn);
        const spec = Math.pow(ndh, shininess) * specular;
        const r8 = clamp01(ambient * mr + diffuse * ndl * mr + spec);
        const g8 = clamp01(ambient * mg + diffuse * ndl * mg + spec);
        const b8 = clamp01(ambient * mb + diffuse * ndl * mb + spec);
        img.data[o + 0] = (r8 * 255) | 0;
        img.data[o + 1] = (g8 * 255) | 0;
        img.data[o + 2] = (b8 * 255) | 0;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  #emitChange(): void {
    (this as unknown as { emit(e: 'change', d: PhongShadingState): void })
      .emit('change', this.getState() as PhongShadingState);
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
