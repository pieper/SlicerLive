// Cardiac example data prep: Slicer public sample NRRDs -> OME-zarr chunks + scene json.
//
//   deno run -A --unstable-webgpu examples/cardiac/prep.ts
//
// Produces examples/cardiac/data/{blobs/,cta.json,cine.json}. Two inputs, both public and
// directly downloadable (no registration):
//
//   CTA-cardio.nrrd     512x512x321 adult cardiac CTA        -> the CT-EndoVascular render
//   CT-cardio.seq.nrrd  10 phases x 128x104x72 4D cardiac CT -> the cine
//
// The 4D file is the LEGACY .seq.nrrd layout (see docs/SEQUENCES-CINE.md §6): axis 0 is the
// `list` axis AND is fastest-varying, so frames are INTERLEAVED with stride nFrames, not
// contiguous. It is also already in RAS, unlike modern Slicer output which is LPS. Both are
// detected from the header rather than assumed — reading it the modern way yields noise.

const HERE = new URL(".", import.meta.url).pathname;
const WORK = HERE + "work/";
const OUT = HERE + "data/";
const CHUNK = 64;

interface Nrrd {
  sizes: number[];
  kinds: string[];
  spaceDirections: (number[] | null)[];
  spaceOrigin: number[];
  space: string;
  type: string;
  data: Int16Array;
}

async function readNrrd(path: string): Promise<Nrrd> {
  const buf = await Deno.readFile(path);
  // Header is ASCII lines terminated by a blank line.
  let end = 0;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0a && (buf[i + 1] === 0x0a || (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a))) {
      end = buf[i + 1] === 0x0a ? i + 2 : i + 3;
      break;
    }
  }
  const header = new TextDecoder().decode(buf.subarray(0, end));
  const field = (k: string) => {
    const m = header.match(new RegExp("^" + k + ":\\s*(.+)$", "m"));
    return m ? m[1].trim() : "";
  };
  const sizes = field("sizes").split(/\s+/).map(Number);
  const kinds = field("kinds").split(/\s+/);
  const space = field("space");
  const type = field("type");
  const encoding = field("encoding");
  // "space directions" entries are either `none` (non-spatial axis) or `(a,b,c)`.
  const spaceDirections = (field("space directions").match(/none|\([^)]*\)/g) ?? []).map((t) =>
    t === "none" ? null : t.slice(1, -1).split(",").map(Number)
  );
  const spaceOrigin = (field("space origin").match(/\(([^)]*)\)/)?.[1] ?? "").split(",").map(Number);

  let raw = buf.subarray(end);
  if (encoding === "gzip") {
    raw = new Uint8Array(
      await new Response(new Response(raw).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
    );
  } else if (encoding !== "raw") throw new Error("unsupported nrrd encoding: " + encoding);
  if (type !== "short") throw new Error("unsupported nrrd type: " + type);
  const data = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  return { sizes, kinds, spaceDirections, spaceOrigin, space, type, data };
}

/** Row-major 4x4 voxel-index -> RAS, flipping LPS->RAS when the file says LPS. */
function ijkToRAS(n: Nrrd, spatialAxes: number[]): number[] {
  const flip = n.space.startsWith("left-posterior") ? [-1, -1, 1] : [1, 1, 1];
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  spatialAxes.forEach((ax, col) => {
    const d = n.spaceDirections[ax]!;
    for (let r = 0; r < 3; r++) m[r * 4 + col] = flip[r] * d[r];
  });
  for (let r = 0; r < 3; r++) m[r * 4 + 3] = flip[r] * n.spaceOrigin[r];
  return m;
}

interface ZarrDesc {
  dir: string; dataset: string;
  shape: [number, number, number];
  chunks: [number, number, number];
  chunkGrid: [number, number, number];
  dtype: string;
}

/** Write one volume as deflate-compressed 64^3 chunks, C-order (z,y,x), edge chunks
 *  zero-padded to full chunk shape — exactly what render/zarr.ts fetchZarrVolume expects. */
