// Local volume ingest (W1): turn a Volume (typed array + geometry) into ordinary LiveScene nodes — an `image`
// node whose voxels are content-addressed zarr chunks (the SAME layout Slicer's serializer writes:
// chunks (64,128,128) of the C-order (nz,ny,nx) array, zlib-deflated, named "sha256-<hex>" of the compressed
// bytes), a `scalarVolumeDisplay`, and the slice composites pointing at it. Chunks are served to the
// existing DisplayableManagers through the pluggable blob fetch (render/zarr.ts setBlobFetch), so a file
// dropped on the page renders through exactly the same code path as a volume streamed from Slicer, and a
// session can cache the chunks like any other blob. Pure TS (no DOM); the panel is render/demos/load-panel.ts.
import type { ZarrDesc } from "../render/zarr.ts";
import { getBlobFetch, setBlobFetch } from "../render/zarr.ts";
import type { Volume } from "./readers/nifti.ts";
import type { LiveScene } from "../render/livescene.ts";
import type { MrsonNode } from "../render/mrson.ts";

export const CHUNK_MAX: [number, number, number] = [64, 128, 128];   // (cz, cy, cx) — Slicer's _write_zarr rule

export interface ZarrBlobs { desc: ZarrDesc; blobs: Map<string, Uint8Array> }

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");                                   // zlib-wrapped, like Python zlib.compress
  return new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(cs)).arrayBuffer());
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return "sha256-" + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Chunk + compress + hash a volume's voxels. `data` is C-order (z,y,x) with dims [nx,ny,nz]. */
export async function volumeToZarr(data: Volume["data"], dims: [number, number, number], dtype: string): Promise<ZarrBlobs> {
  const [nx, ny, nz] = dims;
  const shape: [number, number, number] = [nz, ny, nx];
  const chunks: [number, number, number] = [Math.min(CHUNK_MAX[0], nz), Math.min(CHUNK_MAX[1], ny), Math.min(CHUNK_MAX[2], nx)];
  const grid: [number, number, number] = [Math.ceil(nz / chunks[0]), Math.ceil(ny / chunks[1]), Math.ceil(nx / chunks[2])];
  const [cz, cy, cx] = chunks;
  const Ctor = data.constructor as new (n: number) => Volume["data"];
  const bpe = (data as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
  const blobs = new Map<string, Uint8Array>();
  const chunkHashes: Record<string, string> = {};
  let bytes = 0;
  for (let kk = 0; kk < grid[0]; kk++) for (let jj = 0; jj < grid[1]; jj++) for (let ii = 0; ii < grid[2]; ii++) {
    const sub = new Ctor(cz * cy * cx);                                          // zero-padded full chunk
    const z0 = kk * cz, y0 = jj * cy, x0 = ii * cx;
    const zw = Math.min(cz, nz - z0), yw = Math.min(cy, ny - y0), xw = Math.min(cx, nx - x0);
    for (let z = 0; z < zw; z++) for (let y = 0; y < yw; y++) {
      const src = ((z0 + z) * ny + (y0 + y)) * nx + x0, dst = (z * cy + y) * cx;
      (sub as unknown as { set(a: ArrayLike<number>, o: number): void }).set((data as unknown as { subarray(a: number, b: number): ArrayLike<number> }).subarray(src, src + xw), dst);
    }
    const raw = new Uint8Array(sub.buffer, sub.byteOffset, sub.length * bpe);
    const comp = await deflate(raw);
    const h = await sha256(comp);
    if (!blobs.has(h)) { blobs.set(h, comp); bytes += comp.byteLength; }
    chunkHashes[`${kk}.${jj}.${ii}`] = h;
  }
  return { desc: { shape, chunks, chunkGrid: grid, dtype, bytes, chunkHashes }, blobs };
}

/** Serves locally produced blobs to the DisplayableManagers (chained in front of whatever fetch was installed). */
export class LocalBlobStore {
  private blobs = new Map<string, Uint8Array>();
  private installed = false;
  private onStore?: (hash: string, bytes: Uint8Array) => void;
  constructor(opts: { onStore?: (hash: string, bytes: Uint8Array) => void } = {}) { this.onStore = opts.onStore; }
  add(blobs: Map<string, Uint8Array>): void {
    for (const [h, b] of blobs) { if (!this.blobs.has(h)) { this.blobs.set(h, b); this.onStore?.(h, b); } }
    this.install();
  }
  has(hash: string): boolean { return this.blobs.has(hash); }
  get(hash: string): Uint8Array | undefined { return this.blobs.get(hash); }
  size(): number { return this.blobs.size; }
  private install(): void {
    if (this.installed) return;
    this.installed = true;
    const prev = getBlobFetch();
    setBlobFetch((url) => {
      const h = url.slice(url.lastIndexOf("/") + 1);
      const b = this.blobs.get(h);
      return b ? Promise.resolve(new Response(b as BlobPart, { status: 200 })) : prev(url);
    });
  }
}

let seq = 0;
export const nextLocalId = (kind: string) => `local-${kind}-${++seq}-${Date.now().toString(36)}`;

/** Slicer's default W/L for a new volume is the 0.1..99.9 percentile range (vtkMRMLScalarVolumeDisplayNode::CalculateAutoLevels);
 *  W3 lands the exact histogram; this is the same idea on a subsample so W1 shows something sensible. */
export function percentileWindowLevel(data: Volume["data"], lo = 0.001, hi = 0.999): { window: number; level: number; range: [number, number] } {
  const n = data.length, step = Math.max(1, Math.floor(n / 500000));
  const s: number[] = [];
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i += step) { const v = data[i] as number; s.push(v); if (v < mn) mn = v; if (v > mx) mx = v; }
  s.sort((a, b) => a - b);
  const a = s[Math.floor(lo * (s.length - 1))], b = s[Math.floor(hi * (s.length - 1))];
  const window = Math.max(1e-6, b - a), level = (a + b) / 2;
  return { window, level, range: [mn, mx] };
}

