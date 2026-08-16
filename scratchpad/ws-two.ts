function client(tag: string, localBulk: string[]) {
  const ws = new WebSocket("ws://localhost:2142/");
  ws.onopen = () => ws.send(JSON.stringify({ op: "subscribe", types: ["segmentation"], localBulk }));
  let snap = 0, upd = 0, done = false;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string);
    if (m.event === "SnapshotComplete") { done = true; return; }
    if (m.event === "NodeAdded" && m.node?.type === "segmentation") { if (done) upd++; else snap++; }
  };
  return () => console.log(`${tag}: snapshot-seg=${snap} update-seg=${upd}`);
}
const a = client("A(localBulk=segmentation)", ["segmentation"]);
const b = client("B(normal)", []);
await new Promise((r) => setTimeout(r, 12000));
a(); b();
Deno.exit(0);
