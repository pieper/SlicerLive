# `render/vendor/dcmjs/` — vendored dcmjs

| | |
|---|---|
| source | https://github.com/dcmjs-org/dcmjs |
| branch | `mrcom-integration` |
| commit | `b02ee51266cac9388ccd9384a3cde6987e893ce6` |
| package version | 0.49.2 |
| `master` it merges | `aee06e4` |
| built | 2026-10-28 with `rollup -c` on node v22.20.0 |

## Why vendored rather than loaded from a CDN

SlicerLive previously loaded dcmjs **0.41.0 from jsdelivr/unpkg**, reader only. MRCOM needs the
*write* path, and three reasons make a CDN wrong for it:

1. **A write path must not depend on the network.** A CDN flake while loading the library that is
   about to encode a file is a corrupted save.
2. **The changes are not released yet.** They are five open PRs — see `docs/MRCOM-PLAN.md` §4. This
   branch is `master` plus all five.
3. **One version everywhere.** The main thread, the classic decode worker
   (`render/vendor/idc_tools/idc-worker.js`, which `importScripts`), Deno, and SlicerAlbula all need
   to agree. A CDN pin plus a worker mirror list is two places to skew.

## The two builds

| file | format | for |
|---|---|---|
| `dcmjs.min.js` | UMD, global `dcmjs` | a script tag and the classic worker's `importScripts` |
| `dcmjs.es.js` | ESM | Deno, SlicerAlbula's server, and esbuild bundling |

Both are needed: Albula imports the ESM from a Deno process, while `idc-worker.js` is a classic
worker and can only `importScripts` the UMD.

Source maps are deliberately not vendored — they are ~4 MB and add nothing to a consumer.

## Do not edit these files

They are build output. To change dcmjs, change it in its own repository and rebuild:

```
cd <dcmjs checkout> && git checkout mrcom-integration && rollup -c
cp build/dcmjs.min.js build/dcmjs.es.js <SlicerLive>/render/vendor/dcmjs/
```

then update the commit in the table above. **The MRCOM PRs are under review and dcmjs is in
production use elsewhere, so treat that branch as read-only input** — raise a needed change rather
than committing one.

## What this build adds over 0.41.0

Beyond upstream `master`: Explicit VR Big Endian byte order for binary value fields,
`registerTag` reaching `nameMap` (so a registered private tag can be *written*, not only read),
`DicomDict#privateBlock()` and `findPrivateBlock()` for PS3.5 §7.8.1 reservation, and a
`SecondaryCapture` derivation. Verified on the global: `data.DicomMessage`, `data.registerTag`,
`data.findPrivateBlock`, `derivations.SecondaryCapture`.
