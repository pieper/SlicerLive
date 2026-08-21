// A volume-rendering preset picker modal (OHIF-style) whose thumbnails are the CURRENTLY loaded
// volume rendered with each preset at the CURRENT camera — generated on the fly, not canned images
// of some other dataset. The caller renders each preset into a small <canvas> (WebGPU) and hands
// this the ready canvases; the modal just lays them out as a clickable grid.

export interface VrPresetItem {
  name: string | null; // preset id, or null for the grayscale default
  label: string;
  canvas: HTMLCanvasElement; // already-rendered thumbnail of THIS volume with this preset
}

/** Open the preset grid. Clicking a tile calls onPick and closes. */
export function openVrPresetMenu(opts: {
  items: VrPresetItem[];
  current: string | null;
  onPick: (name: string | null) => void;
}): void {
  if (document.getElementById("vr-preset-menu")) return;
  const overlay = document.createElement("div");
  overlay.id = "vr-preset-menu";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2100;background:rgba(5,6,10,.82);display:flex;align-items:center;justify-content:center;";
  const card = document.createElement("div");
  card.style.cssText =
    "background:#11141d;border:1px solid #33507e;border-radius:12px;padding:18px 20px;max-width:min(720px,94vw);" +
    "max-height:88vh;overflow-y:auto;font:13px -apple-system,system-ui,sans-serif;color:#d6e2f2;";
  card.innerHTML =
    `<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;">` +
    `<h3 style="margin:0;color:#fff;font-size:16px;">Volume rendering preset</h3>` +
    `<span style="color:#5a6b85;font-size:11px;">Slicer CT presets · thumbnails rendered from this study</span></div>`;
  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;";
  card.appendChild(grid);

  const close = () => overlay.remove();
  for (const it of opts.items) {
    const cell = document.createElement("button");
    const sel = it.name === opts.current;
    cell.style.cssText =
      "display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px 6px 7px;cursor:pointer;" +
      "background:" + (sel ? "rgba(84,198,240,.18)" : "rgba(255,255,255,.04)") + ";" +
      "border:1px solid " + (sel ? "#54c6f0" : "rgba(255,255,255,.12)") + ";border-radius:10px;color:#eaf0ff;";
    it.canvas.style.cssText = "width:110px;height:110px;border-radius:7px;background:#05060a;display:block;";
    const lab = document.createElement("div");
    lab.textContent = it.label;
    lab.style.cssText = "font:600 11.5px -apple-system,system-ui,sans-serif;text-align:center;white-space:nowrap;" +
      "overflow:hidden;text-overflow:ellipsis;max-width:110px;" + (sel ? "color:#9fe9ff;" : "");
    cell.appendChild(it.canvas); cell.appendChild(lab);
    cell.onclick = () => { opts.onPick(it.name); close(); };
    grid.appendChild(cell);
  }
  overlay.appendChild(card);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc, true); } };
  document.addEventListener("keydown", esc, true);
  document.body.appendChild(overlay);
}
