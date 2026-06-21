import { Widget, type WidgetOptions } from '../../core/Widget.js';
import { injectThemeStylesheet } from '../../core/theme.js';
import css from './LightingPanel.css';

export type LightId = 'key' | 'fill';

export interface Light {
  /** Unit vector pointing FROM surface TO light. */
  direction: [number, number, number];
  intensity: number;
}

export interface LightingPanelState {
  key: Light;
  fill: Light;
  cameraRelative: boolean;
}

export interface LightingPanelEvents {
  change: LightingPanelState;
  [key: string]: unknown;
}

export interface LightingPanelOptions extends WidgetOptions {
  initial?: Partial<LightingPanelState>;
}

let cssInjected = false;
function ensureStylesheet() {
  if (cssInjected) return;
  const style = document.createElement('style');
  style.setAttribute('data-liveinterface-lighting', '');
  style.textContent = css;
  document.head.appendChild(style);
  cssInjected = true;
}

const DEFAULTS: LightingPanelState = {
  key:  { direction: [0.45, -0.55, 0.7], intensity: 1.0 },
  fill: { direction: [-0.5, 0.35, 0.8],  intensity: 0.35 },
  cameraRelative: false,
};

export class LightingPanel
  extends Widget<LightingPanelState, LightingPanelEvents>
{
  #sphere!: HTMLDivElement;
  #handleKey!: HTMLButtonElement;
  #handleFill!: HTMLButtonElement;
  #intensityInputs = new Map<LightId, HTMLInputElement>();
  #intensityValues = new Map<LightId, HTMLSpanElement>();
  #cameraInput!: HTMLInputElement;

  constructor(host: HTMLElement, opts: LightingPanelOptions = {}) {
    const initial: LightingPanelState = {
      key:            normalizeLight(opts.initial?.key  ?? DEFAULTS.key),
      fill:           normalizeLight(opts.initial?.fill ?? DEFAULTS.fill),
      cameraRelative: opts.initial?.cameraRelative ?? DEFAULTS.cameraRelative,
    };
    super(host, initial, { ...opts, className: opts.className ?? 'lw-lighting' });
    injectThemeStylesheet();
    ensureStylesheet();
    this.#buildDom();
    this.#positionHandles();
  }

  protected override render(): void {
    this.#positionHandles();
    this.#syncSliders();
  }

  #buildDom(): void {
    this.host.innerHTML = '';

    this.#sphere = document.createElement('div');
    this.#sphere.className = 'lw-lighting-sphere';
    this.#sphere.setAttribute('role', 'application');
    this.#sphere.setAttribute('aria-label',
      'Lighting direction sphere; drag the warm key light and cool fill light');

    this.#handleKey  = this.#createHandle('key', 'Key light direction');
    this.#handleFill = this.#createHandle('fill', 'Fill light direction');
    this.#sphere.append(this.#handleFill, this.#handleKey);
    this.host.append(this.#sphere);

    const sliders = document.createElement('div');
    sliders.className = 'lw-lighting-sliders';

    sliders.append(this.#buildIntensityRow('key',  'Key'));
    sliders.append(this.#buildIntensityRow('fill', 'Fill'));

    const toggleRow = document.createElement('div');
    toggleRow.className = 'lw-lighting-row toggle';
    const camLabel = document.createElement('label');
    this.#cameraInput = document.createElement('input');
    this.#cameraInput.type = 'checkbox';
    this.#cameraInput.checked = this.state.cameraRelative;
    this.#cameraInput.addEventListener('change', () => {
      this.state = { ...this.state, cameraRelative: this.#cameraInput.checked };
      this.#emitChange();
    });
    camLabel.append(this.#cameraInput, document.createTextNode(' Camera-relative'));
    toggleRow.append(camLabel);
    sliders.append(toggleRow);

    this.host.append(sliders);
  }

  #createHandle(id: LightId, ariaLabel: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `lw-lighting-handle ${id}`;
    btn.dataset.light = id;
    btn.setAttribute('role', 'application');
    btn.setAttribute('aria-label', ariaLabel);
    btn.addEventListener('pointerdown', (e) => this.#onHandlePointerDown(e, id));
    btn.addEventListener('keydown', (e) => this.#onHandleKey(e, id));
    return btn;
  }

  #buildIntensityRow(id: LightId, label: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = `lw-lighting-row ${id}`;
    const lab = document.createElement('label');
    lab.append(document.createTextNode(' ' + label));
    const input = document.createElement('input');
    input.type = 'range'; input.min = '0'; input.max = '2'; input.step = '0.01';
    input.value = String(this.state[id].intensity);
    input.setAttribute('aria-label', `${label} light intensity`);
    const val = document.createElement('span');
    val.className = 'value';
    val.textContent = this.state[id].intensity.toFixed(2);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      this.state = {
        ...this.state,
        [id]: { ...this.state[id], intensity: v },
      };
      val.textContent = v.toFixed(2);
      this.#emitChange();
    });
    row.append(lab, input, val);
    this.#intensityInputs.set(id, input);
    this.#intensityValues.set(id, val);
    return row;
  }

  // -- positioning ---------------------------------------------------------

  #positionHandles(): void {
    this.#positionHandle('key',  this.#handleKey);
    this.#positionHandle('fill', this.#handleFill);
  }

  #positionHandle(id: LightId, btn: HTMLButtonElement): void {
    const [x, y, z] = this.state[id].direction;
    // Sphere is rendered as a 2D disc; map x to left, -y to top (CSS Y axis).
    const leftPct = 50 + x * 50;
    const topPct  = 50 - y * 50;
    btn.style.left = `${leftPct}%`;
    btn.style.top  = `${topPct}%`;
    btn.classList.toggle('behind', z < 0);
  }

  // -- interactions --------------------------------------------------------

  #onHandlePointerDown = (e: PointerEvent, id: LightId): void => {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    btn.focus();
    btn.classList.add('dragging');
    try { btn.setPointerCapture(e.pointerId); } catch {}
    const onMove = (ev: PointerEvent) => {
      const r = this.#sphere.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const halfW = r.width / 2;
      const halfH = r.height / 2;
      const x = (ev.clientX - cx) / halfW;
      const y = -(ev.clientY - cy) / halfH;
      this.#updateLightFrom2D(id, x, y);
    };
    const onUp = (ev: PointerEvent) => {
      btn.classList.remove('dragging');
      btn.removeEventListener('pointermove', onMove);
      btn.removeEventListener('pointerup', onUp);
      btn.removeEventListener('pointercancel', onUp);
      try { btn.releasePointerCapture(ev.pointerId); } catch {}
    };
    btn.addEventListener('pointermove', onMove);
    btn.addEventListener('pointerup', onUp);
    btn.addEventListener('pointercancel', onUp);
  };

  #onHandleKey = (e: KeyboardEvent, id: LightId): void => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const [x, y] = this.state[id].direction;
    let nx = x, ny = y;
    if (e.key === 'ArrowLeft')       nx -= step;
    else if (e.key === 'ArrowRight') nx += step;
    else if (e.key === 'ArrowUp')    ny += step;
    else if (e.key === 'ArrowDown')  ny -= step;
    else return;
    e.preventDefault();
    this.#updateLightFrom2D(id, nx, ny);
  };

  #updateLightFrom2D(id: LightId, x: number, y: number): void {
    // Project (x, y) inside unit disc; z = sqrt(1 - x² - y²) on the front hemisphere.
    // Outside the disc, clamp to the rim and let z = 0.
    const mag = Math.hypot(x, y);
    if (mag > 1) { x /= mag; y /= mag; }
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    const direction: [number, number, number] = [x, y, z];
    this.state = { ...this.state, [id]: { ...this.state[id], direction } };
    this.#positionHandles();
    this.#emitChange();
  }

  #syncSliders(): void {
    for (const id of ['key', 'fill'] as const) {
      const input = this.#intensityInputs.get(id);
      const val = this.#intensityValues.get(id);
      if (!input || !val) continue;
      const v = this.state[id].intensity;
      input.value = String(v);
      val.textContent = v.toFixed(2);
    }
    if (this.#cameraInput) this.#cameraInput.checked = this.state.cameraRelative;
  }

  #emitChange(): void {
    (this as unknown as { emit(e: 'change', d: LightingPanelState): void })
      .emit('change', this.getState() as LightingPanelState);
  }
}

function normalizeLight(l: Light): Light {
  const [x, y, z] = l.direction;
  const n = Math.hypot(x, y, z) || 1;
  return {
    direction: [x / n, y / n, z / n],
    intensity: l.intensity,
  };
}
