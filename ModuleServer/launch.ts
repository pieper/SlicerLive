// ModuleServer launcher -- start a stock 3D Slicer as a headless ModuleServer and report READY.
//
//   deno run --allow-run --allow-read --allow-write --allow-env ModuleServer/launch.ts [options]
//
// Options:
//   --slicer <path>   Slicer executable or .app (default: newest /Applications/Slicer-*.app)
//   --http <port>     mrson HTTP port (scene.json + blobs)          default 2131
//   --ws <port>       mrson live WebSocket port (events + ops)      default 2132
//   --mcp <port>      MCP port for automation/tests, 0 = off        default 2126
//   --gui <port>      GUI stream WebSocket (frames + events)        default 2133
//   --mcp-server <p>  slicer-mcp-server.py (default ~/slicer/slicer-skill/slicer-mcp-server.py)
//   --state <path>    JSON state file written when READY (default: <log dir>/moduleserver-<ws>.json)
//   --log <path>      Slicer stdout/stderr log (default: ~/.slicerlive/moduleserver/<ws>.log)
//   --show            keep Slicer's main window visible (debug)
//   --platform <qpa>  Qt platform plugin: offscreen (Qt6 builds; true headless), cocoa/xcb/windows,
//                     or "" to leave Qt's default. Default: offscreen if the build ships it, else default.
//   --dpr <n>         device pixel ratio for GUI grabs (QT_SCALE_FACTOR; 2 = retina)  default 1
//   --roles <list>    capabilities this server advertises, comma separated (default module; POC: app,module)
//   --extra <args>    extra Slicer args, comma separated (e.g. --extra=--disable-cli-modules)
//   --token <secret>  require ?token=<secret> on both WebSockets (remote deployments; put wss in front)
//   --session <dir>   SlicerLiveSessions/<id> the server may write (blob cache, exports); default: a temp dir
//   --sandbox <mode>  none (default) | seatbelt (macOS: sandbox-exec, HOSTILE mode: writes only to the session +
//                    Slicer settings, no secrets, no network except localhost and --allow-host)
//   --allow-host <h>  host:port the sandboxed server may reach besides localhost (data host); repeatable ,-list
//
// Prints one JSON line `{"READY": {...}}` on stdout once the servers are up, then stays attached;
// Ctrl-C (SIGINT/SIGTERM) stops the Slicer child. Exit codes: 0 clean, 2 launch failure, 3 timeout.
//
// This launcher is the unprivileged-process seam for sandboxing (plan section 5): everything the
// ModuleServer may touch is decided HERE (which Slicer, which ports, later: which sandbox rung).
import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, {
  string: ["slicer", "http", "ws", "mcp", "mcp-server", "state", "log", "extra", "platform", "roles", "gui", "dpr", "token", "session", "sandbox", "allow-host"],
  boolean: ["show", "help"],
  default: { http: "2131", ws: "2132", mcp: "2126", gui: "2133", roles: "module", dpr: "1" },
});
if (args.help) { console.log(new TextDecoder().decode(await Deno.readFile(new URL(import.meta.url))).split("\n").filter((l) => l.startsWith("//")).join("\n")); Deno.exit(0); }

const HOME = Deno.env.get("HOME") ?? ".";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const BOOTSTRAP = `${ROOT}/ModuleServer/python/bootstrap.py`;

function findSlicer(): string {
  if (args.slicer) return resolveExe(args.slicer);
  const apps: string[] = [];
  try { for (const e of Deno.readDirSync("/Applications")) if (/^Slicer-[\d.]+\.app$/.test(e.name)) apps.push(e.name); } catch { /* not macOS */ }
  apps.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (apps.length) return `/Applications/${apps[apps.length - 1]}/Contents/MacOS/Slicer`;
  for (const c of ["/opt/sr/Slicer-build/Slicer", `${HOME}/Slicer/Slicer`]) { try { Deno.statSync(c); return c; } catch { /* next */ } }
  throw new Error("no Slicer found; pass --slicer <path>");
}
function resolveExe(p: string): string {
  if (p.endsWith(".app")) return `${p}/Contents/MacOS/Slicer`;
  try { if (Deno.statSync(p).isDirectory) { for (const c of [`${p}/Slicer-build/Slicer`, `${p}/Slicer`]) { try { Deno.statSync(c); return c; } catch { /* next */ } } } } catch { /* fallthrough */ }
  return p;   // a launcher (build tree: /opt/sr/Slicer-build/Slicer) or the real executable
}
/** Does this Slicer's Qt ship the offscreen QPA plugin? (build trees use the system Qt's plugin dir) */
function hasOffscreen(exe: string): boolean {
  const candidates = [
    `${exe.replace(/\/Contents\/MacOS\/Slicer$/, "")}/Contents/lib/QtPlugins/platforms`,
    "/opt/homebrew/share/qt/plugins/platforms", "/usr/lib/qt6/plugins/platforms", "/usr/lib/x86_64-linux-gnu/qt6/plugins/platforms",
  ];
  for (const d of candidates) { try { for (const e of Deno.readDirSync(d)) if (/qoffscreen/.test(e.name)) return true; } catch { /* next */ } }
  return false;
}

