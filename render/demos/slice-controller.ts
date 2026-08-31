// Slice-view controller bar (W2) — the thin coloured bar Slicer shows above each slice view: orientation,
// an offset slider (mm along the normal, from vtkMRMLSliceLogic::GetSliceOffsetRangeResolution), and a fit
// button. Plain DOM in the theme; a pure adapter supplies the data so it works over native sliceView nodes
// and over a Slicer peer's slice nodes alike. Reuses the app theme tokens (--sl-view-* per cell colour).
export interface SliceControllerAdapter {
  orientation(): "axial" | "coronal" | "sagittal" | null;
  offset(): number | null;
  range(): { min: number; max: number; step: number } | null;
  setOffset(mm: number): void;
  fit(): void;
  /** optional reformat: when present the orientation shows as a combo (Slicer's orientation menu). */
  setOrientation?(o: "axial" | "coronal" | "sagittal"): void;
  /** optional "show this slice in the 3D view" (Slice Model / Drop-Slice) toggle + current state. */
  toggle3D?(): void;
  in3D?(): boolean;
  /** subscribe to external offset/geometry changes (scroll, jump) so the bar re-reads; returns unsubscribe */
  onChange(cb: () => void): () => void;
}

const ORIENT_LABEL: Record<string, string> = { axial: "Axial", coronal: "Coronal", sagittal: "Sagittal" };

export interface SliceController { el: HTMLElement; refresh(): void; detach(): void }

/** Mount a controller bar as the first child of a slice cell element. `cellName` picks the accent colour. */
export function mountSliceController(host: HTMLElement, cellName: string, a: SliceControllerAdapter): SliceController {
  const bar = document.createElement("div");
  bar.className = "sl-slice-bar";
  bar.dataset.cell = cellName;
  const orientHtml = a.setOrientation
    ? `<select class="sl-slice-orient" aria-label="Slice orientation"><option value="axial">Axial</option><option value="sagittal">Sagittal</option><option value="coronal">Coronal</option></select>`
    : `<span class="sl-slice-orient"></span>`;
  bar.innerHTML = `
    ${orientHtml}
    <input class="sl-slice-offset" type="range" step="any" aria-label="Slice offset">
    <span class="sl-slice-value"></span>
    ${a.toggle3D ? `<button class="sl-slice-3d" title="Show this slice in 3D">3D</button>` : ""}
    <button class="sl-slice-fit" title="Fit to volume">⤢</button>`;
  host.appendChild(bar);
  const orient = bar.querySelector(".sl-slice-orient") as HTMLElement;
  if (a.setOrientation) (orient as HTMLSelectElement).addEventListener("change", (e) => { a.setOrientation!((e.target as HTMLSelectElement).value as "axial" | "coronal" | "sagittal"); });
  const slider = bar.querySelector(".sl-slice-offset") as HTMLInputElement;
  const value = bar.querySelector(".sl-slice-value") as HTMLElement;
  const fit = bar.querySelector(".sl-slice-fit") as HTMLButtonElement;
  const btn3d = bar.querySelector(".sl-slice-3d") as HTMLButtonElement | null;

  let editing = false;
  const refresh = () => {
    if (editing) return;
    const o = a.orientation(), r = a.range(), off = a.offset();
    if (a.setOrientation) { if (o) (orient as HTMLSelectElement).value = o; } else orient.textContent = o ? ORIENT_LABEL[o] : "";
    const disabled = !r || off == null;
    slider.disabled = disabled; fit.disabled = disabled;
    if (r) { slider.min = String(r.min); slider.max = String(r.max); slider.step = String(r.step > 0 ? r.step : "any"); }
    if (btn3d && a.in3D) btn3d.classList.toggle("sl-active", a.in3D());
    if (off != null) { slider.value = String(off); value.textContent = off.toFixed(1); }
    else value.textContent = "";
  };
  slider.addEventListener("input", () => { editing = true; const mm = Number(slider.value); value.textContent = mm.toFixed(1); a.setOffset(mm); });
  slider.addEventListener("change", () => { editing = false; refresh(); });
  slider.addEventListener("pointerup", () => { editing = false; });
  fit.addEventListener("click", () => { a.fit(); refresh(); });
  btn3d?.addEventListener("click", () => { a.toggle3D?.(); refresh(); });
  const unsub = a.onChange(refresh);
  refresh();
  return { el: bar, refresh, detach() { unsub(); bar.remove(); } };
}
