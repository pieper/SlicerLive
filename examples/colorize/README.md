# Colorize volume — a CT tinted by 86 TotalSegmentator structures

Slicer's *Colorize Volume* rendered in WebGPU, on public data from the NCI Imaging Data Commons.
Live at [pieper.github.io/live/webgpu/colorize.html](https://pieper.github.io/live/webgpu/colorize.html).

## The data

    collection   nlst (National Lung Screening Trial), patient 218750, study 2001-01-02
    CT           1.3.6.1.4.1.14519.5.2.1.7009.9004.139859765152523282624455168995
    SEG          1.2.276.0.7230010.3.1.3.313263360.35342.1706317560.962438
    geometry     512x512x299 @ 0.566 x 0.566 x 1.25 mm  (373 mm of coverage)
    acquisition  120 kVp, 140 mA, STANDARD kernel; ~10 HU noise in homogeneous soft tissue
    segments     86, from TotalSegmentator v1.5.6
    licence      CC BY 4.0 — doi 10.5281/zenodo.8347011

`totalsegmentator_ct_segmentations` is the **only** TotalSegmentator analysis result in IDC and it
covers **only** NLST, so "a high-resolution CT with TotalSegmentator labels" means an NLST chest CT.
Within that, 1.0–1.25 mm slices at 0.55–0.68 mm in-plane is the best available; this case is the
finest in-plane of those reconstructed with a smooth (non-sharp) kernel, which matters because the
sharp/bone kernels are visibly noisier under volume rendering.

## The trap: the SEG is row-flipped relative to its own reference series

    CT  ImageOrientationPatient  [1,0,0,  0, 1,0]   ImagePositionPatient y = -145.00
    SEG ImageOrientationPatient  [1,0,0,  0,-1,0]   frame 0              y = +144.43

The SEG column axis runs −y while the CT runs +y, so every SEG frame needs `[::-1, :]` before it
indexes the CT grid. Everything else matches exactly — same 512×512 grid, same spacing, same 299 z
positions, and the SEG names the CT in `ReferencedSeriesSequence`.

This fails **silently**: unflipped, the labels still land on plausible-looking anatomy. `prep.py`
therefore asserts on mean HU per label and refuses to write misaligned data:

    WRONG (unflipped)            RIGHT (flipped)
    liver           -65.5        liver            62.0
    left ventricle -538.6        left ventricle   42.4
    right scapula   -37.1        right scapula   443.7
    lungs     -493 .. -711       lungs     -854 .. -861

Do not remove that check.

## Regenerating

    pip install pydicom numpy
    python3 prep.py --out data            # ~30 s: fetches from IDC, writes data/
    deno run -A serve.ts 8778             # http://localhost:8778/colorize.html?data=data/

`prep.py` writes `data/blobs/ct.zarr` (int16 HU, 60.9 MB), `data/blobs/labels.zarr` (uint8 segment
numbers, 0.6 MB) and `data/colorize.json` (geometry, palette, groups). Full resolution: the label
volume compresses to under a megabyte, so there is nothing to gain by downsampling.

**`data/` is gitignored.** The published page streams from the public, CORS-enabled JS2 container:

    https://js2.jetstream-cloud.org:8001/swift/v1/slicerlive/colorize/     481 objects, 61.4 MB

To re-upload after regenerating, get a token with the `CIS230102_IU` application credential in
`~/.config/openstack/clouds.yaml` and PUT each file under `slicerlive/colorize/`; the container
already carries `X-Container-Read: .r:*,.rlistings` and `Access-Control-Allow-Origin: *`.
`?data=<url>` repoints the page.

## Why the RGBA is composed in the shader

A baked rgba16float volume — what `RGBAVolumeField` consumes — freezes every segment's opacity at
bake time. Composing per sample instead ([`render/colorize-field.ts`](../../render/colorize-field.ts))
costs one extra texture fetch and keeps each segment's opacity a live uniform, so a group slider
fades a whole system by rewriting a 1 kB palette while the ray march is running. It also halves the
memory: r16float + u8 labels is 3 bytes/voxel against 8 for rgba16float, and a baked RGBA volume at
this size would be 222 MB.

Three things that are easy to get wrong here, all of which produced visibly broken renders:

- **`fetchZarrVolume` always returns a `Float32Array`**, whatever `dtype` says — the dtype only
  decodes the chunk. Handing that to `writeTexture` for a u8 label volume reinterprets each 4-byte
  float as four label bytes and the labelmap becomes noise, while every *value*-based read of the
  same array still looks correct. `ColorizeField` copies by value; `test/colorize-field.ts` pins it.
- **Shading must not use the CT LUT alpha.** Most CT presets are near step functions in opacity
  (CT-Soft-Tissue is flat 1.0 above −160 HU), so the alpha gradient is zero through the interior and
  enormous on one noisy isosurface — the volume renders as banded moiré. The CT scalar's gradient is
  smooth and is the real surface normal.
- **Labels cannot be hardware-interpolated** (blending 5 and 40 gives 22), so the fetch is NEAREST
  and every organ boundary is a voxel staircase. Interpolating the *indicator* of the nearest label
  across the 8 neighbours antialiases the surface without inventing a label that is not there.

## Controls

Opacity sliders are **per centimetre of tissue**, not per voxel: at the voxel scale a ray crossing
15 cm of lung takes ~265 samples, so even 2% accumulates to fully opaque and the top of the slider
range does nothing. The nine groups partition all 86 segments — `prep.py` asserts the partition, so
a slider can never silently miss a structure.
