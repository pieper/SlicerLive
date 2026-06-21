import { Widget, type WidgetOptions } from '../../core/Widget.js';
import { injectThemeStylesheet } from '../../core/theme.js';
import {
  rgbToHsv, hsvToRgb, rgbToHex, hexToRgba,
  type RGB,
} from './ColorMath.js';
import css from './ColorPicker.css';

export interface ColorPickerState {
  rgb: RGB;
  alpha: number;
}

export interface ColorPickerEvents {
  change: ColorPickerState;
  [key: string]: unknown;
}

export interface ColorPickerOptions extends WidgetOptions {
  showAlpha?: boolean;
  initial?: Partial<ColorPickerState>;
}

let cssInjected = false;
function ensureStylesheet() {
  if (cssInjected) return;
  const style = document.createElement('style');
  style.setAttribute('data-liveinterface-colorpicker', '');
  style.textContent = css;
  document.head.appendChild(style);
  cssInjected = true;
}

const DEVICE_PIXEL_LIMIT = 4;

export class ColorPicker extends Widget<ColorPickerState, ColorPickerEvents> {
  #showAlpha: boolean;
  // Internal HSV mirror so a drag that pulls saturation or value to 0 doesn't lose hue.
  #hsv: [number, number, number];

  #hsvCanvas!: HTMLCanvasElement;
  #hueCanvas!: HTMLCanvasElement;
  #alphaCanvas: HTMLCanvasElement | null = null;
  #hsvCtx!: CanvasRenderingContext2D;
  #hueCtx!: CanvasRenderingContext2D;
  #alphaCtx: CanvasRenderingContext2D | null = null;
  #hsvHandle!: HTMLDivElement;
  #hueHandle!: HTMLDivElement;
  #alphaHandle: HTMLDivElement | null = null;
  #swatch!: HTMLDivElement;
  #hexInput!: HTMLInputElement;

  constructor(host: HTMLElement, opts: ColorPickerOptions = {}) {
    const initial: ColorPickerState = {
      rgb: opts.initial?.rgb ?? [1, 0, 0],
      alpha: opts.initial?.alpha ?? 1,
    };
    super(host, initial, { ...opts, className: opts.className ?? 'lw-color-picker' });
    this.#showAlpha = opts.showAlpha ?? true;
    this.#hsv = rgbToHsv(initial.rgb) as [number, number, number];
    injectThemeStylesheet();
    ensureStylesheet();
    this.#buildDom();
    this.#renderHueStrip();
    this.render();
  }

  #buildDom(): void {
    this.host.innerHTML = '';

    const top = el('div', 'lw-cp-top');
    const hsv = el('div', 'lw-cp-hsv');
    const hue = el('div', 'lw-cp-hue');
    this.#hsvCanvas = canvasIn(hsv);
    this.#hueCanvas = canvasIn(hue);
    this.#hsvCtx = ctx2d(this.#hsvCanvas);
    this.#hueCtx = ctx2d(this.#hueCanvas);
    this.#hsvHandle = handle('lw-cp-handle', hsv);
    this.#hueHandle = handle('lw-cp-bar-handle', hue);
    hsv.setAttribute('role', 'application');
    hsv.setAttribute('aria-label', 'Saturation and value');
    hsv.tabIndex = 0;
    hue.setAttribute('role', 'slider');
    hue.setAttribute('aria-label', 'Hue');
    hue.setAttribute('aria-valuemin', '0');
    hue.setAttribute('aria-valuemax', '360');
    hue.tabIndex = 0;
    top.append(hsv, hue);

    const bottom = el('div', 'lw-cp-bottom');
    this.#swatch = el('div', 'lw-cp-swatch') as HTMLDivElement;
    this.#hexInput = document.createElement('input');
    this.#hexInput.type = 'text';
    this.#hexInput.className = 'lw-cp-hex';
    this.#hexInput.spellcheck = false;
    this.#hexInput.setAttribute('aria-label', 'Hex color');
    bottom.append(this.#swatch, this.#hexInput);

    this.host.append(top);
    if (this.#showAlpha) {
      const alpha = el('div', 'lw-cp-alpha');
      this.#alphaCanvas = canvasIn(alpha);
      this.#alphaCtx = ctx2d(this.#alphaCanvas);
      this.#alphaHandle = handle('lw-cp-bar-handle', alpha);
      alpha.setAttribute('role', 'slider');
      alpha.setAttribute('aria-label', 'Alpha');
      alpha.setAttribute('aria-valuemin', '0');
      alpha.setAttribute('aria-valuemax', '100');
      alpha.tabIndex = 0;
      this.host.append(alpha);
      this.#wireAlpha(alpha);
    }
    this.host.append(bottom);

    this.#wireHsv(hsv);
    this.#wireHue(hue);
    this.#wireHex();
  }

