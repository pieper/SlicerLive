const url = Deno.args[0] ?? "ws://localhost:2142/";
const dur = Number(Deno.args[1] ?? 22000);
const ws = new WebSocket(url);
const seg: unknown[] = [];
ws.onopen = () => { ws.send(JSON.stringify({ op: "subscribe", types: ["segmentation","image","camera","view","layout","volumeRenderingDisplay","scalarVolumeDisplay","transferFunction","segEdit"] })); console.error("[ws] subscribed"); };
ws.onmessage = (e) => {
  let m: any; try { m = JSON.parse(e.data as string); } catch { return; }
  if (m.event === "SegEdit") { seg.push(m); console.log("SEGEDIT " + JSON.stringify(m)); }
};
ws.onerror = () => console.error("[ws] error");
await new Promise((r) => setTimeout(r, dur));
console.error(`[ws] done — ${seg.length} SegEdit event(s)`);
Deno.exit(0);
