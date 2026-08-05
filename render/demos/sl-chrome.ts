// Shared demo "chrome" for ALL SlicerLive demos (DRY): a SlicerLive logo mark (top-right) whose
// hover/click popup holds visualization controls (toggles the demo supplies), and a "?" button
// (top-left) that opens a glass cheat-sheet of the mouse/trackpad/keyboard bindings. Ported from the
// legacy help-overlay.js so the WebGPU demos feel like the old vtk.js ones. Self-contained DOM — no
// render deps; each demo calls installChrome({...}) from its entry.
import { SL_LOGO } from "./sl-logo.ts";

export interface VizControl {
  label: string;
  get: () => boolean;
  set: (on: boolean) => void;
  disabled?: () => boolean;    // e.g. no segmentation to toggle
}
export interface SegInfo { num: number; name: string; color: [number, number, number] }
export interface SegmentControls {
  list: () => SegInfo[];              // the current case's segments (re-read each time the popup opens)
  get: (num: number) => number;       // current opacity level (tri-state: 1, 0.5, or 0)
  cycle: (num: number) => void;       // advance one tri-state step (1 → 0.5 → 0 → 1)
  enabled?: () => boolean;            // dim the whole section when there's nothing to toggle
}
export interface ChromeOpts {
  controls?: VizControl[];                                   // viz toggles (empty → branding only)
  segments?: SegmentControls;                                // per-segment visibility list (swatch + toggle)
  help?: { title: string; rows: [string, string][] }[];     // override the default cheat-sheet
  onChange?: () => void;                                     // after a toggle (redraw)
  anchor?: HTMLElement;                                      // float the badge over this element's top-right corner (e.g. the 3D cell); falls back to the viewport corner when hidden/absent
  about?: { label?: string; url?: string } | false;         // "About" row at the popup bottom (default: About SlicerLive → repo); false to omit
}
export interface Chrome { refresh(): void }

const DEFAULT_HELP: { title: string; rows: [string, string][] }[] = [
  { title: "3D view", rows: [
    ["Left-drag", "Rotate"], ["Right-drag", "Zoom"], ["Middle / Shift+Left-drag", "Pan"],
    ["Wheel / two-finger", "Zoom (dolly)"], ["Double-click", "Maximize / restore"],
    ["Shift + move", "Pick → jump slices to the point"],
  ] },
  { title: "Slice views", rows: [
    ["Wheel / Left-drag", "Scroll through slices"], ["Right-drag / ⌘-wheel", "Zoom this slice"],
    ["Middle / Shift+Left-drag", "Pan"], ["Double-click", "Maximize / restore"], ["R", "Reset pan/zoom"],
    ["Shift + move", "Jump the other views to the point under the cursor"],
  ] },
];

function glass(el: HTMLElement, extra = "") {
  el.style.cssText += ";background:linear-gradient(135deg,rgba(58,64,88,.55),rgba(20,24,38,.66));" +
    "backdrop-filter:blur(20px) saturate(1.6);-webkit-backdrop-filter:blur(20px) saturate(1.6);" +
    "border:1px solid rgba(255,255,255,.2);box-shadow:0 18px 50px rgba(0,0,0,.55);" + extra;
}

