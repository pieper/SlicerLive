// Minimal, dependency-free PNG encoder (8-bit RGBA). Uses stored (uncompressed)
// zlib blocks so there is no deflate dependency — fine for verification output.

function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function zlibStore(raw: Uint8Array): Uint8Array {
  const nBlocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + nBlocks * 5 + 4);
  let p = 0;
  out[p++] = 0x78; out[p++] = 0x01;               // zlib header
  let off = 0;
  for (let bi = 0; bi < nBlocks; bi++) {
    const len = Math.min(65535, raw.length - off);
    out[p++] = bi === nBlocks - 1 ? 1 : 0;         // BFINAL, BTYPE=00 (stored)
    out[p++] = len & 0xff; out[p++] = (len >> 8) & 0xff;
    const nlen = ~len & 0xffff;
    out[p++] = nlen & 0xff; out[p++] = (nlen >> 8) & 0xff;
    out.set(raw.subarray(off, off + len), p); p += len; off += len;
  }
  const ad = adler32(raw);
  out[p++] = (ad >>> 24) & 0xff; out[p++] = (ad >>> 16) & 0xff;
  out[p++] = (ad >>> 8) & 0xff; out[p++] = ad & 0xff;
  return out.subarray(0, p);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** rgba: tightly-packed width*height*4 bytes. Returns a PNG file. */
export function encodePNG(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit, RGBA

  const stride = width * 4;
  const filtered = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;                          // filter type 0 (none)
    filtered.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", zlibStore(filtered)), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