  /** Update color (and optionally alpha) programmatically. Keeps the internal
   *  HSV mirror in sync — important when callers reuse one picker across
   *  multiple targets (e.g. a popup that re-targets per handle click). */
  setColor(rgb: RGB, alpha?: number): void {
    this.#hsv = rgbToHsv(rgb) as [number, number, number];
    this.state = {
      ...this.state,
      rgb,
      ...(alpha !== undefined ? { alpha } : {}),
    };
    this.render();
  }

  protected override render(): void {
    this.#renderHsvPlane();
    this.#renderAlphaBar();
    this.#updateHandles();
    this.#updateSwatchAndHex();
  }

  // Canvas2D rendering ------------------------------------------------------

  #syncCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): {
    w: number; h: number;
  } {
    const dpr = Math.min(window.devicePixelRatio || 1, DEVICE_PIXEL_LIMIT);
    const r = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(r.width));
    const cssH = Math.max(1, Math.round(r.height));
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: cssW, h: cssH };
  }

  // Two-gradient HSV square: hue-tinted background, white→transparent overlay
  // for saturation, then transparent→black overlay for value. The standard
  // CSS color-picker trick — fast at any size.
  #renderHsvPlane(): void {
    const ctx = this.#hsvCtx;
    const { w, h } = this.#syncCanvas(this.#hsvCanvas, ctx);
    const hueColor = rgbAsCssString(hsvToRgb([this.#hsv[0], 1, 1]));
    ctx.fillStyle = hueColor;
    ctx.fillRect(0, 0, w, h);

    const horiz = ctx.createLinearGradient(0, 0, w, 0);
    horiz.addColorStop(0, 'rgba(255,255,255,1)');
    horiz.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = horiz;
    ctx.fillRect(0, 0, w, h);

    const vert = ctx.createLinearGradient(0, 0, 0, h);
    vert.addColorStop(0, 'rgba(0,0,0,0)');
    vert.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = vert;
    ctx.fillRect(0, 0, w, h);
  }

  // Hue strip — vertical rainbow gradient with stops at the six pure hues.
  #renderHueStrip(): void {
    const ctx = this.#hueCtx;
    const { w, h } = this.#syncCanvas(this.#hueCanvas, ctx);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0,       'rgb(255, 0,   0)');
    g.addColorStop(1 / 6,   'rgb(255, 0, 255)');
    g.addColorStop(2 / 6,   'rgb(  0, 0, 255)');
    g.addColorStop(3 / 6,   'rgb(  0,255, 255)');
    g.addColorStop(4 / 6,   'rgb(  0,255,   0)');
    g.addColorStop(5 / 6,   'rgb(255,255,   0)');
    g.addColorStop(1,       'rgb(255, 0,   0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // Alpha bar — small checker pattern then a transparent→opaque overlay of
  // the current RGB. Checker is drawn manually with two fillRect colors.
  #renderAlphaBar(): void {
    const ctx = this.#alphaCtx;
    if (!ctx || !this.#alphaCanvas) return;
    const { w, h } = this.#syncCanvas(this.#alphaCanvas, ctx);
    const cell = 6;
    for (let y = 0; y < h; y += cell) {
      for (let x = 0; x < w; x += cell) {
        const dark = (((x / cell) | 0) + ((y / cell) | 0)) % 2 === 0;
        ctx.fillStyle = dark ? '#aaa' : '#ddd';
        ctx.fillRect(x, y, cell, cell);
      }
    }
    const [r, gC, b] = this.state.rgb;
    const css = `rgb(${(r * 255) | 0}, ${(gC * 255) | 0}, ${(b * 255) | 0})`;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, css.replace('rgb', 'rgba').replace(')', ', 0)'));
    grad.addColorStop(1, css);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  #updateHandles(): void {
    const [, s, v] = this.#hsv;
    this.#hsvHandle.style.left = `${s * 100}%`;
    this.#hsvHandle.style.top = `${(1 - v) * 100}%`;
    this.#hueHandle.style.top = `${(1 - this.#hsv[0]) * 100}%`;
    if (this.#alphaHandle) {
      this.#alphaHandle.style.left = `${this.state.alpha * 100}%`;
    }
  }

  #updateSwatchAndHex(): void {
    this.#swatch.style.setProperty(
      '--lw-cp-swatch-color',
      `rgba(${Math.round(this.state.rgb[0] * 255)}, ${Math.round(this.state.rgb[1] * 255)}, ${Math.round(this.state.rgb[2] * 255)}, ${this.state.alpha})`,
    );
    if (document.activeElement !== this.#hexInput) {
      this.#hexInput.value = this.#showAlpha
        ? rgbToHex(this.state.rgb, this.state.alpha)
        : rgbToHex(this.state.rgb);
    }
  }

  // Interaction wiring -----------------------------------------------------

  #wireHsv(host: HTMLElement): void {
    pointerDrag(host, (px, py) => {
      const s = clamp01(px);
      const v = clamp01(1 - py);
      this.#hsv = [this.#hsv[0], s, v];
      this.#commitFromHsv();
    });
    host.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.01;
      let [, s, v] = this.#hsv;
      if (e.key === 'ArrowLeft')  s = clamp01(s - step);
      else if (e.key === 'ArrowRight') s = clamp01(s + step);
      else if (e.key === 'ArrowUp')    v = clamp01(v + step);
      else if (e.key === 'ArrowDown')  v = clamp01(v - step);
      else return;
      e.preventDefault();
      this.#hsv = [this.#hsv[0], s, v];
      this.#commitFromHsv();
    });
  }

  #wireHue(host: HTMLElement): void {
    pointerDrag(host, (_px, py) => {
      const h = clamp01(1 - py);
      this.#hsv = [h, this.#hsv[1], this.#hsv[2]];
      this.#commitFromHsv();
    });
    host.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 1 / 12 : 1 / 360;
      let h = this.#hsv[0];
      if (e.key === 'ArrowUp')        h = clamp01(h + step);
      else if (e.key === 'ArrowDown') h = clamp01(h - step);
      else return;
      e.preventDefault();
      this.#hsv = [h, this.#hsv[1], this.#hsv[2]];
      this.#commitFromHsv();
    });
  }

  #wireAlpha(host: HTMLElement): void {
    pointerDrag(host, (px) => {
      this.state = { ...this.state, alpha: clamp01(px) };
      this.render();
      this.#emitChange();
    });
    host.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.01;
      let a = this.state.alpha;
      if (e.key === 'ArrowRight')     a = clamp01(a + step);
      else if (e.key === 'ArrowLeft') a = clamp01(a - step);
      else return;
      e.preventDefault();
      this.state = { ...this.state, alpha: a };
      this.render();
      this.#emitChange();
    });
  }

  #wireHex(): void {
    const commit = () => {
      const parsed = hexToRgba(this.#hexInput.value);
      if (!parsed) {
        this.#updateSwatchAndHex();
        return;
      }
      this.#hsv = rgbToHsv(parsed.rgb) as [number, number, number];
      this.state = {
        rgb: parsed.rgb,
        alpha: this.#showAlpha ? parsed.alpha : this.state.alpha,
      };
      this.#renderHsvPlane();   // hue changed → repaint plane
      this.#renderAlphaBar();
      this.#updateHandles();
      this.#updateSwatchAndHex();
      this.#emitChange();
    };
    this.#hexInput.addEventListener('change', commit);
    this.#hexInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
        this.#hexInput.blur();
      }
    });
  }

  #commitFromHsv(): void {
    const rgb = hsvToRgb(this.#hsv) as RGB;
    this.state = { ...this.state, rgb };
    this.#renderHsvPlane();
    this.#renderAlphaBar();
    this.#updateHandles();
    this.#updateSwatchAndHex();
    this.#emitChange();
  }

  #emitChange(): void {
    (this as unknown as { emit(name: 'change', data: ColorPickerState): void })
      .emit('change', { rgb: this.state.rgb, alpha: this.state.alpha });
  }
}

