// "Sample Data" panel — Slicer's Sample Data module, split out of the Data panel. Downloads a catalog entry
// (SHA-256 verified) and loads it through the normal ingest path via __loadVolumeBytes. Plain DOM, theme.css.
import type { AppShell } from "./app-shell.ts";
import { downloadSample, SAMPLE_DATA } from "../../logic/sample-data.ts";

interface Hooks { __loadVolumeBytes: (bytes: Uint8Array, name: string) => Promise<void>; }
const g = () => globalThis as unknown as Hooks;

export function registerSampleDataPanel(shell: AppShell, opts: { onStatus?: (s: string) => void }): void {
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };
  shell.registerPanel({ id: "sampledata", title: "Sample Data", order: 2, mount(el) {
    el.innerHTML = `
      <h2>Sample Data</h2>
      <div class="sl-samples"></div>
      <div class="sl-progress" hidden><div class="sl-progress-bar"></div><span class="sl-progress-text"></span></div>`;
    const samples = el.querySelector(".sl-samples") as HTMLElement;
    const prog = el.querySelector(".sl-progress") as HTMLElement, bar = el.querySelector(".sl-progress-bar") as HTMLElement, ptxt = el.querySelector(".sl-progress-text") as HTMLElement;
    for (const d of SAMPLE_DATA) {
      const row = document.createElement("div"); row.className = "sl-row";
      const b = document.createElement("button"); b.textContent = d.title; b.title = `${d.fileName} · ${d.modality ?? ""} · ~${d.mb ?? "?"} MB · SHA-256 verified`;
      b.addEventListener("click", async () => {
        b.disabled = true; prog.hidden = false; bar.style.width = "0%"; ptxt.textContent = `downloading ${d.title}…`;
        let got = 0; const total = (d.mb ?? 20) * 1048576;
        try {
          const r = await downloadSample(d.name, undefined, (n) => { got += n; bar.style.width = Math.min(100, 100 * got / total).toFixed(0) + "%"; ptxt.textContent = `${d.title}: ${(got / 1048576).toFixed(1)} MB`; });
          ptxt.textContent = "verified ✓";
          await g().__loadVolumeBytes(r.bytes, d.fileName);
        } catch (e) { status(`${d.title}: ${(e as Error).message}`); }
        finally { b.disabled = false; setTimeout(() => { prog.hidden = true; }, 1500); }
      });
      row.appendChild(b); const meta = document.createElement("span"); meta.className = "sl-hint"; meta.textContent = `${d.modality ?? ""} ${d.mb ? `~${d.mb} MB` : ""}`; row.appendChild(meta);
      samples.appendChild(row);
    }
  } });
}
