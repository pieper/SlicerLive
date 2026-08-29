// T4: closed-loop MRML <-> mrson parity for every row in harness/fixtures/parity/*.json — set in Slicer,
// read in the browser LiveScene; write in the browser, read in Slicer. Needs a running Slicer (SL_MCP)
// and a mirror page on CDP :9222 exposing window.__live (slicer-app.html / mirror.html). Self-ignores
// when Slicer is not reachable so it never fails a hermetic run.
//   deno run -A test/run.ts --parity        (or: SL_SLICER=1 deno test -A harness/parity/)
import { assert } from "jsr:@std/assert@1";
import { CDP } from "../cdp.ts";
import { executePython, pyJson, slicerAvailable } from "../slicer.ts";
import { waitReady, waitStable } from "../ready.ts";
import { type ParityFile, type ParityRow, pyLit, readPath, same, type Val } from "../../test/oracle.ts";

const PAGE = Deno.env.get("SL_PAGE") ?? "slicer-app.html";
const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
const available = await slicerAvailable();

async function loadFixtures(): Promise<ParityFile[]> {
  const out: ParityFile[] = [];
  for await (const e of Deno.readDir("harness/fixtures/parity")) if (e.name.endsWith(".json")) out.push(JSON.parse(await Deno.readTextFile(`harness/fixtures/parity/${e.name}`)));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Aliases resolve to the first node of a class in the running Slicer (scene-independent fixtures).
const ALIAS_CLASS: Record<string, string> = {
  $svd: "vtkMRMLScalarVolumeDisplayNode", $vr: "vtkMRMLGPURayCastVolumeRenderingDisplayNode", $seg: "vtkMRMLSegmentationNode",
  $fid: "vtkMRMLMarkupsFiducialNode", $camera: "vtkMRMLCameraNode", $layout: "vtkMRMLLayoutNode", $vol: "vtkMRMLScalarVolumeNode",
};
const resolved = new Map<string, string>();
async function resolveNode(id: string): Promise<string> {
  if (!id.startsWith("$")) return id;
  if (id === "$tf") {
    const env = Deno.env.get("PARITY_TF_ID"); if (env) return env;
    return await pyJson<string>("(lambda d: d.GetVolumePropertyNode().GetID() if d else '')(slicer.mrmlScene.GetFirstNodeByClass('vtkMRMLGPURayCastVolumeRenderingDisplayNode'))");
  }
  if (!resolved.has(id)) resolved.set(id, await pyJson<string>(`(lambda n: n.GetID() if n else '')(slicer.mrmlScene.GetFirstNodeByClass(${JSON.stringify(ALIAS_CLASS[id])}))`));
  return resolved.get(id)!;
}

Deno.test({
  name: "parity: every fixture row round-trips both directions (Slicer <-> LiveScene)",
  ignore: !available,
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    // a FRESH tab: an existing tab may predate a server restart and hold a stale LiveScene (0/21 that way)
    const cdp = await CDP.openTab(`${BASE}${PAGE}`);
    await waitReady(cdp, 60000);
    await cdp.waitForValue<number>("window.__live && window.__live.nodes ? window.__live.nodes.size : 0", (n) => n > 0, 30000);
    await cdp.waitForValue<boolean>("!!(window.__sync && window.__sync.transport && window.__sync.transport.isOpen)", (v) => v, 30000);
    const failures: string[] = [];
    let n = 0;
    for (const file of await loadFixtures()) {
      for (const r of file.rows) {
        n++;
        const node = await resolveNode(r.node);
        const exists = await pyJson<boolean>(`slicer.mrmlScene.GetNodeByID(${JSON.stringify(node)}) is not None`);
        if (!node || !exists) { failures.push(`${file.name}/${r.id}: node ${r.node} (${node || "unresolved"}) not in the Slicer scene`); continue; }
        // inbound: Slicer -> browser
        await executePython(`import slicer\nnd = slicer.mrmlScene.GetNodeByID(${JSON.stringify(node)})\n${r.slicerSet.replace("%V%", pyLit(r.inV))}\nslicer.app.processEvents()\n__result='ok'`);
        const expr = `(()=>{const n=window.__live.nodes.get(${JSON.stringify(node)});return n?(${JSON.stringify(r.path)}).replace(/^#/,"").split("/").filter(Boolean).reduce((c,k)=>c==null?c:c[k],n):null;})()`;
        let bIn: unknown;
        try { bIn = await cdp.waitForValue<unknown>(expr, (v) => same(r, v, r.inV), 5000); } catch { bIn = await cdp.evalJson(expr); }
        const inOk = same(r, bIn, r.inV);
        // outbound: browser -> Slicer
        await cdp.eval(`window.__live.write({op:"patch",id:${JSON.stringify(node)},path:${JSON.stringify(r.path)},value:${JSON.stringify(r.outV)}}); return 1;`);
        let sOut: unknown = null;
        for (let i = 0; i < 25; i++) {
          sOut = await pyJson(`(lambda nd: ${r.slicerGet})(slicer.mrmlScene.GetNodeByID(${JSON.stringify(node)}))`);
          if (same(r, sOut, r.outV)) break;
          await new Promise((res) => setTimeout(res, 200));
        }
        const outOk = same(r, sOut, r.outV);
        if (!inOk || !outOk) failures.push(`${file.name}/${r.id}: ${inOk ? "" : `inbound ${JSON.stringify(bIn)}≠${JSON.stringify(r.inV)} `}${outOk ? "" : `outbound ${JSON.stringify(sOut)}≠${JSON.stringify(r.outV)}`}`);
      }
    }
    await cdp.closeTab();
    console.log(`  parity: ${n - failures.length}/${n} rows`);
    assert(failures.length === 0, failures.join("\n"));
  },
});
export { readPath, waitStable, type Val, type ParityRow };
