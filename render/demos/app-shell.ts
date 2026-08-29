// The native SlicerLive application shell — the frame the workflow panels (W1..W7) mount into.
// "Feel like Slicer, modernized": a module sidebar with a panel registry, a toolbar row, the view area,
// a status line; dark theme tokens from theme.css (Slicer's Red/Yellow/Green view colours preserved,
// logo palette for accents). Plain DOM, no framework, no render/ dependency: anything that renders
// mounts into `main` (mountLiveViews) and anything with controls registers a panel.
//
// Usage:
//   const shell = mountAppShell(document.body, { title: "SlicerLive" });
//   shell.registerPanel({ id: "welcome", title: "Welcome", mount(el) { ... } });
//   const views = mountLiveViews(gpu, shell.main, {...});
//   shell.onMainResize(() => views.setCells(fourUp(shell.main)));

export interface PanelSpec {
  id: string;
  title: string;
  /** Called once, the first time the panel is shown; the element persists (hidden when another panel is active). */
  mount(el: HTMLElement, shell: AppShell): void | Promise<void>;
  /** Called every time the panel becomes active (refresh lists, etc.). */
  onShow?(el: HTMLElement): void;
  order?: number;           // sidebar order (lower first); default = registration order
}

export interface AppShell {
  root: HTMLElement;
  sidebar: HTMLElement;     // the panel column
  toolbar: HTMLElement;     // above the views: layout picker, view controllers' global toggles, etc.
  main: HTMLElement;        // the view area (position: relative; children absolutely placed)
  statusEl: HTMLElement;
  registerPanel(spec: PanelSpec): void;
  showPanel(id: string): Promise<void>;
  activePanel(): string | null;
  panels(): PanelSpec[];
  setStatus(text: string): void;
  /** Register a callback for main-area size changes (also called once on registration). */
  onMainResize(fn: (rect: DOMRect) => void): () => void;
  /** Add a toolbar button (returns the element). */
  toolButton(label: string, onClick: () => void, opts?: { title?: string; icon?: string; group?: string }): HTMLButtonElement;
  setSidebarVisible(v: boolean): void;
}

export interface ShellOptions {
  title?: string;
  sidebarWidth?: number;    // px, default 320
  container?: HTMLElement;  // defaults to `root` itself being filled
}

/** A 2×2 FourUp arrangement over `rect` (viewport coords), the standalone default until the layout engine (W2). */
export function fourUpCells(rect: DOMRect): { id: string; kind: "slice" | "3d"; name: string; view: { x: number; y: number; w: number; h: number } }[] {
  const gap = 2, w = (rect.width - gap) / 2, h = (rect.height - gap) / 2;
  const cell = (name: string, kind: "slice" | "3d", col: number, row: number) => ({ id: name, kind, name, view: { x: rect.left + col * (w + gap), y: rect.top + row * (h + gap), w, h } });
  return [cell("Red", "slice", 0, 0), cell("1", "3d", 1, 0), cell("Yellow", "slice", 0, 1), cell("Green", "slice", 1, 1)];
}

export function mountAppShell(root: HTMLElement, opts: ShellOptions = {}): AppShell {
  const sidebarWidth = opts.sidebarWidth ?? 320;
  root.classList.add("sl-app");
  root.innerHTML = `
    <div class="sl-top">
      <div class="sl-brand"><span class="sl-brand-mark"></span><span class="sl-brand-name">${opts.title ?? "SlicerLive"}</span></div>
      <div class="sl-modules"><label class="sl-modules-label">Modules:</label><select class="sl-module-select" aria-label="Module"></select></div>
      <div class="sl-toolbar" role="toolbar"></div>
    </div>
    <div class="sl-body">
      <aside class="sl-sidebar" style="width:${sidebarWidth}px"><div class="sl-panels"></div></aside>
      <div class="sl-splitter" role="separator" aria-orientation="vertical"></div>
      <div class="sl-main"></div>
    </div>
    <div class="sl-status" role="status"></div>`;
  const $ = (sel: string) => root.querySelector(sel) as HTMLElement;
  const sidebar = $(".sl-sidebar"), panelsEl = $(".sl-panels"), toolbar = $(".sl-toolbar"), main = $(".sl-main"), statusEl = $(".sl-status");
  const select = $(".sl-module-select") as HTMLSelectElement;
  const splitter = $(".sl-splitter");

  const specs: PanelSpec[] = [];
  const els = new Map<string, HTMLElement>();
  const mounted = new Set<string>();
  let active: string | null = null;

  const rebuildSelect = () => {
    const sorted = [...specs].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || specs.indexOf(a) - specs.indexOf(b));
    select.innerHTML = "";
    for (const s of sorted) { const o = document.createElement("option"); o.value = s.id; o.textContent = s.title; select.appendChild(o); }
    if (active) select.value = active;
  };

  async function showPanel(id: string) {
    const spec = specs.find((s) => s.id === id);
    if (!spec) return;
    let el = els.get(id);
    if (!el) { el = document.createElement("section"); el.className = "sl-panel"; el.dataset.panel = id; el.hidden = true; panelsEl.appendChild(el); els.set(id, el); }
    for (const [pid, pel] of els) pel.hidden = pid !== id;
    active = id; select.value = id;
    if (!mounted.has(id)) { mounted.add(id); await spec.mount(el, shell); }
    spec.onShow?.(el);
    try { localStorage.setItem("sl.activePanel", id); } catch { /* private mode */ }
  }
  select.addEventListener("change", () => void showPanel(select.value));

  // sidebar splitter drag
  let dragging = false;
  splitter.addEventListener("pointerdown", (e) => { dragging = true; splitter.setPointerCapture(e.pointerId); e.preventDefault(); });
  splitter.addEventListener("pointermove", (e) => { if (!dragging) return; const w = Math.max(200, Math.min(640, e.clientX - root.getBoundingClientRect().left)); sidebar.style.width = w + "px"; });
  splitter.addEventListener("pointerup", () => { dragging = false; });

  const resizeFns = new Set<(r: DOMRect) => void>();
  const ro = new ResizeObserver(() => { const r = main.getBoundingClientRect(); for (const fn of resizeFns) fn(r); });
  ro.observe(main);

  const shell: AppShell = {
    root, sidebar, toolbar, main, statusEl,
    registerPanel(spec) {
      if (specs.some((s) => s.id === spec.id)) throw new Error(`panel ${spec.id} already registered`);
      specs.push(spec); rebuildSelect();
      if (!active) { let last: string | null = null; try { last = localStorage.getItem("sl.activePanel"); } catch { /* */ } void showPanel(last && specs.some((s) => s.id === last) ? last : spec.id); }
    },
    showPanel, activePanel: () => active, panels: () => [...specs],
    setStatus(text) { statusEl.textContent = text; },
    onMainResize(fn) { resizeFns.add(fn); fn(main.getBoundingClientRect()); return () => resizeFns.delete(fn); },
    toolButton(label, onClick, o = {}) {
      const b = document.createElement("button"); b.type = "button"; b.className = "sl-tool"; b.textContent = o.icon ? `${o.icon} ${label}` : label; b.title = o.title ?? label;
      if (o.group) b.dataset.group = o.group;
      b.addEventListener("click", onClick); toolbar.appendChild(b); return b;
    },
    setSidebarVisible(v) { sidebar.style.display = v ? "" : "none"; splitter.style.display = v ? "" : "none"; },
  };
  return shell;
}
