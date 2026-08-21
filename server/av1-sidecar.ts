// Client for the Rust AV1 encode sidecar (native/encode `liverender-sidecar`). The render server
// spawns the sidecar, holds one Unix-socket connection, and asks it to turn premultiplied-RGBA
// patches into AV1 intra frames on the GPU. Deno has no WebCodecs encoder, so the hardware encode
// lives in the sidecar; the browser decodes with WebCodecs. See docs and reference_liverender_codec.
//
// Framing (little-endian), one request → one reply, strictly ordered:
//   request : u16 w · u16 h · u16 qp · u8 bgR · u8 bgG · u8 bgB · u32 rgba_len · rgba[rgba_len]
//   reply   : u32 av1_len · av1[av1_len]      (av1_len == 0 ⇒ encode failed; caller falls back)

import { AV1_GRID } from "../render/codec.ts";
export { AV1_GRID };
/** Coded size the sidecar encodes at — sample dims rounded UP to AV1_GRID so NVENC sessions
 *  (fixed-size, ~50-100 ms to create) are reused across the small set of sizes a drag produces. */
export const codedSize = (w: number, h: number): [number, number] => [
  Math.ceil(w / AV1_GRID) * AV1_GRID,
  Math.ceil(h / AV1_GRID) * AV1_GRID,
];

export class Av1Sidecar {
  #conn: Deno.UnixConn | null = null;
  #child: Deno.ChildProcess | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #hdr = new Uint8Array(13);
  #view = new DataView(this.#hdr.buffer);

  /** Spawn the sidecar and connect. Resolves once it prints READY; throws on any failure so the
   *  caller can fall back to gzip. */
  static async start(bin: string, sock: string): Promise<Av1Sidecar> {
    try { Deno.removeSync(sock); } catch { /* not there */ }
    const child = new Deno.Command(bin, {
      args: [sock],
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    // wait for READY on stdout
    const rd = child.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = performance.now() + 30_000;
    while (!buf.includes("READY")) {
      if (performance.now() > deadline) throw new Error("sidecar did not become READY");
      const { value, done } = await rd.read();
      if (done) throw new Error("sidecar exited before READY");
      buf += dec.decode(value);
    }
    rd.releaseLock();
    child.stdout.cancel().catch(() => {});
    // connect the socket (retry briefly: bind and READY race is tiny but real)
    let conn: Deno.UnixConn | null = null;
    for (let i = 0; i < 50 && !conn; i++) {
      try { conn = await Deno.connect({ transport: "unix", path: sock }); }
      catch { await new Promise((r) => setTimeout(r, 20)); }
    }
    if (!conn) throw new Error("could not connect to sidecar socket");
    const s = new Av1Sidecar();
    s.#child = child;
    s.#conn = conn;
    return s;
  }

  /** Encode one premultiplied-RGBA patch. Serialized (one request in flight); returns null on any
   *  error so the caller falls back to gzip for that frame. */
  encode(rgba: Uint8Array, w: number, h: number, qp: number, bg: [number, number, number]): Promise<Uint8Array | null> {
    const p = this.#chain.then(() => this.#encode(rgba, w, h, qp, bg)).catch((e) => {
      console.error("[av1] encode failed:", e.message);
      return null;
    });
    this.#chain = p;
    return p;
  }

  async #encode(rgba: Uint8Array, w: number, h: number, qp: number, bg: [number, number, number]): Promise<Uint8Array | null> {
    const c = this.#conn!;
    const D = Deno.env.get("DBG") === "1";
    this.#view.setUint16(0, w, true);
    this.#view.setUint16(2, h, true);
    this.#view.setUint16(4, qp, true);
    this.#hdr[6] = bg[0]; this.#hdr[7] = bg[1]; this.#hdr[8] = bg[2];
    this.#view.setUint32(9, rgba.length, true);
    if (D) console.error(`[av1] > hdr`);
    await writeAll(c, this.#hdr);
    if (D) console.error(`[av1] > rgba ${rgba.length}`);
    await writeAll(c, rgba);
    if (D) console.error(`[av1] < len`);
    const lenb = new Uint8Array(4);
    await readAll(c, lenb);
    const n = new DataView(lenb.buffer).getUint32(0, true);
    if (D) console.error(`[av1] < ${n} bytes`);
    if (n === 0) return null;
    const av1 = new Uint8Array(n);
    await readAll(c, av1);
    if (D) console.error(`[av1] done`);
    return av1;
  }

  close() {
    try { this.#conn?.close(); } catch { /* */ }
    try { this.#child?.kill(); } catch { /* */ }
  }
}

async function writeAll(c: Deno.UnixConn, b: Uint8Array) {
  let o = 0;
  while (o < b.length) o += await c.write(b.subarray(o));
}
async function readAll(c: Deno.UnixConn, b: Uint8Array) {
  let o = 0;
  while (o < b.length) {
    const r = await c.read(b.subarray(o));
    if (r === null) throw new Error("sidecar closed the connection");
    o += r;
  }
}
