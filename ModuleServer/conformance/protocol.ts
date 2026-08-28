// Protocol conformance for a ModuleServer WS A peer — itself a minimal non-SlicerLive client. Run against
// any server: the Slicer peer, the mock, a future OHIF/MITK-side implementation. Each check returns a
// pass/fail with detail; runProtocolConformance(url) never throws.
export interface ProtoResult { name: string; ok: boolean; detail: string }

class Client {
  ws: WebSocket; events: Record<string, unknown>[] = []; waiters: ((e: Record<string, unknown>) => void)[] = [];
  constructor(url: string) { this.ws = new WebSocket(url); this.ws.onmessage = (m) => { let j; try { j = JSON.parse(m.data); } catch { return; } this.events.push(j); for (const w of this.waiters.splice(0)) w(j); }; }
  open() { return new Promise<void>((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error("connect failed")); }); }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  /** Wait for an event matching `pred` (already received or future), up to `ms`. */
  wait(pred: (e: Record<string, unknown>) => boolean, ms = 8000): Promise<Record<string, unknown> | null> {
    const have = this.events.find(pred); if (have) return Promise.resolve(have);
    return new Promise((res) => { const t = setTimeout(() => res(null), ms); const w = (e: Record<string, unknown>) => { if (pred(e)) { clearTimeout(t); res(e); } else this.waiters.push(w); }; this.waiters.push(w); });
  }
  close() { this.ws.close(); }
}

export async function runProtocolConformance(url: string, opts: { types?: string[]; putType?: string } = {}): Promise<ProtoResult[]> {
  const out: ProtoResult[] = [];
  const check = async (name: string, fn: () => Promise<void>) => { try { await fn(); out.push({ name, ok: true, detail: "" }); } catch (e) { out.push({ name, ok: false, detail: String((e as Error).message ?? e) }); } };
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
  const types = opts.types ?? ["markup", "image", "camera", "view", "module"];
  const c = new Client(url);
  try { await c.open(); } catch (e) { return [{ name: "connect", ok: false, detail: String(e) }]; }

  await check("subscribe → snapshot ends with SnapshotComplete carrying seq", async () => {
    c.send({ op: "subscribe", types, lastSeq: 0 });
    const done = await c.wait((e) => e.event === "SnapshotComplete");
    assert(done, "no SnapshotComplete"); assert(typeof done!.seq === "number", "SnapshotComplete has no seq");
    for (const e of c.events) if (e.event === "NodeAdded") { assert(typeof e.seq === "number", "NodeAdded without seq"); assert((e.node as { id?: string })?.id, "NodeAdded without node.id"); }
  });
  let created = "";
  await check("put → OpAck with tag + created map; NodeAdded (with clientId) for the new node", async () => {
    c.send({ op: "applyOps", tag: 101, ops: [{ op: "put", id: "conf-tmp-1", node: { type: opts.putType ?? "markup", id: "conf-tmp-1", name: "ConformancePut", markupType: "fiducial", controlPoints: [{ position: [1, 2, 3] }], visible: true } }] });
    const ack = await c.wait((e) => e.event === "OpAck" && e.tag === 101);
    assert(ack, "no OpAck for tag 101"); assert(typeof ack!.seq === "number", "OpAck without seq"); assert((ack!.applied as number) >= 1, "put not applied: " + JSON.stringify(ack!.errors));
    created = ((ack!.created as Record<string, string>) ?? {})["conf-tmp-1"] ?? "";
    assert(created, "OpAck.created lacks the provisional id");
    const added = await c.wait((e) => e.event === "NodeAdded" && (e.sourceId === created || e.clientId === "conf-tmp-1"), 4000);
    assert(added, "no NodeAdded for the created node");
  });
  await check("patch on the created node → OpAck applied ≥ 1 and an echo NodeAdded", async () => {
    assert(created, "no created node"); const before = c.events.length;
    c.send({ op: "applyOps", tag: 102, ops: [{ op: "patch", id: created, path: "#/visible", value: false }] });
    const ack = await c.wait((e) => e.event === "OpAck" && e.tag === 102);
    assert(ack && (ack.applied as number) >= 1, "patch not applied: " + JSON.stringify(ack?.errors));
    const echo = await c.wait((e) => e.event === "NodeAdded" && e.sourceId === created && c.events.indexOf(e) >= before, 4000);
    assert(echo, "no echo after patch");
  });
  await check("reconcile → Reconciled", async () => {
    c.send({ op: "reconcile", nodes: created ? { [created]: { type: "markup", id: created, visible: true } } : {} });
    const r = await c.wait((e) => e.event === "Reconciled"); assert(r, "no Reconciled"); assert(typeof r!.applied === "number", "Reconciled.applied missing");
  });
  await check("del → OpAck + NodeRemoved", async () => {
    assert(created, "no created node");
    c.send({ op: "applyOps", tag: 103, ops: [{ op: "del", id: created }] });
    const ack = await c.wait((e) => e.event === "OpAck" && e.tag === 103); assert(ack && (ack.applied as number) >= 1, "del not applied");
    const rm = await c.wait((e) => e.event === "NodeRemoved" && e.sourceId === created, 4000); assert(rm, "no NodeRemoved");
  });
  await check("unknown op is ignored, connection stays open", async () => {
    c.send({ op: "no-such-op" }); await new Promise((r) => setTimeout(r, 300)); assert(c.ws.readyState === WebSocket.OPEN, "connection dropped");
  });
  c.close();
  return out;
}

if (import.meta.main) {
  const url = Deno.args[0] ?? "ws://localhost:2132/";
  const res = await runProtocolConformance(url);
  for (const r of res) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  Deno.exit(res.every((r) => r.ok) ? 0 : 1);
}
