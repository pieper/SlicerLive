// Share + Download extra-tools for the SlicerLive BIR demo — ported from the SlicerRad reader,
// made self-contained (no separate download worker; inline parallel fetch pool).
//
// Share:    a modal with an OHIF/IDC-portal-style deep link that reopens THIS study in THIS
//           viewer (both the UID form and the index-free direct-S3 form), plus the canonical
//           IDC OHIF portal link for the same study.
// Download: streams the study's DICOM straight to a user-picked folder (File System Access API),
//           N objects in flight at once, no whole-series buffering.
import { fetchRetry, idcS3, ohifViewerURL, s3ListKeys } from "../vendor/idc_tools/index.js";

/** The BIR demo's resolved source (subset used here). */
export interface ShareSource {
  c: string; cb: string; // image series S3 prefix + bucket
  s?: string; sb?: string; // optional SEG prefix + bucket
  m: string; col: string; st: string; sd: string; lic: string;
}
/** One downloadable series (the loaded pair, or every series in the study). */
export interface SeriesRef {
  prefix: string; bucket: string; modality: string;
  seriesUID?: string; seriesDescription?: string; seriesNumber?: string | number;
}

/** Deep link that reopens this study here. Carries the OHIF/IDC-portal UID params (portal
 *  compatibility) AND the index-free direct-S3 params (opens straight from the bucket). */
export function studyShareURL(src: ShareSource): string {
  const u = new URL(globalThis.location.origin + globalThis.location.pathname);
  if (src.st) u.searchParams.set("StudyInstanceUIDs", src.st);
  // direct-S3 fast path (works even before/without the slim index)
  u.searchParams.set("series", src.c);
  if (src.cb && src.cb !== "idc-open-data") u.searchParams.set("bucket", src.cb);
  if (src.s) u.searchParams.set("seg", src.s);
  if (src.sb && src.sb !== "idc-open-data") u.searchParams.set("segBucket", src.sb);
  if (src.m && src.m !== "CT") u.searchParams.set("modality", src.m);
  const pid = (src.sd.split("·")[0] || "").trim();
  if (pid && pid !== "IDC") u.searchParams.set("patient", pid);
  if (src.col && src.col !== "IDC") u.searchParams.set("collection", src.col);
  return u.toString();
}

const OVERLAY_CSS =
  "position:fixed;inset:0;z-index:2000;background:rgba(5,6,10,.85);display:flex;align-items:center;justify-content:center;";
const CARD_CSS =
  "background:#11141d;border:1px solid #33507e;border-radius:10px;padding:20px 24px;width:600px;max-width:92vw;font:13px -apple-system,system-ui,sans-serif;color:#d6e2f2;";