export interface LoadedVolume { imageId: string; displayId: string; nodes: MrsonNode[] }

/** Build the mrson nodes for a local volume (no scene side effects; testable). */
export async function volumeNodes(vol: Volume, opts: { name?: string; labelmap?: boolean } = {}): Promise<{ nodes: MrsonNode[]; blobs: Map<string, Uint8Array>; imageId: string; displayId: string }> {
  const { desc, blobs } = await volumeToZarr(vol.data, vol.dims, vol.dtype);
  const imageId = nextLocalId("image"), displayId = nextLocalId("display");
  const wl = percentileWindowLevel(vol.data);
  const name = opts.name ?? vol.name ?? "Volume";
  const image: MrsonNode = {
    type: "image", id: imageId, name, frame: "RAS", dims: vol.dims, comps: 1, ijkToRAS: vol.ijkToRAS, zarr: desc,
    labelmap: !!opts.labelmap, refs: { display: [displayId] }, source: { mrmlClass: opts.labelmap ? "vtkMRMLLabelMapVolumeNode" : "vtkMRMLScalarVolumeNode" },
    origin: { local: true, dtype: vol.dtype, ...(vol.meta ?? {}) },
  };
  const display: MrsonNode = opts.labelmap
    ? { type: "labelMapDisplay", id: displayId, name: `${name} display`, frame: "RAS", visible: true, interpolate: false, refs: {}, source: { mrmlClass: "vtkMRMLLabelMapVolumeDisplayNode" }, origin: { local: true } }
    : { type: "scalarVolumeDisplay", id: displayId, name: `${name} display`, frame: "RAS", visible: true, window: wl.window, level: wl.level, autoWindowLevel: true,
        interpolate: true, applyThreshold: false, threshold: [wl.range[0], wl.range[1]], color: [1, 1, 1, 1], refs: {}, source: { mrmlClass: "vtkMRMLScalarVolumeDisplayNode" }, origin: { local: true } };
  return { nodes: [display, image], blobs, imageId, displayId };
}

/** Put the volume into the LiveScene as background of every slice composite (creating Red/Yellow/Green composites
 *  for a standalone scene that has none), so it shows exactly the way a Slicer-loaded volume would. */
export async function loadVolumeIntoScene(live: LiveScene, store: LocalBlobStore, vol: Volume, opts: { name?: string; labelmap?: boolean; layer?: "background" | "foreground" | "label" } = {}): Promise<LoadedVolume> {
  const built = await volumeNodes(vol, opts);
  store.add(built.blobs);
  for (const n of built.nodes) live.write({ op: "put", id: n.id, node: n });
  const layer = opts.layer ?? (opts.labelmap ? "label" : "background");
  const composites = [...live.nodes.values()].filter((n) => n.type === "sliceComposite");
  if (composites.length === 0) {
    for (const ln of ["Red", "Yellow", "Green"]) {
      const id = `local-sliceComposite-${ln}`;
      live.write({ op: "put", id, node: { type: "sliceComposite", id, name: `${ln} composite`, layoutName: ln, refs: { [layer]: [built.imageId] }, foregroundOpacity: 0, labelOpacity: 1, compositing: 0, linkedControl: false, hotLinkedControl: false, source: { mrmlClass: "vtkMRMLSliceCompositeNode" }, origin: { local: true } } });
    }
  } else {
    for (const c of composites) live.write({ op: "patch", id: c.id, path: `#/refs/${layer}`, value: [built.imageId] });
  }
  return { imageId: built.imageId, displayId: built.displayId, nodes: built.nodes };
}
