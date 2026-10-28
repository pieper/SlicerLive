# `mrson/fixtures/` — captured real output

`mrson/conformance.test.ts` validates these. They exist because the strongest evidence that the
schema describes reality is *the output of the shipped producers*, and one of those producers
(`LiveStory/LiveStoryLib/serialize_mrson.py`) needs a running 3D Slicer, so CI cannot run it.

Capture the rest in-process instead; only Slicer output needs committing here.

| file | captured from |
|---|---|
| `slicer-app-state.mrson.json` | `serialize_mrson.py` against a live Slicer 5.12.4 — the application-state node set: `layout`, `camera`, `view` (both `slice` and `3d`), `crosshair`, `interaction`, `selection`, `sliceComposite`, `transform`. 15 nodes, no bulk, no patient data. |

## Capturing another one

With Slicer running, from a Python console inside it:

```python
import sys, tempfile
sys.path.insert(0, "<path to>/SlicerLive/LiveStory")
import LiveStoryLib.serialize_mrson as SM
out = tempfile.mkdtemp()
SM.serialize_mrson(out, "fixture")          # writes <out>/fixture.mrson.json + <out>/blobs/
```

Then copy **only the `.mrson.json`** here — the `blobs/` directory is bulk and does not belong in
git, and the schema never needs it to validate a document.

**Check it before committing.** A scene serialized from real data carries node names, and
`image`/`segmentation` nodes can carry `origin` metadata from the file they were read from. Grep for
absolute paths and for anything patient-identifying first; a fixture is a public file forever.
