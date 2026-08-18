// Static server for the colorize example (zarr chunks + scene json + the page itself).
//   deno run -A examples/colorize/serve.ts [port]
const ROOT = new URL(".", import.meta.url).pathname;
const port = Number(Deno.args[0] ?? 8777);
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

Deno.serve({ port, onListen: () => console.log(`colorize example: http://localhost:${port}/colorize.html`) }, async (req) => {
  const path = decodeURIComponent(new URL(req.url).pathname);
  const file = ROOT + (path === "/" ? "colorize.html" : path.replace(/^\//, ""));
  try {
    const body = await Deno.readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    return new Response(body, {
      headers: {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        "access-control-allow-origin": "*",
        // Never cache the page or the bundle during local iteration: a stale cardiac.js is
        // indistinguishable from a code bug and wasted real debugging time. Zarr chunks are
        // content-addressed and immutable, so they stay cacheable.
        ...(ext === ".js" || ext === ".html" || ext === ".json"
          ? { "cache-control": "no-store, must-revalidate" } : {}),
      },
    });
  } catch {
    return new Response("not found: " + path, { status: 404 });
  }
});
