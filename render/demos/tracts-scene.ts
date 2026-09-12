// Real tractography — the SlicerDMRI fiber bundles of a Slicer scene — rendered with the same
// FiberField capsule tubes as the synthetic lava-lamp demo.
//
// The exporter (tools/export_tracts.py, run inside Slicer) writes each bundle as a directory of
// CHUNKS, each holding 5% of that bundle's streamlines:
//
//     u32 lineCount, u32 pointCount            header
//     u32 offsets[lineCount + 1]               first point index of each streamline
//     i16 xyz[pointCount * 3]                  RAS mm, quantized: p = q * scale + origin
//
// Streamlines are shuffled deterministically before chunking, so every chunk is a uniform random
// sample and the first N chunks are a uniform random N*5%. Raising the displayed fraction pulls only
// the chunks not already held — nothing is re-fetched — and because chunks are separate objects
// rather than byte ranges, each caches independently on a JS2 container, like the zarr chunks the
// other gallery demos use.
//
// Changing the fraction REBUILDS the FiberField: its capsule grid is baked at construction, so more
// streamlines means a new field (and the old one's GPU buffers are released).
import { FiberField, type RGBA, type Strand } from "../fiber-field.ts";
import { flowFor, orientation } from "./tract-direction.ts";
import type { Vec3 } from "../mat4.ts";

export interface TractChunkInfo {
  file: string | null;      // null when the bundle has fewer streamlines than chunks
  lines: number;
  points: number;
  bytes: number;
}

export interface TractBundleInfo {
  name: string;
  group: string;
  slug: string;
  lines: number;
  points: number;
  color: [number, number, number];
  opacity: number;
  chunks: TractChunkInfo[];
}

export interface TractManifest {
  name: string;
  origin: Vec3;
  scale: number;
  boundsRAS: number[];          // xmin, xmax, ymin, ymax, zmin, zmax
  groups: string[];             // in the order the Slicer Data module shows them
  chunkFraction: number;        // streamlines per chunk (0.05)
  defaultFraction: number;
  bundles: TractBundleInfo[];
}

export interface TractGroup {
  name: string;
  color: [number, number, number];   // mean of its bundles' colours, for the popup chip
  bundleIds: number[];               // FiberField palette ids (1-based) of its members
}

/** Resolve a possibly-relative base ("./" on a page, "file:///tmp/…/" under Deno). `new URL(rel, rel)`
 *  throws, so a page-relative base has to be resolved against the document first. */
function rootUrl(base: string): URL {
  const here = (globalThis as { location?: { href: string } }).location?.href ?? "file:///";
  return new URL(base.endsWith("/") ? base : base + "/", here);
}

export async function fetchManifest(base: string): Promise<TractManifest> {
  const r = await fetch(new URL("manifest.json", rootUrl(base)).href);
  if (!r.ok) throw new Error(`tract manifest ${r.status} at ${base}`);
  return await r.json() as TractManifest;
}

export interface TractSceneOpts {
  /** Fraction of each bundle's streamlines to load up front (default: the manifest's). */
  fraction?: number;
  /** Tube radius in mm (default 0.175 — fine strands, close to the streamline density itself). */
  radius?: number;
  /** Object-space ambient occlusion. On by default here: dense tracts read as a flat coloured mass
   *  under a headlight alone, and this is what gives the mass depth. */
  ao?: { strength?: number; radiusMm?: number; densityScale?: number };
  /** Depth-dependent halos (Everts 2009): dark rims that let a tube occlude what lies behind it, so
   *  bundles separate into readable layers instead of matting together. */
  halo?: { strength?: number; widthMm?: number };
  onProgress?: (done: number, total: number, label: string) => void;
}

