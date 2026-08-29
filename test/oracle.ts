// Parity oracle (tier T4): rows that compare a property in real Slicer with the same property in the
// browser LiveScene, in BOTH directions (Slicer -> SlicerLive, SlicerLive -> Slicer), within a tolerance.
// Rows live in JSON (harness/fixtures/parity/*.json) so they are data, reviewable, and capturable; this
// module holds the schema and the comparison — no I/O. The runner is harness/parity/*.parity.test.ts.

export type Val = number | boolean | number[];

export interface ParityRow {
  id: string;                 // row id (stable; used in reports)
  property: string;           // human label, e.g. "scalarVolumeDisplay.window"
  node: string;               // MRML node id in Slicer, e.g. "vtkMRMLScalarVolumeDisplayNode1" (or "$tf" alias)
  path: string;               // JSON pointer into the LiveScene node, e.g. "#/window"
  slicerGet: string;          // python expr on `nd`
  slicerSet: string;          // python stmt on `nd`; %V% = python literal of the value
  inV: Val;                   // value set in Slicer, expected in the browser
  outV: Val;                  // value written in the browser, expected in Slicer
  tol?: number;               // absolute tolerance (numbers / each array element)
  bool?: boolean;             // compare by truthiness
  unit?: string;              // documentation
  ref?: string;               // Slicer class/algorithm this pins
}

export interface ParityFile { name: string; description?: string; rows: ParityRow[] }

export function same(row: ParityRow, a: unknown, b: Val): boolean {
  if (row.bool) return a !== null && a !== undefined && Boolean(a) === Boolean(b);
  const tol = row.tol ?? 0.01;
  if (Array.isArray(b)) return Array.isArray(a) && a.length >= b.length && b.every((bv, i) => Math.abs(Number((a as unknown[])[i]) - Number(bv)) <= tol);
  return typeof a !== "object" && Math.abs(Number(a) - Number(b)) <= tol;
}

/** Python literal for a row value. */
export function pyLit(v: Val): string {
  return Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "True" : "False") : String(v);
}

/** Read a JSON-pointer path ("#/a/b/0") out of a node document. */
export function readPath(node: unknown, path: string): unknown {
  let c: unknown = node;
  for (const k of path.replace(/^#/, "").split("/").filter(Boolean)) c = c == null ? c : (c as Record<string, unknown>)[k];
  return c;
}

/** Validate a parity file's shape (T1 unit test guards the checked-in fixtures). */
export function validate(file: ParityFile): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const r of file.rows) {
    if (!r.id || seen.has(r.id)) errs.push(`duplicate or missing id: ${r.id}`); seen.add(r.id);
    for (const k of ["property", "node", "path", "slicerGet", "slicerSet"] as const) if (typeof r[k] !== "string" || !r[k]) errs.push(`${r.id}: missing ${k}`);
    if (!r.path.startsWith("#/")) errs.push(`${r.id}: path must be a JSON pointer starting with #/`);
    if (!r.slicerSet.includes("%V%")) errs.push(`${r.id}: slicerSet must contain %V%`);
    if (Array.isArray(r.inV) !== Array.isArray(r.outV)) errs.push(`${r.id}: inV/outV kinds differ`);
    if (JSON.stringify(r.inV) === JSON.stringify(r.outV)) errs.push(`${r.id}: inV and outV must differ (else a no-op passes)`);
  }
  return errs;
}
