// Probe the GUI stream: subscribe, print regions/menus, save the first PNG per region, click a
// module-panel widget, type a key, and report frame counts. deno run -A ModuleServer/tools/gui-probe.ts [ws://localhost:2133/]
const url = Deno.args[0] ?? "ws://localhost:2133/";
const outDir = Deno.args[1] ?? "/tmp/gui-probe";
await Deno.mkdir(outDir, { recursive: true });
const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";
const counts: Record<string, number> = {};
let regions: { id: string; kind: string; x: number; y: number; w: number; h: number }[] = [];
const saved = new Set<string>();
const dec = new TextDecoder();
ws.onopen = () => { ws.send(JSON.stringify({ op: "subscribe", dpr: 1 })); ws.send(JSON.stringify({ op: "resize", w: 1440, h: 900 })); };
ws.onmessage = async (m) => {
  if (typeof m.data === "string") {
    const j = JSON.parse(m.data);
    if (j.ev === "regions") { regions = j.regions; console.log("regions", j.w, j.h, "viewport", JSON.stringify(j.viewport), regions.map((r) => `${r.id}[${r.kind} ${r.x},${r.y} ${r.w}x${r.h}]`).join(" ")); }
    else if (j.ev === "menus") console.log("menus", j.menus.map((mm: { title: string; items: unknown[] }) => `${mm.title}(${mm.items.length})`).join(" "));
    else console.log("text", m.data.slice(0, 200));
    return;
  }
  const buf = new Uint8Array(m.data as ArrayBuffer);
  const hl = new DataView(buf.buffer).getUint32(0);
  const hdr = JSON.parse(dec.decode(buf.subarray(4, 4 + hl)));
  counts[hdr.region] = (counts[hdr.region] ?? 0) + 1;
  if (!saved.has(hdr.region)) { saved.add(hdr.region); await Deno.writeFile(`${outDir}/${hdr.region.replace(/[^\w]/g, "_")}.png`, buf.subarray(4 + hl)); }
};
await new Promise((r) => setTimeout(r, 3000));
console.log("frames after 3s", JSON.stringify(counts));
// click near the top of the module panel (collapsible header) and type into wherever focus lands
const panel = regions.find((r) => r.id === "PanelDockWidget");
if (panel) {
  const x = 60, y = 40;
  for (const type of ["move", "down", "up"]) ws.send(JSON.stringify({ op: "pointer", type, region: "PanelDockWidget", x, y, button: 0, buttons: type === "down" ? 1 : 0, mods: {} }));
}
ws.send(JSON.stringify({ op: "key", type: "down", key: "a", text: "a", mods: {} }));
ws.send(JSON.stringify({ op: "key", type: "up", key: "a", text: "a", mods: {} }));
await new Promise((r) => setTimeout(r, 1500));
console.log("frames after click", JSON.stringify(counts));
ws.close(); Deno.exit(0);
