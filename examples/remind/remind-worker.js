// ReMINDer DICOM decode worker — loads one IDC series into a browser-ready volume.
//
// Adapted from render/vendor/idc_tools/idc-worker.js (same dcmjs bootstrap, the same
// ranged-PixelData read, the same SEG rasteriser), generalised for what ReMIND needs
// and the roulette's one-image-plus-one-SEG shape cannot express:
//
//   * MULTI-FRAME volumes. Every ReMIND ultrasound series is a SINGLE instance —
//     Multi-frame Grayscale Byte SC (1.2.840.10008.5.1.4.1.1.7.2), 8-bit, ~193 frames,
//     geometry in Shared/PerFrame functional groups, up to 197 MB uncompressed. The
//     roulette worker only ever walked one-frame-per-instance series, so this is new.
//   * SEG ONTO A CALLER-SUPPLIED GRID. A ReMIND MR series carries up to three SEGs
//     (tumor + cerebrum + ventricles); each is rasterised against the grid the image
//     row already lives on, so a row can stack several labelmaps without reloading.
//   * DOWNSAMPLE BEFORE TRANSFER. Native US is 0.125 x 0.125 x 0.5 mm — 92 M voxels,
//     371 MB as the f32 an ImageField wants, per row. The isotropic resample happens
//     HERE, so that never crosses the postMessage boundary or reaches the GPU.
//
// Protocol — one request per worker, `id` echoed back:
//   {op:'volume', id, keys[], bucket, modality, maxDim, maxVoxels}
//     -> {t:'progress'} … {t:'volume', vol:f32, dims, ijkToRAS, win, lev, native, vox}
//   {op:'seg', id, key, bucket, grid:{dims, ijkToRAS}}
//     -> {t:'progress'} … {t:'labelmap', lab:u8, colors, names}
(function loadDcmjs() {
  const mirrors = [
    'https://cdn.jsdelivr.net/npm/dcmjs@0.41.0/build/dcmjs.min.js',
    'https://unpkg.com/dcmjs@0.41.0/build/dcmjs.min.js',
    'https://cdn.jsdelivr.net/npm/dcmjs@0.41.0/build/dcmjs.js',
    'https://unpkg.com/dcmjs@0.41.0/build/dcmjs.js',
  ];
  for (let i = 0; i < 12; i++) {
    try { importScripts(mirrors[i % mirrors.length]); return; } catch (e) { /* try next mirror */ }
  }
  throw new Error('dcmjs: all CDN mirrors failed');
})();

const s3url = (b) => 'https://' + (b || 'idc-open-data') + '.s3.us-east-1.amazonaws.com/';
let BASE = s3url();
let ID = 0;
const post = (m, x) => self.postMessage({ ...m, id: ID }, x || []);
const prog = (msg, frac) => post({ t: 'progress', msg, frac });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, opts, tries = 6) {
  let err;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 60000);   // US objects are big: 20 s is not enough
    try {
      const r = await fetch(url, { ...(opts || {}), signal: ac.signal });
      if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) {
      err = e;
      if (i < tries - 1) await sleep(Math.min(4000, 250 * 2 ** i) * (0.6 + 0.8 * Math.random()));
    } finally { clearTimeout(to); }
  }
  throw err;
}

const naturalize = (buf) => dcmjs.data.DicomMetaDictionary.naturalizeDataset(dcmjs.data.DicomMessage.readFile(buf).dict);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lps2ras = (v) => [-v[0], -v[1], v[2]];
const num = (v) => Number(Array.isArray(v) ? v[0] : v);
const fetchBuf = (key) => fetchRetry(BASE + key).then((r) => r.arrayBuffer());

/** Pixel view of one dataset's PixelData, honouring BitsAllocated/PixelRepresentation. */
function pixelsOf(ds, pd) {
  if (Array.isArray(pd)) pd = pd[0];
  if (Number(ds.BitsAllocated) === 8) return new Uint8Array(pd);
  return ds.PixelRepresentation === 1 ? new Int16Array(pd) : new Uint16Array(pd);
}

