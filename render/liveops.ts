// liveops — the shared mrson op-applier: apply an mrson op to a map of mrson nodes. This is the
// TypeScript dual of `mrson_server._apply_op` (the Slicer side): the SAME op vocabulary
// (put / patch / del / cmd, mrson `structure/ops.struct.json`) applied to the mrson node DOCUMENT
// (generic JSON) instead of to C++ MRML. Pure over a `Map<id, MrsonNode>`, so it runs identically
// in Deno and the browser and is unit-testable in both.
//
// It is what makes a LiveScene locally authoritative: a local Control/Interactor write and an
// inbound remote op go through the exact same mutation, so standalone and connected behave the same.
// LiveScene wraps this with the {origin, version} tagging + observer dispatch (the _changes feed);
// LiveSync wraps that with coalescing/echo-suppression. This file only mutates node state.

import type { MrsonNode } from "./mrson.ts";

export type Role = "human" | "agent" | "module" | "automated";

/** Common op envelope (mrson `Op`): `id` is required; `v`/`origin`/`role` drive echo-suppression
 *  and Lamport-LWW in the layers above (this applier ignores them — it only mutates). */
interface OpBase {
  op: string;
  id: string;
  v?: number;
  origin?: string;
  role?: Role;
}
export interface PutOp extends OpBase { op: "put"; node: MrsonNode }
export interface PatchOp extends OpBase { op: "patch"; path: string; value: unknown }
export interface DelOp extends OpBase { op: "del" }
export interface CmdOp extends OpBase { op: "cmd"; cmd: string; args?: Record<string, unknown> }
export type Op = PutOp | PatchOp | DelOp | CmdOp;

export interface ApplyResult {
  changed: boolean;                                  // did it mutate the node map?
  id: string;
  kind: "put" | "patch" | "del" | "cmd" | "noop";
  path?: string;                                     // for patch: the pointer touched
}

// ── JSON pointer (URI-fragment form "#/a/b/0", per mrson) ─────────────────────
// Slicer's _apply_patch parses the identical form: strip a leading '#', split on '/', drop empties.

function pointerKeys(path: string): string[] {
  return path.replace(/^#/, "").split("/").filter((k) => k.length > 0);
}

/** Set `value` at pointer `path` inside `obj`, creating intermediate objects as needed. Numeric
 *  keys index into arrays. Returns false if the path can't be navigated (missing array element). */
function setByPointer(obj: Record<string, unknown>, path: string, value: unknown): boolean {
  const keys = pointerKeys(path);
  if (keys.length === 0) return false;
  let cur: unknown = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur == null || typeof cur !== "object") return false;
    const container = cur as Record<string, unknown> | unknown[];
    let next = (container as Record<string, unknown>)[k];
    if (next == null || typeof next !== "object") {
      // create the intermediate the way the NEXT key implies (array if it's an index)
      next = /^\d+$/.test(keys[i + 1]) ? [] : {};
      (container as Record<string, unknown>)[k] = next;
    }
    cur = next;
  }
  if (cur == null || typeof cur !== "object") return false;
  (cur as Record<string, unknown>)[keys[keys.length - 1]] = value;
  return true;
}

// ── cmd registry (mirrors _apply_cmd) ────────────────────────────────────────
// Named imperative ops that translate to a node-document mutation. Declarative node-state changes
// SHOULD prefer `patch`; `cmd` is for operations that aren't a single-property set. Extensible so a
// new tool registers a handler rather than editing a dispatcher (same discipline as the interactors).

export type CmdHandler = (node: MrsonNode, args: Record<string, unknown>) => boolean;

const CMDS: Record<string, CmdHandler> = {
  // move one markup control point (SlicerLive drag). World (RAS) coords, latest-wins.
  setControlPoint(node, args) {
    const i = Number(args.index ?? 0);
    const pos = args.position;
    const cps = node.controlPoints as { position: number[] }[] | undefined;
    if (!cps || !cps[i] || !Array.isArray(pos)) return false;
    cps[i].position = [Number(pos[0]), Number(pos[1]), Number(pos[2])];
    return true;
  },
  setCameraPose(node, args) {
    let did = false;
    for (const k of ["position", "focalPoint", "viewUp"] as const) {
      if (Array.isArray(args[k])) { (node as Record<string, unknown>)[k] = [...(args[k] as number[])]; did = true; }
    }
    return did;
  },
  setRoi(node, args) {
    let did = false;
    for (const k of ["center", "size"] as const) {
      if (Array.isArray(args[k])) { (node as Record<string, unknown>)[k] = [...(args[k] as number[])]; did = true; }
    }
    return did;
  },
};

/** Register a cmd handler (a tool/module adds its imperative op without editing this file). */
export function registerCmd(name: string, handler: CmdHandler): void {
  CMDS[name] = handler;
}

// ── the applier ───────────────────────────────────────────────────────────────

/** Apply one mrson op to `nodes`, mutating in place. Returns what changed so the caller (LiveScene)
 *  can notify the right observers. Unknown ops / missing targets are a no-op (changed:false), never
 *  a throw — a lossy transport can deliver a patch for a node not yet (or no longer) present. */
export function applyOp(nodes: Map<string, MrsonNode>, op: Op): ApplyResult {
  const id = op.id;
  switch (op.op) {
    case "put": {
      if (!op.node || typeof op.node !== "object") return { changed: false, id, kind: "noop" };
      nodes.set(id, { ...op.node, id });                       // id is authoritative from the envelope
      return { changed: true, id, kind: "put" };
    }
    case "del": {
      return { changed: nodes.delete(id), id, kind: "del" };
    }
    case "patch": {
      const node = nodes.get(id);
      if (!node) return { changed: false, id, kind: "noop", path: op.path };
      const ok = setByPointer(node as unknown as Record<string, unknown>, op.path, op.value);
      return { changed: ok, id, kind: ok ? "patch" : "noop", path: op.path };
    }
    case "cmd": {
      const node = nodes.get(id);
      const handler = CMDS[op.cmd];
      if (!node || !handler) return { changed: false, id, kind: "noop" };
      const ok = handler(node, op.args ?? {});
      return { changed: ok, id, kind: ok ? "cmd" : "noop" };
    }
    default:
      return { changed: false, id, kind: "noop" };
  }
}

/** Apply a batch in order; returns the per-op results. */
export function applyOps(nodes: Map<string, MrsonNode>, ops: Op[]): ApplyResult[] {
  return ops.map((o) => applyOp(nodes, o));
}
