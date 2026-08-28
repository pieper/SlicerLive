// LegacyGui — client of a ModuleServer/AppServer GUI stream (WS B). Streams the legacy app's chrome
// (toolbars, docks, status bar, popups/dialogs) as per-region PNG frames positioned in WINDOW
// coordinates, and forwards pointer/wheel/key events back as synthetic events. The central layout
// viewport is reported (never streamed): the host places its own views there.
// Wire format: see ModuleServer/python/gui_stream.py (Slicer-independent: pixels + generic events).

export interface Region { id: string; kind: string; title: string; x: number; y: number; w: number; h: number; z: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface MenuItem { id?: string; text?: string; shortcut?: string; enabled?: boolean; checkable?: boolean; checked?: boolean; sep?: boolean; items?: MenuItem[] }
export interface Menu { title: string; items: MenuItem[] }
/** One node of the streamed GUI's accessibility tree (region-local CSS px). */
export interface A11yNode { id: string; region: string; role: string; name: string; value?: unknown; x: number; y: number; w: number; h: number; enabled: boolean; focused: boolean; checked?: boolean }
export interface LinkStats { rttMs: number; bytesPerS: number; framesPerS: number; codec: string; quality: number }
export interface ViewCell { id: string; kind: "slice" | "3d" | "plot" | "table"; name: string; x: number; y: number; w: number; h: number; view: Rect }

export interface LegacyGuiOptions {
  onViewport?: (v: Rect, win: { w: number; h: number }) => void;
  onCells?: (cells: ViewCell[]) => void;                      // where the app laid out its view cells (window coords)
  onBlocked?: (info: { title: string; className: string } | null) => void;   // a modal dialog is waiting (null = cleared)
  onMenus?: (menus: Menu[]) => void;
  onTitle?: (title: string) => void;
  onStatus?: (s: string) => void;
  onA11y?: (nodes: A11yNode[]) => void;
  onStats?: (s: LinkStats) => void;
  /** Adaptive codec for slow links (default on): PNG while the link is good, WebP at falling quality when
   *  RTT or bytes/s exceed the budget. Set false to pin PNG. */
  adaptive?: boolean;
  hideKinds?: string[];           // e.g. ["menubar"] when the host provides native menus
}

const mods = (e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) =>
  ({ shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });

export class LegacyGui {
  private ws: WebSocket | null = null;
  private layers = new Map<string, { canvas: HTMLCanvasElement; region: Region }>();
  private pressed: { id: string; canvas: HTMLCanvasElement } | null = null;
  private dec = new TextDecoder();
  private ro: ResizeObserver;
  private dpr = 1;
  private hoverTimer: number | undefined;
  private a11yLayers = new Map<string, HTMLElement>();
  /** Latest accessibility tree from the server (see a11y ops below). */
  a11y: A11yNode[] = [];
  /** Link measurements: RTT from our pings, throughput from the server's stats reports. */
  stats: LinkStats = { rttMs: 0, bytesPerS: 0, framesPerS: 0, codec: "png", quality: 100 };
  private pingTimer: number | undefined;
  private rttSamples: number[] = [];
  private lastAdapt = 0;
  connected = false;

  constructor(private root: HTMLElement, private url: string, private opts: LegacyGuiOptions = {}) {
    if (getComputedStyle(root).position === "static") root.style.position = "relative";   // never override the host's absolute/inset layout
    this.ro = new ResizeObserver(() => this.sendResize());
    this.ro.observe(root);
    // keyboard: window-level so a click anywhere in the streamed chrome gives Qt the keys
    addEventListener("keydown", (e) => this.key(e, "down"), true);
    addEventListener("keyup", (e) => this.key(e, "up"), true);
  }

