// Slicer's layout catalog as data (vtkMRMLLayoutNode ids + vtkMRMLLayoutLogic arrangements), replacing the
// hard-coded LAYOUTS tables. A cell is a fractional rectangle over the view area; the app places renderers
// into them. Names/colours follow Slicer's layout XML (Red/Yellow/Green + 3D "1").
export type ViewKind = "slice" | "3d";
export interface LayoutCell { view: string; kind: ViewKind; x: number; y: number; w: number; h: number; orientation?: "Axial" | "Sagittal" | "Coronal" }
export interface Layout { id: number; name: string; cells: LayoutCell[] }

const cell = (view: string, kind: ViewKind, x: number, y: number, w: number, h: number, orientation?: LayoutCell["orientation"]): LayoutCell => ({ view, kind, x, y, w, h, orientation });

// vtkMRMLLayoutNode::SlicerLayout ids
export const LAYOUTS: Record<number, Layout> = {
  2: { id: 2, name: "Conventional", cells: [cell("1", "3d", 0, 0, 1, 0.5), cell("Red", "slice", 0, 0.5, 1 / 3, 0.5, "Axial"), cell("Yellow", "slice", 1 / 3, 0.5, 1 / 3, 0.5, "Sagittal"), cell("Green", "slice", 2 / 3, 0.5, 1 / 3, 0.5, "Coronal")] },
  3: { id: 3, name: "Four-Up", cells: [cell("Red", "slice", 0, 0, 0.5, 0.5, "Axial"), cell("1", "3d", 0.5, 0, 0.5, 0.5), cell("Yellow", "slice", 0, 0.5, 0.5, 0.5, "Sagittal"), cell("Green", "slice", 0.5, 0.5, 0.5, 0.5, "Coronal")] },
  4: { id: 4, name: "One-Up 3D", cells: [cell("1", "3d", 0, 0, 1, 1)] },
  6: { id: 6, name: "One-Up Red", cells: [cell("Red", "slice", 0, 0, 1, 1, "Axial")] },
  7: { id: 7, name: "One-Up Yellow", cells: [cell("Yellow", "slice", 0, 0, 1, 1, "Sagittal")] },
  8: { id: 8, name: "One-Up Green", cells: [cell("Green", "slice", 0, 0, 1, 1, "Coronal")] },
  15: { id: 15, name: "Dual 3D", cells: [cell("1", "3d", 0, 0, 0.5, 1), cell("2", "3d", 0.5, 0, 0.5, 1)] },
  21: { id: 21, name: "Three-Over-Three", cells: [cell("Red", "slice", 0, 0, 1 / 3, 0.5, "Axial"), cell("Yellow", "slice", 1 / 3, 0, 1 / 3, 0.5, "Sagittal"), cell("Green", "slice", 2 / 3, 0, 1 / 3, 0.5, "Coronal"), cell("Slice4", "slice", 0, 0.5, 1 / 3, 0.5, "Axial"), cell("Slice5", "slice", 1 / 3, 0.5, 1 / 3, 0.5, "Sagittal"), cell("Slice6", "slice", 2 / 3, 0.5, 1 / 3, 0.5, "Coronal")] },
  29: { id: 29, name: "Two-Over-Two", cells: [cell("Red", "slice", 0, 0, 0.5, 0.5, "Axial"), cell("Yellow", "slice", 0.5, 0, 0.5, 0.5, "Sagittal"), cell("Green", "slice", 0, 0.5, 0.5, 0.5, "Coronal"), cell("Slice4", "slice", 0.5, 0.5, 0.5, 0.5, "Axial")] },
};

export const DEFAULT_LAYOUT = 3;
export function layout(id: number): Layout { return LAYOUTS[id] ?? LAYOUTS[DEFAULT_LAYOUT]; }
export function layoutList(): Layout[] { return Object.values(LAYOUTS).sort((a, b) => a.id - b.id); }

/** Cell rectangles in pixel coords over a view area (origin at 0,0 unless given). */
export function cellsFor(id: number, areaW: number, areaH: number, x0 = 0, y0 = 0): (LayoutCell & { px: { x: number; y: number; w: number; h: number } })[] {
  return layout(id).cells.map((c) => ({ ...c, px: { x: x0 + c.x * areaW, y: y0 + c.y * areaH, w: c.w * areaW, h: c.h * areaH } }));
}
