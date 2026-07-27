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
export interface ChromeOpts {
  controls?: VizControl[];                                   // viz toggles (empty → branding only)
  help?: { title: string; rows: [string, string][] }[];     // override the default cheat-sheet
  onChange?: () => void;                                     // after a toggle (redraw)
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

  // ---- SlicerLive logo mark (top-right, the hover target) + viz-controls popup ----
  const logo = document.createElement("img");
  logo.src = SL_LOGO;
  logo.alt = "SlicerLive";
  logo.title = "SlicerLive — visualization";
  logo.style.cssText = "position:fixed;top:7px;right:12px;z-index:74;cursor:pointer;user-select:none;height:36px;width:auto;" +
    "filter:drop-shadow(0 2px 6px rgba(0,0,0,.5));transition:transform 120ms ease-out;";
  document.body.appendChild(logo);

  const pop = document.createElement("div");
  pop.style.cssText = "position:fixed;top:42px;right:12px;z-index:73;min-width:180px;padding:10px 12px;border-radius:12px;" +
    "color:#eaf0ff;font:13px -apple-system,system-ui,sans-serif;opacity:0;pointer-events:none;transform:translateY(-6px);" +
    "transition:opacity 120ms ease-out,transform 120ms ease-out;";
  glass(pop);
  document.body.appendChild(pop);

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
      row.onclick = () => { if (c.disabled?.()) return; c.set(!c.get()); opts.onChange?.(); refresh(); };
      pop.appendChild(row);
      rows.push({ c, row, sw });
    }
  } else {
    pop.textContent = "SlicerLive — WebGPU renderer";
  }

  function refresh() {
    for (const { c, row, sw } of rows) {
      const on = c.get(), dis = c.disabled?.() ?? false;
      row.style.opacity = dis ? "0.4" : "1";
      row.style.cursor = dis ? "default" : "pointer";
      sw.style.background = on ? "linear-gradient(180deg,#9fe9ff,#54c6f0)" : "rgba(255,255,255,.18)";
      sw.innerHTML = `<span style="position:absolute;top:2px;left:${on ? 17 : 2}px;width:15px;height:15px;border-radius:50%;background:#fff;transition:left 120ms;box-shadow:0 1px 3px rgba(0,0,0,.4)"></span>`;
    }
  }
  refresh();

  const show = () => { pop.style.opacity = "1"; pop.style.pointerEvents = "auto"; pop.style.transform = "translateY(0)"; };
  const hide = () => { pop.style.opacity = "0"; pop.style.pointerEvents = "none"; pop.style.transform = "translateY(-6px)"; };
  let pinned = false;
  logo.onmouseenter = () => { logo.style.transform = "scale(1.08)"; show(); };
  logo.onclick = () => { pinned = !pinned; pinned ? show() : hide(); };
  logo.onmouseleave = () => { logo.style.transform = "scale(1)"; if (!pinned) setTimeout(() => { if (!pop.matches(":hover") && !pinned) hide(); }, 120); };
  pop.onmouseleave = () => { if (!pinned) hide(); };

  return { refresh };
}