  connect() {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.connected = true; this.opts.onStatus?.("gui stream connected");
      ws.send(JSON.stringify({ op: "subscribe", dpr: 1, codec: this.stats.codec, quality: this.stats.quality })); this.sendResize();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ op: "ping", t: performance.now() }), 2000) as unknown as number;
    };
    ws.onclose = () => { this.connected = false; clearInterval(this.pingTimer); this.opts.onStatus?.("gui stream closed — retrying"); setTimeout(() => this.connect(), 1500); };
    ws.onmessage = (m) => (typeof m.data === "string" ? this.onText(JSON.parse(m.data)) : this.onFrame(new Uint8Array(m.data as ArrayBuffer)));
    this.ws = ws;
  }

  send(obj: Record<string, unknown>) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  triggerAction(id: string) { this.send({ op: "triggerAction", id }); }
  selectModule(name: string) { this.send({ op: "selectModule", name }); }
  private sendResize() { const r = this.root.getBoundingClientRect(); if (r.width > 0) this.send({ op: "resize", w: Math.round(r.width), h: Math.round(r.height) }); }

  private onText(j: Record<string, unknown>) {
    if (j.ev === "regions") this.applyRegions(j as unknown as { w: number; h: number; dpr?: number; viewport: Rect; regions: Region[]; cells?: ViewCell[] });
    else if (j.ev === "menus") this.opts.onMenus?.(j.menus as Menu[]);
    else if (j.ev === "title") this.opts.onTitle?.(j.text as string);
    else if (j.ev === "cursor") this.root.style.cursor = j.shape as string;
    else if (j.ev === "blocked") this.opts.onBlocked?.({ title: j.title as string, className: j.className as string });
    else if (j.ev === "unblocked") this.opts.onBlocked?.(null);
    else if (j.ev === "a11y") this.applyA11y(j.nodes as A11yNode[]);
    else if (j.ev === "pong") this.onPong(performance.now() - (j.t as number));
    else if (j.ev === "stats") { Object.assign(this.stats, { bytesPerS: j.bytesPerS, framesPerS: j.framesPerS, codec: j.codec, quality: j.quality }); this.opts.onStats?.(this.stats); }
    else if (j.ev === "error") console.warn("gui stream:", j);
  }

  private applyRegions(r: { w: number; h: number; dpr?: number; viewport: Rect; regions: Region[]; cells?: ViewCell[] }) {
    this.dpr = r.dpr ?? 1;
    const hide = new Set(this.opts.hideKinds ?? []);
    const seen = new Set<string>();
    for (const reg of r.regions) {
      if (hide.has(reg.kind)) continue;
      seen.add(reg.id);
      let l = this.layers.get(reg.id);
      if (!l) {
        const canvas = document.createElement("canvas");
        canvas.dataset.region = reg.id;
        canvas.className = "legacy-region " + reg.kind;
        canvas.style.position = "absolute";
        canvas.tabIndex = -1;
        this.attachPointer(canvas, reg.id);
        this.root.appendChild(canvas);
        l = { canvas, region: reg };
        this.layers.set(reg.id, l);
      }
      l.region = reg;
      const c = l.canvas;
      c.style.left = reg.x + "px"; c.style.top = reg.y + "px";
      c.style.width = reg.w + "px"; c.style.height = reg.h + "px";
      c.style.zIndex = String(reg.kind === "popup" ? 100 + reg.z : 10);
      const pw = Math.round(reg.w * this.dpr), ph = Math.round(reg.h * this.dpr);
      if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    }
    for (const [id, l] of this.layers) if (!seen.has(id)) { l.canvas.remove(); this.layers.delete(id); this.a11yLayers.get(id)?.remove(); this.a11yLayers.delete(id); }
    this.opts.onViewport?.(r.viewport, { w: r.w, h: r.h });
    if (r.cells) this.opts.onCells?.(r.cells);
  }

  // ---- accessibility overlay + automation (S12) --------------------------------------------
  // The pixels are opaque to assistive tech; the server publishes the widgets under every region as a
  // semantic tree and we mirror it as ARIA elements positioned over the canvas. They take no pointer
  // events (the pixels do) but are focusable/readable, and Enter/Space on one activates the real widget.
  private applyA11y(nodes: A11yNode[]) {
    this.a11y = nodes;
    const byRegion = new Map<string, A11yNode[]>();
    for (const n of nodes) { if (!byRegion.has(n.region)) byRegion.set(n.region, []); byRegion.get(n.region)!.push(n); }
    for (const [rid, l] of this.layers) {
      let layer = this.a11yLayers.get(rid);
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "legacy-a11y";
        layer.style.cssText = "position:absolute;pointer-events:none;overflow:hidden";
        layer.setAttribute("role", "group");
        this.root.appendChild(layer);
        this.a11yLayers.set(rid, layer);
      }
      const c = l.canvas;
      layer.style.left = c.style.left; layer.style.top = c.style.top; layer.style.width = c.style.width; layer.style.height = c.style.height;
      layer.style.zIndex = String(Number(c.style.zIndex) + 1);
      layer.setAttribute("aria-label", l.region.title || l.region.kind);
      const want = byRegion.get(rid) ?? [];
      const seen = new Set<string>();
      for (const n of want) {
        seen.add(n.id);
        let el = layer.querySelector<HTMLElement>(`[data-a11y="${n.id}"]`);
        if (!el) {
          el = document.createElement("div");
          el.dataset.a11y = n.id;
          el.style.cssText = "position:absolute;pointer-events:none;outline:none";
          el.addEventListener("focus", () => this.send({ op: "a11yFocus", id: n.id }));
          el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.send({ op: "a11yClick", id: n.id }); } });
          layer.appendChild(el);
        }
        el.setAttribute("role", n.role === "label" ? "text" : n.role);
        el.setAttribute("aria-label", n.name || n.role);
        if (n.value !== undefined && n.role !== "checkbox") el.setAttribute("aria-valuetext", String(n.value)); else el.removeAttribute("aria-valuetext");
        if (n.checked !== undefined) el.setAttribute("aria-checked", String(n.checked)); else el.removeAttribute("aria-checked");
        el.setAttribute("aria-disabled", String(!n.enabled));
        el.tabIndex = n.enabled && n.role !== "label" && n.role !== "group" ? 0 : -1;
        el.style.left = n.x + "px"; el.style.top = n.y + "px"; el.style.width = n.w + "px"; el.style.height = n.h + "px";
        if (n.focused && document.activeElement !== el && !(document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName))) el.focus({ preventScroll: true });
      }
      for (const el of [...layer.children]) if (!seen.has((el as HTMLElement).dataset.a11y!)) el.remove();
    }
    this.opts.onA11y?.(nodes);
  }
  /** Find tree nodes by name (string = case-insensitive substring, or a RegExp) and optional role. */
  find(name: string | RegExp, role?: string): A11yNode[] {
    const test = typeof name === "string" ? (s: string) => s.toLowerCase().includes(name.toLowerCase()) : (s: string) => name.test(s);
    return this.a11y.filter((n) => (!role || n.role === role) && test(n.name));
  }
  private one(name: string | RegExp, role?: string): A11yNode {
    const hits = this.find(name, role);
    if (!hits.length) throw new Error(`no ${role ?? "widget"} named ${name}`);
    return hits.find((n) => n.enabled) ?? hits[0];
  }
  /** Activate a widget by name (buttons click; anything else gets a press+release at its centre). */
  click(name: string | RegExp, role?: string) { const n = this.one(name, role); this.send({ op: "a11yClick", id: n.id }); return n; }
  /** Set a widget's value by name (text, number, checked, or combobox item text). */
  set(name: string | RegExp, value: unknown, role?: string) { const n = this.one(name, role); this.send({ op: "a11ySet", id: n.id, value }); return n; }
  focus(name: string | RegExp, role?: string) { const n = this.one(name, role); this.send({ op: "a11yFocus", id: n.id }); return n; }
  /** Ask the server for the tree now; resolves with the next tree that arrives. */
  refreshA11y(): Promise<A11yNode[]> {
    return new Promise((resolve) => { const prev = this.opts.onA11y; this.opts.onA11y = (n) => { this.opts.onA11y = prev; prev?.(n); resolve(n); }; this.send({ op: "a11yQuery" }); });
  }

  // ---- link adaptation (S13) --------------------------------------------------------------
  // Chrome is text: PNG is right on a LAN. On a slow/remote link the same dirty rects go as lossy
  // WebP at a quality that tracks the measured RTT and throughput, and climb back when it recovers.
  private onPong(rtt: number) {
    this.rttSamples.push(rtt); if (this.rttSamples.length > 5) this.rttSamples.shift();
    this.stats.rttMs = Math.round(this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length);
    this.opts.onStats?.(this.stats);
    if (this.opts.adaptive === false || performance.now() - this.lastAdapt < 4000) return;
    const slow = this.stats.rttMs > 120 || this.stats.bytesPerS > 1_500_000;
    const fast = this.stats.rttMs < 40 && this.stats.bytesPerS < 300_000;
    if (slow && (this.stats.codec === "png" || this.stats.quality > 40)) this.setQuality("webp", this.stats.codec === "png" ? 80 : this.stats.quality - 20);
    else if (fast && this.stats.codec !== "png") this.setQuality(this.stats.quality >= 90 ? "png" : "webp", Math.min(100, this.stats.quality + 10));
  }
  /** Pin the frame codec/quality (also what the adaptation calls). */
  setQuality(codec: "png" | "webp" | "jpeg", quality = 100) {
    this.lastAdapt = performance.now();
    this.stats.codec = codec; this.stats.quality = quality;
    this.send({ op: "quality", codec, quality });
  }

  private async onFrame(buf: Uint8Array) {
    const hl = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
    const hdr = JSON.parse(this.dec.decode(buf.subarray(4, 4 + hl))) as { region: string; x: number; y: number; w: number; h: number };
    const l = this.layers.get(hdr.region);
    if (!l) return;
    const fmt = (hdr as { fmt?: string }).fmt ?? "png";
    const bmp = await createImageBitmap(new Blob([buf.subarray(4 + hl)], { type: fmt === "webp" ? "image/webp" : fmt === "jpeg" ? "image/jpeg" : "image/png" }));
    const ctx = l.canvas.getContext("2d")!;
    const full = hdr.x === 0 && hdr.y === 0 && bmp.width >= l.canvas.width && bmp.height >= l.canvas.height;
    if (full && (l.canvas.width !== bmp.width || l.canvas.height !== bmp.height)) { l.canvas.width = bmp.width; l.canvas.height = bmp.height; }
    ctx.drawImage(bmp, Math.round(hdr.x * this.dpr), Math.round(hdr.y * this.dpr));   // partial (dirty-rect) or full frame
    bmp.close();
  }

  private attachPointer(canvas: HTMLCanvasElement, id: string) {
    const xy = (e: PointerEvent | WheelEvent | MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) }; };
    const ptr = (type: string, e: PointerEvent | MouseEvent) => this.send({ op: "pointer", type, region: id, ...xy(e), button: e.button, buttons: e.buttons, mods: mods(e) });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); this.pressed = { id, canvas }; ptr("down", e); });
    canvas.addEventListener("pointermove", (e) => {
      ptr("move", e);
      clearTimeout(this.hoverTimer);
      if (!e.buttons) this.hoverTimer = setTimeout(() => this.send({ op: "hover", region: id, ...xy(e) }), 700) as unknown as number;
    });
    canvas.addEventListener("pointerleave", () => clearTimeout(this.hoverTimer));
    canvas.addEventListener("pointerup", (e) => { ptr("up", e); this.pressed = null; try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ } });
    canvas.addEventListener("dblclick", (e) => ptr("dblclick", e));
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); this.send({ op: "wheel", region: id, ...xy(e), dx: e.deltaX, dy: e.deltaY, buttons: e.buttons, mods: mods(e) }); }, { passive: false });
  }

  private key(e: KeyboardEvent, type: "down" | "up") {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;   // host's own inputs
    if (e.metaKey && !e.shiftKey && /^[a-z]$/i.test(e.key)) return;                                  // leave ⌘-shortcuts to the host/native menus
    this.send({ op: "key", type, key: e.key, text: e.key.length === 1 ? e.key : "", mods: mods(e) });
    if (["Tab", "Backspace", " ", "ArrowUp", "ArrowDown"].includes(e.key)) e.preventDefault();
  }
}
