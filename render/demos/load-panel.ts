// "Data" panel (W1): open local volume files (NRRD / NIfTI, gzipped or not), drag-and-drop onto the views,
// and Slicer's Sample Data catalog with SHA-256 verification. Everything goes through logic/ingest.ts, so a
// loaded file is an ordinary `image` node in the LiveScene. Plain DOM in the app-shell style (theme.css tokens).
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import { loadVolumeIntoScene, LocalBlobStore } from "../../logic/ingest.ts";
import { readVolume, sniff } from "../../logic/readers/registry.ts";
import { fetchZarrVolumeNative, type ZarrDesc } from "../zarr.ts";
import { indexDirectory, indexFiles, loadDcmjs, loadEntry, type SeriesEntry } from "../../logic/readers/dicom-local.ts";
import { downloadSample } from "../../logic/sample-data.ts";

export interface LoadPanelOpts {
  live: LiveScene;
  store: LocalBlobStore;
  dropTarget?: HTMLElement;                 // where a drag-and-drop overlay appears (default: shell.main)
  onLoaded?: (info: { name: string; imageId: string; source: string; rasLo: [number, number, number]; rasHi: [number, number, number]; ijkToRAS: number[] }) => void;
  onStatus?: (s: string) => void;
}

/** RAS bounding box of a volume from its ijkToRAS + dims (the 8 corners). */
function rasBounds(dims: [number, number, number], m: number[]): { lo: [number, number, number]; hi: [number, number, number] } {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const i = (c & 1) ? dims[0] - 1 : 0, j = (c & 2) ? dims[1] - 1 : 0, k = (c & 4) ? dims[2] - 1 : 0;
    for (let r = 0; r < 3; r++) { const v = m[r * 4] * i + m[r * 4 + 1] * j + m[r * 4 + 2] * k + m[r * 4 + 3]; if (v < lo[r]) lo[r] = v; if (v > hi[r]) hi[r] = v; }
  }
  return { lo, hi };
}