// Helpers ----------------------------------------------------------------

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function canvasIn(parent: HTMLElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  parent.append(c);
  return c;
}

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return ctx;
}

function handle(cls: string, parent: HTMLElement): HTMLDivElement {
  const d = el('div', cls) as HTMLDivElement;
  parent.append(d);
  return d;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function rgbAsCssString(rgb: RGB): string {
  return `rgb(${(rgb[0] * 255) | 0}, ${(rgb[1] * 255) | 0}, ${(rgb[2] * 255) | 0})`;
}

function pointerDrag(
  host: HTMLElement,
  onMove: (px: number, py: number) => void,
): void {
  let dragging = false;
  const compute = (e: PointerEvent) => {
    const r = host.getBoundingClientRect();
    const px = clamp01((e.clientX - r.left) / r.width);
    const py = clamp01((e.clientY - r.top) / r.height);
    onMove(px, py);
  };
  host.addEventListener('pointerdown', (e) => {
    dragging = true;
    host.setPointerCapture(e.pointerId);
    host.focus({ preventScroll: true });
    compute(e);
    e.preventDefault();
  });
  host.addEventListener('pointermove', (e) => {
    if (dragging) compute(e);
  });
  const stop = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try { host.releasePointerCapture(e.pointerId); } catch {}
  };
  host.addEventListener('pointerup', stop);
  host.addEventListener('pointercancel', stop);
}
