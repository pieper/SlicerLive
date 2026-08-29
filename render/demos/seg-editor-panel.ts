// "Segment Editor" panel (W5): create a segmentation over the active volume, manage segments (add/select/
// color/visibility), and run the discrete effects (Threshold + auto Otsu, Islands, Smoothing, Margin) via
// logic/segmentation-editor.ts. Plain DOM, theme.css. The interactive paint effect stays on the GPU path.
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { LocalBlobStore } from "../../logic/ingest.ts";

interface Hooks {
  __createSegmentation: (sourceImageId: string) => Promise<{ segId: string; segment: number }>;
  __addSegment: (segId: string) => number;
  __applyEffect: (segId: string, effect: string, params: Record<string, unknown>) => Promise<{ voxels: number; threshold?: number }>;
  __segmentations: () => { segId: string; name: string; segments: { labelValue: number; name: string; color: number[]; visible: boolean }[] }[];
  __setSegmentProp: (segId: string, labelValue: number, prop: string, value: unknown) => void;
  __volumeList: () => { imageId: string; name: string }[];
  __segmentStats: (segId: string) => Promise<{ labelValue: number; voxels: number; volumeMm3: number }[]>;
  __setSegTool: (segId: string, tool: string, params: { diameterMm?: number; sphere?: boolean; segment?: number }) => void;
  __segTool: () => { activeEffect: string; diameterMm: number; sphere: boolean };
}
const g = () => globalThis as unknown as Hooks;