/** ijkToRAS (row-major 4x4) from column vectors already in RAS mm. */
const ijkToRASFrom = (c0, c1, c2, o) => [
  c0[0], c1[0], c2[0], o[0],
  c0[1], c1[1], c2[1], o[1],
  c0[2], c1[2], c2[2], o[2],
  0, 0, 0, 1,
];

/** Robust display window from the data itself (2nd–98th percentile over a sampled histogram).
 *  ReMIND US carries no WindowCenter/Width at all, and the MR values are raw scanner units,
 *  so a fixed guess would blow out one row and black out the next. */
function autoWindow(vol, ds) {
  const wc = ds && ds.WindowCenter, ww = ds && ds.WindowWidth;
  if (wc != null && ww != null && Number(num(ww)) > 0) return { win: Number(num(ww)), lev: Number(num(wc)) };
  const stride = Math.max(1, Math.floor(vol.length / 200000));
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < vol.length; i += stride) { const v = vol[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi > lo)) return { win: 1, lev: 0 };
  const NB = 512, hist = new Uint32Array(NB), sc = NB / (hi - lo);
  let n = 0;
  for (let i = 0; i < vol.length; i += stride) { hist[Math.min(NB - 1, ((vol[i] - lo) * sc) | 0)]++; n++; }
  const at = (frac) => {
    let acc = 0, target = frac * n;
    for (let b = 0; b < NB; b++) { acc += hist[b]; if (acc >= target) return lo + (b + 0.5) / sc; }
    return hi;
  };
  const p2 = at(0.02), p98 = at(0.98);
  const win = Math.max(1e-6, p98 - p2);
  return { win, lev: p2 + win / 2 };
}

/** Trilinear resample onto an isotropic grid sharing the source's direction cosines.
 *  Same per-axis cap → memory cap policy (and the same column-rescaling of ijkToRAS) as
 *  algorithms/geom.ts resampleIsotropic, but interpolating instead of nearest: these are
 *  greyscale scans, and nearest on a 4x decimation of 0.125 mm US is visibly aliased. */
