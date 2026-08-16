// Static server for the cardiac example (zarr chunks + scene json + the page itself).
//   deno run -A examples/cardiac/serve.ts [port]
const ROOT = new URL(".", import.meta.url).pathname;
const port = Number(Deno.args[0] ?? 8777);
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

Deno.serve({ port, onListen: () => console.log(`cardiac example: http://localhost:${port}/cardiac.html`) }, async (req) => {
  const path = decodeURIComponent(new URL(req.url).pathname);
  const file = ROOT + (path === "/" ? "cardiac.html" : path.replace(/^\//, ""));
  try {
    const body = await Deno.readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    return new Response(body, {
      headers: { "content-type": TYPES[ext] ?? "application/octet-stream", "access-control-allow-origin": "*" },
    });
  } catch {
    return new Response("not found: " + path, { status: 404 });
  }
});
