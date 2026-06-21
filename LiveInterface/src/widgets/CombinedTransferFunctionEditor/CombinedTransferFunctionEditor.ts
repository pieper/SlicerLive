import { Widget, type WidgetOptions } from '../../core/Widget.js';
import { injectThemeStylesheet } from '../../core/theme.js';
import { Histogram } from '../Histogram/Histogram.js';
import { ColorPicker } from '../ColorPicker/ColorPicker.js';
import type { ScalarArray } from '../Histogram/HistogramBinning.js';
import {
  type CombinedTFPoint, type PiecewisePoint, type ColorPoint,
  type TFLayer, type LayerBlendMode,
  parsePiecewise, parseColorTransfer,
  serializePiecewise, serializeColorTransfer,
  unifyTransferFunctions, compositeLayers,
} from '../../mrml/VolumeProperty.js';
import css from './CombinedTransferFunctionEditor.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
let gradientCounter = 0;
let layerIdCounter = 0;
const nextLayerId = () => `layer-${++layerIdCounter}`;

export interface CombinedTFEditorState {
  range: [number, number];
  layers: TFLayer[];
  activeLayerId: string;
  logScale: boolean;
  histogramColor: [number, number, number];
  blend: LayerBlendMode;
}

export interface CombinedTFEditorEvents {
  change: { layers: TFLayer[]; activeLayerId: string };
  rangechange: { range: [number, number] };
  activelayerchange: { activeLayerId: string };
  [key: string]: unknown;
}

export interface CombinedTFEditorOptions extends WidgetOptions {
  range?: [number, number];
  /** Initial control points for a single starting layer. Use `layers` to seed
   *  multiple layers at construction time. */
  controlPoints?: CombinedTFPoint[];
  /** Seed multiple layers directly. Takes precedence over `controlPoints`. */
  layers?: Array<{ name?: string; visible?: boolean; controlPoints: CombinedTFPoint[] }>;
  logScale?: boolean;
  histogramColor?: [number, number, number];
  width?: number;
  height?: number;
  binCount?: number;
  blend?: LayerBlendMode;
}

let cssInjected = false;
function ensureStylesheet() {
  if (cssInjected) return;
  const style = document.createElement('style');
  style.setAttribute('data-liveinterface-ctf', '');
  style.textContent = css;
  document.head.appendChild(style);
  cssInjected = true;
}

const DEFAULT_POINTS: CombinedTFPoint[] = [
  { x: 0, opacity: 0, rgb: [0, 0, 0] },
  { x: 1, opacity: 1, rgb: [1, 1, 1] },
];

const DRAG_THRESHOLD_PX = 4;

interface LayerDom {
  gradient: SVGLinearGradientElement;
  area: SVGPathElement;
  line: SVGPathElement;
  gradId: string;
}

