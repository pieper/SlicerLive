// Closed-loop MRML <-> mrson property PARITY test. For each property, BOTH directions live:
//   inbound  : set it in Slicer            -> assert the browser LiveScene model reflects it
//   outbound : write it from the browser    -> assert Slicer reflects it
// The routine way to widen parity: add a row here, and add serialize (Slicer->mrson) + _apply_patch
// (mrson->Slicer) support. Requires a live mirror: MCP on :2126, browser mirror on CDP :9222 with the
// __live debug hook. Usage: deno run -A render/test/parity-run.ts

const MCP = "http://localhost:2126/mcp";
const CDP = "http://localhost:9222";

const IDS = {
  scalarVolumeDisplay: "vtkMRMLScalarVolumeDisplayNode1",
  vr: "vtkMRMLGPURayCastVolumeRenderingDisplayNode1",
  seg: "vtkMRMLSegmentationNode1",
  markup: "vtkMRMLMarkupsFiducialNode1",
  camera: "vtkMRMLCameraNode1",
  sliceRed: "vtkMRMLSliceNodeRed",
};

type Val = number | boolean | number[];
interface Row {
  label: string; id: string; path: string;
  get: string;                 // python expr on `nd`
  set: string;                 // python stmt on `nd`, %V% = the value literal
  inV: Val; outV: Val;
  bool?: boolean; tol?: number;
}
const ROWS: Row[] = [
  { label: "scalarVolumeDisplay.window", id: IDS.scalarVolumeDisplay, path: "#/window", get: "nd.GetWindow()", set: "nd.SetAutoWindowLevel(0); nd.SetWindow(%V%)", inV: 210, outV: 175, tol: 0.5 },
  { label: "scalarVolumeDisplay.interpolate", id: IDS.scalarVolumeDisplay, path: "#/interpolate", get: "nd.GetInterpolate()", set: "nd.SetInterpolate(%V%)", inV: false, outV: true, bool: true },
  { label: "volumeRenderingDisplay.visible", id: IDS.vr, path: "#/visible", get: "nd.GetVisibility()", set: "nd.SetVisibility(%V%)", inV: true, outV: false, bool: true },
  { label: "volumeRenderingDisplay.cropEnabled", id: IDS.vr, path: "#/cropEnabled", get: "nd.GetCroppingEnabled()", set: "nd.SetCroppingEnabled(%V%)", inV: true, outV: false, bool: true },
  { label: "segmentation.opacity", id: IDS.seg, path: "#/opacity", get: "nd.GetDisplayNode().GetOpacity()", set: "nd.GetDisplayNode().SetOpacity(%V%)", inV: 0.6, outV: 0.85, tol: 0.02 },
  { label: "segmentation.outline2D.opacity", id: IDS.seg, path: "#/outline2D/opacity", get: "nd.GetDisplayNode().GetOpacity2DOutline()", set: "nd.GetDisplayNode().SetOpacity2DOutline(%V%)", inV: 0.4, outV: 0.7, tol: 0.02 },
  { label: "markup.glyphScale", id: IDS.markup, path: "#/glyphScale", get: "nd.GetDisplayNode().GetGlyphScale()", set: "nd.GetDisplayNode().SetGlyphScale(%V%)", inV: 5.0, outV: 2.5, tol: 0.05 },
  { label: "markup.textScale", id: IDS.markup, path: "#/textScale", get: "nd.GetDisplayNode().GetTextScale()", set: "nd.GetDisplayNode().SetTextScale(%V%)", inV: 4.0, outV: 2.0, tol: 0.05 },
  { label: "markup.locked", id: IDS.markup, path: "#/locked", get: "nd.GetLocked()", set: "nd.SetLocked(%V%)", inV: true, outV: false, bool: true },
  { label: "markup.color", id: IDS.markup, path: "#/color", get: "list(nd.GetDisplayNode().GetSelectedColor())", set: "nd.GetDisplayNode().SetSelectedColor(%V%)", inV: [0.2, 0.8, 0.4], outV: [0.9, 0.3, 0.1], tol: 0.02 },
  { label: "segmentation.fill2D.opacity", id: IDS.seg, path: "#/fill2D/opacity", get: "nd.GetDisplayNode().GetOpacity2DFill()", set: "nd.GetDisplayNode().SetOpacity2DFill(%V%)", inV: 0.35, outV: 0.65, tol: 0.02 },
  { label: "segmentation.segments[0].visible", id: IDS.seg, path: "#/segments/0/visible", get: "nd.GetDisplayNode().GetSegmentVisibility(nd.GetSegmentation().GetNthSegmentID(0))", set: "nd.GetDisplayNode().SetSegmentVisibility(nd.GetSegmentation().GetNthSegmentID(0), %V%)", inV: false, outV: true, bool: true },
  // camera — the pose a recording must reproduce. position/viewUp fire the node's Modified directly;
  // viewAngle/parallelScale live on the vtkCamera, so nudge nd.Modified() to emit the CameraModified event.
  { label: "camera.position", id: IDS.camera, path: "#/position", get: "list(nd.GetPosition())", set: "nd.SetPosition(%V%)", inV: [10, 20, 30], outV: [-40, -50, -60], tol: 0.5 },
  { label: "camera.viewUp", id: IDS.camera, path: "#/viewUp", get: "list(nd.GetViewUp())", set: "nd.SetViewUp(%V%)", inV: [1, 0, 0], outV: [0, 0, 1], tol: 0.02 },
  { label: "camera.viewAngle", id: IDS.camera, path: "#/viewAngle", get: "nd.GetCamera().GetViewAngle()", set: "nd.GetCamera().SetViewAngle(%V%); nd.Modified()", inV: 25, outV: 40, tol: 0.1 },
  { label: "camera.parallelScale", id: IDS.camera, path: "#/parallelScale", get: "nd.GetCamera().GetParallelScale()", set: "nd.GetCamera().SetParallelScale(%V%); nd.Modified()", inV: 120, outV: 80, tol: 0.5 },
  // slice — out-of-plane scroll (mm). A slice change echoes as a `view` NodeAdded upsert.
  { label: "slice.offset", id: IDS.sliceRed, path: "#/offset", get: "nd.GetSliceOffset()", set: "nd.SetSliceOffset(%V%)", inV: 12.0, outV: -8.0, tol: 0.5 },
];