export function installChrome(opts: ChromeOpts): Chrome {
  const controls = opts.controls ?? [];
  const help = opts.help ?? DEFAULT_HELP;

  // ---- "?" help button (top-left) ----
  const helpBtn = document.createElement("button");
  helpBtn.textContent = "?";
  helpBtn.title = "Controls & key bindings";
  helpBtn.style.cssText = "position:fixed;top:12px;left:12px;z-index:74;width:32px;height:32px;padding:0;cursor:pointer;" +
    "display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#cfe6ff;" +
    "font:700 15px -apple-system,system-ui,sans-serif;";
  glass(helpBtn);
  helpBtn.onclick = openHelp;
  document.body.appendChild(helpBtn);

  let helpEl: HTMLElement | null = null;
  function openHelp() {
    if (helpEl) return;
    helpEl = document.createElement("div");
    helpEl.style.cssText = "position:fixed;inset:0;z-index:96;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(6,8,14,.55);font:13px/1.5 -apple-system,system-ui,sans-serif;color:#e8eeff;";
    helpEl.addEventListener("mousedown", (e) => { if (e.target === helpEl) closeHelp(); });
    const panel = document.createElement("div");
    panel.style.cssText = "max-width:min(640px,92vw);max-height:86vh;overflow-y:auto;padding:22px 26px;border-radius:16px;color:#eaf0ff;";
    glass(panel);
    panel.innerHTML = `<div style="font:800 20px -apple-system,system-ui,sans-serif;margin-bottom:4px">SlicerLive — controls</div>`;
    for (const sec of help) {
      const rows = sec.rows.map(([k, d]) =>
        `<div style="font:600 12px ui-monospace,Menlo,monospace;color:#fff5d6;white-space:nowrap">${k}</div>` +
        `<div style="color:rgba(232,238,255,.85)">${d}</div>`).join("");
      panel.innerHTML += `<div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)">` +
        `<div style="font:700 11px -apple-system,system-ui,sans-serif;letter-spacing:1.1px;text-transform:uppercase;color:#9fe9ff;margin-bottom:9px">${sec.title}</div>` +
        `<div style="display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;align-items:baseline">${rows}</div></div>`;
    }
    panel.innerHTML += `<div style="margin-top:16px;font-size:12px;color:rgba(232,238,255,.55)">Press <b style="color:#fff5d6">esc</b> or click outside to dismiss.</div>`;
    helpEl.appendChild(panel);
    document.body.appendChild(helpEl);
    document.addEventListener("keydown", escClose, true);
  }
  function escClose(e: KeyboardEvent) { if (e.key === "Escape") closeHelp(); }
  function closeHelp() { if (helpEl) { helpEl.remove(); helpEl = null; document.removeEventListener("keydown", escClose, true); } }

  // ---- SlicerLive logo BADGE (dark rounded mark + "SlicerLive" wordmark), floated over the corner
  // of the 3D view (opts.anchor) like the legacy demo — readable, and the hover target for the popup.
  const logo = document.createElement("div");
  logo.title = "SlicerLive — visualization";
  logo.style.cssText = "position:fixed;z-index:74;cursor:pointer;user-select:none;display:flex;flex-direction:column;" +
    "align-items:center;gap:4px;padding:7px 12px 6px;border-radius:14px;background:#121826;" +
    "border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06);" +
    "transition:transform 120ms ease-out;";
  const mark = document.createElement("img");
  mark.src = SL_LOGO; mark.alt = "SlicerLive";
  mark.style.cssText = "height:40px;width:auto;display:block;filter:drop-shadow(0 0 5px rgba(255,200,80,.5));";
  const word = document.createElement("div");
  word.innerHTML = 'Slicer<b style="color:#ffd34d">Live</b>';
  word.style.cssText = "font:800 12px/1 -apple-system,system-ui,sans-serif;letter-spacing:.5px;color:#eef7ff;" +
    "text-shadow:0 0 14px rgba(255,210,90,.4);";
  logo.appendChild(mark); logo.appendChild(word);
  document.body.appendChild(logo);

  // Keep the badge pinned to the anchor's (3D cell) top-right corner; fall back to the viewport corner
  // when the anchor is hidden (another view maximized) or absent.
  const place = () => {
    const a = opts.anchor;
    const r = a && a.getClientRects().length ? a.getBoundingClientRect() : null;
    if (r && r.width > 2 && r.height > 2) {
      logo.style.top = Math.round(r.top + 8) + "px";
      logo.style.right = Math.round(window.innerWidth - r.right + 8) + "px";
    } else {
      logo.style.top = "10px"; logo.style.right = "12px";
    }
  };
  place();
  requestAnimationFrame(place);
  globalThis.addEventListener("resize", place);
  if (opts.anchor && "ResizeObserver" in globalThis) new ResizeObserver(place).observe(opts.anchor);

  const pop = document.createElement("div");
  pop.style.cssText = "position:fixed;z-index:73;min-width:210px;max-width:300px;max-height:84vh;overflow-y:auto;padding:10px 12px;border-radius:12px;" +
    "color:#eaf0ff;font:13px -apple-system,system-ui,sans-serif;opacity:0;pointer-events:none;transform:translateY(-6px);" +
    "transition:opacity 120ms ease-out,transform 120ms ease-out;";
  glass(pop);
  document.body.appendChild(pop);

  // Toggle responsiveness (user report): a change can be heavy (re-bake + scene rebuild), and running
  // it synchronously in the click handler froze even the checkbox until the render finished. Instead:
  // paint the switch optimistically, then run the change AFTER the browser has painted (double-rAF =
  // one frame to show the flipped switch, then do the work) — so the UI is instant and the render
  // enters the adaptive/progressive path (draw3d = kick) instead of blocking.
  const paintSw = (sw: HTMLElement, on: boolean) => {
    sw.style.background = on ? "linear-gradient(180deg,#9fe9ff,#54c6f0)" : "rgba(255,255,255,.18)";
    sw.innerHTML = `<span style="position:absolute;top:2px;left:${on ? 17 : 2}px;width:15px;height:15px;border-radius:50%;background:#fff;transition:left 120ms;box-shadow:0 1px 3px rgba(0,0,0,.4)"></span>`;
  };
  const afterPaint = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

  // Tri-state per-segment opacity box: a rounded chip whose fill width + tint (the segment colour)
  // tracks the level, with a percent label — reads clearly as 100% / 50% / 0% and cycles on click.
  const paintTri = (box: HTMLElement, level: number, color: [number, number, number]) => {
    const pct = Math.round(level * 100);
    const c = `rgb(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)})`;
    box.style.opacity = level === 0 ? "0.75" : "1";
    box.innerHTML =
      `<span style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:${c};opacity:.9"></span>` +
      `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;` +
      `font:700 10px -apple-system,system-ui,sans-serif;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.75)">${pct}%</span>`;
  };

  const rows: { c: VizControl; row: HTMLElement; sw: HTMLElement }[] = [];
  if (controls.length) {
    const head = document.createElement("div");
    head.textContent = "Visualization";
    head.style.cssText = "font:700 10px -apple-system,system-ui,sans-serif;letter-spacing:1.1px;text-transform:uppercase;color:#9fe9ff;margin:0 0 8px;";
    pop.appendChild(head);
    for (const c of controls) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:14px;padding:5px 0;cursor:pointer;";
      const lab = document.createElement("span"); lab.textContent = c.label;
      const sw = document.createElement("span");   // toggle pill
      sw.style.cssText = "width:34px;height:19px;border-radius:999px;position:relative;transition:background 120ms;flex:0 0 auto;";
      row.appendChild(lab); row.appendChild(sw);
      row.onclick = () => { if (c.disabled?.()) return; const next = !c.get(); paintSw(sw, next); afterPaint(() => { c.set(next); opts.onChange?.(); refresh(); }); };
      pop.appendChild(row);
      rows.push({ c, row, sw });
    }
  } else if (opts.about === false && !opts.segments) {
    pop.textContent = "SlicerLive — WebGPU renderer";
  }

  // ---- per-segment opacity (swatch + tri-state box), rebuilt from the current case on each open ----
  const segHost = document.createElement("div");
  pop.appendChild(segHost);
  const segRows: { num: number; box: HTMLElement; color: [number, number, number] }[] = [];
  function buildSegments() {
    const S = opts.segments;
    segRows.length = 0; segHost.innerHTML = "";
    if (!S) return;
    const list = S.list();
    if (!list.length) return;
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:6px;border-top:1px solid rgba(255,255,255,.12);padding-top:6px;" +
      (list.length > 6 ? "max-height:210px;overflow-y:auto;" : "");
    for (const s of list) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 2px;cursor:pointer;";
      const left = document.createElement("span");
      left.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0;";
      const swatch = document.createElement("span");
      swatch.style.cssText = `flex:0 0 auto;width:11px;height:11px;border-radius:3px;box-shadow:0 0 0 1px rgba(255,255,255,.25);background:rgb(${Math.round(s.color[0] * 255)},${Math.round(s.color[1] * 255)},${Math.round(s.color[2] * 255)})`;
      const lab = document.createElement("span");
      lab.textContent = s.name;
      lab.style.cssText = "font:500 12.5px -apple-system,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      left.appendChild(swatch); left.appendChild(lab);
      const box = document.createElement("span");
      box.title = "Opacity: click to cycle 100% → 50% → off";
      box.style.cssText = "width:40px;height:18px;border-radius:6px;position:relative;overflow:hidden;flex:0 0 auto;" +
        "background:rgba(255,255,255,.14);box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);";
      row.appendChild(left); row.appendChild(box);
      row.onclick = () => {
        if (S.enabled && !S.enabled()) return;
        const next = ({ 1: 0.5, 0.5: 0, 0: 1 } as Record<number, number>)[S.get(s.num)] ?? 1;
        paintTri(box, next, s.color);                        // optimistic paint
        afterPaint(() => { S.cycle(s.num); refresh(); });
      };
      wrap.appendChild(row);
      segRows.push({ num: s.num, box, color: s.color });
    }
    segHost.appendChild(wrap);
    paintSegments();
  }
  function paintSegments() {
    const S = opts.segments;
    if (!S) return;
    const dis = S.enabled ? !S.enabled() : false;
    segHost.style.opacity = dis ? "0.4" : "1";
    for (const { num, box, color } of segRows) paintTri(box, S.get(num), color);
  }

  // ---- "About SlicerLive" row (matches the legacy popup) ----
  if (opts.about !== false) {
    const about = document.createElement("div");
    const aLabel = opts.about?.label ?? "About SlicerLive";
    const aURL = opts.about?.url ?? "https://github.com/pieper/SlicerLive";
    about.textContent = aLabel;
    about.style.cssText = "cursor:pointer;border-radius:9px;padding:9px 8px 3px;margin-top:4px;" +
      (controls.length || opts.segments ? "border-top:1px solid rgba(255,255,255,.12);" : "") +
      "font:600 13px -apple-system,system-ui,sans-serif;color:#9fe9ff;";
    about.onmouseenter = () => { about.style.background = "rgba(255,255,255,.07)"; };
    about.onmouseleave = () => { about.style.background = "transparent"; };
    about.onclick = (e) => { e.stopPropagation(); globalThis.open(aURL, "_blank", "noopener"); };
    pop.appendChild(about);
  }

  function refresh() {
    for (const { c, row, sw } of rows) {
      const on = c.get(), dis = c.disabled?.() ?? false;
      row.style.opacity = dis ? "0.4" : "1";
      row.style.cursor = dis ? "default" : "pointer";
      sw.style.background = on ? "linear-gradient(180deg,#9fe9ff,#54c6f0)" : "rgba(255,255,255,.18)";
      sw.innerHTML = `<span style="position:absolute;top:2px;left:${on ? 17 : 2}px;width:15px;height:15px;border-radius:50%;background:#fff;transition:left 120ms;box-shadow:0 1px 3px rgba(0,0,0,.4)"></span>`;
    }
    paintSegments();
  }
  refresh();

  const show = () => {
    buildSegments();                            // fresh per-case segment list each open
    refresh();
    const b = logo.getBoundingClientRect();     // anchor the popup just below the badge
    pop.style.top = Math.round(b.bottom + 6) + "px";
    pop.style.right = Math.round(window.innerWidth - b.right) + "px";
    pop.style.opacity = "1"; pop.style.pointerEvents = "auto"; pop.style.transform = "translateY(0)";
  };
  const hide = () => { pop.style.opacity = "0"; pop.style.pointerEvents = "none"; pop.style.transform = "translateY(-6px)"; };
  let pinned = false;
  logo.onmouseenter = () => { logo.style.transform = "scale(1.08)"; show(); };
  logo.onclick = () => { pinned = !pinned; pinned ? show() : hide(); };
  logo.onmouseleave = () => { logo.style.transform = "scale(1)"; if (!pinned) setTimeout(() => { if (!pop.matches(":hover") && !pinned) hide(); }, 120); };
  pop.onmouseleave = () => { if (!pinned) hide(); };

  return { refresh };
}
