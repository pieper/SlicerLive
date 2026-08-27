// LegacyGui — client of a ModuleServer/AppServer GUI stream (WS B). Streams the legacy app's chrome
// (toolbars, docks, status bar, popups/dialogs) as per-region PNG frames positioned in WINDOW
// coordinates, and forwards pointer/wheel/key events back as synthetic events. The central layout
// viewport is reported (never streamed): the host places its own views there.
// Wire format: see ModuleServer/python/gui_stream.py (Slicer-independent: pixels + generic events).

export interface Region { id: string; kind: string; title: string; x: number; y: number; w: number; h: number; z: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface MenuItem { id?: string; text?: string; shortcut?: string; enabled?: boolean; checkable?: boolean; checked?: boolean; sep?: boolean; items?: MenuItem[] }
export interface Menu { title: string; items: MenuItem[] }

export interface LegacyGuiOptions {
  onViewport?: (v: Rect, win: { w: number; h: number }) => void;
  onMenus?: (menus: Menu[]) => void;
  onTitle?: (title: string) => void;
  onStatus?: (s: string) => void;
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
    ws.onopen = () => { this.connected = true; this.opts.onStatus?.("gui stream connected"); ws.send(JSON.stringify({ op: "subscribe", dpr: 1 })); this.sendResize(); };
    ws.onclose = () => { this.connected = false; this.opts.onStatus?.("gui stream closed — retrying"); setTimeout(() => this.connect(), 1500); };
    ws.onmessage = (m) => (typeof m.data === "string" ? this.onText(JSON.parse(m.data)) : this.onFrame(new Uint8Array(m.data as ArrayBuffer)));
    this.ws = ws;
  }

  send(obj: Record<string, unknown>) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  triggerAction(id: string) { this.send({ op: "triggerAction", id }); }
  selectModule(name: string) { this.send({ op: "selectModule", name }); }
  private sendResize() { const r = this.root.getBoundingClientRect(); if (r.width > 0) this.send({ op: "resize", w: Math.round(r.width), h: Math.round(r.height) }); }

  private onText(j: Record<string, unknown>) {
    if (j.ev === "regions") this.applyRegions(j as unknown as { w: number; h: number; viewport: Rect; regions: Region[] });
    else if (j.ev === "menus") this.opts.onMenus?.(j.menus as Menu[]);
    else if (j.ev === "title") this.opts.onTitle?.(j.text as string);
    else if (j.ev === "error") console.warn("gui stream:", j);
  }

  private applyRegions(r: { w: number; h: number; viewport: Rect; regions: Region[] }) {
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
      if (c.width !== reg.w || c.height !== reg.h) { c.width = reg.w; c.height = reg.h; }
    }
    for (const [id, l] of this.layers) if (!seen.has(id)) { l.canvas.remove(); this.layers.delete(id); }
    this.opts.onViewport?.(r.viewport, { w: r.w, h: r.h });
  }

  private async onFrame(buf: Uint8Array) {
    const hl = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
    const hdr = JSON.parse(this.dec.decode(buf.subarray(4, 4 + hl))) as { region: string; w: number; h: number };
    const l = this.layers.get(hdr.region);
    if (!l) return;
    const bmp = await createImageBitmap(new Blob([buf.subarray(4 + hl)], { type: "image/png" }));
    const ctx = l.canvas.getContext("2d")!;
    if (l.canvas.width !== bmp.width || l.canvas.height !== bmp.height) { l.canvas.width = bmp.width; l.canvas.height = bmp.height; }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
  }

  private attachPointer(canvas: HTMLCanvasElement, id: string) {
    const xy = (e: PointerEvent | WheelEvent | MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) }; };
    const ptr = (type: string, e: PointerEvent | MouseEvent) => this.send({ op: "pointer", type, region: id, ...xy(e), button: e.button, buttons: e.buttons, mods: mods(e) });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); this.pressed = { id, canvas }; ptr("down", e); });
    canvas.addEventListener("pointermove", (e) => ptr("move", e));
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