export class TractScene {
  readonly manifest: TractManifest;
  readonly groups: TractGroup[];
  readonly center: Vec3;
  readonly radius: number;
  fibers!: FiberField;
  /** Fraction of streamlines currently held (a multiple of the manifest's chunkFraction). */
  fraction = 0;
  bytesFetched = 0;
  strandCount = 0;
  capsuleCount = 0;
  /** Streamlines carrying a defensible anatomical direction (the only ones ever animated). */
  flowStrands = 0;
  private dev: GPUDevice;
  private root: URL;
  private tubeRadius: number;
  private chunks: (Strand[] | undefined)[][] = [];   // [bundle][chunk]
  private opacity: Record<string, number> = {};
  /** Kept on the scene, not just passed once: changing the streamline fraction rebuilds the field,
   *  and these have to survive that. AO sits at 0.4 rather than the 0.7 it wants alone, because the
   *  halos below carry the local separation and stacking both at full strength goes muddy; AO's job
   *  here is the regional sense of depth into the mass. (Past ~0.025 density it erases thin strands.) */
  aoSettings = { strength: 0.4, radiusMm: 2, densityScale: 0.012 };
  /** Same story: the field is rebuilt on every density change, so halo settings live here too. This
   *  is the strongest of the depth cues — close up, strands separate instead of matting together —
   *  at ~17% cost when zoomed in and none at whole-brain framing. */
  haloSettings = { strength: 0.6, widthMm: 0.5 };

  private constructor(dev: GPUDevice, root: URL, manifest: TractManifest, tubeRadius: number) {
    this.dev = dev;
    this.root = root;
    this.manifest = manifest;
    this.tubeRadius = tubeRadius;
    this.chunks = manifest.bundles.map((b) => new Array(b.chunks.length).fill(undefined));
    this.groups = manifest.groups.map((name) => ({ name, color: [0, 0, 0] as [number, number, number], bundleIds: [] as number[] }));
    for (let i = 0; i < manifest.bundles.length; i++) {
      const b = manifest.bundles[i];
      const g = this.groups.find((x) => x.name === b.group) ?? this.groups[0];
      g.bundleIds.push(i + 1);
      for (let k = 0; k < 3; k++) g.color[k] += b.color[k];
    }
    for (const g of this.groups) {
      const n = Math.max(1, g.bundleIds.length);
      g.color = [g.color[0] / n, g.color[1] / n, g.color[2] / n];
      this.opacity[g.name] = 1;
    }
    const bb = manifest.boundsRAS;
    this.center = [(bb[0] + bb[1]) / 2, (bb[2] + bb[3]) / 2, (bb[4] + bb[5]) / 2];
    this.radius = 0.5 * Math.hypot(bb[1] - bb[0], bb[3] - bb[2], bb[5] - bb[4]);
  }

  static async create(dev: GPUDevice, base: string, opts: TractSceneOpts = {}): Promise<TractScene> {
    const manifest = await fetchManifest(base);
    const sc = new TractScene(dev, rootUrl(base), manifest, opts.radius ?? 0.175);
    if (opts.ao) Object.assign(sc.aoSettings, opts.ao);
    if (opts.halo) Object.assign(sc.haloSettings, opts.halo);
    await sc.setFraction(opts.fraction ?? manifest.defaultFraction ?? 0.1, opts.onProgress);
    return sc;
  }

  /** Chunks per bundle held for `fraction` — the same count for every bundle, so each bundle is
   *  sampled at the same rate whatever its size. */
  private chunksFor(fraction: number): number {
    const per = this.manifest.chunkFraction || 0.05;
    const n = this.manifest.bundles[0]?.chunks.length ?? Math.round(1 / per);
    return Math.max(1, Math.min(n, Math.ceil(fraction / per - 1e-6)));
  }

