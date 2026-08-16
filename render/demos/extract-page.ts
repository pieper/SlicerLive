// Lightweight KiTS extractor: loads a case (CT + SEG) from IDC via idc_tools and
// POSTs the raw arrays + geometry to the local drop server. NO WebGPU — this exists
// only to cache native arrays to disk so the feature-cortex work happens headless in
// Deno. Bundle: deno run -A npm:esbuild@0.21.5 render/demos/extract-page.ts --bundle
//   --format=esm --outfile=render/demos/extract.js
//   ?pid=KiTS-00012   which case   ?drop=http://127.0.0.1:8150   drop server
import { loadManifest, loadSeries } from "../vendor/idc_tools/index.js";
import type { SeriesEntry } from "../vendor/idc_tools/index.js";

const P = new URLSearchParams(location.search);
const PID = P.get("pid") || "";
const DROP = P.get("drop") || "http://127.0.0.1:8150";
const el = document.getElementById("s")!;
const log = (m: string) => { el.textContent = m; console.log(m); };
const post = (name: string, body: BodyInit) => fetch(`${DROP}/save/${name}`, { method: "POST", body });

(async () => {
  try {
    if (!PID) { log("no ?pid"); (globalThis as Record<string, unknown>).__done = "err"; return; }
    log("loading manifest…");
    const man = await loadManifest("./segroulette.json");
    const entry = (man.rows as Array<SeriesEntry & { pid?: string }>).find((r) => r.pid === PID);
    if (!entry) { log(`no manifest row ${PID}`); (globalThis as Record<string, unknown>).__done = "err"; return; }
    log(`loading ${PID} from IDC…`);
    const res = await loadSeries(entry, { onProgress: (p) => log(`${PID}: ${p.msg} ${Math.round(p.frac * 100)}%`) });
    if (!res.ct || !res.seg) { log(`${PID}: CT or SEG failed`); (globalThis as Record<string, unknown>).__done = "err"; return; }
    const ct = res.ct, seg = res.seg;
    // CT scalars: Int16 HU for CT. Store as int16 regardless (KiTS is CT).
    const i16 = ct.vol instanceof Int16Array ? ct.vol : Int16Array.from(ct.vol as ArrayLike<number>);
    await post(`${PID}.ct.i16`, i16.buffer.slice(i16.byteOffset, i16.byteOffset + i16.byteLength));
    await post(`${PID}.lab.u8`, seg.lab.buffer.slice(seg.lab.byteOffset, seg.lab.byteOffset + seg.lab.byteLength));
    const meta = {
      pid: PID, dims: ct.dims, ijkToRAS: ct.ijkToRAS, win: ct.win, lev: ct.lev,
      dtype: "int16", modality: ct.modality ?? "CT",
      colors: seg.colors, names: seg.names,
    };
    await post(`${PID}.json`, new Blob([JSON.stringify(meta)], { type: "application/json" }));
    log(`${PID} DONE — dims ${ct.dims.join("x")}, segs ${seg.colors.map((c) => c[0]).join(",")}`);
    (globalThis as Record<string, unknown>).__done = "ok";
  } catch (e) {
    log(`ERR ${e}`);
    (globalThis as Record<string, unknown>).__done = "err";
  }
})();
