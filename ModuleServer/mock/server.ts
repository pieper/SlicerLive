// A mock, non-Slicer ModuleServer: proves the protocol is Slicer-independent. Deno WebSocket server
// implementing WS A (mrson peer): Hello capabilities, subscribe → snapshot + SnapshotComplete (seq on
// every event), applyOps → OpAck {tag, seq, applied, errors, created}, put (assigns its own ids),
// reconcile → Reconciled, getNode. No GUI (gui: "none"). One module, "MarkCenter": a cmd on the
// module node that creates a fiducial at the centre of a referenced image (metadata only — it never
// needs voxels), showing a server contributing nodes to a shared LiveScene.
//   deno run --allow-net ModuleServer/mock/server.ts [port=2142]
export interface MockServer { port: number; nodes: Map<string, Record<string, unknown>>; close(): void }

export function startMockServer(port = 2142): MockServer {
  const nodes = new Map<string, Record<string, unknown>>();
  nodes.set("mock-module-MarkCenter", { type: "module", id: "mock-module-MarkCenter", name: "MarkCenter", server: "mock", gui: "none" });
  let seq = 0, created = 0;
  const clients = new Set<WebSocket>();
  const send = (ws: WebSocket, ev: Record<string, unknown>) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...ev, seq: ++seq })); };
  const broadcast = (ev: Record<string, unknown>, except?: WebSocket) => { for (const c of clients) if (c !== except) send(c, ev); };
  const subs = new Map<WebSocket, Set<string>>();

  const applyPatch = (node: Record<string, unknown>, path: string, value: unknown): boolean => {
    const keys = path.replace(/^#/, "").split("/").filter(Boolean);
    if (!keys.length) return false;
    let cur: Record<string, unknown> = node;
    for (const k of keys.slice(0, -1)) { if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {}; cur = cur[k] as Record<string, unknown>; }
    cur[keys[keys.length - 1]] = value; return true;
  };
  const applyOp = (op: Record<string, unknown>, _ws: WebSocket, createdMap: Record<string, string>): boolean => {
    const id = op.id as string;
    if (op.op === "put") {
      const node = { ...(op.node as Record<string, unknown>) };
      // ids are global in mrson: a put keeps the id it came with (a node relayed from another peer must
      // stay addressable under ONE id everywhere). Only provisional client ids ("tmp-…"/"conf-…") get ours.
      const real = nodes.has(id) || !/^(tmp|conf)-/.test(id) ? id : `mock${++created}`;
      node.id = real; nodes.set(real, node); if (real !== id) createdMap[id] = real;
      broadcast({ event: "NodeAdded", sourceId: real, node, ...(real !== id ? { clientId: id } : {}) });   // echo to everyone incl. the writer (like MRML observers)
      return true;
    }
    if (op.op === "del") { if (!nodes.delete(id)) return false; broadcast({ event: "NodeRemoved", sourceId: id }); return true; }
    if (op.op === "patch") { const n = nodes.get(id); if (!n) return false; const ok = applyPatch(n, op.path as string, op.value); if (ok) broadcast({ event: "NodeAdded", sourceId: id, node: n }); return ok; }
    if (op.op === "cmd" && op.cmd === "markCenter") {
      // the module: put a fiducial at the centre of the referenced image's bounds (from ijkToRAS + dims)
      const img = nodes.get(((op.args as Record<string, unknown>)?.image as string) ?? "");
      if (!img) return false;
      const m = img.ijkToRAS as number[], d = img.dims as number[];
      const c = [0, 1, 2].map((r) => m[r * 4] * (d[0] - 1) / 2 + m[r * 4 + 1] * (d[1] - 1) / 2 + m[r * 4 + 2] * (d[2] - 1) / 2 + m[r * 4 + 3]);
      const real = `mock${++created}`;
      const node = { type: "markup", id: real, name: "MarkCenter", markupType: "fiducial", controlPoints: [{ position: c, label: "center" }], color: [0.2, 0.9, 1, 1], visible: true, source: { server: "mock", module: "MarkCenter" } };
      nodes.set(real, node); broadcast({ event: "NodeAdded", sourceId: real, node });   // to everyone incl. the caller
      return true;
    }
    return false;
  };

  const server = Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, (req) => {
    if (req.headers.get("upgrade") !== "websocket") return new Response("mock ModuleServer", { status: 200 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => { clients.add(socket); send(socket, { event: "Hello", roles: ["module"], modules: ["MarkCenter"], gui: "none", bulk: "lazy", server: "mock" }); };
    socket.onclose = () => { clients.delete(socket); subs.delete(socket); };
    socket.onmessage = (m) => {
      let msg: Record<string, unknown>; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.op === "subscribe") {
        const types = new Set((msg.types as string[]) ?? []); subs.set(socket, types);
        for (const n of nodes.values()) if (types.has(n.type as string) || types.size === 0) send(socket, { event: "NodeAdded", sourceId: n.id, node: n });
        send(socket, { event: "SnapshotComplete", sourceId: "", authority: "replica" });
      } else if (msg.op === "applyOps") {
        const createdMap: Record<string, string> = {}; let applied = 0; const errors: string[] = [];
        for (const op of (msg.ops as Record<string, unknown>[]) ?? []) { try { if (applyOp(op, socket, createdMap)) applied++; } catch (e) { errors.push(String(e)); } }
        send(socket, { event: "OpAck", tag: msg.tag, received: ((msg.ops as unknown[]) ?? []).length, applied, errors, created: createdMap });
      } else if (msg.op === "reconcile") {
        let applied = 0;
        for (const [id, n] of Object.entries((msg.nodes as Record<string, Record<string, unknown>>) ?? {})) { if (nodes.has(id) && JSON.stringify(nodes.get(id)) !== JSON.stringify(n)) { nodes.set(id, n); applied++; } }
        send(socket, { event: "Reconciled", applied });
      } else if (msg.op === "getNode") {
        const n = nodes.get(msg.id as string); if (n) send(socket, { event: "NodeAdded", sourceId: n.id, node: n });
      }
    };
    return response;
  });
  return { port, nodes, close() { server.shutdown(); } };
}

if (import.meta.main) {
  const s = startMockServer(Number(Deno.args[0] ?? 2142));
  console.log(`mock ModuleServer: ws://127.0.0.1:${s.port}/  (module MarkCenter, gui none)`);
}