export function registerSegEditorPanel(shell: AppShell, opts: { live: LiveScene; store: LocalBlobStore; onStatus?: (s: string) => void }): void {
  const { live } = opts;
  let root: HTMLElement | null = null;
  let segId = "", active = 1;
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };

  async function ensureSeg(): Promise<string> {
    if (segId && live.nodes.has(segId)) return segId;
    const vols = g().__volumeList?.() ?? [];
    if (!vols.length) { status("load a volume first"); return ""; }
    const r = await g().__createSegmentation(vols[0].imageId);
    segId = r.segId; active = r.segment; status(`created ${segId}`); return segId;
  }

  async function effect(name: string, params: Record<string, unknown>) {
    const id = await ensureSeg(); if (!id) return;
    status(`${name}…`);
    const r = await g().__applyEffect(id, name, { segment: active, ...params });
    status(`${name}: ${r.voxels} voxels${r.threshold !== undefined ? ` (t=${r.threshold.toFixed(0)})` : ""}`);
    render();
  }

  function render() {
    if (!root) return;
    const segn = g().__segmentations?.().find((s) => s.segId === segId);
    const segs = segn?.segments ?? [];
    if (segs.length && !segs.some((s) => s.labelValue === active)) active = segs[0].labelValue;
    root.innerHTML = `
      <h2>Segment Editor</h2>
      <div class="sl-row"><button class="sl-primary sl-seg-new">${segId ? "New segment" : "Create segmentation"}</button></div>
      <div class="sl-seg-list">${segs.map((s) => `<div class="sl-seg-row${s.labelValue === active ? " sl-active" : ""}" data-seg="${s.labelValue}"><span class="sl-seg-swatch" style="background:rgb(${s.color.map((c) => Math.round(c * 255)).join(",")})"></span><span class="sl-seg-name">${s.name}</span><button data-vis="${s.labelValue}" title="Show/hide">${s.visible ? "👁" : "🚫"}</button></div>`).join("") || `<p class="sl-hint">No segments yet.</p>`}</div>
      <h3>Brush</h3>
      <div class="sl-row"><button class="sl-eff-paint">Paint</button><button class="sl-eff-erase">Erase</button><label><input type="checkbox" class="sl-brush-sphere"> Sphere</label></div>
      <div class="sl-row"><label>Diameter (mm)</label><input class="sl-brush-dia" type="range" min="1" max="40" step="1" value="8"><span class="sl-brush-diav">8</span></div>
      <h3>Effects</h3>
      <div class="sl-row"><label>Threshold</label><input class="sl-th-lo" type="number" placeholder="lo" style="width:70px"><input class="sl-th-hi" type="number" placeholder="hi" style="width:70px"><button class="sl-eff-th">Apply</button></div>
      <div class="sl-row"><button class="sl-eff-auto">Auto (Otsu)</button></div>
      <div class="sl-row"><label>Islands</label><button class="sl-eff-largest">Keep largest</button><button class="sl-eff-small">Remove small</button></div>
      <div class="sl-row"><label>Smoothing</label><button class="sl-eff-median">Median</button><button class="sl-eff-open">Open</button><button class="sl-eff-close">Close</button></div>
      <div class="sl-row"><label>Margin (mm)</label><input class="sl-margin" type="number" value="2" step="0.5" style="width:70px"><button class="sl-eff-grow">Grow</button><button class="sl-eff-shrink">Shrink</button></div>
      <div class="sl-row"><label>Logical (vs seg)</label><input class="sl-other" type="number" value="2" step="1" style="width:60px"><button class="sl-eff-union">∪</button><button class="sl-eff-sub">−</button><button class="sl-eff-int">∩</button></div>
      <div class="sl-row"><button class="sl-eff-stats">Statistics</button></div>
      <div class="sl-seg-stats"></div>`;
    const $ = <T extends HTMLElement>(s: string) => root!.querySelector(s) as T;
    const num = (s: string) => Number(($(s) as HTMLInputElement).value);
    $(".sl-seg-new").addEventListener("click", async () => { if (!segId) { await ensureSeg(); } else { active = g().__addSegment(segId); } render(); });
    root.querySelectorAll(".sl-seg-row").forEach((el) => el.addEventListener("click", (e) => { if ((e.target as HTMLElement).dataset.vis) return; active = Number((el as HTMLElement).dataset.seg); render(); }));
    root.querySelectorAll("[data-vis]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); const lv = Number((b as HTMLElement).dataset.vis); const s = (g().__segmentations().find((x) => x.segId === segId)?.segments ?? []).find((x) => x.labelValue === lv); g().__setSegmentProp(segId, lv, "visible", !(s?.visible)); render(); }));
    $(".sl-eff-th").addEventListener("click", () => effect("threshold", { lower: num(".sl-th-lo"), upper: num(".sl-th-hi") }));
    $(".sl-eff-auto").addEventListener("click", () => effect("autoThreshold", { autoMethod: "otsu" }));
    $(".sl-eff-largest").addEventListener("click", () => effect("islands", { islands: "keepLargest" }));
    $(".sl-eff-small").addEventListener("click", () => effect("islands", { islands: "removeSmall", minSize: 10 }));
    $(".sl-eff-median").addEventListener("click", () => effect("smoothing", { smooth: "median", radiusVoxels: 1 }));
    $(".sl-eff-open").addEventListener("click", () => effect("smoothing", { smooth: "open", radiusVoxels: 1 }));
    $(".sl-eff-close").addEventListener("click", () => effect("smoothing", { smooth: "close", radiusVoxels: 1 }));
    $(".sl-eff-grow").addEventListener("click", () => effect("margin", { marginMm: Math.abs(num(".sl-margin")) }));
    $(".sl-eff-shrink").addEventListener("click", () => effect("margin", { marginMm: -Math.abs(num(".sl-margin")) }));
    $(".sl-eff-union").addEventListener("click", () => effect("logical", { logical: "union", other: num(".sl-other") }));
    $(".sl-eff-sub").addEventListener("click", () => effect("logical", { logical: "subtract", other: num(".sl-other") }));
    $(".sl-eff-int").addEventListener("click", () => effect("logical", { logical: "intersect", other: num(".sl-other") }));
    $(".sl-eff-stats").addEventListener("click", async () => { const st = await g().__segmentStats(segId); const el = $(".sl-seg-stats"); el.innerHTML = st.map((x) => `<div class="sl-hint">Segment ${x.labelValue}: ${x.voxels} vox, ${(x.volumeMm3 / 1000).toFixed(2)} mL</div>`).join(""); });
    const tool = g().__segTool?.() ?? { activeEffect: "", diameterMm: 8, sphere: false };
    const dia = () => Number(($(".sl-brush-dia") as HTMLInputElement).value);
    const sphere = () => ($(".sl-brush-sphere") as HTMLInputElement).checked;
    ($(".sl-brush-dia") as HTMLInputElement).value = String(tool.diameterMm);
    ($(".sl-brush-sphere") as HTMLInputElement).checked = tool.sphere;
    ($(".sl-brush-diav") as HTMLElement).textContent = String(tool.diameterMm);
    if (tool.activeEffect === "paint") $(".sl-eff-paint").classList.add("sl-primary");
    if (tool.activeEffect === "erase") $(".sl-eff-erase").classList.add("sl-primary");
    const setTool = async (t: string) => { const id = await ensureSeg(); if (!id) return; const cur = g().__segTool().activeEffect; g().__setSegTool(id, cur === t ? "" : t, { diameterMm: dia(), sphere: sphere(), segment: active }); status(cur === t ? "brush off" : `${t} — drag in a slice view`); render(); };
    $(".sl-eff-paint").addEventListener("click", () => setTool("paint"));
    $(".sl-eff-erase").addEventListener("click", () => setTool("erase"));
    $(".sl-brush-dia").addEventListener("input", (e) => { ($(".sl-brush-diav") as HTMLElement).textContent = (e.target as HTMLInputElement).value; const cur = g().__segTool(); if (cur.activeEffect) g().__setSegTool(segId, cur.activeEffect, { diameterMm: dia(), sphere: sphere(), segment: active }); });
    $(".sl-brush-sphere").addEventListener("change", () => { const cur = g().__segTool(); if (cur.activeEffect) g().__setSegTool(segId, cur.activeEffect, { diameterMm: dia(), sphere: sphere(), segment: active }); });
  }

  shell.registerPanel({ id: "segment", title: "Segment Editor", order: 6, mount(el) { root = el; render(); } });
  live.subscribe((c) => { if (c.type === "segmentation" || c.type === "image") render(); });
}
