// Adapt an mrson scene (~/slicer/mrson core: { mrson, blobBase, nodes:{ id:{ type, ... } } })
// into the legacy class-keyed SceneWrapper the renderer already consumes, so a served mrson
// scene renders with no changes to scene-volume.ts / SceneRenderer. Rendering-lossless for the
// node types SlicerLive draws (image + transferFunction + display + markup + camera); other
// nodes pass through with source.mrmlClass preserved.
//
// This is the SlicerLive <- mrson seam. The reverse (SlicerLive -> mrson ops) is the Phase-3
// WebServer ingest path.

export interface MrsonNode {
  type: string;
  id: string;
  name?: string;
  refs?: Record<string, string[]>;
  source?: { mrmlClass?: string };
  [k: string]: unknown;
}
export interface MrsonScene { mrson?: number; blobBase?: string; nodes: Record<string, MrsonNode> }

interface LegacyNode {
  id: string;
  class: string;
  name?: string;
  refs: Record<string, string[]>;
  attrs: Record<string, unknown>;
  blobs: unknown[];
}

// Neutral type -> a representative vtkMRML class (only used when source.mrmlClass is absent).
const TYPE_TO_CLASS: Record<string, string> = {
  image: "vtkMRMLScalarVolumeNode",
  mesh: "vtkMRMLModelNode",
  segmentation: "vtkMRMLSegmentationNode",
  markup: "vtkMRMLMarkupsFiducialNode",
  transform: "vtkMRMLLinearTransformNode",
  camera: "vtkMRMLCameraNode",
  view: "vtkMRMLViewNode",
  transferFunction: "vtkMRMLVolumePropertyNode",
  scalarVolumeDisplay: "vtkMRMLScalarVolumeDisplayNode",
  volumeRenderingDisplay: "vtkMRMLGPURayCastVolumeRenderingDisplayNode",
  modelDisplay: "vtkMRMLModelDisplayNode",
  markupDisplay: "vtkMRMLMarkupsDisplayNode",
};

export function isMrsonScene(raw: unknown): raw is MrsonScene {
  const r = raw as { mrson?: unknown; nodes?: Record<string, { type?: unknown }> };
  if (!r || typeof r !== "object") return false;
  if (r.mrson !== undefined) return true;
  return !!r.nodes && Object.values(r.nodes).some((n) => typeof n?.type === "string");
}

// mrson [{value, rgba:[r,g,b,a]}] -> legacy color TF rows [s, r, g, b]
const colorRows = (a: unknown): number[][] =>
  Array.isArray(a) ? (a as { value: number; rgba: number[] }[]).map((s) => [s.value, s.rgba[0], s.rgba[1], s.rgba[2]]) : [];
// mrson [{value, opacity}] -> legacy opacity TF rows [s, a]
const opacityRows = (a: unknown): number[][] =>
  Array.isArray(a) ? (a as { value: number; opacity: number }[]).map((s) => [s.value, s.opacity]) : [];

export function adaptMrsonScene(scene: MrsonScene): { blobBase?: string; nodes: Record<string, LegacyNode> } {
  const nodes = scene.nodes ?? {};
  const out: Record<string, LegacyNode> = {};
  for (const [id, n] of Object.entries(nodes)) {
    const cls = n.source?.mrmlClass ?? TYPE_TO_CLASS[n.type] ?? n.type;
    const refs: Record<string, string[]> = { ...(n.refs ?? {}) };
    const attrs: Record<string, unknown> = {};
    switch (n.type) {
      case "image":
        attrs.zarr = n.zarr;
        attrs.ijkToRAS = n.ijkToRAS;
        attrs.dims = n.dims;
        attrs.comps = n.comps;
        break;
      case "transferFunction":
        attrs.color = colorRows(n.colorStops);
        attrs.scalarOpacity = opacityRows(n.scalarOpacity);
        attrs.gradientOpacity = opacityRows(n.gradientOpacity);
        attrs.shade = n.shade;
        break;
      case "scalarVolumeDisplay":
        attrs.window = n.window;
        attrs.level = n.level;
        attrs.color = n.color;
        attrs.visibility = n.visible ? 1 : 0;
        break;
      case "volumeRenderingDisplay":
        // the loader resolves the TF via disp.refs.volumeProperty; mrson names it refs.transferFunction
        if (n.refs?.transferFunction) refs.volumeProperty = n.refs.transferFunction;
        break;
      case "markup": {
        attrs.controlPoints = n.controlPoints;
        const dc = (n.refs?.display ?? [])
          .map((d) => (nodes[d] as MrsonNode | undefined)?.color as number[] | undefined)
          .find(Boolean);
        if (dc) attrs.color = dc.slice(0, 3);
        break;
      }
      case "camera":
        attrs.position = n.position;
        attrs.focalPoint = n.focalPoint;
        attrs.viewUp = n.viewUp;
        attrs.viewAngle = n.viewAngle;
        attrs.parallelScale = n.parallelScale;
        break;
      default:
        break;
    }
    out[id] = { id, class: cls, name: n.name, refs, attrs, blobs: [] };
  }
  return { blobBase: scene.blobBase, nodes: out };
}
