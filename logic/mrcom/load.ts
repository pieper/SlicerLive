// Putting a read MRCOM bundle into a live scene.
//
// NON-DESTRUCTIVE, and that is the whole design. 3D Slicer's SlicerDataBundle plugin loads through
// vtkMRMLScene::Connect(), which CLEARS the current scene - so it has to diff the node set before
// and after to work out what arrived, and guess which node to hang in the subject hierarchy. Here
// loading issues `put` ops only and returns the ids it added, so a caller can merge a bundle into a
// scene it is already working in, and undo it.
//
// DOM-free: it takes the LiveScene interface it needs rather than importing the renderer.

import type { MrsonNode } from "../../render/mrson.ts";
import type { ReadBundle } from "./read.ts";

/** The slice of LiveScene this needs. Structural, so a test can pass a stub. */
export interface SceneWriter {
  write(op: { op: "put"; id: string; node: MrsonNode }): unknown;
  readonly nodes: Map<string, MrsonNode>;
}

/** Somewhere to put the bundle's blobs so the renderer can fetch them by hash. */
export interface BlobSink {
  add(blobs: Map<string, Uint8Array>): void;
  has?(hash: string): boolean;
}

export interface LoadOptions {
  /**
   * What to do when a node id in the bundle is already in the scene. Default "rename": the incoming
   * node gets a fresh id and every ref to it is rewritten, so loading a bundle twice gives two
   * independent copies rather than one overwriting the other.
   */
  onCollision?: "rename" | "replace" | "skip";
  /** Prefix for renamed ids. Default "mrcom". */
  renamePrefix?: string;
}

export interface LoadResult {
  /** Node ids now in the scene because of this load, in load order. */
  added: string[];
  /** Incoming id -> the id actually used, for anything renamed. */
  renamed: Record<string, string>;
  /** Ids skipped because they already existed and onCollision was "skip". */
  skipped: string[];
  /** Blobs handed to the sink. */
  blobs: number;
  /** Hashes the scene still needs that the bundle did not carry (reference mode). */
  missing: string[];
}

let sequence = 0;

/**
 * Merge a bundle into a scene.
 *
 * @param scene the live scene to write into
 * @param store where the bundle's blobs go
 * @param bundle a bundle from readMrcomBundle()
 * @param options collision policy
 * @returns what was added, renamed, skipped, and still missing
 */
export function loadMrcomIntoScene(
  scene: SceneWriter,
  store: BlobSink | null,
  bundle: ReadBundle,
  options: LoadOptions = {},
): LoadResult {
  const policy = options.onCollision ?? "rename";
  const prefix = options.renamePrefix ?? "mrcom";

  // ---- decide the final id of every incoming node ---------------------------------------------
  const renamed: Record<string, string> = {};
  const skipped: string[] = [];
  const incoming = Object.entries(bundle.nodes);

  for (const [id] of incoming) {
    if (!scene.nodes.has(id)) continue;
    if (policy === "skip") {
      skipped.push(id);
    } else if (policy === "rename") {
      let candidate = `${prefix}-${++sequence}-${id}`;
      while (scene.nodes.has(candidate) || renamed[candidate]) {
        candidate = `${prefix}-${++sequence}-${id}`;
      }
      renamed[id] = candidate;
    }
    // "replace" needs no mapping: the put overwrites.
  }

  const skippedSet = new Set(skipped);
  const finalId = (id: string) => renamed[id] ?? id;

  // ---- blobs first, so a renderer that reacts to a node can already fetch its bulk -------------
  let blobCount = 0;
  if (store && bundle.blobs.size) {
    store.add(bundle.blobs);
    blobCount = bundle.blobs.size;
  }

  // ---- write the nodes -------------------------------------------------------------------------
  const added: string[] = [];
  for (const [id, node] of incoming) {
    if (skippedSet.has(id)) continue;
    const target = finalId(id);
    const rewritten = { ...node, id: target } as MrsonNode;

    // Rewrite refs, so a renamed node's graph still points at the right places. A ref to a node
    // that was skipped is left alone: it dangles, which validateScene() reports as a warning
    // because a partial closure is legitimate.
    if (node.refs) {
      const refs: Record<string, string[]> = {};
      for (const [role, targets] of Object.entries(node.refs)) {
        refs[role] = (targets ?? []).map((t) => finalId(t));
      }
      rewritten.refs = refs;
    }

    scene.write({ op: "put", id: target, node: rewritten });
    added.push(target);
  }

  // ---- what is still needed --------------------------------------------------------------------
  const missing = bundle.required.filter((hash) => !(store?.has?.(hash) ?? false));

  return { added, renamed, skipped, blobs: blobCount, missing };
}
