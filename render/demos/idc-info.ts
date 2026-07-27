// Shared IDC "Details" dialog for IDC demos (DRY): a glass modal with the source citation (DOIs),
// license, links to the OHIF viewer + IDC portal, and the full segment list — the old SEGRoulette
// "Details" panel. Reusable by any Imaging Data Commons demo.
import type { SeriesEntry } from "../vendor/idc_tools/types.js";

export interface IdcInfoOpts {
  getEntry: () => (SeriesEntry & Record<string, unknown>) | undefined;
  getSegments: () => { name: string; color: [number, number, number] }[];
  ohifURL: (studyInstanceUID: string) => string;
}

function glass(el: HTMLElement) {
  el.style.cssText += ";background:linear-gradient(135deg,rgba(58,64,88,.55),rgba(20,24,38,.66));" +
    "backdrop-filter:blur(22px) saturate(1.6);-webkit-backdrop-filter:blur(22px) saturate(1.6);" +
    "border:1px solid rgba(255,255,255,.2);box-shadow:0 20px 56px rgba(0,0,0,.6);";
}

/** Append a "ⓘ Details" button to `host` and wire the dialog. Returns { refresh } (no-op hook). */
export function installIdcInfo(host: HTMLElement, opts: IdcInfoOpts): { refresh(): void } {
  const btn = document.createElement("button");
  btn.textContent = "ⓘ Details";
  btn.style.cssText = "cursor:pointer;white-space:nowrap;border:1px solid rgba(255,255,255,.18);border-radius:7px;" +
    "padding:5px 11px;font:600 12px -apple-system,system-ui,sans-serif;color:#cfe6ff;background:rgba(255,255,255,.06);";
  btn.onclick = open;
  host.appendChild(btn);

  let modal: HTMLElement | null = null;
  function close() { if (modal) { modal.remove(); modal = null; document.removeEventListener("keydown", onKey, true); } }
  function onKey(e: KeyboardEvent) { if (e.key === "Escape") close(); }

  function open() {
    if (modal) return;
    const e = opts.getEntry();
    const segs = opts.getSegments();
    modal = document.createElement("div");
    modal.style.cssText = "position:fixed;inset:0;z-index:96;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(6,8,14,.55);font:13px/1.5 -apple-system,system-ui,sans-serif;color:#e8eeff;";
    modal.addEventListener("mousedown", (ev) => { if (ev.target === modal) close(); });
    const panel = document.createElement("div");
    panel.style.cssText = "max-width:min(640px,92vw);max-height:86vh;overflow-y:auto;padding:22px 26px;border-radius:16px;";
    glass(panel);

    const col = (e?.col ?? "IDC").toUpperCase();
    const mod = e?.m ?? "";
    const sd = e?.sd ?? "segmentation";
    const lic = e?.lic ?? "";
    const idoi = e?.idoi as string | undefined, sdoi = e?.sdoi as string | undefined, pid = e?.pid as string | undefined;
    const chips = segs.map((s) =>
      `<span style="font-size:11px;border:1px solid rgb(${s.color.map((c) => Math.round(c * 255)).join(",")});border-radius:999px;padding:1px 9px;white-space:nowrap">${s.name}</span>`).join(" ");
    const doiLink = (d?: string, label = "DOI") => d ? `<a href="https://doi.org/${d}" target="_blank" rel="noopener">${label}</a>` : "";
    const ohif = e?.st ? `<a href="${opts.ohifURL(e.st)}" target="_blank" rel="noopener">Open in OHIF viewer</a>` : "";
    const portal = `<a href="https://portal.imaging.datacommons.cancer.gov/explore/filters/?collection_id=${e?.col ?? ""}" target="_blank" rel="noopener">IDC portal — ${e?.col ?? "collections"}</a>`;

    panel.innerHTML =
      `<div style="font:800 20px -apple-system,system-ui,sans-serif">${col} <span style="color:#9fe9ff;font-size:14px">${mod}</span></div>` +
      `<div style="opacity:.8;margin-top:2px">${sd}</div>` +
      (pid ? `<div style="opacity:.5;font-size:12px;margin-top:2px">patient ${pid}</div>` : "") +
      `<div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:5px">${chips || "<i style='opacity:.6'>no segments</i>"}</div>` +
      `<div style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1);display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:12.5px">` +
        (lic ? `<div style="color:#9fe9ff">License</div><div>${lic}</div>` : "") +
        (idoi || sdoi ? `<div style="color:#9fe9ff">Citation</div><div>${[doiLink(idoi, "source series DOI"), doiLink(sdoi, "segmentation DOI")].filter(Boolean).join(" · ")}</div>` : "") +
        `<div style="color:#9fe9ff">View</div><div>${[ohif, portal].filter(Boolean).join(" · ")}</div>` +
      `</div>` +
      `<div style="margin-top:16px;font-size:12px;color:rgba(232,238,255,.55)">Data streamed live from the NCI Imaging Data Commons. Press <b style="color:#fff5d6">esc</b> or click outside to close.</div>`;

    modal.appendChild(panel);
    document.body.appendChild(modal);
    document.addEventListener("keydown", onKey, true);
  }

  return { refresh() {/* dialog reads current entry on open */} };
}