// ---- MCP (Slicer) ---- use curl: Deno fetch POSTs a chunked body (no Content-Length) that the
// Slicer MCP HTTP server reads as empty (known bug); curl sets Content-Length.
let mid = 100;
function mcp(code: string): string {
  const req = JSON.stringify({ jsonrpc: "2.0", id: ++mid, method: "tools/call", params: { name: "execute_python", arguments: { code } } });
  const out = new Deno.Command("curl", { args: ["-s", "-m", "20", "-X", "POST", MCP, "-H", "content-type: application/json", "-d", req] }).outputSync();
  const parsed = JSON.parse(new TextDecoder().decode(out.stdout));
  if (parsed.error || !parsed.result) throw new Error("MCP error: " + JSON.stringify(parsed).slice(0, 300));
  return parsed.result.content[0].text;
}
const pyLit = (v: Val) => (Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "True" : "False") : String(v));
const slicerSet = (r: Row, v: Val) =>
  mcp(`import slicer\nnd = slicer.mrmlScene.GetNodeByID(${JSON.stringify(r.id)})\n${r.set.replace("%V%", pyLit(v))}\nslicer.app.processEvents()\n__result="ok"`);
const slicerGet = (r: Row) =>
  mcp(`import slicer, json\nnd = slicer.mrmlScene.GetNodeByID(${JSON.stringify(r.id)})\n__result = json.dumps(${r.get})`);

// ---- CDP (browser mirror) ----
const targets = await (await fetch(`${CDP}/json`)).json();
const tgt = targets.find((x: { url?: string }) => (x.url || "").endsWith("mirror.html"));
if (!tgt) { console.error("no mirror.html tab on :9222"); Deno.exit(2); }
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let cid = 0; const pending = new Map<number, (v: unknown) => void>();
ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
await new Promise((r) => ws.onopen = () => r(null));
const call = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<{ result?: { result?: { value?: unknown } } }>((res) => { const i = ++cid; pending.set(i, res as (v: unknown) => void); ws.send(JSON.stringify({ id: i, method, params })); });
async function evalJS(expr: string): Promise<unknown> {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}
const browserRead = (r: Row) => evalJS(
  `(()=>{const n=window.__live.nodes.get(${JSON.stringify(r.id)});if(!n)return null;let c=n;for(const k of ${JSON.stringify(r.path.replace(/^#/, "").split("/").filter(Boolean))})c=c==null?c:c[k];return c;})()`);
const browserWrite = (r: Row, v: Val) =>
  evalJS(`window.__live.write({op:"patch",id:${JSON.stringify(r.id)},path:${JSON.stringify(r.path)},value:${JSON.stringify(v)}}),"ok"`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function same(r: Row, a: unknown, b: Val): boolean {
  if (Array.isArray(b)) return Array.isArray(a) && b.every((bv, i) => Math.abs(Number((a as number[])[i]) - Number(bv)) <= (r.tol ?? 0.02));
  if (r.bool) return a !== null && a !== undefined && Boolean(a) === Boolean(b);
  return Math.abs(Number(a) - Number(b)) <= (r.tol ?? 0.01);
}

// ---- run ----
console.log("\n  " + "property".padEnd(40) + "inbound (Slicer->SL)   outbound (SL->Slicer)");
console.log("  " + "-".repeat(80));
let fail = 0;
for (const r of ROWS) {
  await slicerSet(r, r.inV);
  await sleep(700);
  const bIn = await browserRead(r);
  const inOk = same(r, bIn, r.inV);

  await browserWrite(r, r.outV);
  await sleep(700);
  const sOut = JSON.parse(await slicerGet(r));
  const outOk = same(r, sOut, r.outV);

  if (!inOk || !outOk) fail++;
  const inTxt = inOk ? "ok " : `FAIL(${JSON.stringify(bIn)}≠${r.inV})`;
  const outTxt = outOk ? "ok " : `FAIL(${JSON.stringify(sOut)}≠${r.outV})`;
  console.log("  " + r.label.padEnd(40) + inTxt.padEnd(23) + outTxt);
}
ws.close();
console.log(`\n  ${ROWS.length - fail}/${ROWS.length} properties round-trip both directions` + (fail ? "  ❌\n" : "  ✅\n"));
Deno.exit(fail ? 1 : 0);
