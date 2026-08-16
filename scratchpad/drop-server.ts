// Drop server: receives POSTed raw arrays / JSON from the browser extractor and
// writes them to scratchpad/kits-cache/. Runs in Deno; CORS-open for localhost.
//   POST /save/<name>  body=bytes  -> kits-cache/<name>
// Run: deno run -A scratchpad/drop-server.ts   (port 8150)
const DIR = new URL("./kits-cache/", import.meta.url);
await Deno.mkdir(DIR, { recursive: true });
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "*",
};
Deno.serve({ port: 8150 }, async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const u = new URL(req.url);
  const m = u.pathname.match(/^\/save\/(.+)$/);
  if (req.method === "POST" && m) {
    const name = m[1].replace(/[^A-Za-z0-9._-]/g, "_");
    const buf = new Uint8Array(await req.arrayBuffer());
    await Deno.writeFile(new URL(name, DIR), buf);
    console.log(`wrote ${name} (${buf.length} bytes)`);
    return new Response("ok", { headers: cors });
  }
  return new Response("drop server up", { headers: cors });
});
