// How logic/mrcom/ gets hold of dcmjs, in every runtime it has to work in.
//
// Three callers, three situations:
//   - a page that already loaded the UMD build (the dcmjs global) - use it, never load twice
//   - Deno, or SlicerAlbula's server - dynamically import the vendored ESM build
//   - a test that wants to inject a specific instance - setDcmjs()
//
// The dynamic import is deliberately not a static one: a static import would pull 1.4 MB of dcmjs
// into every demo bundle that happens to touch logic/mrcom, whereas a dynamic one is a separate
// chunk that a page with the UMD already loaded never fetches.
//
// render/vendor/dcmjs/README.md explains why the build is vendored rather than loaded from a CDN.

import type { Dcmjs } from "../../render/vendor/dcmjs/dcmjs.d.ts";

export type { Dcmjs };

let injected: Dcmjs | null = null;
let loading: Promise<Dcmjs> | null = null;

/** Use this instance instead of loading one. For tests, and for a host that manages its own copy. */
export function setDcmjs(instance: Dcmjs | null): void {
  injected = instance;
  loading = null;
}

/**
 * The dcmjs instance to use: an injected one, the page's global, or the vendored ESM build.
 *
 * @returns dcmjs
 */
export function getDcmjs(): Promise<Dcmjs> {
  if (injected) return Promise.resolve(injected);
  const global = (globalThis as { dcmjs?: Dcmjs }).dcmjs;
  if (global && global.data) return Promise.resolve(global);
  if (!loading) {
    loading = import("../../render/vendor/dcmjs/dcmjs.es.js")
      .then((module) => (module as { default: Dcmjs }).default)
      .catch((cause) => {
        loading = null;
        throw new Error(
          "dcmjs is unavailable: no dcmjs on globalThis, and the vendored build at " +
            "render/vendor/dcmjs/dcmjs.es.js could not be imported. " +
            "Pass one with setDcmjs(), or see render/vendor/dcmjs/README.md.",
          { cause },
        );
      });
  }
  return loading;
}
