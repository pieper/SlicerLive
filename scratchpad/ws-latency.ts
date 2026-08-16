// Record arrival wall-clock (ms) of each SegEdit; write to a file so we can compare with Slicer's send time.
const ws = new WebSocket("ws://localhost:2142/");
const rows: string[] = [];
ws.onopen = () => ws.send(JSON.stringify({ op: "subscribe", types: ["segmentation","segEdit"] }));
ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.event === "SegEdit") { rows.push(`recv ${Date.now()} ${JSON.stringify(m.edit?.points?.length)}pts`); console.log(rows[rows.length-1]); } };
await new Promise((r) => setTimeout(r, 16000));
Deno.exit(0);