export function registerLoadPanel(shell: AppShell, opts: LoadPanelOpts): void {
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };

  async function loadBytes(bytes: Uint8Array, fileName: string, source: string): Promise<void> {
    const fmt = sniff(bytes, fileName);
    status(`reading ${fileName} (${fmt}, ${(bytes.byteLength / 1048576).toFixed(1)} MB)…`);
    const vol = await readVolume(bytes, fileName);
    const r = await loadVolumeIntoScene(opts.live, opts.store, vol, { name: vol.name ?? fileName });
    status(`loaded ${vol.name ?? fileName}: ${vol.dims.join("×")} voxels`);
    const b = rasBounds(vol.dims, vol.ijkToRAS);
    opts.onLoaded?.({ name: vol.name ?? fileName, imageId: r.imageId, source, rasLo: b.lo, rasHi: b.hi, ijkToRAS: vol.ijkToRAS });
  }
  async function loadFiles(files: FileList | File[]): Promise<void> {
    for (const f of Array.from(files)) {
      try { await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, "file"); }
      catch (e) { status(`${f.name}: ${(e as Error).message}`); }
    }
  }

  async function loadVolumeObj(vol: Awaited<ReturnType<typeof readVolume>>, source: string): Promise<void> {
    const r = await loadVolumeIntoScene(opts.live, opts.store, vol, { name: vol.name ?? "Volume" });
    status(`loaded ${vol.name}: ${vol.dims.join("×")} voxels`);
    const b = rasBounds(vol.dims, vol.ijkToRAS);
    opts.onLoaded?.({ name: vol.name ?? "Volume", imageId: r.imageId, source, rasLo: b.lo, rasHi: b.hi, ijkToRAS: vol.ijkToRAS });
  }

  shell.registerPanel({ id: "data", title: "Data", order: 1, mount(el) {
    el.innerHTML = `
      <h2>Data</h2>
      <h3>Load</h3>
      <div class="sl-row"><button class="sl-primary" data-act="open">Open volume file…</button><span class="sl-hint">NRRD, NIfTI (.nii, .nii.gz)</span></div>
      <div class="sl-row"><button data-act="dicom-dir">Open DICOM folder…</button><button data-act="dicom-files">DICOM files…</button></div>
      <div class="sl-series" hidden><h3>Series</h3><div class="sl-series-list"></div></div>
      <p>Or drag files onto the views.</p>
      <input type="file" multiple accept=".nrrd,.nhdr,.nii,.nii.gz,.gz" hidden>
      <input type="file" multiple data-dicom hidden>
      <h3>Subject Hierarchy</h3>
      <div class="sl-sh"></div>`;
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

    // ---- DICOM ----
    const seriesBox = el.querySelector(".sl-series") as HTMLElement, seriesList = el.querySelector(".sl-series-list") as HTMLElement;
    const dicomInput = el.querySelector("[data-dicom]") as HTMLInputElement;
    const showSeries = (entries: SeriesEntry[]) => {
      seriesList.innerHTML = "";
      if (!entries.length) { seriesBox.hidden = false; seriesList.innerHTML = "<p>No DICOM image series found.</p>"; return; }
      seriesBox.hidden = false;
      for (const e of entries) {
        const row = document.createElement("div"); row.className = "sl-series-row";
        const b = document.createElement("button");
        b.textContent = `${e.modality ?? "?"} · ${e.description || e.seriesInstanceUID.slice(-12)} · ${e.count} img`;
        b.title = `${e.patientName ?? ""} · ${e.seriesInstanceUID}`;
        b.addEventListener("click", async () => {
          try { status(`reconstructing ${e.count} slices…`); await loadVolumeObj(loadEntry(e), "dicom"); }
          catch (err) { status(`DICOM: ${(err as Error).message}`); }
        });
        row.appendChild(b); seriesList.appendChild(row);
      }
    };
    const indexProgress = (p: { scanned: number; dicom: number; note?: string }) => status(`scanning: ${p.dicom} DICOM / ${p.scanned} files${p.note ? " — " + p.note : ""}`);
    (el.querySelector('[data-act="dicom-dir"]') as HTMLButtonElement).addEventListener("click", async () => {
      const picker = (globalThis as unknown as { showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
      if (!picker) { status("directory picker unavailable — use ‘DICOM files…’"); return; }
      try { const dir = await picker({ id: "slicerlive-dicom" }); status("scanning folder…"); showSeries(await indexDirectory(dir, indexProgress)); }
      catch (e) { if ((e as Error).name !== "AbortError") status((e as Error).message); }
    });
    (el.querySelector('[data-act="dicom-files"]') as HTMLButtonElement).addEventListener("click", () => dicomInput.click());
    dicomInput.addEventListener("change", async () => { if (dicomInput.files?.length) { status("scanning files…"); showSeries(await indexFiles(Array.from(dicomInput.files), indexProgress)); } dicomInput.value = ""; });

    // Subject Hierarchy: every data node (any type) unless hidden, with per-node operations.
    const shEl = el.querySelector(".sl-sh") as HTMLElement;
    const DATA_TYPES = new Set(["image", "segmentation", "markup", "model", "transform"]);
    const ICON: Record<string, string> = { image: "🧊", segmentation: "🎨", markup: "📍", model: "🧩", transform: "⭮" };
    const refresh = () => {
      const nodes = [...opts.live.nodes.values()].filter((n) => DATA_TYPES.has(n.type as string) && !(n as { hidden?: boolean }).hidden);
      shEl.innerHTML = nodes.length ? nodes.map((n) => {
        const kind = n.type === "image" && (n as { labelmap?: boolean }).labelmap ? "labelmap" : n.type;
        const detail = n.type === "image" ? ((n.dims as number[] | undefined)?.join("×") ?? "") : n.type === "markup" ? `${((n.controlPoints as unknown[] | undefined) ?? []).length} pts` : "";
        return `<div class="sl-sh-row" data-id="${n.id}"><span class="sl-sh-icon">${ICON[n.type as string] ?? "•"}</span><span class="sl-sh-name" title="${kind}">${n.name ?? n.id}</span><span class="sl-hint">${detail}</span><span class="sl-sh-ops"><button data-vis="${n.id}" title="Show/hide">${(n.visible === false) ? "🚫" : "👁"}</button><button data-ren="${n.id}" title="Rename">✎</button><button data-del="${n.id}" title="Delete">✕</button></span></div>`;
      }).join("") : `<p class="sl-hint">No data yet — open a file or load sample data.</p>`;
      shEl.querySelectorAll("[data-vis]").forEach((b) => b.addEventListener("click", () => { const id = (b as HTMLElement).dataset.vis!; const n = opts.live.nodes.get(id); opts.live.write({ op: "patch", id, path: "#/visible", value: n?.visible === false }); }));
      shEl.querySelectorAll("[data-ren]").forEach((b) => b.addEventListener("click", () => { const id = (b as HTMLElement).dataset.ren!; const n = opts.live.nodes.get(id); const name = globalThis.prompt?.("Rename", (n?.name as string) ?? id); if (name) opts.live.write({ op: "patch", id, path: "#/name", value: name }); }));
      shEl.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { opts.live.write({ op: "del", id: (b as HTMLElement).dataset.del! }); }));
    };
    opts.live.subscribe((c) => { if (DATA_TYPES.has(c.type as string) || c.kind === "remove") refresh(); });
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
  Object.assign(globalThis, {
    __loadVolumeBytes: (bytes: Uint8Array, name: string) => loadBytes(bytes, name, "api"),
    __loadFiles: loadFiles,
    __loadSample: (name: string) => downloadSample(name).then((r) => loadBytes(r.bytes, r.dataset.fileName, "sampleData:" + name)),
    __volumeStats: volumeStats,
    // DICOM: index raw buffers -> pick a series -> load. Returns the series list (for tests/automation).
    __dcmjs: () => loadDcmjs(),
    __indexDicom: (buffers: ArrayBuffer[]) => indexFiles(buffers.map((b, i) => new File([b], "i" + i + ".dcm"))),
    __loadDicomSeries: async (buffers: ArrayBuffer[], which = 0) => {
      const entries = await indexFiles(buffers.map((b, i) => new File([b], "i" + i + ".dcm")));
      if (!entries[which]) throw new Error("no series " + which);
      const r = await loadVolumeIntoScene(opts.live, opts.store, loadEntry(entries[which]), { name: entries[which].description || "DICOM" });
      return { imageId: r.imageId, series: entries.map((e) => ({ uid: e.seriesInstanceUID, count: e.count, modality: e.modality })) };
    },
  });
}
