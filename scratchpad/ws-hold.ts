const mk = (lb: string[]) => { const ws = new WebSocket("ws://localhost:2142/"); ws.onopen = () => ws.send(JSON.stringify({ op: "subscribe", types: ["segmentation"], localBulk: lb })); return ws; };
mk(["segmentation"]); mk([]);
await new Promise((r) => setTimeout(r, 15000)); Deno.exit(0);