async function writeZarr(name: string, vol: Int16Array, nx: number, ny: number, nz: number): Promise<ZarrDesc> {
  const grid: [number, number, number] = [Math.ceil(nz / CHUNK), Math.ceil(ny / CHUNK), Math.ceil(nx / CHUNK)];
  const dir = `${OUT}blobs/${name}.zarr/0/`;
  await Deno.mkdir(dir, { recursive: true });
  const chunk = new Int16Array(CHUNK * CHUNK * CHUNK);
  let written = 0;
  for (let kk = 0; kk < grid[0]; kk++) {
    for (let jj = 0; jj < grid[1]; jj++) {
      for (let ii = 0; ii < grid[2]; ii++) {
        chunk.fill(0);
        const z0 = kk * CHUNK, y0 = jj * CHUNK, x0 = ii * CHUNK;
        const zw = Math.min(CHUNK, nz - z0), yw = Math.min(CHUNK, ny - y0), xw = Math.min(CHUNK, nx - x0);
        for (let z = 0; z < zw; z++) {
          for (let y = 0; y < yw; y++) {
            const src = ((z0 + z) * ny + (y0 + y)) * nx + x0;
            const dst = (z * CHUNK + y) * CHUNK;
            for (let x = 0; x < xw; x++) chunk[dst + x] = vol[src + x];
          }
        }
        const def = new Uint8Array(
          await new Response(
            new Response(new Uint8Array(chunk.buffer, 0, chunk.byteLength)).body!
              .pipeThrough(new CompressionStream("deflate")),
          ).arrayBuffer(),
        );
        await Deno.writeFile(`${dir}${kk}.${jj}.${ii}`, def);
        written += def.byteLength;
      }
    }
  }
  const n = grid[0] * grid[1] * grid[2];
  console.log(`  ${name}: ${nx}x${ny}x${nz} -> ${n} chunks, ${(written / 1048576).toFixed(1)} MB on disk`);
  return { dir: `${name}.zarr`, dataset: "0", shape: [nz, ny, nx], chunks: [CHUNK, CHUNK, CHUNK], chunkGrid: grid, dtype: "<i2" };
}

/** Deepest point inside a homogeneous contrast-filled pool (a chamber or great vessel),
 *  found by eroding a conservative "all voxels in this cell are blood" grid until one core
 *  survives. That is where a camera can sit and see endocardium in every direction under
 *  CT-EndoVascular, which is the whole point of the JACC paper's technique. Returned in RAS. */
function endovascularSeed(vol: Int16Array, nx: number, ny: number, nz: number, m: number[], thresh = 340): number[] {
  const S = 4;
  const gx = Math.floor(nx / S), gy = Math.floor(ny / S), gz = Math.floor(nz / S);
  let cur = new Uint8Array(gx * gy * gz);
  for (let k = 0; k < gz; k++) {
    for (let j = 0; j < gy; j++) {
      for (let i = 0; i < gx; i++) {
        let all = 1;
        for (let dk = 0; dk < S && all; dk++) {
          for (let dj = 0; dj < S && all; dj++) {
            const row = ((k * S + dk) * ny + (j * S + dj)) * nx + i * S;
            for (let di = 0; di < S; di++) if (vol[row + di] < thresh) { all = 0; break; }
          }
        }
        cur[(k * gy + j) * gx + i] = all;
      }
    }
  }
  let depth = 0;
  for (let pass = 1; pass < 40; pass++) {
    const next = new Uint8Array(cur.length);
    let c = 0;
    for (let k = 1; k < gz - 1; k++) {
      for (let j = 1; j < gy - 1; j++) {
        for (let i = 1; i < gx - 1; i++) {
          const o = (k * gy + j) * gx + i;
          if (!cur[o]) continue;
          if (cur[o - 1] && cur[o + 1] && cur[o - gx] && cur[o + gx] && cur[o - gx * gy] && cur[o + gx * gy]) { next[o] = 1; c++; }
        }
      }
    }
    if (!c) break;
    cur = next; depth = pass;
  }
  let si = 0, sj = 0, sk = 0, sn = 0;
  for (let o = 0; o < cur.length; o++) {
    if (!cur[o]) continue;
    si += o % gx; sj += Math.floor(o / gx) % gy; sk += Math.floor(o / (gx * gy)); sn++;
  }
  if (!sn) return [0, 0, 0];
  const ijk = [(si / sn) * S + S / 2, (sj / sn) * S + S / 2, (sk / sn) * S + S / 2];
  const ras = [0, 1, 2].map((r) => m[r * 4] * ijk[0] + m[r * 4 + 1] * ijk[1] + m[r * 4 + 2] * ijk[2] + m[r * 4 + 3]);
  console.log(`  endovascular seed: ${depth} erosions (~${(depth * S * 0.93).toFixed(0)} mm from wall) -> RAS (${ras.map((v) => v.toFixed(1)).join(", ")})`);
  return ras;
}

// ---------------------------------------------------------------- transfer functions
// Verbatim from Slicer's presets.xml / SlicerHeart US-VrPresets.mrml. See
// docs/CARDIAC-RENDERING-PLAN.md §2 — every cardiac preset has a FLAT gradient opacity,
// so these port to the scalar-only LUT machinery unchanged.
import { CARDIAC_PRESETS } from "./presets.ts";

// ---------------------------------------------------------------- main
await Deno.mkdir(OUT, { recursive: true });

