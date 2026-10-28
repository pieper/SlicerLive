// T1: logic/mrcom/* must stay DOM-free.
//
// This is a CONTRACT, not a style preference. SlicerAlbula is a Deno desktop app and imports this
// surface from its server (docs/MRCOM-PLAN.md section 5); so does any headless caller. A stray
// `document`, `window`, `HTMLCanvasElement` or `Blob`-from-a-canvas would break them, and it would
// break at import time in production rather than here.
//
// The guard is twofold: the modules must import and run with the DOM globals REMOVED, and their
// source must not mention the DOM identifiers at all.

import { assert, assertEquals } from "../../mrson/assert.ts";

const MODULES = [
  "./format.ts",
  "./vr.ts",
  "./sc-pixels.ts",
  "./write.ts",
  "./read.ts",
  "./load.ts",
  "./dcmjs.ts",
  "../bytes.ts",
  "../bulk.ts",
];

/** Globals a browser has and Deno does not - the ones that would betray a DOM dependency. */
const DOM_GLOBALS = [
  "document",
  "window",
  "HTMLCanvasElement",
  "HTMLImageElement",
  "Image",
  "navigator",
  "localStorage",
  "requestAnimationFrame",
  "GPUDevice",
];

Deno.test("every logic/mrcom module imports with the DOM globals deleted", async () => {
  // Deno has no `document`/`window`, but it DOES have `navigator`. Remove anything DOM-ish that is
  // present, so a module reaching for one fails here.
  const removed: [string, unknown][] = [];
  const target = globalThis as unknown as Record<string, unknown>;
  for (const name of DOM_GLOBALS) {
    if (name in target) {
      removed.push([name, target[name]]);
      try {
        delete target[name];
      } catch {
        // non-configurable: leave it, the source scan below still covers it
        removed.pop();
      }
    }
  }
  try {
    for (const path of MODULES) {
      const module = await import(path);
      assert(
        Object.keys(module).length > 0,
        `${path} exported nothing - did it fail to initialize?`,
      );
    }
  } finally {
    for (const [name, value] of removed) target[name] = value;
  }
});

Deno.test("no logic/mrcom source mentions a DOM identifier", async () => {
  const here = new URL(".", import.meta.url).pathname;
  const offenders: string[] = [];

  for await (const entry of Deno.readDir(here)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    // tests may legitimately talk about the DOM; the modules may not
    if (entry.name.endsWith(".test.ts")) continue;
    const source = await Deno.readTextFile(here + entry.name);
    // strip comments, so prose explaining WHY there is no DOM does not trip this
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

    for (const name of ["document", "window", "HTMLCanvasElement", "HTMLImageElement"]) {
      if (new RegExp(`\\b${name}\\b`).test(code)) {
        offenders.push(`${entry.name} mentions ${name}`);
      }
    }
    // A canvas or a Blob-shaped input would mean the caller has to be a browser. Blob is used
    // INTERNALLY by logic/bytes.ts for the compression streams, which is fine - it is in Deno too -
    // but it must not appear in an exported signature here.
    if (/:\s*(HTMLCanvasElement|OffscreenCanvas|ImageBitmap|CanvasRenderingContext2D)/.test(code)) {
      offenders.push(`${entry.name} takes a canvas type in a signature`);
    }
  }

  assertEquals(offenders, [], "logic/mrcom must stay importable from Deno:\n  " + offenders.join("\n  "));
});

Deno.test("the writer's screenshot input is raw pixels, not a canvas or a Blob", async () => {
  // The specific shape Albula needs: it supplies a frame grab as bytes.
  const source = await Deno.readTextFile(new URL("./sc-pixels.ts", import.meta.url).pathname);
  assert(/rgba\?:\s*Uint8Array/.test(source), "rgba must be a Uint8Array");
  assert(/rgb\?:\s*Uint8Array/.test(source), "rgb must be a Uint8Array");
  assert(!/toBlob|toDataURL|getContext/.test(source), "sc-pixels must not touch a canvas");
});

Deno.test("the writer returns bytes, so a Deno caller can just write the file", async () => {
  const source = await Deno.readTextFile(new URL("./write.ts", import.meta.url).pathname);
  assert(/bytes:\s*Uint8Array/.test(source), "WrittenBundle must expose bytes as a Uint8Array");
  assert(!/new Blob\(/.test(source), "the writer must not hand back a Blob");
  assert(!/createObjectURL|download/.test(source), "saving is the caller's business");
});
