// Shared DICOM -> volume core for the SlicerLive decode workers.
//
// ONE code path for both classic workers: render/vendor/idc_tools/idc-worker.js (the IDC loader
// behind SEGRoulette / the BIR reader / SlicerRAD-IDC) and examples/remind/remind-worker.js
// (ReMINDer). Both importScripts() this file and read `self.DicomVolume`.
//
// Everything here is PURE: geometry, windowing, pixel unpacking, PixelData location, and volume
// assembly. No fetching and no postMessage — each worker keeps its own transport and progress
// reporting, so this stays reusable and testable.
(function (g) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const lps2ras = (v) => [-v[0], -v[1], v[2]]; // DICOM LPS -> RAS
  const ijkToRASFrom = (c0, c1, c2, o) => [
    c0[0], c1[0], c2[0], o[0],
    c0[1], c1[1], c2[1], o[1],
    c0[2], c1[2], c2[2], o[2],
    0, 0, 0, 1,
  ];

  /** Percentile auto-window for data with no usable VOI (MR/PET, and ultrasound — ReMIND US
   *  carries no WindowCenter/Width at all). PET clamps the floor at 0 and uses a 98th pct top. */
  function autoWindow(vol, isPET) {
    const N = vol.length, step = Math.max(1, (N / 200000) | 0), samp = [];
    for (let i = 0; i < N; i += step) {
      const v = vol[i];
      if (!isPET || v > 0) samp.push(v);
    }
    samp.sort((a, b) => a - b);
    const pct = (f) => (samp.length ? samp[Math.min(samp.length - 1, (f * samp.length) | 0)] : 0);
    const lo = isPET ? 0 : pct(0.01), hi = isPET ? (pct(0.98) || 1) : pct(0.99);
    return { lev: (lo + hi) / 2, win: Math.max(1, hi - lo) };
  }

  /** VOI straight from the dataset (or a shared functional group), else null. */
  function voiOf(ds, shared) {
    const wc = shared?.FrameVOILUTSequence?.[0]?.WindowCenter ?? ds.WindowCenter;
    const ww = shared?.FrameVOILUTSequence?.[0]?.WindowWidth ?? ds.WindowWidth;
    if (wc == null || ww == null) return null;
    const win = Number(Array.isArray(ww) ? ww[0] : ww) || 0;
    const lev = Number(Array.isArray(wc) ? wc[0] : wc);
    return win > 0 ? { win, lev } : null;
  }

  /** A Uint8Array view (e.g. a subarray of a header read) may sit at an odd byte offset, which
   *  a 16-bit typed array cannot wrap — normalise to a standalone ArrayBuffer when needed. */
  function rawBuffer(bytes) {
    return (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
      ? bytes.buffer : bytes.slice().buffer;
  }

  /** Raw stored pixels as the right typed array for BitsAllocated / PixelRepresentation. */
  function pixelsOf(buf, bits, signed) {
    if (bits === 8) return signed ? new Int8Array(buf) : new Uint8Array(buf);
    return signed ? new Int16Array(buf) : new Uint16Array(buf);
  }

  /** Locate PixelData (7FE0,0010) in an explicit-VR header buffer so its bytes can be range-read
   *  instead of downloading the whole object. Returns {valOff, pdLen}; throws when the tag isn't
   *  in `head` or the pixels are encapsulated/undefined-length (compressed). */
  function findPixelData(head) {
    const dv = new DataView(head.buffer, head.byteOffset);
    let pt = -1;
    for (let i = 132; i + 12 <= head.length; i += 2) {
      if (head[i] === 0xE0 && head[i + 1] === 0x7F && head[i + 2] === 0x10 && head[i + 3] === 0x00) {
        const vr = String.fromCharCode(head[i + 4], head[i + 5]);
        if (vr === 'OB' || vr === 'OW' || vr === 'UN') { pt = i; break; }
      }
    }
    if (pt < 0) throw new Error('PixelData tag not found in the fetched header');
    const pdLen = dv.getUint32(pt + 8, true);
    if (!pdLen || pdLen === 0xFFFFFFFF) throw new Error('encapsulated/undefined-length PixelData');
    return { tagOff: pt, valOff: pt + 12, pdLen };
  }

  /** Per-frame geometry of an enhanced / multi-frame instance: orientation, spacing, and the
   *  frame order along the slice normal (frames are NOT required to be stored in geometric
   *  order). A multi-frame object with no per-frame positions — a 2D cine rather than a 3D
   *  volume — falls back to stored order + SpacingBetweenSlices/SliceThickness. */
  function multiFrameGeometry(ds, nf) {
    const shared = ds.SharedFunctionalGroupsSequence?.[0] || {};
    const perFrame = ds.PerFrameFunctionalGroupsSequence || [];
    const iop = (shared.PlaneOrientationSequence?.[0]?.ImageOrientationPatient
      || perFrame[0]?.PlaneOrientationSequence?.[0]?.ImageOrientationPatient
      || ds.ImageOrientationPatient || [1, 0, 0, 0, 1, 0]).map(Number);
    const pm = shared.PixelMeasuresSequence?.[0] || perFrame[0]?.PixelMeasuresSequence?.[0] || {};
    const ps = (pm.PixelSpacing || ds.PixelSpacing || [1, 1]).map(Number);
    const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6), normal = cross(rowDir, colDir);
    let order, p0, spacing;
    if (perFrame.length === nf && perFrame[0]?.PlanePositionSequence?.[0]?.ImagePositionPatient) {
      order = perFrame.map((fg, f) => {
        const ipp = (fg.PlanePositionSequence?.[0]?.ImagePositionPatient || [0, 0, 0]).map(Number);
        return { f, ipp, proj: dot(ipp, normal) };
      }).sort((a, b) => a.proj - b.proj);
      p0 = order[0].ipp;
      spacing = nf > 1 ? dot(sub(order[nf - 1].ipp, p0), normal) / (nf - 1) : 1;
    } else {
      order = Array.from({ length: nf }, (_, f) => ({ f }));
      p0 = (ds.ImagePositionPatient || [0, 0, 0]).map(Number);
      spacing = Number(pm.SpacingBetweenSlices ?? pm.SliceThickness ?? ds.SpacingBetweenSlices ?? ds.SliceThickness) || 1;
    }
    if (!spacing) spacing = 1;
    const xf = shared.PixelValueTransformationSequence?.[0] || {};
    return {
      shared, perFrame, iop, ps, rowDir, colDir, normal, order, p0, spacing,
      slope: Number(xf.RescaleSlope ?? ds.RescaleSlope ?? 1),
      inter: Number(xf.RescaleIntercept ?? ds.RescaleIntercept ?? 0),
    };
  }

  /** ONE enhanced / multi-frame instance (e.g. every ReMIND 3D ultrasound series) -> volume on
   *  its native grid. `bytes` is the raw PixelData. opts.float picks Float32 over Int16 storage;
   *  opts.onFrame(k, nf) reports progress. */
  function assembleMultiFrame(ds, bytes, opts) {
    const o = opts || {};
    const nx = Number(ds.Columns), ny = Number(ds.Rows), nf = Number(ds.NumberOfFrames) || 1;
    const bits = Number(ds.BitsAllocated) || 8;
    const gm = multiFrameGeometry(ds, nf);
    const px = pixelsOf(rawBuffer(bytes), bits, ds.PixelRepresentation === 1);
    const frameLen = nx * ny;
    const vol = o.float ? new Float32Array(frameLen * nf) : new Int16Array(frameLen * nf);
    for (let k = 0; k < nf; k++) {
      const src = gm.order[k].f * frameLen, dst = k * frameLen;
      for (let p = 0; p < frameLen; p++) vol[dst + p] = px[src + p] * gm.slope + gm.inter;
      if (o.onFrame && (k % 16 === 0)) o.onFrame(k, nf);
    }
    const ijkToRAS = ijkToRASFrom(
      lps2ras(gm.rowDir.map((v) => v * gm.ps[1])),
      lps2ras(gm.colDir.map((v) => v * gm.ps[0])),
      lps2ras(gm.normal.map((v) => v * gm.spacing)),
      lps2ras(gm.p0),
    );
    const voi = voiOf(ds, gm.shared) || autoWindow(vol, false);
    return { vol, dims: [nx, ny, nf], ijkToRAS, win: voi.win, lev: voi.lev, iop: gm.iop, ps: gm.ps };
  }

  /** A conventional one-frame-per-instance series -> volume. `slices` are naturalized datasets;
   *  they are sorted here by position along the slice normal. */
  function assembleSlices(slices, opts) {
    const o = opts || {};
    const s0 = slices[0];
    const iop = s0.ImageOrientationPatient.map(Number);
    const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6), normal = cross(rowDir, colDir);
    slices.sort((a, b) => dot(a.ImagePositionPatient.map(Number), normal) - dot(b.ImagePositionPatient.map(Number), normal));
    const nz = slices.length, ny = Number(s0.Rows), nx = Number(s0.Columns);
    const ps = s0.PixelSpacing.map(Number);
    const p0 = slices[0].ImagePositionPatient.map(Number);
    const p1 = slices[nz - 1].ImagePositionPatient.map(Number);
    const spacing = nz > 1 ? dot(sub(p1, p0), normal) / (nz - 1) : (Number(s0.SliceThickness) || 1);
    const vol = o.float ? new Float32Array(nx * ny * nz) : new Int16Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) {
      const ds = slices[k];
      // PER-SLICE rescale: PET (and some CT/MR) carry a DIFFERENT RescaleSlope/RescaleIntercept on
      // every slice — applying only the first slice's values mis-scales the rest of the volume.
      const slope = Number(ds.RescaleSlope ?? 1), inter = Number(ds.RescaleIntercept ?? 0);
      let pd = ds.PixelData;
      if (Array.isArray(pd)) pd = pd[0];
      const px = pixelsOf(pd, Number(ds.BitsAllocated) || 16, ds.PixelRepresentation === 1);
      const off = k * nx * ny;
      for (let p = 0; p < nx * ny; p++) vol[off + p] = px[p] * slope + inter;
    }
    const ijkToRAS = ijkToRASFrom(
      lps2ras(rowDir.map((v) => v * ps[1])),
      lps2ras(colDir.map((v) => v * ps[0])),
      lps2ras(normal.map((v) => v * spacing)),
      lps2ras(p0),
    );
    return { vol, dims: [nx, ny, nz], ijkToRAS, iop, ps };
  }

  g.DicomVolume = {
    sub, dot, cross, lps2ras, ijkToRASFrom,
    autoWindow, voiOf, pixelsOf, rawBuffer, findPixelData,
    multiFrameGeometry, assembleMultiFrame, assembleSlices,
  };
})(self);