function resampleIso(src, dims, ijkToRAS, maxDim, maxVoxels) {
  const colNorm = (c) => Math.hypot(ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]);
  const sp = [colNorm(0), colNorm(1), colNorm(2)];
  const ext = [dims[0] * sp[0], dims[1] * sp[1], dims[2] * sp[2]];
  let vox = Math.max(...ext) / maxDim;
  const count = (v) => Math.max(1, Math.round(ext[0] / v)) * Math.max(1, Math.round(ext[1] / v)) * Math.max(1, Math.round(ext[2] / v));
  if (count(vox) > maxVoxels) vox = Math.cbrt((ext[0] * ext[1] * ext[2]) / maxVoxels);
  const cd = [Math.max(1, Math.round(ext[0] / vox)), Math.max(1, Math.round(ext[1] / vox)), Math.max(1, Math.round(ext[2] / vox))];
  const [nx, ny, nz] = dims, [cx, cy, cz] = cd;
  const out = new Float32Array(cx * cy * cz);
  if (cx === nx && cy === ny && cz === nz) {
    for (let i = 0; i < out.length; i++) out[i] = src[i];
    return { vol: out, dims, ijkToRAS, vox: Math.min(...sp) };
  }
  const rx = nx / cx, ry = ny / cy, rz = nz / cz;
  for (let z = 0; z < cz; z++) {
    const fz = Math.min(nz - 1, Math.max(0, (z + 0.5) * rz - 0.5));
    const z0 = Math.floor(fz), z1 = Math.min(nz - 1, z0 + 1), tz = fz - z0;
    for (let y = 0; y < cy; y++) {
      const fy = Math.min(ny - 1, Math.max(0, (y + 0.5) * ry - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(ny - 1, y0 + 1), ty = fy - y0;
      const b00 = (z0 * ny + y0) * nx, b01 = (z0 * ny + y1) * nx;
      const b10 = (z1 * ny + y0) * nx, b11 = (z1 * ny + y1) * nx;
      let w = (z * cy + y) * cx;
      for (let x = 0; x < cx; x++, w++) {
        const fx = Math.min(nx - 1, Math.max(0, (x + 0.5) * rx - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(nx - 1, x0 + 1), tx = fx - x0;
        const c00 = src[b00 + x0] + (src[b00 + x1] - src[b00 + x0]) * tx;
        const c01 = src[b01 + x0] + (src[b01 + x1] - src[b01 + x0]) * tx;
        const c10 = src[b10 + x0] + (src[b10 + x1] - src[b10 + x0]) * tx;
        const c11 = src[b11 + x0] + (src[b11 + x1] - src[b11 + x0]) * tx;
        const c0 = c00 + (c01 - c00) * ty, c1 = c10 + (c11 - c10) * ty;
        out[w] = c0 + (c1 - c0) * tz;
      }
    }
  }
  const r = [nx / cx, ny / cy, nz / cz], m = ijkToRAS.slice();
  for (let row = 0; row < 3; row++) { m[row * 4] *= r[0]; m[row * 4 + 1] *= r[1]; m[row * 4 + 2] *= r[2]; }
  return { vol: out, dims: cd, ijkToRAS: m, vox };
}

/** Locate PixelData in a header prefix, then range-fetch the pixel bytes in parallel.
 *  For a 197 MB single-instance US series a plain GET is one long serial stream; this
 *  splits it across connections and keeps only the bytes, never a second parsed copy. */
async function fetchBulk(key, label) {
  const HEAD = 4 << 20;
  const head = new Uint8Array(await fetchRetry(BASE + key, { headers: { Range: `bytes=0-${HEAD - 1}` } }).then((r) => r.arrayBuffer()));
  const dv = new DataView(head.buffer, head.byteOffset);
  let pt = -1;
  for (let i = 132; i + 12 <= head.length; i += 2) {
    if (head[i] === 0xE0 && head[i + 1] === 0x7F && head[i + 2] === 0x10 && head[i + 3] === 0x00) {
      const vr = String.fromCharCode(head[i + 4], head[i + 5]);
      if (vr === 'OB' || vr === 'OW' || vr === 'UN') { pt = i; break; }
    }
  }
  if (pt < 0) throw new Error('PixelData tag not within the first 4 MB');
  const valOff = pt + 12, pdLen = dv.getUint32(pt + 8, true);
  if (!pdLen || pdLen === 0xFFFFFFFF) throw new Error('encapsulated/undefined-length PixelData');
  const ds = naturalize(head.slice(0, pt).buffer);
  const bytes = new Uint8Array(pdLen);
  const have = Math.max(0, Math.min(HEAD, valOff + pdLen) - valOff);
  if (have > 0) bytes.set(head.subarray(valOff, valOff + have), 0);
  const rs = valOff + have, re = valOff + pdLen - 1;
  if (rs <= re) {
    const CH = 8, cs = Math.ceil((re - rs + 1) / CH);
    let got = have;
    await Promise.all(Array.from({ length: CH }, (_, c) => {
      const s = rs + c * cs, e = Math.min(re, s + cs - 1);
      if (s > e) return null;
      return fetchRetry(BASE + key, { headers: { Range: `bytes=${s}-${e}` } }).then((r) => r.arrayBuffer()).then((ab) => {
        bytes.set(new Uint8Array(ab), s - valOff);
        got += ab.byteLength;
        prog(`${label} ${(got / 1e6) | 0}/${(pdLen / 1e6) | 0} MB`, 0.05 + 0.55 * got / pdLen);
      });
    }));
  }
  return { ds, bytes };
}

/** One multi-frame instance (ReMIND US) → volume on its native grid. */
async function buildMultiFrame(key, label) {
  const { ds, bytes } = await fetchBulk(key, label);
  const nx = Number(ds.Columns), ny = Number(ds.Rows), nf = Number(ds.NumberOfFrames);
  const bits = Number(ds.BitsAllocated) || 8;
  const shared = ds.SharedFunctionalGroupsSequence?.[0] || {};
  const perFrame = ds.PerFrameFunctionalGroupsSequence || [];
  if (perFrame.length !== nf) throw new Error(`per-frame groups ${perFrame.length} != NumberOfFrames ${nf}`);
  const iop = (shared.PlaneOrientationSequence?.[0]?.ImageOrientationPatient
    || perFrame[0]?.PlaneOrientationSequence?.[0]?.ImageOrientationPatient).map(Number);
  const pm = shared.PixelMeasuresSequence?.[0] || perFrame[0]?.PixelMeasuresSequence?.[0] || {};
  const ps = (pm.PixelSpacing || [1, 1]).map(Number);
  const xf = shared.PixelValueTransformationSequence?.[0] || {};
  const slope = Number(xf.RescaleSlope ?? ds.RescaleSlope ?? 1), inter = Number(xf.RescaleIntercept ?? ds.RescaleIntercept ?? 0);

  const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6), normal = cross(rowDir, colDir);
  // Frames are NOT required to be stored in geometric order — sort by position along the
  // slice normal (the same rule the multi-slice path uses), never by index.
  const order = perFrame.map((fg, f) => {
    const ipp = (fg.PlanePositionSequence?.[0]?.ImagePositionPatient || [0, 0, 0]).map(Number);
    return { f, ipp, proj: dot(ipp, normal) };
  }).sort((a, b) => a.proj - b.proj);
  const p0 = order[0].ipp, p1 = order[nf - 1].ipp;
  const spacing = nf > 1 ? dot(sub(p1, p0), normal) / (nf - 1)
    : (Number(pm.SpacingBetweenSlices || pm.SliceThickness) || 1);

  const px = bits === 8 ? bytes
    : (ds.PixelRepresentation === 1 ? new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1)
      : new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1));
  const frameLen = nx * ny;
  const vol = new Float32Array(frameLen * nf);
  for (let k = 0; k < nf; k++) {
    const off = order[k].f * frameLen, dst = k * frameLen;
    for (let p = 0; p < frameLen; p++) vol[dst + p] = px[off + p] * slope + inter;
    if (k % 32 === 0) prog(`${label} frame ${k}/${nf}`, 0.6 + 0.25 * k / nf);
  }
  const ijkToRAS = ijkToRASFrom(
    lps2ras(rowDir.map((v) => v * ps[1])),
    lps2ras(colDir.map((v) => v * ps[0])),
    lps2ras(normal.map((v) => v * spacing)),
    lps2ras(p0),
  );
  return { vol, dims: [nx, ny, nf], ijkToRAS, ds };
}

