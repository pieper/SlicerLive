// Which tracts have a direction, and which way it points.
//
// Diffusion MRI cannot measure this. The signal is antipodally symmetric — a gradient g and -g give
// the same measurement — so every model built on it yields an ORIENTATION field, never a vector
// field, and "whether an axon is afferent or efferent does not affect water diffusion"
// (Jbabdi & Johansen-Berg, Brain Connectivity 1(3), 2011). A streamline's stored point order is an
// artifact of where the tracking algorithm seeded and which half it wrote first; every along-tract
// toolkit re-orients streamlines before use (DIPY's orient_by_rois, AFQ) for exactly that reason.
//
// So direction here is PRIOR ANATOMICAL KNOWLEDGE, applied per tract group, never data. The table
// below only marks a tract directional where a dominant direction is a textbook fact, and each
// streamline is then oriented by its endpoints along that tract's anatomical axis. Everything else
// stays undirected — a corpus callosum or an arcuate flowing one way would be a fabricated claim,
// not a simplification, since association and commissural fibres are reciprocal. The corona radiata
// and the posterior limb of the internal capsule are explicitly excluded: they carry ascending and
// descending fibres in the same bundle, so a single direction would be wrong about half the axons.
//
// "convention" marks tracts where the stated direction is the conventional functional reading rather
// than the numerical majority: corticothalamic feedback axons outnumber ascending thalamocortical
// ones by roughly 10:1 (Sherman & Guillery), so an ascending thalamic radiation shows the relay
// direction, not the dominant fibre count. The UI labels those differently.
import type { Vec3 } from "../mat4.ts";

export type FlowMode = "none" | "polarized" | "convention";

export interface TractFlow {
  mode: FlowMode;
  /** Fixed RAS axis the upstream→downstream direction should point along. */
  axis?: Vec3;
  /** Or a rule relative to the scene's deep centre: toward it, away from it, or away from midline. */
  radial?: "inward" | "outward" | "lateral";
  /** Why this tract is marked the way it is — shown in the UI for the directional ones. */
  note?: string;
}

/** Keyed by the ORG atlas abbreviation in parentheses, e.g. "corticospinal tract (CST)" → CST. */
const FLOW: Record<string, TractFlow> = {
  // --- Genuinely polarized projection systems -------------------------------------------------
  CST: { mode: "polarized", axis: [0, 0, -1], note: "descending motor output, cortex → brainstem/cord" },
  SF: { mode: "polarized", radial: "inward", note: "corticostriatal: cortex → striatum (the name reads the other way)" },
  SP: { mode: "polarized", radial: "inward", note: "corticostriatal: cortex → striatum" },
  SO: { mode: "polarized", radial: "inward", note: "corticostriatal: cortex → striatum" },
  // --- Cerebellar afferent systems ------------------------------------------------------------
  MCP: { mode: "polarized", radial: "lateral", note: "pontocerebellar afferents, pons → cerebellum" },
  ICP: { mode: "polarized", axis: [0, 0, 1], note: "spino-/olivo-/vestibulocerebellar afferents (carries some efferents too)" },
  CPC: { mode: "polarized", axis: [0, 0, -1], note: "cortex → pons → cerebellum; crosses a synapse at the pontine nuclei" },
  // --- Conventional reading, labelled as such -------------------------------------------------
  TF: { mode: "convention", radial: "outward", note: "thalamus → cortex relay direction; corticothalamic axons outnumber it ~10:1" },
  TP: { mode: "convention", radial: "outward", note: "thalamus → cortex relay direction; corticothalamic axons outnumber it ~10:1" },
  TO: { mode: "convention", radial: "outward", note: "thalamus → cortex relay direction; corticothalamic axons outnumber it ~10:1" },
  TT: { mode: "convention", radial: "outward", note: "thalamus → cortex relay direction; corticothalamic axons outnumber it ~10:1" },
  // Everything else — association (AF, CB, EC, EmC, ILF, IOFF, MdLF, SLF-I/II/III, UF), commissural
  // (CC1-7), corona radiata (CR-F, CR-P), PLIC, superficial U-fibres and the intracerebellar tracts
  // — is reciprocal, mixed, or unresolvable, and is left undirected on purpose.
};

/** The flow rule for a bundle, by its full ORG name. Unlisted tracts are undirected. */
export function flowFor(bundleName: string): TractFlow {
  const m = /\(([^)]+)\)\s*$/.exec(bundleName.trim());
  const abbr = m ? m[1] : "";
  return FLOW[abbr] ?? { mode: "none" };
}

/** Sign to orient a streamline so index 0 is UPSTREAM: +1 keeps the stored order, -1 reverses it.
 *  Uses the endpoints rather than the mean tangent, which reverses along curved bundles. Returns 0
 *  when the endpoints do not separate along the axis by `minSepMm` — those streamlines stay
 *  unanimated instead of contributing a speckle of wrong-way motion at bundle edges and fans. */
export function orientation(flow: TractFlow, first: Vec3, last: Vec3, centre: Vec3, minSepMm = 10): number {
  if (flow.mode === "none") return 0;
  const d: Vec3 = [last[0] - first[0], last[1] - first[1], last[2] - first[2]];
  let axis: Vec3;
  if (flow.axis) {
    axis = flow.axis;
  } else {
    // Radial rules need a reference: the midpoint's offset from the scene's deep centre.
    const mid: Vec3 = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2, (first[2] + last[2]) / 2];
    const out: Vec3 = [mid[0] - centre[0], mid[1] - centre[1], mid[2] - centre[2]];
    if (flow.radial === "lateral") {
      axis = [Math.sign(out[0]) || 1, 0, 0];
    } else {
      const l = Math.hypot(out[0], out[1], out[2]) || 1;
      const unit: Vec3 = [out[0] / l, out[1] / l, out[2] / l];
      axis = flow.radial === "inward" ? [-unit[0], -unit[1], -unit[2]] : unit;
    }
  }
  const proj = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
  if (Math.abs(proj) < minSepMm) return 0;
  return proj > 0 ? 1 : -1;
}