/** Small modal listing the SlicerLive deep link + the IDC OHIF portal link, each copyable. */
export function shareStudy(src: ShareSource): void {
  if (document.getElementById("idc-share")) return;
  const here = studyShareURL(src);
  const portal = (src.st && ohifViewerURL(src.st)) || "";
  const overlay = document.createElement("div");
  overlay.id = "idc-share";
  overlay.style.cssText = OVERLAY_CSS;
  const esc = (s: string) => s.replace(/"/g, "&quot;");
  const row = (label: string, url: string, hint: string) => `
    <div style="margin:0 0 14px;">
      <div style="color:#9fd0b3;font-weight:600;margin-bottom:4px;">${label}</div>
      <div style="display:flex;gap:6px;">
        <input readonly value="${esc(url)}" style="flex:1;font:12px ui-monospace,monospace;color:#d6e2f2;
          background:#0b0e16;border:1px solid #33507e;border-radius:4px;padding:6px 8px;">
        <button data-copy="${esc(url)}" style="font:600 12px -apple-system,system-ui,sans-serif;color:#d6e2f2;
          background:#1b2740;border:1px solid #33507e;border-radius:4px;padding:6px 12px;cursor:pointer;">Copy</button>
      </div>
      <div style="color:#5a6b85;font-size:11px;margin-top:3px;">${hint}</div>
    </div>`;
  overlay.innerHTML = `
    <div style="${CARD_CSS}">
      <h3 style="margin:0 0 4px;color:#fff;">Share study</h3>
      <p style="margin:0 0 16px;color:#9fb3d0;">${src.sd}${src.st ? " · " + src.st : ""}</p>
      ${row("Open in SlicerLive (this viewer)", here, "Reopens this study in the SlicerLive BIR reader (OHIF-style + direct-S3 params).")}
      ${portal ? row("Open in IDC OHIF portal", portal, "The canonical IDC viewer link for the same study.") : ""}
      <div style="text-align:right;margin-top:6px;">
        <button id="idc-share-close" style="font:600 12px -apple-system,system-ui,sans-serif;color:#9fb3d0;
          background:none;border:none;cursor:pointer;padding:6px 4px;">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#idc-share-close")!.addEventListener("click", close);
  for (const b of overlay.querySelectorAll("button[data-copy]")) {
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText((b as HTMLElement).dataset.copy!);
        (b as HTMLElement).textContent = "Copied ✓";
        setTimeout(() => ((b as HTMLElement).textContent = "Copy"), 1400);
      } catch {
        (b as HTMLElement).textContent = "Copy failed";
      }
    });
  }
}

const DL_LANES = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "study";

/** Stream every listed series' DICOM to a picked folder, DL_LANES objects in flight. */
export async function downloadStudy(
  src: ShareSource,
  seriesList: SeriesRef[],
  onProgress: (done: number, total: number, bytes: number, note: string) => void,
  opts?: { root?: FileSystemDirectoryHandle; maxFilesPerSeries?: number },
): Promise<void> {
  let root: FileSystemDirectoryHandle;
  if (opts?.root) root = opts.root;
  else {
    // deno-lint-ignore no-explicit-any
    const picker = (globalThis as any).showDirectoryPicker;
    if (!picker) throw new Error("File System Access API unavailable — cannot pick a download folder");
    root = await picker({ mode: "readwrite", id: "slicerlive-idc-download" });
  }
  onProgress(0, 0, 0, "listing series…");
  const studyDir = await root.getDirectoryHandle(
    safeName(`${src.col}_${(src.st || src.c).slice(-12)}`),
    { create: true },
  );
  // Enumerate keys up front for an exact total.
  const tasks: { dir: FileSystemDirectoryHandle; base: string; keys: string[] }[] = [];
  let total = 0, sn = 0;
  for (const s of seriesList) {
    onProgress(0, total, 0, `listing ${s.modality} ${s.seriesDescription || (s.prefix.slice(0, 8) + "…")}…`);
    let keys = await s3ListKeys(s.prefix, s.bucket);
    if (!keys.length) continue;
    if (opts?.maxFilesPerSeries) keys = keys.slice(0, opts.maxFilesPerSeries);
    total += keys.length;
    const dir = await studyDir.getDirectoryHandle(
      safeName(`${s.seriesNumber || ++sn}_${s.modality}_${s.prefix.slice(0, 8)}`),
      { create: true },
    );
    tasks.push({ dir, base: idcS3(s.bucket), keys });
  }
  if (!total) throw new Error("no DICOM objects found to download");
  onProgress(0, total, 0, `downloading ${total} files (${DL_LANES} at a time)…`);

  let done = 0, bytes = 0;
  const errors: string[] = [];
  for (const task of tasks) {
    let next = 0;
    const lane = async () => {
      while (next < task.keys.length) {
        const key = task.keys[next++];
        try {
          const resp = await fetchRetry(task.base + key, {});
          const buf = await resp.arrayBuffer();
          const fname = safeName(key.split("/").pop() || `obj-${done}.dcm`);
          const fh = await task.dir.getFileHandle(fname, { create: true });
          const w = await fh.createWritable();
          await w.write(buf);
          await w.close();
          bytes += buf.byteLength;
        } catch (e) {
          errors.push(`${key}: ${(e as Error).message}`);
        }
        done++;
        if (done % 5 === 0 || done === total) onProgress(done, total, bytes, `${done}/${total} files`);
      }
    };
    await Promise.all(Array.from({ length: DL_LANES }, lane));
  }
  const mb = (bytes / 1e6).toFixed(0);
  onProgress(
    done, total, bytes,
    `saved ${done - errors.length}/${total} files (${mb} MB) to “${root.name}/${studyDir.name}”` +
      (errors.length ? ` — ${errors.length} failed` : ""),
  );
  if (errors.length) console.warn("IDC download errors:", errors.slice(0, 10));
}

/** Download WITH a live progress dialog (attribution + bar). `listAll` resolves the study's full
 *  series set when available; otherwise the loaded image (+ SEG) pair is downloaded. */
export async function downloadStudyWithDialog(
  src: ShareSource,
  listAll?: () => Promise<SeriesRef[]>,
): Promise<void> {
  if (document.getElementById("idc-download")) return;
  const overlay = document.createElement("div");
  overlay.id = "idc-download";
  overlay.style.cssText = OVERLAY_CSS;
  overlay.innerHTML = `
    <div style="${CARD_CSS.replace("width:600px", "width:560px")}">
      <h3 style="margin:0 0 4px;color:#fff;">Downloading study</h3>
      <p style="margin:0 0 6px;color:#9fb3d0;">${src.sd}${src.st ? " · " + src.st : ""}</p>
      <p style="margin:0 0 14px;color:#5a6b85;font-size:11px;">${src.lic || "NCI Imaging Data Commons — open data"}</p>
      <div style="height:8px;background:#0b0e16;border:1px solid #1b2740;border-radius:5px;overflow:hidden;">
        <div id="idc-dl-bar" style="height:100%;width:0%;background:#2b6cb0;transition:width .2s;"></div>
      </div>
      <p id="idc-dl-note" style="margin:10px 0 0;color:#9fb3d0;font-variant-numeric:tabular-nums;">starting…</p>
      <div style="text-align:right;margin-top:12px;">
        <button id="idc-dl-close" style="font:600 12px -apple-system,system-ui,sans-serif;color:#9fb3d0;
          background:none;border:none;cursor:pointer;padding:6px 4px;">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const bar = overlay.querySelector("#idc-dl-bar") as HTMLElement;
  const note = overlay.querySelector("#idc-dl-note") as HTMLElement;
  const closeBtn = overlay.querySelector("#idc-dl-close") as HTMLButtonElement;
  closeBtn.addEventListener("click", () => overlay.remove()); // the download keeps running

  try {
    const loaded: SeriesRef[] = [{ prefix: src.c, bucket: src.cb, modality: src.m }];
    if (src.s) loaded.push({ prefix: src.s, bucket: src.sb || "idc-open-data", modality: "SEG" });
    const seriesList = listAll ? await listAll().catch(() => loaded) : loaded;
    await downloadStudy(src, seriesList.length ? seriesList : loaded, (done, total, bytes, msg) => {
      bar.style.width = (total ? (100 * done) / total : 0).toFixed(1) + "%";
      note.textContent = total
        ? `${done.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} files · ${(bytes / 1e6).toFixed(0)} MB — ${msg}`
        : msg;
    });
    bar.style.width = "100%";
    closeBtn.textContent = "Done";
  } catch (err) {
    note.textContent = "download failed: " + (err as Error).message;
    note.style.color = "#ff6b74";
    closeBtn.textContent = "Close";
  }
}

// Harness hook: drive Share/Download without the OS folder picker (opts.root → OPFS).
(globalThis as Record<string, unknown>).__slicerLiveIdc = {
  studyShareURL,
  shareStudy,
  downloadStudy,
  downloadStudyWithDialog,
};