/** A conventional one-frame-per-instance series (ReMIND MR) → volume on its native grid. */
async function buildMultiSlice(keys, label) {
  const slices = new Array(keys.length);
  let done = 0, idx = 0;
  const CONC = 8;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (idx < keys.length) {
      const my = idx++;
      slices[my] = naturalize(await fetchBuf(keys[my]));
      done++;
      if (done % 4 === 0) prog(`${label} ${done}/${keys.length}`, 0.05 + 0.75 * done / keys.length);
    }
  }));
  const s0 = slices[0];
  const iop = s0.ImageOrientationPatient.map(Number);
  const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6), normal = cross(rowDir, colDir);
  slices.sort((a, b) => dot(a.ImagePositionPatient.map(Number), normal) - dot(b.ImagePositionPatient.map(Number), normal));
  const nz = slices.length, ny = Number(s0.Rows), nx = Number(s0.Columns);
  const ps = s0.PixelSpacing.map(Number);
  const p0 = slices[0].ImagePositionPatient.map(Number), p1 = slices[nz - 1].ImagePositionPatient.map(Number);
  const spacing = nz > 1 ? dot(sub(p1, p0), normal) / (nz - 1) : (Number(s0.SliceThickness) || 1);
  const vol = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const ds = slices[k];
    const slope = Number(ds.RescaleSlope ?? 1), inter = Number(ds.RescaleIntercept ?? 0);   // per-slice: some MR rescales vary down the stack
    const px = pixelsOf(ds, ds.PixelData);
    const base = k * nx * ny;
    for (let p = 0; p < nx * ny; p++) vol[base + p] = px[p] * slope + inter;
  }
  const ijkToRAS = ijkToRASFrom(
    lps2ras(rowDir.map((v) => v * ps[1])),
    lps2ras(colDir.map((v) => v * ps[0])),
    lps2ras(normal.map((v) => v * spacing)),
    lps2ras(p0),
  );
  return { vol, dims: [nx, ny, nz], ijkToRAS, ds: s0 };
}

