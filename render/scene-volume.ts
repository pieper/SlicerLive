// Load a real SlicerLive scene volume into an ImageField for the WebGPU renderer.
// Parses the scene json ({blobBase,nodes}), fetches the scalar volume (zarr chunks),
// and builds a color/opacity LUT from the scene's VolumePropertyNode transfer
// functions (falling back to a window/level grayscale ramp). The rotated ijkToRAS
// geometry is handed straight to the ImageField — no resampling to an axis-aligned box.

import { ImageField } from "./fields.ts";
import { fetchZarrVolume, type ZarrDesc } from "./zarr.ts";
import { adaptMrsonScene, isMrsonScene } from "./mrson.ts";
import type { Vec3 } from "./mat4.ts";

interface Node {
  id: string;
  class: string;
  name?: string;
  refs?: Record<string, string[]>;
  attrs?: Record<string, unknown>;
  blobs?: Record<string, unknown>;
}
interface SceneWrapper { blobBase?: string; nodes?: Record<string, Node> }

export type TF = number[][]; // color: [s,r,g,b][]; opacity: [s,a][]

/** Piecewise-linear interpolation of a transfer function (sorted by first column) at scalar s. */
export function interpTF(tf: TF, s: number, comps: number): number[] {
  if (!tf.length) return new Array(comps).fill(0);
  if (s <= tf[0][0]) return tf[0].slice(1, 1 + comps);
  const last = tf[tf.length - 1];
  if (s >= last[0]) return last.slice(1, 1 + comps);
  for (let i = 1; i < tf.length; i++) {
    if (s <= tf[i][0]) {
      const a = tf[i - 1], b = tf[i];
      const u = (s - a[0]) / Math.max(b[0] - a[0], 1e-9);
      return Array.from({ length: comps }, (_, c) => a[1 + c] + u * (b[1 + c] - a[1 + c]));
    }
  }
  return last.slice(1, 1 + comps);
}

/** Build a 256-entry rgba8 LUT sampling color+opacity TFs across [lo,hi]. */
export function lutFromTransferFunctions(colorTF: TF, opacityTF: TF, clim: [number, number]): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const s = clim[0] + (i / 255) * (clim[1] - clim[0]);
    const [r, g, b] = interpTF(colorTF, s, 3);
    const [a] = interpTF(opacityTF, s, 1);
    lut[i * 4 + 0] = Math.round(Math.max(0, Math.min(1, r)) * 255);
    lut[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
    lut[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
    lut[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
  return lut;
}

/** Grayscale ramp with a linear opacity foot from window/level (fallback when no VolumeProperty). */
export function lutFromWindowLevel(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const g = Math.round(t * 255);
    lut[i * 4 + 0] = lut[i * 4 + 1] = lut[i * 4 + 2] = g;
    lut[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, (t - 0.15) / 0.85)) * 200); // soft foot
  }
  return lut;
}

/** A markup control point read from the scene (RAS world position). */
export interface Markup { ras: Vec3; label: string; color: [number, number, number] }

export interface SceneVolume {
  field: ImageField;
  voxels: Float32Array;         // raw scalar volume (HU for CT), (z,y,x) C-order — for the segmenter
  dims: [number, number, number];
  ijkToRAS: number[];
  name: string;
  range: [number, number];      // observed voxel [min,max]
  center: Vec3;                  // world center (for camera framing)
  radius: number;               // world bounding radius (for camera distance)
  win: number;                  // display window (for MPR grayscale)
  lev: number;                  // display level
  markups: Markup[];            // fiducial control points from the scene's Markups nodes (RAS)
}

/** Read all Markups-node control points from a scene's node dict, in RAS. Control points
 *  accept either `{position:[x,y,z], label}` or a bare `[x,y,z]`; colour from the node. */
function parseMarkups(nodes: Record<string, Node>): Markup[] {
  const out: Markup[] = [];
  for (const n of Object.values(nodes)) {
    if (!/Markups.*Node$/.test(n.class)) continue;
    const cps = (n.attrs?.controlPoints ?? n.attrs?.markups) as unknown[] | undefined;
    if (!Array.isArray(cps)) continue;
    const color = (n.attrs?.color as [number, number, number]) ?? [1, 0.85, 0.2];
    cps.forEach((cp, i) => {
      const c = cp as { position?: number[]; label?: string } & number[];
      const p = (c.position ?? cp) as number[];
      if (!Array.isArray(p) || p.length < 3) return;
      out.push({ ras: [p[0], p[1], p[2]], label: c.label ?? `${n.name ?? "F"}-${i + 1}`, color });
    });
  }
  return out;
}

