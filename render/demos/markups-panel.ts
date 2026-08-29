// "Markups" panel (W4): place points/lines/angles/curves/ROIs (Slicer's place toolbar), a persistent-place
// toggle, and the markups list with per-node measurement, visibility and delete. Placement itself is the
// native placer wired in live-views (interaction node + placeClick); this panel only drives it through the
// exposed hooks, so it works standalone. Plain DOM, theme.css. RAS/geometry handled downstream.
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { MarkupType } from "../../logic/markups/measurements.ts";

interface MarkupInfo { id: string; markupType: MarkupType; name: string; points: number; measurements: { name: string; value: number; units: string }[]; visible: boolean; locked: boolean; }
interface PlaceState { mode: string; markupType: string; persistent: boolean; placeNodeId: string; }
interface Hooks {
  __startPlace: (t: MarkupType, persistent?: boolean) => void;
  __endPlace: () => void;
  __placeState: () => PlaceState | null;
  __markups: () => MarkupInfo[];
  __deleteMarkup: (id: string) => boolean;
}
const g = () => globalThis as unknown as Hooks;

const TYPES: { t: MarkupType; label: string }[] = [
  { t: "fiducial", label: "Point" }, { t: "line", label: "Line" }, { t: "angle", label: "Angle" },
  { t: "curve", label: "Curve" }, { t: "closedCurve", label: "Closed Curve" }, { t: "roi", label: "ROI" },
];

export function registerMarkupsPanel(shell: AppShell, opts: { live: LiveScene; onStatus?: (s: string) => void }): void {
  const { live } = opts;
  let root: HTMLElement | null = null;
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };
  const fmt = (m: { value: number; units: string }) => `${m.value.toFixed(m.units === "deg" ? 1 : 2)} ${m.units === "deg" ? "°" : m.units === "mm2" ? "mm²" : m.units === "mm3" ? "mm³" : m.units}`;

  function render() {
    if (!root) return;
    const ps = g().__placeState?.() ?? null;
    const persistent = !!ps?.persistent;
    const placing = ps?.mode === "place" ? (ps.markupType as string) : "";
    const list = g().__markups?.() ?? [];
    root.innerHTML = `
      <h2>Markups</h2>
      <div class="sl-row sl-markup-types">${TYPES.map((x) => `<button data-t="${x.t}" class="${placing === x.t ? "sl-primary" : ""}">${x.label}</button>`).join("")}</div>
      <div class="sl-row"><label><input type="checkbox" class="sl-mk-persist"${persistent ? " checked" : ""}> Place multiple</label>${placing ? `<button class="sl-mk-end">Stop placing</button>` : ""}</div>
      ${placing ? `<p class="sl-hint">Click in a slice view to place ${placing}. Esc / Stop to finish.</p>` : ""}
      <h3>List (${list.length})</h3>
      <div class="sl-markup-list">${list.length ? list.map(nodeRow).join("") : `<p class="sl-hint">No markups yet.</p>`}</div>`;
    const $ = <T extends HTMLElement>(s: string) => root!.querySelector(s) as T;
    root.querySelectorAll(".sl-markup-types button").forEach((b) => b.addEventListener("click", () => {
      const t = (b as HTMLElement).dataset.t as MarkupType;
      if (placing === t) { g().__endPlace(); status("placement stopped"); }
      else { g().__startPlace(t, $("input.sl-mk-persist").checked); status(`place ${t} — click in a slice view`); }
      render();
    }));
    $("input.sl-mk-persist")?.addEventListener("change", () => { if (placing) g().__startPlace(placing as MarkupType, $("input.sl-mk-persist").checked); });
    $(".sl-mk-end")?.addEventListener("click", () => { g().__endPlace(); status("placement stopped"); render(); });
    root.querySelectorAll(".sl-markup-list [data-del]").forEach((b) => b.addEventListener("click", () => { g().__deleteMarkup((b as HTMLElement).dataset.del!); render(); }));
  }

  function nodeRow(n: MarkupInfo): string {
    const meas = n.measurements.length ? ` — ${fmt(n.measurements[0])}` : "";
    return `<div class="sl-markup-row"><span class="sl-mk-name">${n.name} <span class="sl-hint">(${n.markupType}, ${n.points} pt${n.points === 1 ? "" : "s"})${meas}</span></span><button data-del="${n.id}" title="Delete">✕</button></div>`;
  }

  shell.registerPanel({ id: "markups", title: "Markups", order: 5, mount(el) { root = el; render(); } });
  live.subscribe((c) => { if (c.type === "markup" || c.type === "interaction" || c.kind === "remove") render(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") { const ps = g().__placeState?.(); if (ps?.mode === "place") { g().__endPlace(); render(); } } });
}
