import { Widget, type WidgetOptions } from '../../core/Widget.js';
import { injectThemeStylesheet } from '../../core/theme.js';
import { Histogram } from '../Histogram/Histogram.js';
import type { ScalarArray } from '../Histogram/HistogramBinning.js';
import {
  type PiecewisePoint,
  parsePiecewise, serializePiecewise, normalizePiecewise,
} from '../../mrml/VolumeProperty.js';
import css from './TransferFunctionEditor.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface TFEditorState {
  range: [number, number];
  controlPoints: PiecewisePoint[];  // always sorted by x
  logScale: boolean;
  curveColor: [number, number, number];
  histogramColor: [number, number, number];
}

export interface TFEditorEvents {
  change: { controlPoints: PiecewisePoint[] };
  rangechange: { range: [number, number] };
  [key: string]: unknown;
}

export interface TFEditorOptions extends WidgetOptions {
  range?: [number, number];
  controlPoints?: PiecewisePoint[];
  logScale?: boolean;
  curveColor?: [number, number, number];
  histogramColor?: [number, number, number];
  width?: number;
  height?: number;
  binCount?: number;
}

let cssInjected = false;
function ensureStylesheet() {
  if (cssInjected) return;
  const style = document.createElement('style');
  style.setAttribute('data-liveinterface-tf', '');
  style.textContent = css;
  document.head.appendChild(style);
  cssInjected = true;
}

