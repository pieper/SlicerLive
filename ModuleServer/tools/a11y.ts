// Drive a streamed Slicer GUI by widget NAME over the accessibility channel (S12) — no browser, no
// CDP, no MCP: just the gui-stream WebSocket. The same tree the ARIA overlay is built from.
//
//   deno run -A ModuleServer/tools/a11y.ts [--url ws://127.0.0.1:2133/] list [role]
//   deno run -A ModuleServer/tools/a11y.ts click <name> [role]
//   deno run -A ModuleServer/tools/a11y.ts set <name> <value> [role]
//   deno run -A ModuleServer/tools/a11y.ts focus <name> [role]
//
// Names match case-insensitively as substrings; the first ENABLED hit wins. Exit 1 if nothing matched.
import { parseArgs } from "jsr:@std/cli@1/parse-args";

interface A11yNode { id: string; region: string; role: string; name: string; value?: unknown; x: number; y: number; w: number; h: number; enabled: boolean; focused: boolean }

const args = parseArgs(Deno.args, { string: ["url"], default: { url: "ws://127.0.0.1:2133/" } });
const [cmd, name, ...rest] = args._.map(String);
if (!cmd) { console.log("usage: a11y.ts list [role] | click <name> [role] | set <name> <value> [role] | focus <name> [role]"); Deno.exit(2); }

const ws = new WebSocket(args.url);
ws.binaryType = "arraybuffer";
const tree = await new Promise<A11yNode[]>((resolve, reject) => {
  ws.onopen = () => { ws.send(JSON.stringify({ op: "subscribe", dpr: 1 })); ws.send(JSON.stringify({ op: "a11yQuery" })); };
  ws.onmessage = (m) => { if (typeof m.data !== "string") return; const j = JSON.parse(m.data); if (j.ev === "a11y") resolve(j.nodes as A11yNode[]); };
  ws.onerror = (e) => reject(e);
  setTimeout(() => reject(new Error("no a11y tree within 5 s")), 5000);
});

const pick = (n: string, role?: string) => {
  const hits = tree.filter((t) => (!role || t.role === role) && t.name.toLowerCase().includes(n.toLowerCase()));
  const hit = hits.find((t) => t.enabled) ?? hits[0];
  if (!hit) { console.error(`no ${role ?? "widget"} named "${n}"`); Deno.exit(1); }
  return hit;
};
const send = (o: Record<string, unknown>) => ws.send(JSON.stringify(o));

if (cmd === "list") {
  const role = name;
  for (const t of tree) if (!role || t.role === role) console.log(`${t.role.padEnd(10)} ${t.enabled ? " " : "-"} ${t.region.padEnd(22)} ${JSON.stringify(t.name)}${t.value !== undefined ? " = " + JSON.stringify(t.value) : ""}`);
} else if (cmd === "click") { const t = pick(name, rest[0]); send({ op: "a11yClick", id: t.id }); console.log(`clicked ${t.role} ${JSON.stringify(t.name)} in ${t.region}`); }
else if (cmd === "set") { const t = pick(name, rest[1]); send({ op: "a11ySet", id: t.id, value: rest[0] }); console.log(`set ${t.role} ${JSON.stringify(t.name)} = ${JSON.stringify(rest[0])}`); }
else if (cmd === "focus") { const t = pick(name, rest[0]); send({ op: "a11yFocus", id: t.id }); console.log(`focused ${JSON.stringify(t.name)}`); }
else { console.error("unknown command " + cmd); Deno.exit(2); }
await new Promise((r) => setTimeout(r, 300));   // let the op leave before closing
ws.close();