  /** Load whatever chunks `target` needs beyond what is already held and rebuild the field. Chunks
   *  already in hand are never re-fetched, so sliding up is incremental. */
  async setFraction(target: number, onProgress?: (done: number, total: number, label: string) => void): Promise<void> {
    const need = this.chunksFor(Math.max(0, Math.min(1, target)));
    const wanted: { bi: number; ci: number }[] = [];
    for (let bi = 0; bi < this.manifest.bundles.length; bi++) {
      for (let ci = 0; ci < need; ci++) {
        const info = this.manifest.bundles[bi].chunks[ci];
        if (info?.file && !this.chunks[bi][ci]) wanted.push({ bi, ci });
      }
    }
    for (let k = 0; k < wanted.length; k++) {
      const { bi, ci } = wanted[k];
      await this.loadChunk(bi, ci);
      onProgress?.(k + 1, wanted.length, this.manifest.bundles[bi].name);
    }
    // Drop anything above the target so sliding DOWN frees GPU memory (re-fetched if it comes back).
    for (let bi = 0; bi < this.chunks.length; bi++) {
      for (let ci = need; ci < this.chunks[bi].length; ci++) this.chunks[bi][ci] = undefined;
    }
    this.flowStrands = 0;
    for (const perBundle of this.chunks) {
      for (const chunk of perBundle) {
        if (chunk) for (const s of chunk) if (s.flow) this.flowStrands++;
      }
    }
    this.fraction = need * (this.manifest.chunkFraction || 0.05);
    this.rebuild();
  }

  private async loadChunk(bi: number, ci: number): Promise<void> {
    const b = this.manifest.bundles[bi];
    const info = b.chunks[ci];
    if (!info?.file) return;
    const r = await fetch(new URL(info.file, this.root).href);
    if (!r.ok) throw new Error(`chunk ${r.status} ${info.file}`);
    const raw = new Uint8Array(await r.arrayBuffer());
    this.bytesFetched += raw.byteLength;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const lineCount = dv.getUint32(0, true), pointCount = dv.getUint32(4, true);
    const headLen = 8 + 4 * (lineCount + 1);
    // Copy out (not a view): a fetch buffer has no alignment guarantee for u32/i16.
    const offsets = new Uint32Array(raw.slice(8, headLen).buffer);
    const q = new Int16Array(raw.slice(headLen, headLen + pointCount * 6).buffer);
    const { scale, origin } = this.manifest;
    const pts = new Float32Array(pointCount * 3);
    for (let i = 0; i < pointCount; i++) {
      pts[i * 3] = q[i * 3] * scale + origin[0];
      pts[i * 3 + 1] = q[i * 3 + 1] * scale + origin[1];
      pts[i * 3 + 2] = q[i * 3 + 2] * scale + origin[2];
    }
    // Direction is PRIOR ANATOMY, never the data: tracts with a textbook dominant direction get each
    // streamline oriented upstream→downstream by its endpoints (stored point order is an artifact of
    // the tracking algorithm), and everything else stays undirected and unanimated.
    const flow = flowFor(b.name);
    const strands: Strand[] = [];
    for (let l = 0; l < lineCount; l++) {
      const a = offsets[l], c = offsets[l + 1];
      if (c - a < 2) continue;
      let line = pts.subarray(a * 3, c * 3);
      let animate = false;
      if (flow.mode !== "none") {
        const np = c - a;
        const sign = orientation(
          flow,
          [line[0], line[1], line[2]],
          [line[(np - 1) * 3], line[(np - 1) * 3 + 1], line[(np - 1) * 3 + 2]],
          this.center,
        );
        if (sign !== 0) {
          animate = true;
          if (sign < 0) {   // reverse so index 0 is the upstream end
            const rev = new Float32Array(np * 3);
            for (let k = 0; k < np; k++) {
              rev[k * 3] = line[(np - 1 - k) * 3];
              rev[k * 3 + 1] = line[(np - 1 - k) * 3 + 1];
              rev[k * 3 + 2] = line[(np - 1 - k) * 3 + 2];
            }
            line = rev;
          }
        }
      }
      if (animate) this.flowStrands++;
      strands.push({ points: line, bundle: bi + 1, flow: animate });
    }
    this.chunks[bi][ci] = strands;
  }