/** Fetch a scene json + its scalar volume and return a renderable ImageField. */
export interface LoadOpts {
  /** Extra RAS translation folded into ijkToRAS — e.g. the Multi-Volume selftest offsets
   *  the second volume +200mm along R via a linear transform node. */
  extraTranslationRAS?: Vec3;
}

export async function loadSceneVolumeField(
  dev: GPUDevice,
  sceneUrl: string,
  onBytes?: (n: number) => void,
  opts: LoadOpts = {},
): Promise<SceneVolume> {
  const raw = await (await fetch(sceneUrl)).json() as SceneWrapper | Record<string, Node>;
  // mrson scenes (neutral `type`-keyed nodes) are adapted to the legacy class-keyed shape.
  const adapted = isMrsonScene(raw) ? adaptMrsonScene(raw) as unknown as SceneWrapper : raw;
  const wrapper = (adapted as SceneWrapper).nodes ? adapted as SceneWrapper : { nodes: adapted as Record<string, Node> };
  const nodes = wrapper.nodes!;
  // Resolve blobBase RELATIVE TO THE SCENE FILE (not the page): a portable export can
  // ship `"blobBase":"blobs/"` next to scene.json and be served from any path. Absolute
  // blobBase (e.g. the JS2 bucket URL) is returned unchanged by URL resolution.
  const pageBase = (globalThis as { location?: { href?: string } }).location?.href ?? "file:///";
  const sceneAbs = new URL(sceneUrl, pageBase).href;
  const blobBase = new URL(wrapper.blobBase ?? "./blobs/", sceneAbs).href;

  const vol = Object.values(nodes).find((n) => n.class === "vtkMRMLScalarVolumeNode" && n.attrs?.zarr);
  if (!vol) throw new Error("no zarr ScalarVolumeNode in scene");
  const z = vol.attrs!.zarr as ZarrDesc;
  let ijkToRAS = vol.attrs!.ijkToRAS as number[];
  if (!ijkToRAS) throw new Error("volume node has no ijkToRAS");
  if (opts.extraTranslationRAS) {   // pre-multiply a RAS translation (row-major 4x4)
    const t = opts.extraTranslationRAS;
    ijkToRAS = ijkToRAS.slice();
    ijkToRAS[3] += t[0]; ijkToRAS[7] += t[1]; ijkToRAS[11] += t[2];
  }

  const zv = await fetchZarrVolume(blobBase, z, onBytes);

  // Prefer a VolumePropertyNode (VR transfer functions) reachable from this volume's display nodes.
  let vp: Node | undefined;
  for (const dispId of vol.refs?.display ?? []) {
    const disp = nodes[dispId];
    for (const vpId of disp?.refs?.volumeProperty ?? []) {
      if (nodes[vpId]?.class === "vtkMRMLVolumePropertyNode") vp = nodes[vpId];
    }
  }

  let lut: Uint8Array, clim: [number, number], shade: [number, number, number, number];
  if (vp?.attrs?.color && vp?.attrs?.scalarOpacity) {
    const colorTF = vp.attrs.color as TF, opacityTF = vp.attrs.scalarOpacity as TF;
    const lo = colorTF[0][0], hi = colorTF[colorTF.length - 1][0];
    clim = [lo, hi];
    lut = lutFromTransferFunctions(colorTF, opacityTF, clim);
    shade = vp.attrs.shade ? [0.25, 0.75, 0.5, 24] : [1, 0, 0, 1];
  } else {
    // window/level grayscale
    const disp = nodes[(vol.refs?.display ?? [])[0]]?.attrs ?? {};
    const win = (disp.window as number) ?? (zv.range[1] - zv.range[0]);
    const lev = (disp.level as number) ?? (zv.range[0] + zv.range[1]) / 2;
    clim = [lev - win / 2, lev + win / 2];
    lut = lutFromWindowLevel();
    shade = [0.25, 0.75, 0.5, 24];
  }

  // Display window/level for MPR grayscale (fall back to the observed data range).
  const disp0 = nodes[(vol.refs?.display ?? [])[0]]?.attrs ?? {};
  const win = (disp0.window as number) ?? (zv.range[1] - zv.range[0]);
  const lev = (disp0.level as number) ?? (zv.range[0] + zv.range[1]) / 2;

  const field = new ImageField(dev, zv.data, zv.dims, [1, 1, 1], lut, { clim, ijkToRAS, shade });
  const [lo, hi] = field.aabb();
  const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
  return { field, voxels: zv.data, dims: zv.dims, ijkToRAS, name: vol.name ?? "volume", range: zv.range, center, radius, win, lev, markups: parseMarkups(nodes) };
}