export class CombinedTransferFunctionEditor
  extends Widget<CombinedTFEditorState, CombinedTFEditorEvents>
{
  #hg!: Histogram;
  #hgHost!: HTMLDivElement;
  #svg!: SVGSVGElement;
  #defs!: SVGDefsElement;
  #layersGroup!: SVGGElement;
  #handlesLayer!: HTMLDivElement;
  #readout!: HTMLDivElement;
  #popover!: HTMLDivElement;
  #popoverPicker: ColorPicker | null = null;
  #popoverIndex = -1;
  #menu!: HTMLDivElement;
  #chips!: HTMLDivElement;
  #puck!: HTMLButtonElement;

  #layerDom = new Map<string, LayerDom>();
  #binCount: number;
  #instanceId: number;
  #draggingIndex = -1;
  #pendingClickIndex = -1;

  constructor(host: HTMLElement, opts: CombinedTFEditorOptions = {}) {
    const range = opts.range ?? [0, 1];

    let layers: TFLayer[];
    if (opts.layers && opts.layers.length > 0) {
      layers = opts.layers.map((l, i) => ({
        id: nextLayerId(),
        name: l.name ?? `Layer ${i + 1}`,
        visible: l.visible ?? true,
        controlPoints: l.controlPoints.map((p) => ({
          x: p.x, opacity: p.opacity,
          rgb: [...p.rgb] as [number, number, number],
        })),
      }));
    } else {
      const initialPts = (opts.controlPoints && opts.controlPoints.length >= 2)
        ? opts.controlPoints
        : DEFAULT_POINTS.map((p) => ({
            x: range[0] + p.x * (range[1] - range[0]),
            opacity: p.opacity,
            rgb: [...p.rgb] as [number, number, number],
          }));
      layers = [{
        id: nextLayerId(),
        name: 'Layer 1',
        visible: true,
        controlPoints: initialPts.map((p) => ({
          x: p.x, opacity: p.opacity,
          rgb: [...p.rgb] as [number, number, number],
        })),
      }];
    }

    const initial: CombinedTFEditorState = {
      range,
      layers,
      activeLayerId: layers[0].id,
      logScale: opts.logScale ?? false,
      histogramColor: opts.histogramColor ?? [0.55, 0.58, 0.65],
      blend: opts.blend ?? 'max',
    };
    super(host, initial, { ...opts, className: opts.className ?? 'lw-ctf-editor' });
    this.#binCount = opts.binCount ?? 256;
    this.#instanceId = ++gradientCounter;
    injectThemeStylesheet();
    ensureStylesheet();
    this.#buildDom(opts.width ?? 480, opts.height ?? 200);
    this.#updateGraphics();
  }

  // -- Public API ----------------------------------------------------------

  setData(
    data: ScalarArray,
    opts: { min?: number; max?: number; bins?: number } = {},
  ): void {
    const bins = opts.bins ?? this.#binCount;
    this.#hg.setData(data, { ...opts, bins });
    const range = this.#hg.getState().range;
    this.state = { ...this.state, range };
    this.#updateGraphics();
    this.#emit('rangechange', { range });
  }

  /** Replace the active layer's control points. */
  setControlPoints(points: CombinedTFPoint[]): void {
    const sorted = [...points].sort((a, b) => a.x - b.x);
    this.#updateActiveLayer((l) => ({ ...l, controlPoints: sorted }));
    this.#updateGraphics();
    this.#emitChange();
  }

  setRange(min: number, max: number): void {
    this.state = { ...this.state, range: [min, max] };
    this.#updateGraphics();
    this.#emit('rangechange', { range: [min, max] });
  }

  setLogScale(on: boolean): void {
    if (this.state.logScale === on) return;
    this.state = { ...this.state, logScale: on };
    this.#hg.setLogScale(on);
  }

  setBlendMode(blend: LayerBlendMode): void {
    if (this.state.blend === blend) return;
    this.state = { ...this.state, blend };
    this.#emitChange();
  }

  /** Compose all visible layers into a single MRML output pair. */
  toMrmlAttributes(): { scalarOpacity: string; colorTransfer: string } {
    const { opacity, color } = compositeLayers(this.state.layers, this.state.blend);
    return {
      scalarOpacity: serializePiecewise(opacity),
      colorTransfer: serializeColorTransfer(color),
    };
  }

  /** Load MRML into a single replacement layer. */
  setFromMrmlAttributes(attrs: { scalarOpacity?: string; colorTransfer?: string }): void {
    const op = attrs.scalarOpacity ? parsePiecewise(attrs.scalarOpacity) : [];
    const co = attrs.colorTransfer ? parseColorTransfer(attrs.colorTransfer) : [];
    const unified = unifyTransferFunctions(op, co);
    if (unified.length < 2) return;
    const layer: TFLayer = {
      id: nextLayerId(),
      name: 'Imported',
      visible: true,
      controlPoints: unified,
    };
    this.state = { ...this.state, layers: [layer], activeLayerId: layer.id };
    this.#updateGraphics();
    this.#emitChange();
  }

  /** Atomically replace all layers (e.g. when applying a multi-layer preset). */
  setLayers(
    layers: Array<{ name?: string; visible?: boolean; controlPoints: CombinedTFPoint[] }>,
  ): void {
    if (layers.length === 0) return;
    const newLayers: TFLayer[] = layers.map((l, i) => ({
      id: nextLayerId(),
      name: l.name ?? `Layer ${i + 1}`,
      visible: l.visible ?? true,
      controlPoints: l.controlPoints.map((p) => ({
        x: p.x, opacity: p.opacity,
        rgb: [...p.rgb] as [number, number, number],
      })),
    }));
    this.state = {
      ...this.state,
      layers: newLayers,
      activeLayerId: newLayers[0].id,
    };
    this.#updateGraphics();
    this.#emit('activelayerchange', { activeLayerId: newLayers[0].id });
    this.#emitChange();
  }

  // Layer management
  addLayer(name?: string, controlPoints?: CombinedTFPoint[]): string {
    const [a, b] = this.state.range;
    const pts: CombinedTFPoint[] = controlPoints?.length
      ? controlPoints.map((p) => ({
          x: p.x, opacity: p.opacity, rgb: [...p.rgb] as [number, number, number],
        }))
      : [
          { x: a, opacity: 0, rgb: [0.4, 0.7, 1.0] },
          { x: b, opacity: 0.8, rgb: [0.4, 0.7, 1.0] },
        ];
    const layer: TFLayer = {
      id: nextLayerId(),
      name: name ?? `Layer ${this.state.layers.length + 1}`,
      visible: true,
      controlPoints: pts,
    };
    this.state = {
      ...this.state,
      layers: [...this.state.layers, layer],
      activeLayerId: layer.id,
    };
    this.#updateGraphics();
    this.#emit('activelayerchange', { activeLayerId: layer.id });
    this.#emitChange();
    return layer.id;
  }

  duplicateActiveLayer(): string {
    const active = this.#activeLayer();
    if (!active) return '';
    const layer: TFLayer = {
      id: nextLayerId(),
      name: `${active.name} copy`,
      visible: true,
      controlPoints: active.controlPoints.map((p) => ({
        x: p.x, opacity: p.opacity, rgb: [...p.rgb] as [number, number, number],
      })),
    };
    this.state = {
      ...this.state,
      layers: [...this.state.layers, layer],
      activeLayerId: layer.id,
    };
    this.#updateGraphics();
    this.#emit('activelayerchange', { activeLayerId: layer.id });
    this.#emitChange();
    return layer.id;
  }

  removeLayer(id: string): void {
    if (this.state.layers.length <= 1) return;
    const idx = this.state.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const layers = this.state.layers.filter((l) => l.id !== id);
    const wasActive = id === this.state.activeLayerId;
    const newActive = wasActive
      ? (layers[Math.min(idx, layers.length - 1)]).id
      : this.state.activeLayerId;
    this.state = { ...this.state, layers, activeLayerId: newActive };
    if (wasActive) this.#emit('activelayerchange', { activeLayerId: newActive });
    this.#updateGraphics();
    this.#emitChange();
  }

  setActiveLayer(id: string): void {
    if (id === this.state.activeLayerId) return;
    if (!this.state.layers.some((l) => l.id === id)) return;
    this.state = { ...this.state, activeLayerId: id };
    this.#updateGraphics();
    this.#emit('activelayerchange', { activeLayerId: id });
  }

  setLayerVisibility(id: string, visible: boolean): void {
    const layers = this.state.layers.map((l) => l.id === id ? { ...l, visible } : l);
    this.state = { ...this.state, layers };
    this.#updateGraphics();
    this.#emitChange();
  }

  getActiveLayer(): TFLayer | undefined {
    return this.#activeLayer();
  }

  getLayers(): readonly TFLayer[] {
    return this.state.layers;
  }

  // -- Internal helpers ----------------------------------------------------

  #activeLayer(): TFLayer | undefined {
    return this.state.layers.find((l) => l.id === this.state.activeLayerId);
  }

  #updateActiveLayer(updater: (l: TFLayer) => TFLayer): void {
    const layers = this.state.layers.map((l) =>
      l.id === this.state.activeLayerId ? updater(l) : l);
    this.state = { ...this.state, layers };
  }

  #emit<K extends keyof CombinedTFEditorEvents>(
    name: K, data: CombinedTFEditorEvents[K],
  ): void {
    (this as unknown as { emit(n: K, d: CombinedTFEditorEvents[K]): void })
      .emit(name, data);
  }

  #emitChange(): void {
    this.#emit('change', {
      layers: this.state.layers,
      activeLayerId: this.state.activeLayerId,
    });
  }

  // -- DOM build -----------------------------------------------------------

  #buildDom(w: number, h: number): void {
    this.host.innerHTML = '';
    this.host.style.width = `${w}px`;
    this.host.style.height = `${h}px`;

    this.#hgHost = document.createElement('div');
    this.#hgHost.className = 'lw-ctf-hg';
    this.host.append(this.#hgHost);
    this.#hg = new Histogram(this.#hgHost, {
      width: w, height: h,
      color: this.state.histogramColor,
      showAxis: true,
      binCount: this.#binCount,
    });

    this.#svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.#svg.classList.add('lw-ctf-svg');
    this.#svg.setAttribute('viewBox', '0 0 100 100');
    this.#svg.setAttribute('preserveAspectRatio', 'none');
    this.#defs = document.createElementNS(SVG_NS, 'defs');
    this.#svg.append(this.#defs);
    this.#layersGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement;
    this.#svg.append(this.#layersGroup);
    this.host.append(this.#svg);

    this.#handlesLayer = document.createElement('div');
    this.#handlesLayer.className = 'lw-ctf-handles';
    this.host.append(this.#handlesLayer);

    this.#readout = document.createElement('div');
    this.#readout.className = 'lw-ctf-readout';
    this.host.append(this.#readout);

    this.#popover = document.createElement('div');
    this.#popover.className = 'lw-ctf-popover';
    document.body.append(this.#popover);

    this.#menu = document.createElement('div');
    this.#menu.className = 'lw-ctf-menu';
    document.body.append(this.#menu);

    this.#chips = document.createElement('div');
    this.#chips.className = 'lw-ctf-chips';
    this.host.append(this.#chips);

    this.#puck = document.createElement('button');
    this.#puck.type = 'button';
    this.#puck.className = 'lw-ctf-puck';
    this.#puck.title = 'Drag to pan all points · Shift+drag to scale around centroid';
    this.#puck.setAttribute('aria-label', 'Pan or scale the active curve');
    this.#puck.addEventListener('pointerdown', this.#onPuckPointerDown);
    this.host.append(this.#puck);

    this.#svg.addEventListener('pointerdown', this.#onSvgPointerDown);
    this.host.addEventListener('contextmenu', this.#onContextMenu);

    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-label',
      'Combined color × opacity transfer function editor with layered curves');
  }

  protected override render(): void { this.#updateGraphics(); }

  // -- Coordinate math -----------------------------------------------------

  #xToView(x: number): number {
    const [a, b] = this.state.range;
    if (b === a) return 0;
    return ((x - a) / (b - a)) * 100;
  }
  #yToView(y: number): number { return (1 - clamp01(y)) * 100; }
  #viewToDomain(svgX: number, svgY: number): { x: number; y: number } {
    const [a, b] = this.state.range;
    const x = a + (svgX / 100) * (b - a);
    const y = clamp01(1 - svgY / 100);
    return { x, y };
  }
  #clientToView(clientX: number, clientY: number): { svgX: number; svgY: number } {
    const pt = this.#svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const ctm = this.#svg.getScreenCTM();
    if (!ctm) return { svgX: 0, svgY: 0 };
    const inv = pt.matrixTransform(ctm.inverse());
    return { svgX: inv.x, svgY: inv.y };
  }

  // -- Rendering -----------------------------------------------------------

  #updateGraphics(): void {
    this.#renderLayers();
    this.#renderHandles();
    this.#positionPuck();
    this.#renderChips();
  }

  #renderLayers(): void {
    const layers = this.state.layers;
    const activeId = this.state.activeLayerId;

    // Reconcile: remove DOM for layers no longer present.
    for (const id of Array.from(this.#layerDom.keys())) {
      if (!layers.some((l) => l.id === id)) {
        const dom = this.#layerDom.get(id)!;
        dom.gradient.remove();
        dom.area.remove();
        dom.line.remove();
        this.#layerDom.delete(id);
      }
    }

    // For each layer (in array order = z-order), ensure DOM exists and update.
    for (const layer of layers) {
      let dom = this.#layerDom.get(layer.id);
      if (!dom) {
        const gradId = `lw-ctf-grad-${this.#instanceId}-${layer.id}`;
        const gradient = document.createElementNS(SVG_NS, 'linearGradient') as SVGLinearGradientElement;
        gradient.setAttribute('id', gradId);
        gradient.setAttribute('x1', '0%'); gradient.setAttribute('y1', '0%');
        gradient.setAttribute('x2', '100%'); gradient.setAttribute('y2', '0%');
        this.#defs.append(gradient);
        const newArea = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
        newArea.classList.add('lw-ctf-area');
        newArea.setAttribute('fill', `url(#${gradId})`);
        const newLine = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
        newLine.classList.add('lw-ctf-line');
        dom = { gradient, area: newArea, line: newLine, gradId };
        this.#layerDom.set(layer.id, dom);
      }
      const isActive = layer.id === activeId;
      const { area, line } = dom;
      if (!layer.visible) {
        area.style.display = 'none';
        line.style.display = 'none';
      } else {
        area.style.display = '';
        line.style.display = '';
        area.classList.toggle('dim', !isActive);
        line.classList.toggle('dim', !isActive);
      }
      this.#updateGradient(dom.gradient, layer.controlPoints);
      this.#updatePathPair(area, line, layer.controlPoints);
    }

    // Re-attach in correct z-order: visible non-active first, then active on top.
    this.#layersGroup.innerHTML = '';
    for (const layer of layers) {
      if (layer.id === activeId) continue;
      const dom = this.#layerDom.get(layer.id);
      if (!dom) continue;
      this.#layersGroup.append(dom.area, dom.line);
    }
    const activeDom = this.#layerDom.get(activeId);
    if (activeDom) this.#layersGroup.append(activeDom.area, activeDom.line);
  }

  #updateGradient(grad: SVGLinearGradientElement, pts: CombinedTFPoint[]): void {
    grad.innerHTML = '';
    if (pts.length === 0) return;
    const [a, b] = this.state.range;
    const span = b - a || 1;
    for (const p of pts) {
      const offset = `${((p.x - a) / span * 100).toFixed(3)}%`;
      const stop = document.createElementNS(SVG_NS, 'stop');
      stop.setAttribute('offset', offset);
      stop.setAttribute('stop-color',
        `rgb(${(p.rgb[0] * 255) | 0}, ${(p.rgb[1] * 255) | 0}, ${(p.rgb[2] * 255) | 0})`);
      grad.append(stop);
    }
  }

  #updatePathPair(
    area: SVGPathElement,
    line: SVGPathElement,
    pts: CombinedTFPoint[],
  ): void {
    if (pts.length === 0) {
      area.setAttribute('d', '');
      line.setAttribute('d', '');
      return;
    }
    const cmds: string[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const vx = this.#xToView(p.x);
      const vy = this.#yToView(p.opacity);
      cmds.push(`${i === 0 ? 'M' : 'L'} ${vx.toFixed(3)} ${vy.toFixed(3)}`);
    }
    line.setAttribute('d', cmds.join(' '));
    const first = pts[0]; const last = pts[pts.length - 1];
    const areaCmds = [
      `M ${this.#xToView(first.x).toFixed(3)} 100`,
      ...cmds.map((c) => c.startsWith('M') ? `L${c.slice(1)}` : c),
      `L ${this.#xToView(last.x).toFixed(3)} 100`,
      'Z',
    ];
    area.setAttribute('d', areaCmds.join(' '));
  }

  #renderHandles(): void {
    const active = this.#activeLayer();
    const pts = active?.controlPoints ?? [];
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
      btn.style.top = `${this.#yToView(p.opacity)}%`;
      btn.style.setProperty('--handle-color',
        `rgb(${(p.rgb[0] * 255) | 0}, ${(p.rgb[1] * 255) | 0}, ${(p.rgb[2] * 255) | 0})`);
      btn.dataset.index = String(i);
      btn.setAttribute('aria-label', `Control point ${i + 1}`);
      btn.setAttribute('aria-valuemin', String(this.state.range[0]));
      btn.setAttribute('aria-valuemax', String(this.state.range[1]));
      btn.setAttribute('aria-valuenow', String(p.x));
      btn.setAttribute('aria-valuetext',
        `x=${p.x.toPrecision(4)}, α=${p.opacity.toFixed(3)}, ` +
        `rgb=${p.rgb.map((c) => (c * 255) | 0).join(',')}`);
    }
  }

  #createHandle(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lw-ctf-handle';
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

  #positionPuck(): void {
    const active = this.#activeLayer();
    const pts = active?.controlPoints ?? [];
    if (!active || pts.length === 0 || !active.visible) {
      this.#puck.style.display = 'none';
      return;
    }
    this.#puck.style.display = '';
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.opacity, 0) / pts.length;
    this.#puck.style.left = `${this.#xToView(cx)}%`;
    this.#puck.style.top = `${this.#yToView(cy)}%`;
  }

  #renderChips(): void {
    this.#chips.innerHTML = '';
    const activeId = this.state.activeLayerId;
    for (const layer of this.state.layers) {
      const chip = document.createElement('div');
      chip.className = 'lw-ctf-chip';
      if (layer.id === activeId) chip.classList.add('active');
      if (!layer.visible) chip.classList.add('hidden');
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'lw-ctf-chip-eye';
      eye.title = layer.visible ? 'Hide layer' : 'Show layer';
      eye.setAttribute('aria-label', eye.title);
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setLayerVisibility(layer.id, !layer.visible);
      });
      const swatch = document.createElement('span');
      swatch.className = 'lw-ctf-chip-swatch';
      swatch.style.setProperty('--chip-color', dominantColor(layer.controlPoints));
      const label = document.createElement('span');
      label.textContent = layer.name;
      chip.append(eye, swatch, label);
      chip.addEventListener('click', () => this.setActiveLayer(layer.id));
      chip.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const next = prompt('Rename layer', layer.name);
        if (next && next.trim()) {
          this.state = {
            ...this.state,
            layers: this.state.layers.map((l) =>
              l.id === layer.id ? { ...l, name: next.trim() } : l),
          };
          this.#renderChips();
          this.#emitChange();
        }
      });
      this.#chips.append(chip);
    }
    const add = document.createElement('div');
    add.className = 'lw-ctf-chip-add';
    add.textContent = '+ curve';
    add.title = 'Add a new curve';
    add.addEventListener('click', () => this.addLayer());
    this.#chips.append(add);
  }

  // -- Interaction: SVG background, handles, puck --------------------------

  #onSvgPointerDown = (e: PointerEvent): void => {
    if (e.button === 2) return; // right-click handled by contextmenu
    if (this.#popoverIndex >= 0) {
      this.#hidePopover();
      e.preventDefault();
      return;
    }
    if (this.#menu.style.display === 'block') {
      this.#hideMenu();
      e.preventDefault();
      return;
    }
    const active = this.#activeLayer();
    if (!active) return;
    const { svgX, svgY } = this.#clientToView(e.clientX, e.clientY);
    const { x, y } = this.#viewToDomain(svgX, svgY);
    const rgb = sampleColorLocal(
      active.controlPoints.map((p) => ({ x: p.x, r: p.rgb[0], g: p.rgb[1], b: p.rgb[2] })),
      x,
    );
    const newPt: CombinedTFPoint = { x, opacity: y, rgb };
    const sorted = [...active.controlPoints, newPt].sort((a, b) => a.x - b.x);
    const newIndex = sorted.findIndex((p) => p === newPt);
    this.#updateActiveLayer((l) => ({ ...l, controlPoints: sorted }));
    this.#updateGraphics();
    this.#emitChange();
    e.preventDefault();
    const handle = this.#handlesLayer.children[newIndex] as HTMLElement | undefined;
    if (handle) {
      handle.focus();
      this.#startInteraction(handle, newIndex, e.pointerId, e.clientX, e.clientY);
    }
  };

  #onHandlePointerDown = (e: PointerEvent, i: number): void => {
    if (e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.focus();
    this.#startInteraction(target, i, e.pointerId, e.clientX, e.clientY);
  };

  #startInteraction(
    handle: HTMLElement, index: number, pointerId: number,
    startClientX: number, startClientY: number,
  ): void {
    let dragging = false;
    this.#pendingClickIndex = index;
    try { handle.setPointerCapture(pointerId); } catch {}

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startClientX;
      const dy = ev.clientY - startClientY;
      if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        dragging = true;
        this.#pendingClickIndex = -1;
        this.#draggingIndex = index;
        handle.classList.add('dragging');
        this.host.classList.add('show-readout');
        const cp = this.#activeLayer()?.controlPoints[index];
        if (cp) this.#updateReadout(cp);
      }
      if (!dragging) return;
      const { svgX, svgY } = this.#clientToView(ev.clientX, ev.clientY);
      const { x: rawX, y } = this.#viewToDomain(svgX, svgY);
      const active = this.#activeLayer();
      if (!active) return;
      const pts = [...active.controlPoints];
      const i = this.#draggingIndex;
      const prev = pts[i - 1];
      const next = pts[i + 1];
      const xMin = prev ? prev.x + 1e-9 : -Infinity;
      const xMax = next ? next.x - 1e-9 : Infinity;
      const x = Math.min(xMax, Math.max(xMin, rawX));
      pts[i] = { ...pts[i], x, opacity: y };
      this.#updateActiveLayer((l) => ({ ...l, controlPoints: pts }));
      this.#updateGraphics();
      this.#updateReadout(pts[i]);
      this.#emitChange();
    };
    const onUp = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      handle.classList.remove('dragging');
      this.host.classList.remove('show-readout');
      if (!dragging && this.#pendingClickIndex === index) {
        this.#showPopover(index);
      }
      this.#draggingIndex = -1;
      this.#pendingClickIndex = -1;
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  #onHandleKey = (e: KeyboardEvent, i: number): void => {
    const active = this.#activeLayer();
    if (!active) return;
    const p = active.controlPoints[i];
    if (!p) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.#deletePoint(i);
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      this.#showPopover(i);
      e.preventDefault();
      return;
    }
    const [a, b] = this.state.range;
    const xStep = (b - a) * (e.shiftKey ? 0.05 : 0.005);
    const yStep = e.shiftKey ? 0.05 : 0.005;
    const prev = active.controlPoints[i - 1];
    const next = active.controlPoints[i + 1];
    const xMin = prev ? prev.x + 1e-9 : -Infinity;
    const xMax = next ? next.x - 1e-9 : Infinity;
    let nx = p.x, ny = p.opacity;
    if (e.key === 'ArrowLeft')       nx = Math.max(xMin, p.x - xStep);
    else if (e.key === 'ArrowRight') nx = Math.min(xMax, p.x + xStep);
    else if (e.key === 'ArrowUp')    ny = clamp01(ny + yStep);
    else if (e.key === 'ArrowDown')  ny = clamp01(ny - yStep);
    else return;
    e.preventDefault();
    const pts = [...active.controlPoints];
    pts[i] = { ...p, x: nx, opacity: ny };
    this.#updateActiveLayer((l) => ({ ...l, controlPoints: pts }));
    this.#updateGraphics();
    this.#emitChange();
  };

  #deletePoint(i: number): void {
    const active = this.#activeLayer();
    if (!active || active.controlPoints.length <= 2) return;
    const pts = [...active.controlPoints];
    pts.splice(i, 1);
    this.#updateActiveLayer((l) => ({ ...l, controlPoints: pts }));
    if (this.#popoverIndex === i) this.#hidePopover();
    this.#updateGraphics();
    this.#emitChange();
  }

  #updateReadout(p: CombinedTFPoint): void {
    this.#readout.textContent =
      `x=${p.x.toPrecision(5)}  α=${p.opacity.toFixed(3)}  ` +
      `rgb=${p.rgb.map((c) => (c * 255) | 0).join(',')}`;
  }

  #onPuckPointerDown = (e: PointerEvent): void => {
    if (e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    this.#puck.focus();
    const active = this.#activeLayer();
    if (!active) return;
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startShift = e.shiftKey;
    const startPts = active.controlPoints.map((p) => ({
      x: p.x, opacity: p.opacity, rgb: [...p.rgb] as [number, number, number],
    }));
    const [a, b] = this.state.range;
    const span = b - a || 1;
    const eRect = this.host.getBoundingClientRect();
    const xPerPx = span / Math.max(1, eRect.width);
    const yPerPx = 1 / Math.max(1, eRect.height);
    const cx = startPts.reduce((s, p) => s + p.x, 0) / startPts.length;
    const cy = startPts.reduce((s, p) => s + p.opacity, 0) / startPts.length;

    this.#puck.classList.add('dragging');
    this.host.classList.add('show-readout');
    try { this.#puck.setPointerCapture(e.pointerId); } catch {}

    const apply = (dx: number, dy: number, scaleMode: boolean) => {
      let pts: CombinedTFPoint[];
      if (scaleMode) {
        const sx = Math.max(0.05, 1 + (dx / Math.max(1, eRect.width)));
        const sy = Math.max(0.05, 1 + (-dy / Math.max(1, eRect.height)));
        pts = startPts.map((p) => ({
          x: cx + (p.x - cx) * sx,
          opacity: clamp01(cy + (p.opacity - cy) * sy),
          rgb: [...p.rgb] as [number, number, number],
        }));
        this.#readout.textContent =
          `scale  ×${sx.toFixed(2)} (x), ×${sy.toFixed(2)} (α)`;
      } else {
        const dxDom = dx * xPerPx;
        const dyDom = -dy * yPerPx;
        pts = startPts.map((p) => ({
          x: p.x + dxDom,
          opacity: clamp01(p.opacity + dyDom),
          rgb: [...p.rgb] as [number, number, number],
        }));
        this.#readout.textContent =
          `pan  Δx=${dxDom.toFixed(3)}  Δα=${dyDom.toFixed(3)}`;
      }
      this.#updateActiveLayer((l) => ({ ...l, controlPoints: pts }));
      this.#updateGraphics();
      this.#emitChange();
    };

    const onMove = (ev: PointerEvent) => {
      apply(ev.clientX - startClientX, ev.clientY - startClientY, ev.shiftKey || startShift);
    };
    const onUp = (ev: PointerEvent) => {
      this.#puck.removeEventListener('pointermove', onMove);
      this.#puck.removeEventListener('pointerup', onUp);
      this.#puck.removeEventListener('pointercancel', onUp);
      try { this.#puck.releasePointerCapture(ev.pointerId); } catch {}
      this.#puck.classList.remove('dragging');
      this.host.classList.remove('show-readout');
    };
    this.#puck.addEventListener('pointermove', onMove);
    this.#puck.addEventListener('pointerup', onUp);
    this.#puck.addEventListener('pointercancel', onUp);
  };

  // -- Color popover -------------------------------------------------------

  #showPopover(index: number): void {
    const active = this.#activeLayer();
    if (!active) return;
    const pt = active.controlPoints[index];
    if (!pt) return;
    this.#popoverIndex = index;
    if (!this.#popoverPicker) {
      const pickerHost = document.createElement('div');
      this.#popover.append(pickerHost);
      this.#popoverPicker = new ColorPicker(pickerHost, {
        showAlpha: false,
        initial: { rgb: pt.rgb },
      });
      this.#popoverPicker.on('change', (s) => {
        if (this.#popoverIndex < 0) return;
        const a = this.#activeLayer();
        if (!a) return;
        const pts = [...a.controlPoints];
        const p = pts[this.#popoverIndex];
        if (!p) return;
        pts[this.#popoverIndex] = {
          ...p,
          rgb: [s.rgb[0], s.rgb[1], s.rgb[2]],
        };
        this.#updateActiveLayer((l) => ({ ...l, controlPoints: pts }));
        this.#updateGraphics();
        this.#emitChange();
      });
    } else {
      this.#popoverPicker.setColor(pt.rgb);
    }
    this.#popover.style.display = 'block';
    this.#positionPopover(index);
    setTimeout(() => {
      document.addEventListener('pointerdown', this.#onOutsidePointerDown, true);
      document.addEventListener('keydown', this.#onPopoverKey);
    }, 0);
  }

  #positionPopover(index: number): void {
    const handle = this.#handlesLayer.children[index] as HTMLElement | undefined;
    if (!handle) return;
    const hRect = handle.getBoundingClientRect();
    const popRect = this.#popover.getBoundingClientRect();
    const popW = popRect.width || 256;
    const popH = popRect.height || 280;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = hRect.left + hRect.width / 2 - popW / 2;
    let top = hRect.bottom + 8;
    if (top + popH > vh - 8) top = hRect.top - popH - 8;
    if (top < 8) top = 8;
    if (left < 8) left = 8;
    if (left + popW > vw - 8) left = vw - popW - 8;
    this.#popover.style.left = `${left}px`;
    this.#popover.style.top = `${top}px`;
  }

  #hidePopover(): void {
    this.#popoverIndex = -1;
    this.#popover.style.display = 'none';
    document.removeEventListener('pointerdown', this.#onOutsidePointerDown, true);
    document.removeEventListener('keydown', this.#onPopoverKey);
  }

  #onOutsidePointerDown = (e: PointerEvent): void => {
    if (this.#popoverIndex < 0) return;
    const target = e.target as Node;
    if (this.#popover.contains(target)) return;
    if (this.#handlesLayer.contains(target)) return;
    if (this.host.contains(target)) return; // editor's own SVG handler closes
    this.#hidePopover();
  };

  #onPopoverKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.#hidePopover();
      e.preventDefault();
    }
  };

  // -- Context menu --------------------------------------------------------

  #onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    this.#showMenu(e.clientX, e.clientY);
  };

  #showMenu(clientX: number, clientY: number): void {
    this.#menu.innerHTML = '';
    const layers = this.state.layers;
    const canDelete = layers.length > 1;
    const items: Array<{
      label: string;
      enabled?: boolean;
      onClick: () => void;
    }> = [
      { label: 'New curve', onClick: () => this.addLayer() },
      { label: 'Duplicate active curve', onClick: () => this.duplicateActiveLayer() },
      {
        label: 'Delete active curve',
        enabled: canDelete,
        onClick: () => this.removeLayer(this.state.activeLayerId),
      },
    ];
    items.forEach((it) => {
      const el = document.createElement('div');
      el.className = 'lw-ctf-menu-item';
      if (it.enabled === false) el.classList.add('disabled');
      el.textContent = it.label;
      el.addEventListener('click', () => {
        if (it.enabled === false) return;
        it.onClick();
        this.#hideMenu();
      });
      this.#menu.append(el);
    });
    if (layers.length > 1) {
      const sep = document.createElement('div');
      sep.className = 'lw-ctf-menu-sep';
      this.#menu.append(sep);
      for (const layer of layers) {
        const el = document.createElement('div');
        el.className = 'lw-ctf-menu-item';
        const mark = layer.id === this.state.activeLayerId ? '● ' : '   ';
        const vis = layer.visible ? '' : ' (hidden)';
        el.textContent = `${mark}${layer.name}${vis}`;
        el.addEventListener('click', () => {
          this.setActiveLayer(layer.id);
          this.#hideMenu();
        });
        this.#menu.append(el);
      }
    }
    this.#menu.style.display = 'block';
    const r = this.#menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = clientX;
    let top = clientY;
    if (left + r.width > vw - 8) left = vw - r.width - 8;
    if (top + r.height > vh - 8) top = clientY - r.height;
    if (top < 8) top = 8;
    if (left < 8) left = 8;
    this.#menu.style.left = `${left}px`;
    this.#menu.style.top = `${top}px`;
    setTimeout(() => {
      document.addEventListener('pointerdown', this.#onMenuOutsidePointerDown, true);
      document.addEventListener('keydown', this.#onMenuKey);
    }, 0);
  }

  #hideMenu(): void {
    this.#menu.style.display = 'none';
    document.removeEventListener('pointerdown', this.#onMenuOutsidePointerDown, true);
    document.removeEventListener('keydown', this.#onMenuKey);
  }

  #onMenuOutsidePointerDown = (e: PointerEvent): void => {
    if (this.#menu.contains(e.target as Node)) return;
    this.#hideMenu();
  };

  #onMenuKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.#hideMenu();
      e.preventDefault();
    }
  };

  override dispose(): void {
    super.dispose();
    this.#hg.dispose();
    this.#popover?.remove();
    this.#menu?.remove();
    document.removeEventListener('pointerdown', this.#onOutsidePointerDown, true);
    document.removeEventListener('keydown', this.#onPopoverKey);
    document.removeEventListener('pointerdown', this.#onMenuOutsidePointerDown, true);
    document.removeEventListener('keydown', this.#onMenuKey);
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function sampleColorLocal(
  pts: ColorPoint[],
  x: number,
): [number, number, number] {
  if (pts.length === 0) return [0.8, 0.8, 0.8];
  if (x <= pts[0].x) return [pts[0].r, pts[0].g, pts[0].b];
  const last = pts[pts.length - 1];
  if (x >= last.x) return [last.r, last.g, last.b];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.x <= x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return [
        a.r + t * (b.r - a.r),
        a.g + t * (b.g - a.g),
        a.b + t * (b.b - a.b),
      ];
    }
  }
  return [0.8, 0.8, 0.8];
}

/** Pick a representative color for a layer chip's swatch: the rgb of the
 *  highest-opacity control point (or the last point if all are zero). */
function dominantColor(pts: CombinedTFPoint[]): string {
  if (pts.length === 0) return '#888';
  let best = pts[0];
  for (const p of pts) if (p.opacity > best.opacity) best = p;
  const [r, g, b] = best.rgb;
  return `rgb(${(r * 255) | 0}, ${(g * 255) | 0}, ${(b * 255) | 0})`;
}
