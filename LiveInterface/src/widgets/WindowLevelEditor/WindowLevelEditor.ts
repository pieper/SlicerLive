import { Widget, type WidgetOptions } from '../../core/Widget.js';
import { injectThemeStylesheet } from '../../core/theme.js';
import { Histogram } from '../Histogram/Histogram.js';
import type { ScalarArray } from '../Histogram/HistogramBinning.js';
import css from './WindowLevelEditor.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface WindowLevelEditorState {
  range: [number, number];      // data domain
  value: [number, number];      // current selection within range
  logScale: boolean;
}

export interface WindowLevelEditorEvents {
  change: { value: [number, number]; level: number; width: number };
  [key: string]: unknown;
}

export interface WindowLevelEditorOptions extends WidgetOptions {
  range?: [number, number];
  value?: [number, number];
  logScale?: boolean;
  width?: number;
  height?: number;
  binCount?: number;
  histogramColor?: [number, number, number];
}

let cssInjected = false;
function ensureStylesheet() {
  if (cssInjected) return;
  const style = document.createElement('style');
  style.setAttribute('data-liveinterface-wl', '');
  style.textContent = css;
  document.head.appendChild(style);
  cssInjected = true;
}

export class WindowLevelEditor
  extends Widget<WindowLevelEditorState, WindowLevelEditorEvents>
{
  #hg!: Histogram;
  #hgHost!: HTMLDivElement;
  #svg!: SVGSVGElement;
  #overlay!: SVGRectElement;
  #edgeLow!: SVGLineElement;
  #edgeHigh!: SVGLineElement;
  #handlesLayer!: HTMLDivElement;
  #handleLow!: HTMLButtonElement;
  #handleHigh!: HTMLButtonElement;
  #readout!: HTMLDivElement;
  #binCount: number;
  #dragging: 'low' | 'high' | null = null;

  constructor(host: HTMLElement, opts: WindowLevelEditorOptions = {}) {
    const range = opts.range ?? [0, 1];
    const value: [number, number] = opts.value ?? [range[0], range[1]];
    super(
      host,
      { range, value, logScale: opts.logScale ?? false },
      { ...opts, className: opts.className ?? 'lw-wl-editor' },
    );
    this.#binCount = opts.binCount ?? 256;
    injectThemeStylesheet();
    ensureStylesheet();
    this.#buildDom(opts.width ?? 460, opts.height ?? 90, opts.histogramColor);
    this.#updateGraphics();
  }

  setData(
    data: ScalarArray,
    opts: { min?: number; max?: number; bins?: number } = {},
  ): void {
    const bins = opts.bins ?? this.#binCount;
    this.#hg.setData(data, { ...opts, bins });
    const range = this.#hg.getState().range;
    const value = clampToRange(this.state.value, range);
    this.state = { ...this.state, range, value };
    this.#updateGraphics();
  }

  setValue(value: [number, number]): void {
    this.state = { ...this.state, value: clampToRange(value, this.state.range) };
    this.#updateGraphics();
    this.#emitChange();
  }

  setRange(min: number, max: number): void {
    const range: [number, number] = [min, max];
    const value = clampToRange(this.state.value, range);
    this.state = { ...this.state, range, value };
    this.#updateGraphics();
  }

  setLogScale(on: boolean): void {
    if (this.state.logScale === on) return;
    this.state = { ...this.state, logScale: on };
    this.#hg.setLogScale(on);
  }

  /** Convenience accessors for level/width semantics. */
  get level(): number { return (this.state.value[0] + this.state.value[1]) * 0.5; }
  get width(): number { return this.state.value[1] - this.state.value[0]; }

  protected override render(): void { this.#updateGraphics(); }

  // -- DOM -----------------------------------------------------------------

  #buildDom(w: number, h: number, hgColor?: [number, number, number]): void {
    this.host.innerHTML = '';
    this.host.style.width = `${w}px`;
    this.host.style.height = `${h}px`;

    this.#hgHost = document.createElement('div');
    this.#hgHost.className = 'lw-wl-hg';
    this.host.append(this.#hgHost);
    this.#hg = new Histogram(this.#hgHost, {
      width: w, height: h,
      color: hgColor ?? [0.36, 0.66, 0.90],
      showAxis: true,
      binCount: this.#binCount,
    });

    this.#svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.#svg.classList.add('lw-wl-svg');
    this.#svg.setAttribute('viewBox', '0 0 100 100');
    this.#svg.setAttribute('preserveAspectRatio', 'none');
    this.#overlay = document.createElementNS(SVG_NS, 'rect') as SVGRectElement;
    this.#overlay.classList.add('lw-wl-overlay');
    this.#edgeLow = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
    this.#edgeLow.classList.add('lw-wl-edge');
    this.#edgeHigh = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
    this.#edgeHigh.classList.add('lw-wl-edge');
    this.#svg.append(this.#overlay, this.#edgeLow, this.#edgeHigh);
    this.host.append(this.#svg);

    this.#handlesLayer = document.createElement('div');
    this.#handlesLayer.className = 'lw-wl-handles';
    this.host.append(this.#handlesLayer);
    this.#handleLow = this.#createHandle('low');
    this.#handleHigh = this.#createHandle('high');
    this.#handlesLayer.append(this.#handleLow, this.#handleHigh);

    this.#readout = document.createElement('div');
    this.#readout.className = 'lw-wl-readout';
    this.host.append(this.#readout);

    this.#svg.addEventListener('pointerdown', this.#onSvgPointerDown);

    this.host.setAttribute('role', 'group');
    this.host.setAttribute('aria-label', 'Window / level editor');
  }

  #createHandle(side: 'low' | 'high'): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lw-wl-handle';
    btn.dataset.side = side;
    btn.setAttribute('role', 'slider');
    btn.setAttribute('aria-label', side === 'low' ? 'Window minimum' : 'Window maximum');
    btn.addEventListener('pointerdown', (e) => this.#onHandlePointerDown(e, side));
    btn.addEventListener('keydown', (e) => this.#onHandleKey(e, side));
    return btn;
  }

  // -- Coordinates ---------------------------------------------------------

  #xToView(x: number): number {
    const [a, b] = this.state.range;
    if (b === a) return 0;
    return ((x - a) / (b - a)) * 100;
  }
  #viewToDomain(svgX: number): number {
    const [a, b] = this.state.range;
    return a + (svgX / 100) * (b - a);
  }
  #clientToView(clientX: number): number {
    const pt = this.#svg.createSVGPoint();
    pt.x = clientX; pt.y = 0;
    const ctm = this.#svg.getScreenCTM();
    if (!ctm) return 0;
    return pt.matrixTransform(ctm.inverse()).x;
  }

  // -- Rendering -----------------------------------------------------------

  #updateGraphics(): void {
    const [lo, hi] = this.state.value;
    const xLow = this.#xToView(lo);
    const xHigh = this.#xToView(hi);
    this.#overlay.setAttribute('x', xLow.toFixed(3));
    this.#overlay.setAttribute('y', '0');
    this.#overlay.setAttribute('width', Math.max(0, xHigh - xLow).toFixed(3));
    this.#overlay.setAttribute('height', '100');
    this.#edgeLow.setAttribute('x1', xLow.toFixed(3));
    this.#edgeLow.setAttribute('x2', xLow.toFixed(3));
    this.#edgeLow.setAttribute('y1', '0');
    this.#edgeLow.setAttribute('y2', '100');
    this.#edgeHigh.setAttribute('x1', xHigh.toFixed(3));
    this.#edgeHigh.setAttribute('x2', xHigh.toFixed(3));
    this.#edgeHigh.setAttribute('y1', '0');
    this.#edgeHigh.setAttribute('y2', '100');
    this.#handleLow.style.left = `${xLow}%`;
    this.#handleHigh.style.left = `${xHigh}%`;
    const fmt = (n: number) =>
      Math.abs(n) >= 1000 ? Math.round(n).toString() : n.toFixed(2);
    const level = this.level;
    const width = this.width;
    this.#readout.textContent =
      `L ${fmt(level)}   W ${fmt(width)}   [${fmt(lo)}, ${fmt(hi)}]`;
  }

  // -- Interactions --------------------------------------------------------

  #onSvgPointerDown = (e: PointerEvent): void => {
    // Click on the background snaps the nearer handle to the click point.
    if (e.button === 2) return;
    const svgX = this.#clientToView(e.clientX);
    const x = this.#viewToDomain(svgX);
    const [lo, hi] = this.state.value;
    const side: 'low' | 'high' = Math.abs(x - lo) <= Math.abs(x - hi) ? 'low' : 'high';
    this.#setEdge(side, x);
    const handle = side === 'low' ? this.#handleLow : this.#handleHigh;
    handle.focus();
    this.#startDrag(handle, side, e.pointerId);
    e.preventDefault();
  };

  #onHandlePointerDown = (e: PointerEvent, side: 'low' | 'high'): void => {
    if (e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLButtonElement;
    target.focus();
    this.#startDrag(target, side, e.pointerId);
  };

  #startDrag(handle: HTMLElement, side: 'low' | 'high', pointerId: number): void {
    this.#dragging = side;
    try { handle.setPointerCapture(pointerId); } catch {}
    const onMove = (ev: PointerEvent) => {
      if (!this.#dragging) return;
      const x = this.#viewToDomain(this.#clientToView(ev.clientX));
      this.#setEdge(this.#dragging, x);
    };
    const onUp = (ev: PointerEvent) => {
      this.#dragging = null;
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  #onHandleKey = (e: KeyboardEvent, side: 'low' | 'high'): void => {
    const [a, b] = this.state.range;
    const step = (b - a) * (e.shiftKey ? 0.05 : 0.005);
    const current = side === 'low' ? this.state.value[0] : this.state.value[1];
    let next = current;
    if (e.key === 'ArrowLeft')       next = current - step;
    else if (e.key === 'ArrowRight') next = current + step;
    else return;
    e.preventDefault();
    this.#setEdge(side, next);
  };

  #setEdge(side: 'low' | 'high', xRaw: number): void {
    const [a, b] = this.state.range;
    const x = Math.min(b, Math.max(a, xRaw));
    let [lo, hi] = this.state.value;
    if (side === 'low')  lo = Math.min(x, hi - 1e-9);
    else                 hi = Math.max(x, lo + 1e-9);
    this.state = { ...this.state, value: [lo, hi] };
    this.#updateGraphics();
    this.#emitChange();
  }

  #emitChange(): void {
    const [lo, hi] = this.state.value;
    (this as unknown as { emit(e: 'change', d: { value: [number, number]; level: number; width: number }): void })
      .emit('change', { value: [lo, hi], level: this.level, width: this.width });
  }

  override dispose(): void {
    super.dispose();
    this.#hg.dispose();
  }
}

function clampToRange(
  v: [number, number],
  r: [number, number],
): [number, number] {
  const lo = Math.min(Math.max(v[0], r[0]), r[1]);
  const hi = Math.max(Math.min(v[1], r[1]), r[0]);
  return [Math.min(lo, hi), Math.max(lo, hi)];
}