// --- 1. Static CTA -------------------------------------------------------------------
{
  const n = await readNrrd(WORK + "CTA-cardio.nrrd");
  const [nx, ny, nz] = n.sizes;
  console.log(`CTA-cardio.nrrd: ${nx}x${ny}x${nz}, space=${n.space}`);
  const z = await writeZarr("cta", n.data, nx, ny, nz);
  const geom = ijkToRAS(n, [0, 1, 2]);
  const seed = endovascularSeed(n.data, nx, ny, nz, geom);
  const p = CARDIAC_PRESETS["CT-EndoVascular"];
  const scene = {
    blobBase: "blobs/",
    nodes: {
      vol: {
        class: "vtkMRMLScalarVolumeNode", name: "CTA cardio",
        attrs: { zarr: z, ijkToRAS: geom, endovascularSeedRAS: seed },
        refs: { display: ["disp"] },
      },
      disp: {
        class: "vtkMRMLScalarVolumeDisplayNode",
        attrs: { window: 1400, level: 300 },
        refs: { volumeProperty: ["vp"] },
      },
      vp: { class: "vtkMRMLVolumePropertyNode", name: "CT-EndoVascular", attrs: { color: p.color, scalarOpacity: p.scalarOpacity, shade: true } },
    },
  };
  await Deno.writeTextFile(OUT + "cta.json", JSON.stringify(scene));
}

// --- 2. 4D cine ----------------------------------------------------------------------
{
  const n = await readNrrd(WORK + "CT-cardio.seq.nrrd");
  const listAxis = n.kinds.indexOf("list");
  if (listAxis < 0) throw new Error("no list axis — not a sequence file");
  const spatial = [0, 1, 2, 3].filter((a) => a !== listAxis);
  const T = n.sizes[listAxis];
  const [nx, ny, nz] = spatial.map((a) => n.sizes[a]);
  // NRRD lists sizes fastest-axis-first, so listAxis===0 means frames are INTERLEAVED.
  const interleaved = listAxis === 0;
  console.log(`CT-cardio.seq.nrrd: ${T} frames of ${nx}x${ny}x${nz}, space=${n.space}, ` +
    `list axis ${listAxis} => ${interleaved ? "INTERLEAVED (stride " + T + ")" : "contiguous"}`);

  const per = nx * ny * nz;
  const items: { index: string; node: string }[] = [];
  const nodes: Record<string, unknown> = {};
  const geom = ijkToRAS(n, spatial);
  for (let t = 0; t < T; t++) {
    const frame = new Int16Array(per);
    if (interleaved) for (let i = 0; i < per; i++) frame[i] = n.data[t + T * i];
    else frame.set(n.data.subarray(t * per, (t + 1) * per));
    const z = await writeZarr(`cine${t}`, frame, nx, ny, nz);
    const id = `vol${t}`;
    nodes[id] = {
      class: "vtkMRMLScalarVolumeNode", name: `frame ${t}`,
      attrs: { zarr: z, ijkToRAS: geom }, refs: { display: ["disp"] },
    };
    items.push({ index: String(t), node: id });
  }
  const p = CARDIAC_PRESETS["CT-Cardiac3"];
  nodes.disp = {
    class: "vtkMRMLScalarVolumeDisplayNode",
    attrs: { window: 1400, level: 300 }, refs: { volumeProperty: ["vp"] },
  };
  nodes.vp = { class: "vtkMRMLVolumePropertyNode", name: "CT-Cardiac3", attrs: { color: p.color, scalarOpacity: p.scalarOpacity, shade: true } };
  // Mirrors vtkMRMLSequenceNode / vtkMRMLSequenceBrowserNode (docs/SEQUENCES-CINE.md §3).
  // No `labels`/`axis 0 index values` in this file, so Slicer's fallbacks apply:
  // indexName "frame", empty unit, values "0".."9".
  nodes.seq = {
    class: "vtkMRMLSequenceNode", type: "sequence", name: "CT cardio",
    attrs: { indexName: "frame", indexUnit: "", indexType: "numeric", numericIndexValueTolerance: 0.001, items },
  };
  nodes.browser = {
    class: "vtkMRMLSequenceBrowserNode", type: "sequenceBrowser", name: "CT cardio browser",
    attrs: {
      sequences: [{ sequence: "seq", proxy: "vol0", playback: true, saveChanges: false, missingItemMode: "createFromPrevious" }],
      selectedItemNumber: 0, playbackActive: false, playbackRateFps: 10,
      playbackLooped: true, playbackItemSkippingEnabled: true,
    },
  };
  await Deno.writeTextFile(OUT + "cine.json", JSON.stringify({ blobBase: "blobs/", nodes }));
}

console.log("\nwrote " + OUT);
