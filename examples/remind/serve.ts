// Dev server for ReMINDer — for iterating on the design without a manual build step.
//
//   deno run -A examples/remind/serve.ts [port]      # default 8788
//     http://localhost:8788/            the dashboard
//     http://localhost:8788/compare     the viewer straight up (add ?case=ReMIND-001)
//
// It REBUILDS the bundle on demand: a request for remind-compare.js checks the mtimes of
// the TypeScript sources and re-bundles if any is newer, so the loop is edit → reload, with
// no separate `deno bundle` to forget. Bundling takes ~30 ms, so this is not worth caching
// more cleverly than "is anything newer than the output".
//
// Pixels still come from IDC's public bucket over the network — this only serves the app.
const HERE = new URL(".", import.meta.url).pathname;
const ROOT = HERE.replace(/examples\/remind\/$/, "");
const port = Number(Deno.args[0] ?? 8788);

const BUNDLE = HERE + "remind-compare.js";
const ENTRY = HERE + "remind-compare-browser.ts";
const SOURCES = [ENTRY, HERE + "remind-compare-scene.ts", HERE + "remind-data.ts"];

const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".css": "text/css", ".map": "application/json",
};

async function mtime(p: string): Promise<number> {
  try { return (await Deno.stat(p)).mtime?.getTime() ?? 0; } catch { return 0; }
}

let building: Promise<void> | null = null;
async function rebuildIfStale() {
  if (building) return building;
  building = (async () => {
    const out = await mtime(BUNDLE);
    // the render/ engine is a dependency too — a change there must show up without a manual
    // rebuild, so take the newest mtime across the whole import surface we care about
    const deps = [...SOURCES];
    for (const d of ["render", "algorithms", "logic"]) {
      for await (const e of Deno.readDir(ROOT + d)) {
        if (e.isFile && e.name.endsWith(".ts")) deps.push(ROOT + d + "/" + e.name);
      }
    }
    let newest = 0;
    for (const d of deps) newest = Math.max(newest, await mtime(d));
    if (newest <= out) return;
    const t0 = performance.now();
    const cmd = new Deno.Command("deno", { args: ["bundle", ENTRY, "-o", BUNDLE], cwd: ROOT, stderr: "piped", stdout: "piped" });
    const r = await cmd.output();
    const ms = (performance.now() - t0).toFixed(0);
    if (r.code === 0) console.log(`  rebuilt remind-compare.js in ${ms} ms`);
    else console.error("  BUNDLE FAILED:\n" + new TextDecoder().decode(r.stderr));
  })();
  try { await building; } finally { building = null; }
}

console.log(`ReMINDer dev server
  dashboard  http://localhost:${port}/
  viewer     http://localhost:${port}/compare?case=ReMIND-001
  (the bundle rebuilds itself when any source is newer — just reload)`);

Deno.serve({ port, onListen: () => {} }, async (req) => {
  let path = decodeURIComponent(new URL(req.url).pathname);
  if (path === "/") path = "/reminder.html";
  if (path === "/compare") path = "/remind-compare.html";
  if (path.endsWith("remind-compare.js")) await rebuildIfStale();
  const file = HERE + path.replace(/^\//, "");
  try {
    const body = await Deno.readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    return new Response(body, {
      headers: {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        "access-control-allow-origin": "*",
        // never cache during iteration: a stale bundle is indistinguishable from a code bug
        "cache-control": "no-store, must-revalidate",
      },
    });
  } catch {
    return new Response("not found: " + path, { status: 404 });
  }
});
