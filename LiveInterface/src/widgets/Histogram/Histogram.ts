import { Widget, type WidgetOptions } from '../../core/Widget.js';
import { injectThemeStylesheet } from '../../core/theme.js';
import { computeBins, type ScalarArray } from './HistogramBinning.js';
import css from './Histogram.css';

export interface HistogramState {
  bins: Uint32Array | null;
  range: [number, number];
  maxBin: number;
  logScale: boolean;
  color: [number, number, number];
  binCount: number;
}

export interface HistogramEvents {
  rangechange: { range: [number, number] };
  [key: string]: unknown;
}

export interface HistogramOptions extends WidgetOptions {
  binCount?: number;
  logScale?: boolean;
  color?: [number, number, number];
  showAxis?: boolean;
  width?: number;
  height?: number;
  background?: string;
}

let cssInjected = false;
function ensureStylesheet() {
  if (cssInjected) return;
  const style = document.createElement('style');
  style.setAttribute('data-liveinterface-histogram', '');
  style.textContent = css;
  document.head.appendChild(style);
  cssInjected = true;
}

const DEVICE_PIXEL_LIMIT = 4;

export class Histogram extends Widget<HistogramState, HistogramEvents> {
  #canvas!: HTMLCanvasElement;
  #ctx!: CanvasRenderingContext2D;
  #axisLeft!: HTMLSpanElement;
  #axisRight!: HTMLSpanElement;
  #showAxis: boolean;
  #background: string;

  constructor(host: HTMLElement, opts: HistogramOptions = {}) {
    const initial: HistogramState = {
      bins: null,
      range: [0, 1],
      maxBin: 0,
      logScale: opts.logScale ?? false,
      color: opts.color ?? [0.36, 0.66, 0.90],
      binCount: opts.binCount ?? 256,
    };
    super(host, initial, { ...opts, className: opts.className ?? 'lw-histogram' });
    this.#showAxis = opts.showAxis ?? true;
    this.#background = opts.background ?? 'rgba(0,0,0,0)';
    injectThemeStylesheet();
    ensureStylesheet();
    this.#buildDom(opts.width ?? 320, opts.height ?? 120);
    this.#syncCanvasSize();
    this.render();
  }

  #buildDom(w: number, h: number): void {
    this.host.innerHTML = '';
    this.host.style.width = `${w}px`;
    this.host.style.height = `${h}px`;
    this.#canvas = document.createElement('canvas');
    this.host.append(this.#canvas);
    const ctx = this.#canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.#ctx = ctx;
    if (this.#showAxis) {
      const axis = document.createElement('div');
      axis.className = 'lw-hg-axis';
      this.#axisLeft = document.createElement('span');
      this.#axisRight = document.createElement('span');
      axis.append(this.#axisLeft, this.#axisRight);
      this.host.append(axis);
    } else {
      this.#axisLeft = document.createElement('span');
      this.#axisRight = document.createElement('span');
    }
  }

  #syncCanvasSize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, DEVICE_PIXEL_LIMIT);
    const r = this.#canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(r.width));
    const cssH = Math.max(1, Math.round(r.height));
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.#canvas.width !== w) this.#canvas.width = w;
    if (this.#canvas.height !== h) this.#canvas.height = h;
    this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setData(
    data: ScalarArray,
    opts: { min?: number; max?: number; bins?: number } = {},
  ): void {
    const binCount = opts.bins ?? this.state.binCount;
    const result = computeBins(data, { ...opts, bins: binCount });
    this.state = {
      ...this.state,
      bins: result.bins,
      range: result.range,
      maxBin: result.maxBin,
      binCount,
    };
    this.#updateAxis();
    this.render();
    (this as unknown as { emit(name: 'rangechange', data: { range: [number, number] }): void })
      .emit('rangechange', { range: result.range });
  }

  setLogScale(logScale: boolean): void {
    if (this.state.logScale === logScale) return;
    this.state = { ...this.state, logScale };
    this.render();
  }

  setColor(color: [number, number, number]): void {
    this.state = { ...this.state, color };
    this.render();
  }

  protected override render(): void {
    if (!this.#ctx) return;
    this.#syncCanvasSize();
    const ctx = this.#ctx;
    const r = this.#canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));

    // Background
    if (this.#background !== 'rgba(0,0,0,0)') {
      ctx.fillStyle = this.#background;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.clearRect(0, 0, w, h);
    }

    const bins = this.state.bins;
    if (!bins) return;
    const maxBin = Math.max(this.state.maxBin, 1);
    const n = this.state.binCount;
    const log = this.state.logScale;
    const logDen = 1 / Math.log(maxBin + 1 || 2);
    const [cr, cg, cb] = this.state.color;
    ctx.fillStyle = `rgb(${(cr * 255) | 0}, ${(cg * 255) | 0}, ${(cb * 255) | 0})`;

    // Bar width — sub-pixel widths are fine; the browser anti-aliases.
    const barW = w / n;
    for (let i = 0; i < n; i++) {
      const v = bins[i] ?? 0;
      if (v === 0) continue;
      const norm = log
        ? Math.log(v + 1) * logDen
        : v / maxBin;
      const barH = norm * h;
      ctx.fillRect(i * barW, h - barH, Math.max(1, barW), barH);
    }
  }

  #updateAxis(): void {
    if (!this.#showAxis) return;
    const fmt = (n: number) =>
      Math.abs(n) >= 1000 || (Math.abs(n) > 0 && Math.abs(n) < 0.01)
        ? n.toExponential(1)
        : n.toFixed(Math.abs(n) >= 100 ? 0 : 2);
    this.#axisLeft.textContent = fmt(this.state.range[0]);
    this.#axisRight.textContent = fmt(this.state.range[1]);
  }
}
