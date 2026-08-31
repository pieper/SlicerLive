// "Volumes" panel (W3): active-volume selection, window/level (sliders + numeric + Auto + CT/PET presets),
// threshold (alpha-only), interpolation toggle, and the color-table picker. Every control patches the
// volume's `scalarVolumeDisplay` node through the LiveScene (local-authoritative), so the slice + VR views
// update immediately and undo/sessions see the edits. Plain DOM, theme.css tokens. RAS/geometry-free.
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";
import type { ZarrDesc } from "../zarr.ts";
import { fetchZarrVolumeNative } from "../zarr.ts";
import { autoWindowLevel, CT_WL_PRESETS } from "../../logic/window-level.ts";
import { COLOR_TABLES, tableNode } from "../../logic/color-tables.ts";

export interface VolumesPanelOpts { live: LiveScene; onStatus?: (s: string) => void; }

interface VolInfo { imageId: string; displayId: string; name: string; range: [number, number]; d: MrsonNode; }

export function registerVolumesPanel(shell: AppShell, opts: VolumesPanelOpts): void {
  const { live } = opts;
  let activeId = "";
  let dragging = false;   // suppress subscribe-driven re-render while a W/L slider is dragged (avoids detaching it)

  const scalarVolumes = (): VolInfo[] => {
    const out: VolInfo[] = [];
    for (const n of live.nodes.values()) {
      if (n.type !== "image" || n.labelmap) continue;
      const did = ((n.refs as Record<string, string[]> | undefined)?.display ?? [])[0];
      const d = did ? live.nodes.get(did) : undefined;
      if (!d || d.type !== "scalarVolumeDisplay") continue;
      const th = (d.threshold as [number, number] | undefined) ?? [0, 1];
      out.push({ imageId: n.id, displayId: d.id, name: (n.name as string) ?? n.id, range: th, d });
    }
    return out;
  };
  const info = (id: string): VolInfo | undefined => scalarVolumes().find((v) => v.imageId === id);
  const patch = (displayId: string, prop: string, value: unknown) => live.write({ op: "patch", id: displayId, path: `#/${prop}`, value });

  // ── programmatic API (tests / desktop shell) ──────────────────────────────
  const setWindowLevel = (imageId: string, window: number, level: number) => {
    const v = info(imageId); if (!v) return;
    patch(v.displayId, "window", window); patch(v.displayId, "level", level); patch(v.displayId, "autoWindowLevel", false);
  };
  const autoWL = async (imageId: string) => {
    const v = info(imageId); const n = live.nodes.get(imageId); if (!v || !n?.zarr) return;
    const zv = await fetchZarrVolumeNative(live.blobBase(), n.zarr as ZarrDesc);
    const wl = autoWindowLevel(zv.data as Parameters<typeof autoWindowLevel>[0]);
    patch(v.displayId, "window", wl.window); patch(v.displayId, "level", wl.level); patch(v.displayId, "autoWindowLevel", true);
    return wl;
  };
  const wlPreset = (imageId: string, name: string) => {
    const p = CT_WL_PRESETS.find((x) => x.name === name); const v = info(imageId); if (!p || !v) return;
    setWindowLevel(imageId, p.window, p.level);
  };
  const setThreshold = (imageId: string, on: boolean, lo?: number, hi?: number) => {
    const v = info(imageId); if (!v) return;
    patch(v.displayId, "applyThreshold", on);
    if (lo !== undefined && hi !== undefined) patch(v.displayId, "threshold", [lo, hi]);
  };
  const setInterpolate = (imageId: string, on: boolean) => { const v = info(imageId); if (v) patch(v.displayId, "interpolate", on); };
  const setColorTable = (imageId: string, tableId: string) => {
    const v = info(imageId); if (!v) return;
    if (!live.nodes.has(tableId)) { const tn = tableNode(tableId); live.write({ op: "put", id: tn.id, node: tn as unknown as MrsonNode }); }
    patch(v.displayId, "refs", { ...(v.d.refs as Record<string, unknown> ?? {}), color: [tableId] });
  };
  const displayState = (imageId: string) => {
    const v = info(imageId); if (!v) return null; const d = v.d;
    const cid = ((d.refs as Record<string, string[]> | undefined)?.color ?? [])[0] ?? "vtkMRMLColorTableNodeGrey";
    return { window: d.window as number, level: d.level as number, autoWindowLevel: !!d.autoWindowLevel,
      applyThreshold: !!d.applyThreshold, threshold: d.threshold as [number, number], interpolate: d.interpolate !== false, colorTableId: cid };
  };

  Object.assign(globalThis, {
    __volumeList: () => scalarVolumes().map((v) => ({ imageId: v.imageId, displayId: v.displayId, name: v.name, active: v.imageId === activeId })),
    __setActiveVolume: (id: string) => { activeId = id; render(); },
    __volumeDisplay: (id: string) => displayState(id),
    __setWindowLevel: setWindowLevel, __autoWL: autoWL, __wlPreset: wlPreset,
    __setThreshold: setThreshold, __setInterpolate: setInterpolate, __setColorTable: setColorTable,
  });

  // ── UI ────────────────────────────────────────────────────────────────────
  let root: HTMLElement | null = null;
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };

  function render() {
    if (!root) return;
    const vols = scalarVolumes();
    if (!activeId || !vols.some((v) => v.imageId === activeId)) activeId = vols[0]?.imageId ?? "";
    const v = info(activeId), st = displayState(activeId);
    if (!v || !st) { root.innerHTML = `<h2>Volumes</h2><p class="sl-hint">No scalar volume loaded.</p>`; return; }
    const dataMin = Math.min(v.range[0], st.level - st.window), dataMax = Math.max(v.range[1], st.level + st.window);
    const presets = CT_WL_PRESETS.map((p) => `<option value="${p.name}">${p.name}</option>`).join("");
    const tables = COLOR_TABLES.map((t) => `<option value="${t.id}"${t.id === st.colorTableId ? " selected" : ""}>${t.name}</option>`).join("");
    const volOpts = vols.map((x) => `<option value="${x.imageId}"${x.imageId === activeId ? " selected" : ""}>${x.name}</option>`).join("");
    root.innerHTML = `
      <h2>Volumes</h2>
      <div class="sl-row"><label>Active</label><select class="sl-vol-active">${volOpts}</select></div>
      <h3>Window / Level</h3>
      <div class="sl-row"><label>W</label><input class="sl-w" type="range" step="any" min="0" max="${(dataMax - dataMin) * 1.5 || 1}" value="${st.window}"><input class="sl-wn" type="number" step="any" value="${st.window.toFixed(1)}"></div>
      <div class="sl-row"><label>L</label><input class="sl-l" type="range" step="any" min="${dataMin}" max="${dataMax}" value="${st.level}"><input class="sl-ln" type="number" step="any" value="${st.level.toFixed(1)}"></div>
      <div class="sl-row"><button class="sl-primary sl-auto">Auto</button><select class="sl-preset"><option value="">Presets…</option>${presets}</select></div>
      <h3>Threshold</h3>
      <div class="sl-row"><label><input type="checkbox" class="sl-th-on"${st.applyThreshold ? " checked" : ""}> Apply</label></div>
      <div class="sl-row"><label>Lo</label><input class="sl-th-lo" type="number" step="any" value="${st.threshold[0]}"><label>Hi</label><input class="sl-th-hi" type="number" step="any" value="${st.threshold[1]}"></div>
      <h3>Display</h3>
      <div class="sl-row"><label><input type="checkbox" class="sl-interp"${st.interpolate ? " checked" : ""}> Interpolate</label></div>
      <div class="sl-row"><label>Colors</label><select class="sl-colors">${tables}</select></div>`;

    const $ = <T extends HTMLElement>(s: string) => root!.querySelector(s) as T;
    $("select.sl-vol-active").addEventListener("change", (e) => { activeId = (e.target as HTMLSelectElement).value; render(); });
    const w = $<HTMLInputElement>("input.sl-w"), wn = $<HTMLInputElement>("input.sl-wn"), l = $<HTMLInputElement>("input.sl-l"), ln = $<HTMLInputElement>("input.sl-ln");
    const pushWL = () => { setWindowLevel(activeId, +w.value, +l.value); status(`W/L ${(+w.value).toFixed(0)}/${(+l.value).toFixed(0)}`); };
    for (const el of [w, l]) { el.addEventListener("pointerdown", () => { dragging = true; }); el.addEventListener("change", () => { dragging = false; render(); }); }
    w.addEventListener("input", () => { wn.value = (+w.value).toFixed(1); pushWL(); });
    l.addEventListener("input", () => { ln.value = (+l.value).toFixed(1); pushWL(); });
    wn.addEventListener("change", () => { w.value = wn.value; pushWL(); });
    ln.addEventListener("change", () => { l.value = ln.value; pushWL(); });
    $("button.sl-auto").addEventListener("click", async () => { status("auto window/level…"); await autoWL(activeId); render(); status("auto window/level applied"); });
    $("select.sl-preset").addEventListener("change", (e) => { const nm = (e.target as HTMLSelectElement).value; if (nm) { wlPreset(activeId, nm); render(); } });
    $("input.sl-th-on").addEventListener("change", (e) => setThreshold(activeId, (e.target as HTMLInputElement).checked));
    const tlo = $<HTMLInputElement>("input.sl-th-lo"), thi = $<HTMLInputElement>("input.sl-th-hi");
    const pushTh = () => setThreshold(activeId, $<HTMLInputElement>("input.sl-th-on").checked, +tlo.value, +thi.value);
    tlo.addEventListener("change", pushTh); thi.addEventListener("change", pushTh);
    $("input.sl-interp").addEventListener("change", (e) => setInterpolate(activeId, (e.target as HTMLInputElement).checked));
    $("select.sl-colors").addEventListener("change", (e) => setColorTable(activeId, (e.target as HTMLSelectElement).value));
  }

  shell.registerPanel({ id: "volumes", title: "Volumes", order: 3, mount(el) { root = el; render(); } });
  // re-render when volumes are added/removed or a display node changes elsewhere
  live.subscribe((c) => { if (!dragging && (c.type === "image" || c.type === "scalarVolumeDisplay" || c.kind === "remove")) render(); });
}