function invAffine(m) {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]], t = [m[3], m[7], m[11]];
  const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const id = 1 / det;
  const r = [
    (a[4] * a[8] - a[5] * a[7]) * id, (a[2] * a[7] - a[1] * a[8]) * id, (a[1] * a[5] - a[2] * a[4]) * id,
    (a[5] * a[6] - a[3] * a[8]) * id, (a[0] * a[8] - a[2] * a[6]) * id, (a[2] * a[3] - a[0] * a[5]) * id,
    (a[3] * a[7] - a[4] * a[6]) * id, (a[1] * a[6] - a[0] * a[7]) * id, (a[0] * a[4] - a[1] * a[3]) * id,
  ];
  return [
    r[0], r[1], r[2], -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]),
    r[3], r[4], r[5], -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]),
    r[6], r[7], r[8], -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]),
    0, 0, 0, 1,
  ];
}

/** Rasterise a binary SEG onto the CALLER's grid (the row's own resampled image grid). */
function buildLabelmap(ds, bits, grid) {
  const [nx, ny, nz] = grid.dims;
  const lab = new Uint8Array(nx * ny * nz);
  const inv = invAffine(grid.ijkToRAS);
  const toIJK = (lps) => {
    const r = lps2ras(lps);
    return [
      inv[0] * r[0] + inv[1] * r[1] + inv[2] * r[2] + inv[3],
      inv[4] * r[0] + inv[5] * r[1] + inv[6] * r[2] + inv[7],
      inv[8] * r[0] + inv[9] * r[1] + inv[10] * r[2] + inv[11],
    ];
  };
  const shared = ds.SharedFunctionalGroupsSequence?.[0] || {};
  const sIop = (shared.PlaneOrientationSequence?.[0]?.ImageOrientationPatient || []).map(Number);
  const sPs = (shared.PixelMeasuresSequence?.[0]?.PixelSpacing || [1, 1]).map(Number);
  const perFrame = ds.PerFrameFunctionalGroupsSequence || [];
  const iop = sIop.length === 6 ? sIop : (perFrame[0]?.PlaneOrientationSequence?.[0]?.ImageOrientationPatient || []).map(Number);
  const colW = iop.slice(0, 3).map((v) => v * sPs[1]);
  const rowW = iop.slice(3, 6).map((v) => v * sPs[0]);
  const sx = Number(ds.Columns), sy = Number(ds.Rows);
  const frameBits = sx * sy;

  const colors = [], names = {};
  for (const s of (ds.SegmentSequence ? [].concat(ds.SegmentSequence) : [])) {
    const rgb = s.RecommendedDisplayCIELabValue ? dcmjs.data.Colors.dicomlab2RGB(s.RecommendedDisplayCIELabValue) : [1, 1, 1];
    colors.push([Number(s.SegmentNumber), rgb[0], rgb[1], rgb[2]]);
    names[Number(s.SegmentNumber)] = s.SegmentLabel || ('Segment ' + s.SegmentNumber);
  }
  const ref = (perFrame[0]?.PlanePositionSequence?.[0]?.ImagePositionPatient || [0, 0, 0]).map(Number);
  const o0 = toIJK(ref);
  const diCol = sub(toIJK([ref[0] + colW[0], ref[1] + colW[1], ref[2] + colW[2]]), o0);
  const diRow = sub(toIJK([ref[0] + rowW[0], ref[1] + rowW[1], ref[2] + rowW[2]]), o0);
  let filled = 0;
  for (let f = 0; f < perFrame.length; f++) {
    const fg = perFrame[f];
    const segNum = fg.SegmentIdentificationSequence?.[0]?.ReferencedSegmentNumber;
    const ippLps = fg.PlanePositionSequence?.[0]?.ImagePositionPatient?.map(Number);
    if (!segNum || !ippLps) continue;
    const o = toIJK(ippLps), fb = f * frameBits;
    for (let row = 0; row < sy; row++) {
      const bi = o[0] + row * diRow[0], bj = o[1] + row * diRow[1], bk = o[2] + row * diRow[2], rb = row * sx;
      for (let col = 0; col < sx; col++) {
        const p = rb + col;
        if (!((bits[(fb + p) >> 3] >> ((fb + p) & 7)) & 1)) continue;
        const i = Math.round(bi + col * diCol[0]), j = Math.round(bj + col * diCol[1]), k = Math.round(bk + col * diCol[2]);
        if (i >= 0 && i < nx && j >= 0 && j < ny && k >= 0 && k < nz) { lab[(k * ny + j) * nx + i] = segNum; filled++; }
      }
    }
    if (f % 64 === 0) prog(`SEG ${f}/${perFrame.length}`, 0.6 + 0.35 * f / perFrame.length);
  }
  return { lab, colors, names, filled };
}

