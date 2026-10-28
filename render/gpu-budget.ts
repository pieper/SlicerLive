// GPU-BUDGET — how much volume memory this device can be asked for, and how big a grid fits.
//
// WebGPU tells you nothing about VRAM. There is no query, and the limits it does expose
// (maxBufferSize, maxTextureDimension3D) describe what a SINGLE allocation may be, not what the
// device has left. So a page that sizes its volumes from the data alone works on the machine it was
// written on and dies on a thinner one: allocation keeps succeeding until it doesn't, the device is
// LOST, and every canvas on the page goes white with nothing in the console a user can act on.
// (Reported from the spine comparison view: "it loads for some time, then flicks some images, but
// then turns white, browser loses responsiveness".)
//
// What is available is coarse and indirect, so this is deliberately a BUDGET, not a measurement:
//   • navigator.deviceMemory — system RAM in GB, clamped by the spec to 8, absent on Safari/Firefox.
//     On integrated graphics (where this fails) VRAM IS system RAM, so it is the relevant number.
//   • GPUAdapter.isFallbackAdapter — a software adapter; assume very little.
//   • adapter.limits.maxBufferSize — a weak proxy for tier, used only as a floor-raiser.
//
// The budget is for LARGE RESIDENT VOLUMES (segmentation fields, CT volumes). Small textures, bind
// groups and the swap chain are not counted; the margin below covers them.

import { JfaSdfBaker } from "./sdf-bake.ts";
import type { Vec3 } from "./mat4.ts";

/** Fraction of the apparent memory we are willing to hold in resident volumes. The rest is the
 *  browser's, the compositor's, and the headroom a transient bake needs. */
const SHARE = 0.25;

/** Hard ceiling, whatever the machine claims. System RAM is NOT VRAM: this machine reports
 *  navigator.deviceMemory = 32 (the spec clamps it to 8, so the number cannot even be trusted to be
 *  in range), and a 25% share of that is 8 GB — which sized the grid to 1.76 GB of segmentation
 *  textures and coarsened nothing, i.e. exactly the state that loses the device on a thinner
 *  machine. What a browser tab can actually keep resident before the compositor starts evicting is
 *  closer to this, on every GPU tier worth targeting. */
const CEILING = 0.75e9;

export interface GpuBudget {
  bytes: number;        // what callers may allocate in resident volumes, total
  deviceMemoryGb?: number;
  fallbackAdapter: boolean;
  why: string;          // one line, for a console note or an "about this view" panel
}

/** A conservative budget for resident volume memory on this adapter. */
export function gpuBudget(adapter?: GPUAdapter): GpuBudget {
  const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  // isFallbackAdapter is in the spec but not in every @webgpu/types release.
  const fallback = !!(adapter as unknown as { isFallbackAdapter?: boolean } | undefined)?.isFallbackAdapter;
  // No signal at all (Safari, Firefox): assume a mid laptop rather than a workstation. Being wrong
  // high here is what loses the device; being wrong low costs resolution, which is recoverable and
  // visible (the view says it coarsened).
  const claimed = typeof dm === "number" ? Math.min(dm, 8) : undefined;   // the spec's own clamp
  const gb = fallback ? 1 : (claimed ?? 4);
  const bytes = Math.max(96e6, Math.min(CEILING, gb * 1e9 * SHARE));
  // An explicit override, for a machine that can take more (or less) than the guess: ?gpumem=1.5
  // means 1.5 GB. Sizing this correctly is a judgement about hardware we cannot see, so there has to
  // be a way to say so.
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("gpumem") : null;
  const override = q ? Number(q) * 1e9 : NaN;
  if (Number.isFinite(override) && override > 32e6) {
    return { bytes: override, deviceMemoryGb: dm, fallbackAdapter: fallback, why: `?gpumem=${q} override` };
  }
  // A budget this tab already learned the hard way. There is no way to ask a GPU what it has, but
  // losing the device IS the answer to that question, so remember it: after a loss the page comes
  // back at half, and keeps that for the rest of the session rather than walking into it again.
  const learned = learnedBudget();
  if (learned !== undefined && learned < bytes) {
    return { bytes: learned, deviceMemoryGb: dm, fallbackAdapter: fallback,
      why: `reduced to ${(learned / 1e9).toFixed(2)} GB after this tab lost the GPU` };
  }
  return {
    bytes,
    deviceMemoryGb: dm,
    fallbackAdapter: fallback,
    why: fallback
      ? "software adapter — minimum budget"
      : `${claimed ? `navigator.deviceMemory ${dm}${dm !== claimed ? ` (clamped to ${claimed})` : ""} GB` : "no deviceMemory signal, assuming 4 GB"}`
        + ` × ${SHARE}, capped at ${(CEILING / 1e9).toFixed(2)} GB`,
  };
}

/** How many LABEL voxels an SDF segmentation may have to fit `bytes`, for `count` of them sharing
 *  the budget. Returns a voxel count to hand to `resampleIsotropic(..., maxVoxels)`. */
export function sdfVoxelCap(bytes: number, count = 1, pad = 2): number {
  const per = Math.max(bytes / Math.max(count, 1), 32e6);
  // Solve n_padded ≈ per / bytesPerVoxel, then subtract the pad shell. The pad is small next to the
  // grid, so approximating the cube root and shrinking by 2·pad per axis is close enough.
  const nPadded = per / JfaSdfBaker.bytesPerVoxel();
  const side = Math.cbrt(nPadded);
  const inner = Math.max(32, side - 2 * pad);
  return Math.floor(inner * inner * inner);
}

/** Bytes a resident scalar volume of `dims` costs at `bytesPerVoxel` (r16float = 2, r32float = 4). */
export function volumeBytes(dims: Vec3, bytesPerVoxel = 2): number {
  return dims[0] * dims[1] * dims[2] * bytesPerVoxel;
}

export const formatBytes = (b: number): string =>
  b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`;


// ── learned budget ───────────────────────────────────────────────────────────
// sessionStorage, not localStorage: a lost device may be this page's fault (too much resident at
// once) or the machine's (another tab holding the GPU), and the second is not worth remembering
// past the session. Wrapped because storage throws in some embedded/incognito contexts.

const KEY = "slicerlive.gpuBudgetBytes";

function learnedBudget(): number | undefined {
  try {
    const v = Number(sessionStorage.getItem(KEY));
    return Number.isFinite(v) && v > 32e6 ? v : undefined;
  } catch { return undefined; }
}

/** Halve the budget this tab will use from now on, and return the new value. Call when the device
 *  is lost; the page has to reload to act on it, since the lost device cannot be revived. */
export function reduceBudget(current: number): number {
  const next = Math.max(96e6, Math.min(current, learnedBudget() ?? current) / 2);
  try { sessionStorage.setItem(KEY, String(next)); } catch { /* storage unavailable: one-shot retry only */ }
  return next;
}

/** Has this tab already stepped down? (For telling a user they are on a reduced budget.) */
export function budgetWasReduced(): boolean { return learnedBudget() !== undefined; }
