// Byte helpers shared by everything that touches the content-addressed blob channel: the local
// ingest path, the MRCOM writer and reader, and the session store's export.
//
// They lived privately in logic/ingest.ts, where `deflate` was not exported and `sha256` returned a
// prefixed NAME rather than a digest. MRCOM needs both forms and needs them in one place, because a
// chunk written by ingest and a payload written by the bundle writer have to be the same bytes under
// the same rules - "zlib-wrapped deflate, named by the sha256 of the compressed bytes" is a format
// commitment (docs/MRCOM-SCENE-BUNDLE.md section 5.2), not an implementation detail.
//
// DOM-free: CompressionStream, crypto.subtle and Response are all available in Deno and the browser,
// so logic/mrcom/* stays importable from a Deno server (docs/MRCOM-PLAN.md section 5).

/** zlib-wrapped deflate, matching Python's zlib.compress so Slicer and SlicerLive agree. */
export async function deflateBytes(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  return new Uint8Array(
    await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(cs)).arrayBuffer(),
  );
}

/** Inverse of deflateBytes. */
export async function inflateBytes(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  return new Uint8Array(
    await new Response(new Blob([compressed as BlobPart]).stream().pipeThrough(ds)).arrayBuffer(),
  );
}

/** Lowercase hex of a byte string. */
export function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * Bare lowercase hex sha256.
 *
 * This is the form every DICOM-side digest takes, because `LO` is 64 characters and
 * "sha256-" + 64 hex is 71 - a prefixed digest is silently truncated into something that still
 * looks like a digest. See docs/MRCOM-SCENE-BUNDLE.md section 2.4.
 */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return hexOf(new Uint8Array(h));
}

/** The content-addressed blob NAME: "sha256-" + the hex digest, as mrson keys blobs. */
export async function sha256Name(bytes: Uint8Array): Promise<string> {
  return "sha256-" + (await sha256Bytes(bytes));
}

/** The hex digest of a blob name, or null if it is not one. Inverse of sha256Name's prefixing. */
export function digestOfName(name: string): string | null {
  const m = /^sha256-([0-9a-f]{64})$/.exec(name);
  return m ? m[1] : null;
}

/** A blob name from a bare hex digest. Inverse of digestOfName. */
export function nameOfDigest(hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a sha256 hex digest: ${JSON.stringify(hex)}`);
  return "sha256-" + hex;
}

/** UTF-8 encode. */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** UTF-8 decode. */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * A plain ArrayBuffer holding exactly `view`'s bytes.
 *
 * A typed array may cover part of a larger buffer, so handing `.buffer` to a DICOM writer can
 * silently write the whole backing allocation. Copy when the view is partial, pass through when it
 * is not.
 */
export function bytesToArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? (view.buffer as ArrayBuffer)
    : (view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
}