const slicer = findSlicer();
const logDir = `${HOME}/.slicerlive/moduleserver`;
await Deno.mkdir(logDir, { recursive: true });
const logPath = args.log ?? `${logDir}/${args.ws}.log`;
const statePath = args.state ?? `${logDir}/moduleserver-${args.ws}.json`;
const mcpServer = args["mcp-server"] ?? `${HOME}/slicer/slicer-skill/slicer-mcp-server.py`;
try { await Deno.remove(statePath); } catch { /* none */ }

const platform = args.platform ?? (hasOffscreen(slicer) ? "offscreen" : "");
const env: Record<string, string> = {
  ...(platform ? { QT_QPA_PLATFORM: platform } : {}),
  ...(args.dpr && args.dpr !== "1" ? { QT_SCALE_FACTOR: args.dpr } : {}),
  MODULESERVER_PLATFORM: platform,
  MODULESERVER_ROLES: args.roles!,
  MODULESERVER_ROOT: ROOT,
  MODULESERVER_STATE: statePath,
  MODULESERVER_HTTP_PORT: args.http!,
  MODULESERVER_WS_PORT: args.ws!,
  MODULESERVER_MCP_PORT: args.mcp!,
  MODULESERVER_GUI_PORT: args.gui!,
  MODULESERVER_MCP_SERVER: mcpServer,
  MODULESERVER_SHOW: args.show ? "1" : "0",
  ...(args.token ? { MODULESERVER_TOKEN: args.token } : {}),
};
const extra = args.extra ? args.extra.split(",").filter(Boolean) : [];
const sessionDir = args.session ?? await Deno.makeTempDir({ prefix: "slicerlive-session-" });
env.MODULESERVER_SESSION_DIR = sessionDir;
const slicerArgs = ["--no-splash", "--ignore-slicerrc", ...extra, "--python-script", BOOTSTRAP];
// Sandbox rung (S14). The launcher is the seam: everything the server may touch is decided here.
let exe = slicer, exeArgs = slicerArgs;
if (args.sandbox && args.sandbox !== "none") {
  if (args.sandbox !== "seatbelt" || Deno.build.os !== "darwin") throw new Error(`--sandbox ${args.sandbox} is not available on ${Deno.build.os} (macOS: seatbelt)`);
  const profile = `${logDir}/moduleserver-${args.ws}.sb`;
  const hosts = (args["allow-host"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const template = await Deno.readTextFile(new URL("./sandbox/moduleserver-seatbelt.sb", import.meta.url));
  await Deno.writeTextFile(profile, template + hosts.map((h) => `(allow network-outbound (remote ip "${h.replace(/"/g, "")}"))\n`).join(""));
  // the tree the profile treats as the Slicer install: the .app bundle, or (build/unpacked trees like
  // /opt/sr/Slicer-build/Slicer with python-install beside it) the grandparent directory
  const slicerHome = /\.app\/Contents\/MacOS\/Slicer$/.test(slicer) ? slicer.replace(/\/Contents\/MacOS\/Slicer$/, "") : slicer.replace(/\/[^/]+\/[^/]+$/, "");
  exe = "/usr/bin/sandbox-exec";
  exeArgs = ["-f", profile, "-D", `SESSION_DIR=${sessionDir}`, "-D", `SLICER_HOME=${slicerHome}`, "-D", `STATE_DIR=${logDir}`, "-D", `HOME=${HOME}`,
    slicer, ...slicerArgs];
  console.error(`moduleserver: sandbox seatbelt (profile ${profile}; writes: ${sessionDir}; hosts: localhost${hosts.length ? ", " + hosts.join(", ") : ""})`);
}
// Hostile mode never inherits the launching shell's environment (API tokens, cloud credentials, ...):
// only a short allow-list crosses, plus what the launcher set explicitly above.
const sandboxed = !!args.sandbox && args.sandbox !== "none";
const KEEP = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "DISPLAY", "XDG_RUNTIME_DIR", "SHELL"];
const childEnv: Record<string, string> = sandboxed
  ? Object.fromEntries([...KEEP.map((k) => [k, Deno.env.get(k) ?? ""]).filter(([, v]) => v), ...Object.entries(env)])
  : env;
const cmd = new Deno.Command(exe, { args: exeArgs, env: childEnv, clearEnv: sandboxed, stdout: "piped", stderr: "piped", stdin: "null" });
const child = cmd.spawn();
const log = await Deno.open(logPath, { write: true, create: true, truncate: true });
console.error(`moduleserver: ${slicer}\n  platform ${platform || "(default)"}  roles ${args.roles}\n  log ${logPath}\n  state ${statePath}`);

let ready = false;
const stop = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
Deno.addSignalListener("SIGINT", stop);
Deno.addSignalListener("SIGTERM", stop);

// Scan stdout for the READY/ERROR line; tee everything to the log file.
async function pump(stream: ReadableStream<Uint8Array>, scan: boolean) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    await log.write(chunk);
    if (!scan) continue;
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.startsWith("{\"READY\"")) { ready = true; console.log(line); }
      else if (line.startsWith("{\"ERROR\"")) { console.error(line); stop(); }
      else if (line.startsWith("{\"warn\"")) console.error(line);
    }
  }
}
const timeout = setTimeout(() => { if (!ready) { console.error("moduleserver: timeout waiting for READY (see log)"); stop(); Deno.exit(3); } }, 180_000);
const pumps = Promise.all([pump(child.stdout, true), pump(child.stderr, false)]);
const status = await child.status;
clearTimeout(timeout);
await pumps;
log.close();
try { await Deno.remove(statePath); } catch { /* none */ }
Deno.exit(ready ? 0 : 2);
