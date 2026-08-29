// "Data" panel (W1): open local volume files (NRRD / NIfTI, gzipped or not), drag-and-drop onto the views,
// and Slicer's Sample Data catalog with SHA-256 verification. Everything goes through logic/ingest.ts, so a
// loaded file is an ordinary `image` node in the LiveScene. Plain DOM in the app-shell style (theme.css tokens).
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import { loadVolumeIntoScene, LocalBlobStore } from "../../logic/ingest.ts";
import { readVolume, sniff } from "../../logic/readers/registry.ts";
import { downloadSample, SAMPLE_DATA } from "../../logic/sample-data.ts";
import { fetchZarrVolumeNative, type ZarrDesc } from "../zarr.ts";

export interface LoadPanelOpts {
  live: LiveScene;
  store: LocalBlobStore;
  dropTarget?: HTMLElement;                 // where a drag-and-drop overlay appears (default: shell.main)
  onLoaded?: (info: { name: string; imageId: string; source: string }) => void;
  onStatus?: (s: string) => void;
}

export function registerLoadPanel(shell: AppShell, opts: LoadPanelOpts): void {
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };

  async function loadBytes(bytes: Uint8Array, fileName: string, source: string): Promise<void> {
    const fmt = sniff(bytes, fileName);
    status(`reading ${fileName} (${fmt}, ${(bytes.byteLength / 1048576).toFixed(1)} MB)…`);
    const vol = await readVolume(bytes, fileName);
    const r = await loadVolumeIntoScene(opts.live, opts.store, vol, { name: vol.name ?? fileName });
    status(`loaded ${vol.name ?? fileName}: ${vol.dims.join("×")} voxels`);
    opts.onLoaded?.({ name: vol.name ?? fileName, imageId: r.imageId, source });
  }
  async function loadFiles(files: FileList | File[]): Promise<void> {
    for (const f of Array.from(files)) {
      try { await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, "file"); }
      catch (e) { status(`${f.name}: ${(e as Error).message}`); }
    }
  }

  shell.registerPanel({ id: "data", title: "Data", order: 1, mount(el) {
    el.innerHTML = `
      <h2>Data</h2>
      <h3>Load</h3>
      <div class="sl-row"><button class="sl-primary" data-act="open">Open volume file…</button><span class="sl-hint">NRRD, NIfTI (.nii, .nii.gz)</span></div>
      <p>Or drag files onto the views. DICOM folders and series browsing arrive with the DICOM module.</p>
      <input type="file" multiple accept=".nrrd,.nhdr,.nii,.nii.gz,.gz" hidden>
      <h3>Sample Data</h3>
      <div class="sl-samples"></div>
      <div class="sl-progress" hidden><div class="sl-progress-bar"></div><span class="sl-progress-text"></span></div>
      <h3>Loaded</h3>
      <ul class="sl-loaded"></ul>`;
    const input = el.querySelector("input[type=file]") as HTMLInputElement;
    const openBtn = el.querySelector('[data-act="open"]') as HTMLButtonElement;
    openBtn.addEventListener("click", async () => {
      const picker = (globalThis as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
      if (picker) {
        try {
          const handles = await picker({ multiple: true, types: [{ description: "Volumes", accept: { "application/octet-stream": [".nrrd", ".nhdr", ".nii", ".gz"] } }] });
          await loadFiles(await Promise.all(handles.map((h) => h.getFile())));
        } catch (e) { if ((e as Error).name !== "AbortError") status((e as Error).message); }
      } else input.click();
    });
    input.addEventListener("change", () => { if (input.files) void loadFiles(input.files); input.value = ""; });

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
          await loadBytes(r.bytes, d.fileName, "sampleData:" + d.name);
        } catch (e) { status(`${d.title}: ${(e as Error).message}`); }
        finally { b.disabled = false; setTimeout(() => { prog.hidden = true; }, 1500); }
      });
      row.appendChild(b); const meta = document.createElement("span"); meta.className = "sl-hint"; meta.textContent = `${d.modality ?? ""} ${d.mb ? `~${d.mb} MB` : ""}`; row.appendChild(meta);
      samples.appendChild(row);
    }
    const loadedList = el.querySelector(".sl-loaded") as HTMLElement;
    const refresh = () => {
      loadedList.innerHTML = "";
      for (const n of opts.live.nodes.values()) if (n.type === "image") { const li = document.createElement("li"); li.textContent = `${n.name ?? n.id} — ${(n.dims as number[] | undefined)?.join("×") ?? "?"}`; loadedList.appendChild(li); }
    };
    opts.live.subscribe((c) => { if (c.type === "image") refresh(); });
    refresh();
  } });

  // drag-and-drop over the views
  const target = opts.dropTarget ?? shell.main;
  const overlay = document.createElement("div");
  overlay.className = "sl-drop"; overlay.textContent = "Drop volume files to load"; overlay.hidden = true;
  target.appendChild(overlay);
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  target.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.hidden = false; });
  target.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; });
  target.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  target.addEventListener("drop", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; overlay.hidden = true; void loadFiles(e.dataTransfer!.files); });
  // programmatic entry for tests and the desktop shell
  /** Numeric oracle for parity tests: dims, ijkToRAS and the exact voxel sum of an image node (re-read from its chunks). */
  const volumeStats = async (imageId: string) => {
    const n = opts.live.nodes.get(imageId); if (!n || !n.zarr) throw new Error("no such image " + imageId);
    const zv = await fetchZarrVolumeNative(opts.live.blobBase(), n.zarr as ZarrDesc);
    let sum = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < zv.data.length; i++) { const v = zv.data[i] as number; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; }
    return { dims: n.dims, ijkToRAS: n.ijkToRAS, sum, min: mn, max: mx, count: zv.data.length, dtype: (n.zarr as ZarrDesc).dtype };
  };
  Object.assign(globalThis, { __loadVolumeBytes: (bytes: Uint8Array, name: string) => loadBytes(bytes, name, "api"), __loadFiles: loadFiles, __loadSample: (name: string) => downloadSample(name).then((r) => loadBytes(r.bytes, r.dataset.fileName, "sampleData:" + name)), __volumeStats: volumeStats });
}
