// T1: merging a bundle into a scene. The property under test is that it is NON-DESTRUCTIVE -
// SlicerDataBundle's load clears the scene, which is the behaviour this exists to avoid.
import { assert, assertEquals } from "../../mrson/assert.ts";
import dcmjs from "../../render/vendor/dcmjs/dcmjs.es.js";
import { setDcmjs } from "./dcmjs.ts";
import type { MrsonNode } from "../../render/mrson.ts";
import { sha256Name, utf8Encode } from "../bytes.ts";
import { loadMrcomIntoScene, type SceneWriter } from "./load.ts";
import { readMrcomBundle } from "./read.ts";
import { writeMrcomBundle } from "./write.ts";

setDcmjs(dcmjs as never);

/** A minimal stand-in for LiveScene: records puts, keeps a node map. */
function fakeScene(initial: Record<string, MrsonNode> = {}) {
  const nodes = new Map<string, MrsonNode>(Object.entries(initial));
  const puts: string[] = [];
  const scene: SceneWriter = {
    nodes,
    write(op) {
      puts.push(op.id);
      nodes.set(op.id, op.node);
      return undefined;
    },
  };
  return { scene, nodes, puts };
}

function fakeStore() {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    add(incoming: Map<string, Uint8Array>) {
      for (const [k, v] of incoming) blobs.set(k, v);
    },
    has(hash: string) {
      return blobs.has(hash);
    },
  };
}

const BULK = utf8Encode("some bulk");

async function bundleOf(nodes: Record<string, MrsonNode>, mode: "embed" | "reference" = "embed") {
  const hash = await sha256Name(BULK);
  const written = await writeMrcomBundle({
    nodes,
    blobs: () => Promise.resolve(BULK),
    mode,
    reference: { dataset: { SOPClassUID: "1.2.840.10008.5.1.4.1.1.2", SOPInstanceUID: "1.2.3" } },
  });
  return { bundle: await readMrcomBundle(written.bytes), hash };
}

const sceneNodes = async (): Promise<Record<string, MrsonNode>> => {
  const hash = await sha256Name(BULK);
  return {
    img1: {
      id: "img1",
      type: "image",
      dims: [2, 2, 1],
      zarr: {
        shape: [1, 2, 2],
        chunks: [1, 2, 2],
        chunkGrid: [1, 1, 1],
        dtype: "|u1",
        chunkHashes: { "0.0.0": hash },
      },
      refs: { display: ["disp1"] },
    } as never,
    disp1: { id: "disp1", type: "scalarVolumeDisplay", window: 400, level: 40 } as never,
  };
};

Deno.test("loading into an empty scene adds every node, and the blobs", async () => {
  const { bundle, hash } = await bundleOf(await sceneNodes());
  const { scene, nodes, puts } = fakeScene();
  const store = fakeStore();

  const result = loadMrcomIntoScene(scene, store, bundle);

  assertEquals(result.added.sort(), ["disp1", "img1"]);
  assertEquals(result.renamed, {});
  assertEquals(result.skipped, []);
  assertEquals(result.blobs, 1);
  assertEquals(result.missing, []);
  assertEquals(nodes.size, 2);
  assertEquals(puts.length, 2);
  assertEquals(store.blobs.get(hash), BULK);
});

Deno.test("loading does NOT clear what is already in the scene", async () => {
  // The SlicerDataBundle behaviour this exists to avoid: its load calls Scene::Connect(), which
  // clears everything, so it cannot merge.
  const existing: Record<string, MrsonNode> = {
    mine: { id: "mine", type: "camera", position: [0, 0, 100] } as never,
  };
  const { bundle } = await bundleOf(await sceneNodes());
  const { scene, nodes } = fakeScene(existing);

  loadMrcomIntoScene(scene, fakeStore(), bundle);

  assert(nodes.has("mine"), "the pre-existing node must survive");
  assertEquals(nodes.get("mine")!.type, "camera");
  assertEquals(nodes.size, 3);
});

Deno.test("only put ops are issued - never a reset", async () => {
  const { bundle } = await bundleOf(await sceneNodes());
  const ops: string[] = [];
  const scene: SceneWriter = {
    nodes: new Map(),
    write(op) {
      ops.push(op.op);
      return undefined;
    },
  };
  loadMrcomIntoScene(scene, null, bundle);
  assertEquals([...new Set(ops)], ["put"]);
});

