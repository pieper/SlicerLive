// "Save" panel (W7): export the loaded volumes and segmentations to NRRD / NIfTI (segmentations as .seg.nrrd),
// downloaded to the browser. Slicer reads these back with matching geometry + voxels (parity). Plain DOM.
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";

interface Hooks {
  __savableNodes: () => { id: string; name: string; type: string }[];
  __exportNode: (id: string, format: string) => Promise<{ filename: string; size: number }>;
}
const g = () => globalThis as unknown as Hooks;

export function registerSavePanel(shell: AppShell, opts: { live: LiveScene; onStatus?: (s: string) => void }): void {
  const { live } = opts;
  let root: HTMLElement | null = null;
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };

  function render() {
    if (!root) return;
    const nodes = g().__savableNodes?.() ?? [];
    root.innerHTML = `
      <h2>Save</h2>
      ${nodes.length ? `<table class="sl-save-table">${nodes.map((n) => `
        <tr data-id="${n.id}"><td>${n.name}</td><td class="sl-hint">${n.type === "segmentation" ? "seg" : "volume"}</td>
        <td><select class="sl-fmt">${n.type === "segmentation" ? `<option value="nrrd">.seg.nrrd</option><option value="nrrd-gz">.seg.nrrd (gz)</option>` : `<option value="nrrd">NRRD</option><option value="nrrd-gz">NRRD (gz)</option><option value="nifti">NIfTI</option>`}</select></td>
        <td><button class="sl-save-btn">Save</button></td></tr>`).join("")}</table>` : `<p class="sl-hint">Nothing to save yet — load or create data.</p>`}`;
    root.querySelectorAll("tr[data-id]").forEach((tr) => {
      (tr.querySelector(".sl-save-btn") as HTMLElement).addEventListener("click", async () => {
        const id = (tr as HTMLElement).dataset.id!, fmt = (tr.querySelector(".sl-fmt") as HTMLSelectElement).value;
        status("exporting…");
        const r = await g().__exportNode(id, fmt);
        status(`saved ${r.filename} (${(r.size / 1024).toFixed(0)} KB)`);
      });
    });
  }

  shell.registerPanel({ id: "save", title: "Save", order: 8, mount(el) { root = el; render(); } });
  live.subscribe((c) => { if (c.type === "image" || c.type === "segmentation" || c.kind === "remove") render(); });
}