  /** (Re)build the FiberField from every chunk currently held. */
  private rebuild(): void {
    const all: Strand[] = [];
    let capsules = 0;
    for (const perBundle of this.chunks) {
      for (const chunk of perBundle) {
        if (!chunk) continue;
        for (const s of chunk) { all.push(s); capsules += s.points.length / 3 - 1; }
      }
    }
    const bundleColors: Record<number, RGBA> = {};
    for (let i = 0; i < this.manifest.bundles.length; i++) {
      const b = this.manifest.bundles[i];
      bundleColors[i + 1] = [b.color[0], b.color[1], b.color[2], b.opacity * (this.opacity[b.group] ?? 1)];
    }
    const next = new FiberField(this.dev, all, {
      radius: this.tubeRadius,
      bundleColors,
      aoStrength: this.aoSettings.strength,
      aoRadiusMm: this.aoSettings.radiusMm,
      aoDensityScale: this.aoSettings.densityScale,
      haloStrength: this.haloSettings.strength,
      haloWidthMm: this.haloSettings.widthMm,
    });
    this.fibers?.destroy();
    this.fibers = next;
    this.strandCount = all.length;
    this.capsuleCount = capsules;
  }

  /** Occlusion strength, live (uniform-resident — no rebuild). Caller does scene.syncUniforms(). */
  setAO(strength: number): void {
    this.aoSettings.strength = Math.max(0, Math.min(1, strength));
    this.fibers.setAO(this.aoSettings.strength, this.aoSettings.radiusMm, this.aoSettings.densityScale);
  }

  /** Halo strength, live (uniform-resident — no rebuild). Caller does scene.syncUniforms(). */
  setHalo(strength: number): void {
    this.haloSettings.strength = Math.max(0, Math.min(1, strength));
    this.fibers.setHalo(this.haloSettings.strength, this.haloSettings.widthMm);
  }

  groupOpacity(group: string): number { return this.opacity[group] ?? 1; }

  /** Scale every bundle in a group by `o` (its own manifest opacity still applies). Uniform-resident
   *  — the caller does scene.syncUniforms(). */
  setGroupOpacity(group: string, o: number): void {
    this.opacity[group] = Math.max(0, Math.min(1, o));
    const g = this.groups.find((x) => x.name === group);
    if (!g) return;
    for (const id of g.bundleIds) {
      const b = this.manifest.bundles[id - 1];
      this.fibers.setBundleColor(id, [b.color[0], b.color[1], b.color[2], b.opacity * this.opacity[group]]);
    }
  }

  destroy(): void { this.fibers?.destroy(); }
}

/** Load a tract scene at its default fraction. */
export function buildTractScene(device: GPUDevice, base: string, opts: TractSceneOpts = {}): Promise<TractScene> {
  return TractScene.create(device, base, opts);
}

/** Capsules (tube segments) held once `chunks` chunks per bundle are loaded: a streamline of n points
 *  is n-1 capsules, so it is points minus lines, summed over the chunks. */
export function capsulesForChunks(manifest: TractManifest, chunks: number): number {
  let n = 0;
  for (const b of manifest.bundles) {
    for (let k = 0; k < Math.min(chunks, b.chunks.length); k++) {
      const c = b.chunks[k];
      if (c?.file) n += c.points - c.lines;
    }
  }
  return n;
}

/** The largest streamline fraction whose GPU buffers fit this adapter, from its reported limits.
 *  FiberField stores 32 bytes per capsule of segment data (the dominant buffer) plus roughly 14 bytes
 *  of grid index; a phone typically caps a storage binding at 128 MB where a desktop GPU allows far
 *  more, so this alone separates the two by about an order of magnitude. Half the cap is left as head
 *  room for the index buffer, the build's transient JS arrays, and everything else in the scene. */
export function fractionCapForLimits(manifest: TractManifest, limits: GPUSupportedLimits): number {
  const per = manifest.chunkFraction || 0.05;
  const total = manifest.bundles[0]?.chunks.length ?? Math.round(1 / per);
  const binding = Number(limits.maxStorageBufferBindingSize ?? 128 * 1024 * 1024);
  const buffer = Number(limits.maxBufferSize ?? 256 * 1024 * 1024);
  const budget = Math.min(binding, buffer) * 0.5;
  for (let k = total; k >= 1; k--) {
    if (capsulesForChunks(manifest, k) * 32 <= budget) return k * per;
  }
  return per;
}