self.onmessage = async (e) => {
  const msg = e.data;
  ID = msg.id;
  BASE = s3url(msg.bucket);
  try {
    if (msg.op === 'volume') {
      const label = msg.modality === 'US' ? 'US' : (msg.modality || 'image');
      prog(`fetching ${label}…`, 0.02);
      // A one-object image series is the enhanced/multi-frame case (every ReMIND US);
      // anything else is one frame per instance.
      const built = msg.keys.length === 1
        ? await buildMultiFrame(msg.keys[0], label)
        : await buildMultiSlice(msg.keys, label);
      prog('resampling…', 0.88);
      const rs = resampleIso(built.vol, built.dims, built.ijkToRAS, msg.maxDim || 224, msg.maxVoxels || 8e6);
      const { win, lev } = autoWindow(rs.vol, built.ds);
      post({
        t: 'volume', vol: rs.vol.buffer, dims: rs.dims, ijkToRAS: rs.ijkToRAS,
        win, lev, vox: rs.vox, native: { dims: built.dims },
      }, [rs.vol.buffer]);
    } else if (msg.op === 'seg') {
      prog('fetching SEG…', 0.05);
      let ds, bits;
      try {
        const r = await fetchBulk(msg.key, 'SEG');
        ds = r.ds; bits = r.bytes;
      } catch (err) {   // header past 4 MB, or an encapsulated transfer syntax — fall back to a whole-object read
        const buf = await fetchBuf(msg.key);
        ds = naturalize(buf);
        let pd = ds.PixelData;
        if (Array.isArray(pd)) pd = pd[0];
        bits = new Uint8Array(pd);
      }
      const seg = buildLabelmap(ds, bits, msg.grid);
      post({ t: 'labelmap', lab: seg.lab.buffer, colors: seg.colors, names: seg.names, filled: seg.filled }, [seg.lab.buffer]);
    } else {
      throw new Error('unknown op ' + msg.op);
    }
    post({ t: 'done' });
  } catch (err) {
    post({ t: 'error', error: String((err && err.stack) || err) });
  }
};