Deno.test("a colliding id is renamed by default, and its refs follow", async () => {
  // Loading the same bundle twice should give two independent copies, not one clobbering the other.
  const { bundle } = await bundleOf(await sceneNodes());
  const { scene, nodes } = fakeScene();

  const first = loadMrcomIntoScene(scene, fakeStore(), bundle);
  const second = loadMrcomIntoScene(scene, fakeStore(), bundle);

  assertEquals(first.renamed, {});
  assertEquals(Object.keys(second.renamed).sort(), ["disp1", "img1"]);
  assertEquals(nodes.size, 4, "two independent copies");

  // the second copy's image points at the second copy's display, not the first
  const newImageId = second.renamed["img1"];
  const newDisplayId = second.renamed["disp1"];
  assertEquals(nodes.get(newImageId)!.refs!.display, [newDisplayId]);
  // and the first copy is untouched
  assertEquals(nodes.get("img1")!.refs!.display, ["disp1"]);
});

Deno.test("onCollision replace overwrites in place", async () => {
  const { bundle } = await bundleOf(await sceneNodes());
  const { scene, nodes } = fakeScene();
  loadMrcomIntoScene(scene, fakeStore(), bundle);
  const result = loadMrcomIntoScene(scene, fakeStore(), bundle, { onCollision: "replace" });

  assertEquals(result.renamed, {});
  assertEquals(nodes.size, 2, "replace must not grow the scene");
  assertEquals(result.added.sort(), ["disp1", "img1"]);
});

Deno.test("onCollision skip leaves the scene alone and says what it skipped", async () => {
  const { bundle } = await bundleOf(await sceneNodes());
  const { scene, nodes, puts } = fakeScene();
  loadMrcomIntoScene(scene, fakeStore(), bundle);
  const before = puts.length;

  const result = loadMrcomIntoScene(scene, fakeStore(), bundle, { onCollision: "skip" });
  assertEquals(result.skipped.sort(), ["disp1", "img1"]);
  assertEquals(result.added, []);
  assertEquals(puts.length, before, "nothing should have been written");
  assertEquals(nodes.size, 2);
});

Deno.test("a reference-mode bundle reports what the scene still needs", async () => {
  const { bundle, hash } = await bundleOf(await sceneNodes(), "reference");
  const { scene } = fakeScene();
  const store = fakeStore();

  const result = loadMrcomIntoScene(scene, store, bundle);
  assertEquals(result.blobs, 0, "reference mode carries no blobs");
  assertEquals(result.missing, [hash], "and says which hash a resolver has to supply");

  // once the store has it, nothing is missing
  store.add(new Map([[hash, BULK]]));
  assertEquals(loadMrcomIntoScene(scene, store, bundle, { onCollision: "replace" }).missing, []);
});

Deno.test("loading with no store at all still writes the nodes", async () => {
  const { bundle } = await bundleOf(await sceneNodes());
  const { scene, nodes } = fakeScene();
  const result = loadMrcomIntoScene(scene, null, bundle);
  assertEquals(result.blobs, 0);
  assertEquals(nodes.size, 2);
});

Deno.test("a ref to a skipped node is left dangling rather than rewritten wrongly", async () => {
  // validateScene() reports a dangling ref as a WARNING, because a partial closure is legitimate.
  // Silently repointing it at an unrelated node would be worse.
  const { bundle } = await bundleOf(await sceneNodes());
  const existing: Record<string, MrsonNode> = {
    disp1: { id: "disp1", type: "scalarVolumeDisplay", window: 1, level: 2 } as never,
  };
  const { scene, nodes } = fakeScene(existing);

  const result = loadMrcomIntoScene(scene, fakeStore(), bundle, { onCollision: "skip" });
  assertEquals(result.skipped, ["disp1"]);
  assertEquals(result.added, ["img1"]);
  // img1 still references disp1 - which exists, but is the scene's own, not the bundle's
  assertEquals(nodes.get("img1")!.refs!.display, ["disp1"]);
  assertEquals(nodes.get("disp1")!.window, 1, "the scene's own display was not overwritten");
});
