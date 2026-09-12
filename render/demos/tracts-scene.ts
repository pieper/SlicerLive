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

function meanColor(colors: [number, number, number][]): [number, number, number] {
  const n = Math.max(1, colors.length);
  return [0, 1, 2].map((k) => colors.reduce((s, c) => s + c[k], 0) / n) as [number, number, number];
}

export interface TractGroup {
  name: string;
  color: [number, number, number];   // mean of its bundles' colours, for the popup chip
  bundleIds: number[];               // FiberField palette ids (1-based) of its members
}

/** Colour per TRACT GROUP, so the five groups read as distinct bodies rather than 42 similar strands.
 *  These are chosen, not derived: averaging each group's member colours (which is what the popup chips
 *  used to show) collapses a dozen hues into much the same muddy brown. Bright, well-separated hues on
 *  a near-black background, and far enough apart to stay distinguishable where bundles overlap.
 *  Per-bundle Slicer display-node colours are still available via `colorBy: "bundle"`. */
const GROUP_COLORS: Record<string, [number, number, number]> = {
  Association: [0.31, 0.76, 0.97],   // cyan-blue
  Cerebellar: [1.00, 0.72, 0.30],    // amber
  Commissural: [0.90, 0.45, 0.45],   // coral
  Projection: [0.51, 0.78, 0.52],    // green
  Superficial: [0.73, 0.41, 0.78],   // violet
};
const FALLBACK_COLORS: [number, number, number][] = [
  [0.95, 0.85, 0.35], [0.45, 0.85, 0.85], [0.85, 0.55, 0.75], [0.65, 0.85, 0.45], [0.85, 0.65, 0.45],
];
function groupColor(name: string, index: number): [number, number, number] {
  return GROUP_COLORS[name] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
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
  /** Phong constants [ka, kd, ks, shininess] for the tubes. */
  shade?: [number, number, number, number];
  /** "group" (default) paints every bundle with its tract group's colour, so the five groups read as
   *  distinct; "bundle" keeps each bundle's own Slicer display-node colour. */
  colorBy?: "group" | "bundle";
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
  /** Same story: the field is rebuilt on every density change, so halo settings live here too. Halos
   *  are the strongest depth cue here — close up, strands separate instead of matting together — but
   *  they work by darkening, so a light touch is enough once the shading is bright and the groups are
   *  colour-coded. Dial it up on the slider to separate a dense region. */
  haloSettings = { strength: 0.1, widthMm: 0.5 };
  /** Brighter than FiberField's own default (0.20/0.65/0.20/96). A brain-sized mass of sub-pixel
   *  tubes under a headlight reads dark and flat: nearly every ray hits a tube at a grazing angle, so
   *  the diffuse term rarely gets near its peak, and the halos and occlusion above take more light
   *  out again. Lifting ambient and diffuse roughly doubles the contrast of the lit pixels (spread
   *  32.5 -> 57.1) while leaving every bundle's colour exactly as its Slicer display node defines it
   *  — the colours are the bundle identity in the group list, so they are not boosted. */
  shadeSettings: [number, number, number, number] = [0.45, 1.10, 0.30, 48];
  colorBy: "group" | "bundle" = "group";
  /** Starting opacity per group. Superficial U-fibres form the brain's outer shell, so at full
   *  opacity they hide the commissural and projection tracts from every exterior angle and the whole
   *  view goes violet. Starting them semi-transparent lets the deep groups read through; the group's
   *  opacity chip takes it back to 1. */
  static readonly DEFAULT_GROUP_OPACITY: Record<string, number> = { Superficial: 0.35 };

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
      this.opacity[g.name] = TractScene.DEFAULT_GROUP_OPACITY[g.name] ?? 1;
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
    if (opts.shade) sc.shadeSettings = [...opts.shade] as [number, number, number, number];
    if (opts.colorBy) sc.colorBy = opts.colorBy;
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
    const strands: Strand[] = [];
    for (let l = 0; l < lineCount; l++) {
      const a = offsets[l], c = offsets[l + 1];
      if (c - a >= 2) strands.push({ points: pts.subarray(a * 3, c * 3), bundle: bi + 1 });
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
    for (let i = 0; i < this.manifest.bundles.length; i++) bundleColors[i + 1] = this.colorFor(i);
    // Keep the popup's group chips showing what is actually drawn.
    for (let g = 0; g < this.groups.length; g++) {
      const grp = this.groups[g];
      grp.color = this.colorBy === "group"
        ? groupColor(grp.name, g)
        : meanColor(grp.bundleIds.map((id) => this.manifest.bundles[id - 1].color));
    }
    const next = new FiberField(this.dev, all, {
      radius: this.tubeRadius,
      bundleColors,
      aoStrength: this.aoSettings.strength,
      aoRadiusMm: this.aoSettings.radiusMm,
      aoDensityScale: this.aoSettings.densityScale,
      haloStrength: this.haloSettings.strength,
      haloWidthMm: this.haloSettings.widthMm,
      shade: this.shadeSettings,
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

  /** Tube shading, live (uniform-resident — no rebuild). Caller does scene.syncUniforms(). */
  setShade(shade: [number, number, number, number]): void {
    this.shadeSettings = [...shade] as [number, number, number, number];
    this.fibers.setShade(this.shadeSettings);
  }

  /** Halo strength, live (uniform-resident — no rebuild). Caller does scene.syncUniforms(). */
  setHalo(strength: number): void {
    this.haloSettings.strength = Math.max(0, Math.min(1, strength));
    this.fibers.setHalo(this.haloSettings.strength, this.haloSettings.widthMm);
  }

  /** The colour a bundle is drawn in: its group's colour by default, or its own Slicer colour under
   *  `colorBy: "bundle"`. Its group's opacity is folded in, so this is the single place both the
   *  rebuild and the opacity controls take colour from. */
  private colorFor(i: number): RGBA {
    const b = this.manifest.bundles[i];
    const rgb = this.colorBy === "group"
      ? groupColor(b.group, Math.max(0, this.manifest.groups.indexOf(b.group)))
      : b.color;
    return [rgb[0], rgb[1], rgb[2], b.opacity * (this.opacity[b.group] ?? 1)];
  }

  groupOpacity(group: string): number { return this.opacity[group] ?? 1; }

  /** Scale every bundle in a group by `o` (its own manifest opacity still applies). Uniform-resident
   *  — the caller does scene.syncUniforms(). */
  setGroupOpacity(group: string, o: number): void {
    this.opacity[group] = Math.max(0, Math.min(1, o));
    const g = this.groups.find((x) => x.name === group);
    if (!g) return;
    for (const id of g.bundleIds) this.fibers.setBundleColor(id, this.colorFor(id - 1));
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
