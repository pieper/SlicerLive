// Static file server for the gallery checkout, run in a Worker because the
// webview's native run loop blocks the main thread's event loop.
// Receives { root, port } and replies { port } with the port actually bound
// (falls back to the next few ports if the preferred one is taken).
import { serveDir } from "jsr:@std/http@1/file-server";

self.onmessage = (e: MessageEvent<{ root: string; port: number }>) => {
  const { root, port } = e.data;
  for (let p = port; p < port + 10; p++) {
    try {
      Deno.serve(
        {
          port: p,
          hostname: "127.0.0.1",
          onListen: (addr) => (self as unknown as Worker).postMessage({ port: addr.port }),
        },
        (req) => serveDir(req, { fsRoot: root, quiet: true }),
      );
      return;
    } catch (err) {
      if (!(err instanceof Deno.errors.AddrInUse)) throw err;
    }
  }
  throw new Error(`no free port in ${port}..${port + 9}`);
};