const DEFAULT_POINTS: PiecewisePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export class TransferFunctionEditor
  extends Widget<TFEditorState, TFEditorEvents>
{
  #hg!: Histogram;
  #hgHost!: HTMLDivElement;
  #svg!: SVGSVGElement;
  #areaPath!: SVGPathElement;
  #linePath!: SVGPathElement;
  #handlesLayer!: HTMLDivElement;
  #readout!: HTMLDivElement;
  #binCount: number;
  #draggingIndex = -1;

  constructor(host: HTMLElement, opts: TFEditorOptions = {}) {
    const range = opts.range ?? [0, 1];
    const controlPoints = normalizePiecewise(
      opts.controlPoints && opts.controlPoints.length >= 2
        ? opts.controlPoints
        : DEFAULT_POINTS.map((p) => ({
            x: range[0] + p.x * (range[1] - range[0]),
            y: p.y,
          })),
    );
    const initial: TFEditorState = {
      range,
      controlPoints,
      logScale: opts.logScale ?? false,
      curveColor: opts.curveColor ?? [0.36, 0.66, 0.90],
      histogramColor: opts.histogramColor ?? [0.55, 0.58, 0.65],
    };
    super(host, initial, { ...opts, className: opts.className ?? 'lw-tf-editor' });
    this.#binCount = opts.binCount ?? 256;
    injectThemeStylesheet();
    ensureStylesheet();
    this.#buildDom(opts.width ?? 480, opts.height ?? 180);
    this.#applyColorVar();
    this.#updateGraphics();
  }

  // Public API --------------------------------------------------------------

  setData(
    data: ScalarArray,
    opts: { min?: number; max?: number; bins?: number } = {},
  ): void {
    const bins = opts.bins ?? this.#binCount;
    this.#hg.setData(data, { ...opts, bins });
    const range = this.#hg.getState().range;
    this.state = { ...this.state, range };
    this.#updateGraphics();
    (this as unknown as { emit(e: 'rangechange', d: { range: [number, number] }): void })
      .emit('rangechange', { range });
  }

  setControlPoints(points: PiecewisePoint[]): void {
    this.state = {
      ...this.state,
      controlPoints: normalizePiecewise(points),
    };
    this.#updateGraphics();
    this.#emitChange();
  }

  setRange(min: number, max: number): void {
    this.state = { ...this.state, range: [min, max] };
    this.#updateGraphics();
    (this as unknown as { emit(e: 'rangechange', d: { range: [number, number] }): void })
      .emit('rangechange', { range: [min, max] });
  }

  setLogScale(on: boolean): void {
    if (this.state.logScale === on) return;
    this.state = { ...this.state, logScale: on };
    this.#hg.setLogScale(on);
  }

  toMrmlAttribute(): string {
    return serializePiecewise(this.state.controlPoints);
  }

  setFromMrmlAttribute(attr: string): void {
    const pts = parsePiecewise(attr);
    if (pts.length < 2) return;
    this.state = { ...this.state, controlPoints: normalizePiecewise(pts) };
    this.#updateGraphics();
    this.#emitChange();
  }

  // DOM ---------------------------------------------------------------------

  #buildDom(w: number, h: number): void {
    this.host.innerHTML = '';
    this.host.style.width = `${w}px`;
    this.host.style.height = `${h}px`;

    this.#hgHost = document.createElement('div');
    this.#hgHost.className = 'lw-tf-hg';
    this.host.append(this.#hgHost);
    this.#hg = new Histogram(this.#hgHost, {
      width: w, height: h,
      color: this.state.histogramColor,
      showAxis: true,
      binCount: this.#binCount,
    });

    this.#svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.#svg.classList.add('lw-tf-svg');
    this.#svg.setAttribute('viewBox', '0 0 100 100');
    this.#svg.setAttribute('preserveAspectRatio', 'none');
    this.host.append(this.#svg);

    this.#areaPath = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
    this.#areaPath.classList.add('lw-tf-area');
    this.#linePath = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
    this.#linePath.classList.add('lw-tf-line');
    this.#svg.append(this.#areaPath, this.#linePath);

    // Handles live in a DOM overlay so they stay circular regardless of the
    // editor's aspect ratio, and so dblclick/focus/keyboard behave natively.
    this.#handlesLayer = document.createElement('div');
    this.#handlesLayer.className = 'lw-tf-handles';
    this.host.append(this.#handlesLayer);

    this.#readout = document.createElement('div');
    this.#readout.className = 'lw-tf-readout';
    this.host.append(this.#readout);

    // SVG pointerdown on an empty spot adds a new control point.
    this.#svg.addEventListener('pointerdown', this.#onSvgPointerDown);

    // Container focus for ARIA, not for global key trapping.
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-label', 'Transfer function editor');
  }

  #applyColorVar(): void {
    const [r, g, b] = this.state.curveColor;
    const css = `rgb(${(r * 255) | 0}, ${(g * 255) | 0}, ${(b * 255) | 0})`;
    this.host.style.setProperty('--lw-tf-color', css);
  }

  protected override render(): void { this.#updateGraphics(); }

  // Graphics ----------------------------------------------------------------

  #xToView(x: number): number {
    const [a, b] = this.state.range;
    if (b === a) return 0;
    return ((x - a) / (b - a)) * 100;
  }
  #yToView(y: number): number {
    return (1 - clamp01(y)) * 100;
  }
  #viewToDomain(svgX: number, svgY: number): { x: number; y: number } {
    const [a, b] = this.state.range;
    const x = a + (svgX / 100) * (b - a);
    const y = clamp01(1 - svgY / 100);
    return { x, y };
  }
  #clientToView(clientX: number, clientY: number): { svgX: number; svgY: number } {
    const pt = this.#svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = this.#svg.getScreenCTM();
    if (!ctm) return { svgX: 0, svgY: 0 };
    const inv = pt.matrixTransform(ctm.inverse());
    return { svgX: inv.x, svgY: inv.y };
  }

  #updateGraphics(): void {
    this.#applyColorVar();
    this.#renderPaths();
    this.#renderHandles();
  }

  #renderPaths(): void {
    const pts = this.state.controlPoints;
    if (pts.length === 0) {
      this.#areaPath.setAttribute('d', '');
      this.#linePath.setAttribute('d', '');
      return;
    }
    const cmds: string[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const vx = this.#xToView(p.x);
      const vy = this.#yToView(p.y);
      cmds.push(`${i === 0 ? 'M' : 'L'} ${vx.toFixed(3)} ${vy.toFixed(3)}`);
    }
    this.#linePath.setAttribute('d', cmds.join(' '));
    const first = pts[0]; const last = pts[pts.length - 1];
    const areaCmds = [
      `M ${this.#xToView(first.x).toFixed(3)} 100`,
      ...cmds.slice(0).map((c) => c.startsWith('M') ? `L${c.slice(1)}` : c),
      `L ${this.#xToView(last.x).toFixed(3)} 100`,
      'Z',
    ];
    this.#areaPath.setAttribute('d', areaCmds.join(' '));
  }

  // Reconcile DOM buttons against state.controlPoints. We never call
  // innerHTML='' on the handles layer during a drag — destroying the
  // captured-pointer handle would kill the drag mid-flight.
  #renderHandles(): void {
    const pts = this.state.controlPoints;
    const layer = this.#handlesLayer;
    while (layer.children.length < pts.length) {
      layer.append(this.#createHandle());
    }
    while (layer.children.length > pts.length) {
      layer.lastChild?.remove();
    }
    const buttons = Array.from(layer.children) as HTMLButtonElement[];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const btn = buttons[i];
      btn.style.left = `${this.#xToView(p.x)}%`;
      btn.style.top = `${this.#yToView(p.y)}%`;
      btn.dataset.index = String(i);
      btn.setAttribute('aria-label', `Control point ${i + 1}`);
      btn.setAttribute('aria-valuemin', String(this.state.range[0]));
      btn.setAttribute('aria-valuemax', String(this.state.range[1]));
      btn.setAttribute('aria-valuenow', String(p.x));
      btn.setAttribute('aria-valuetext', `x=${p.x.toPrecision(4)}, y=${p.y.toFixed(3)}`);
    }
  }

  #createHandle(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lw-tf-handle';
    btn.setAttribute('role', 'slider');
    btn.addEventListener('pointerdown', (e) => {
      const i = Number(btn.dataset.index);
      this.#onHandlePointerDown(e, i);
    });
    btn.addEventListener('keydown', (e) => {
      const i = Number(btn.dataset.index);
      this.#onHandleKey(e, i);
    });
    btn.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const i = Number(btn.dataset.index);
      this.#deletePoint(i);
    });
    return btn;
  }

  // Interaction -------------------------------------------------------------

  // Click on the SVG background → add a new control point and start dragging it.
  #onSvgPointerDown = (e: PointerEvent): void => {
    const { svgX, svgY } = this.#clientToView(e.clientX, e.clientY);
    const { x, y } = this.#viewToDomain(svgX, svgY);
    const points = [...this.state.controlPoints, { x, y }];
    const normalized = normalizePiecewise(points);
    const newIndex = normalized.findIndex((p) => p.x === x);
    this.state = { ...this.state, controlPoints: normalized };
    this.#updateGraphics();
    this.#emitChange();
    e.preventDefault();
    // Move focus + drag onto the freshly created handle.
    const handle = this.#handlesLayer.children[newIndex] as HTMLElement | undefined;
    if (handle) {
      handle.focus();
      this.#startDrag(handle, newIndex, e.pointerId);
    }
  };

  #onHandlePointerDown = (e: PointerEvent, i: number): void => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.focus();
    this.#startDrag(target, i, e.pointerId);
  };

  #startDrag(handle: HTMLElement, index: number, pointerId: number): void {
    this.#draggingIndex = index;
    handle.classList.add('dragging');
    try { handle.setPointerCapture(pointerId); } catch {}
    this.host.classList.add('show-readout');
    this.#updateReadout(this.state.controlPoints[index]);

    const onMove = (ev: PointerEvent) => {
      if (this.#draggingIndex < 0) return;
      const { svgX, svgY } = this.#clientToView(ev.clientX, ev.clientY);
      const { x: rawX, y } = this.#viewToDomain(svgX, svgY);
      const pts = [...this.state.controlPoints];
      const i = this.#draggingIndex;
      // Clamp x to (prev.x, next.x) so the order can't change mid-drag.
      // That keeps the captured-pointer handle pinned to its index, which
      // means our reconcile loop never tears down the live element.
      const prev = pts[i - 1];
      const next = pts[i + 1];
      const xMin = prev ? prev.x + 1e-9 : -Infinity;
      const xMax = next ? next.x - 1e-9 : Infinity;
      const x = Math.min(xMax, Math.max(xMin, rawX));
      pts[i] = { x, y };
      this.state = { ...this.state, controlPoints: pts };
      this.#updateGraphics();
      this.#updateReadout({ x, y });
      this.#emitChange();
    };
    const onUp = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      handle.classList.remove('dragging');
      this.#draggingIndex = -1;
      this.host.classList.remove('show-readout');
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  #onHandleKey = (e: KeyboardEvent, i: number): void => {
    const pts = this.state.controlPoints;
    const p = pts[i];
    if (!p) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.#deletePoint(i);
      e.preventDefault();
      return;
    }
    const [a, b] = this.state.range;
    const xStep = (b - a) * (e.shiftKey ? 0.05 : 0.005);
    const yStep = e.shiftKey ? 0.05 : 0.005;
    let nx = p.x, ny = p.y;
    if (e.key === 'ArrowLeft')       nx -= xStep;
    else if (e.key === 'ArrowRight') nx += xStep;
    else if (e.key === 'ArrowUp')    ny = clamp01(ny + yStep);
    else if (e.key === 'ArrowDown')  ny = clamp01(ny - yStep);
    else return;
    e.preventDefault();
    const next = [...pts];
    next[i] = { x: nx, y: ny };
    const normalized = normalizePiecewise(next);
    this.state = { ...this.state, controlPoints: normalized };
    this.#updateGraphics();
    this.#emitChange();
  };

  #deletePoint(i: number): void {
    if (this.state.controlPoints.length <= 2) return; // keep at least two
    const pts = [...this.state.controlPoints];
    pts.splice(i, 1);
    this.state = { ...this.state, controlPoints: pts };
    this.#updateGraphics();
    this.#emitChange();
  }

  #updateReadout(p: { x: number; y: number }): void {
    this.#readout.textContent = `x=${p.x.toPrecision(5)}  α=${p.y.toFixed(3)}`;
  }

  #emitChange(): void {
    (this as unknown as { emit(e: 'change', d: { controlPoints: PiecewisePoint[] }): void })
      .emit('change', { controlPoints: this.state.controlPoints });
  }

  override dispose(): void {
    super.dispose();
    this.#hg.dispose();
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
